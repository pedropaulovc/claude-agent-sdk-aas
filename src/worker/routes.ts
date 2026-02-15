import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { jsonResponse, deferSpanEnd } from "../telemetry/middleware.js";
import { logInfo, countMetric } from "../telemetry/helpers.js";
import type { WorkerState } from "./activation.js";
import { activate } from "./activation.js";
import { QueueFullError } from "./queue.js";
import type { SseEvent } from "./queue.js";
import type { HistoryMessage } from "./history.js";

let state: WorkerState;

const messageSchema = z.object({
  message: z.string().min(1, "message must be a non-empty string"),
  traceContext: z
    .object({
      sentryTrace: z.string(),
      baggage: z.string(),
    })
    .optional(),
});

export function initWorkerState(s: WorkerState): void {
  state = s;
}

export function getWorkerState(): WorkerState {
  return state;
}

/**
 * Accumulates assistant text and tool calls from SSE events for a single invocation,
 * then appends the completed assistant message to the history store when done.
 */
function trackHistory(
  userMessage: string,
  invocationId: string,
  originalOnEvent: (event: SseEvent) => void,
): (event: SseEvent) => void {
  const store = state.historyStore;
  if (!store) {
    return originalOnEvent;
  }

  // Record the user message immediately
  store.append({
    role: "user",
    content: userMessage,
    timestamp: new Date().toISOString(),
    invocationId,
  });

  let assistantText = "";
  const toolCalls: Array<{ toolName: string; toolInput: unknown }> = [];

  return (event: SseEvent) => {
    if (event.event === "assistant_text") {
      assistantText += event.data.text;
    }

    if (event.event === "tool_use") {
      toolCalls.push({
        toolName: event.data.toolName,
        toolInput: event.data.toolInput,
      });
    }

    if (event.event === "done") {
      const msg: HistoryMessage = {
        role: "assistant",
        content: assistantText,
        timestamp: new Date().toISOString(),
        invocationId,
      };
      if (toolCalls.length > 0) {
        msg.toolCalls = toolCalls;
      }
      store.append(msg);
    }

    originalOnEvent(event);
  };
}

// Dormant guard middleware — returns 503 for non-health/activate routes when dormant
const dormantGuard = createMiddleware(async (c, next) => {
  if (state.status === "dormant") {
    return jsonResponse(c, { error: "Worker is dormant", code: "dormant" }, 503);
  }
  await next();
});

export const workerRoutes = new Hono();

// --- Routes available in ALL states ---

workerRoutes.get("/health", (c) => {
  const base = {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    uid: process.getuid?.() ?? -1,
  };

  if (state.status === "dormant") {
    return jsonResponse(c, { status: "dormant" as const, ...base });
  }

  return jsonResponse(c, {
    status: "ok" as const,
    instanceName: state.instanceName ?? "unknown",
    ...base,
  });
});

workerRoutes.post("/activate", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) {
    return jsonResponse(c, { error: "Invalid JSON body" }, 400);
  }

  const result = activate(state, body);
  if (!result.success) {
    return jsonResponse(
      c,
      { error: result.error, code: result.code },
      result.status as 400 | 409,
    );
  }

  logInfo("POST /activate succeeded", { instanceName: state.instanceName });

  return jsonResponse(c, {
    activated: true,
    instanceName: state.instanceName,
  });
});

// --- Routes guarded by dormant check ---

workerRoutes.get("/history", dormantGuard, (c) => {
  if (!state.historyStore) {
    return jsonResponse(c, { error: "Worker not initialized" }, 500);
  }

  return jsonResponse(c, {
    instanceName: state.instanceName,
    messages: state.historyStore.getAll(),
  });
});

workerRoutes.get("/status", dormantGuard, (c) => {
  if (!state.sdkRunner || !state.invocationQueue) {
    return jsonResponse(c, { error: "Worker not initialized" }, 500);
  }

  const uptime = state.startedAt
    ? Date.now() - new Date(state.startedAt).getTime()
    : 0;

  return jsonResponse(c, {
    instanceName: state.instanceName,
    model: state.sdkRunner.config.model,
    sessionId: state.sdkRunner.sessionId,
    uptime,
    messageCount: state.sdkRunner.messageCount,
    totalCostUsd: state.sdkRunner.totalCostUsd,
    queueDepth: state.invocationQueue.depth,
    activeInvocationId: state.invocationQueue.activeInvocationId,
    startedAt: state.startedAt,
  });
});

workerRoutes.post("/abort", dormantGuard, (c) => {
  if (!state.invocationQueue) {
    return jsonResponse(c, { error: "Worker not initialized" }, 500);
  }

  const result = state.invocationQueue.abort();
  if (!result.aborted) {
    return jsonResponse(c, { aborted: false, reason: "no_active_invocation" });
  }

  return jsonResponse(c, { aborted: true, invocationId: result.invocationId });
});

workerRoutes.post("/reset", dormantGuard, (c) => {
  if (!state.invocationQueue || !state.sdkRunner || !state.historyStore) {
    return jsonResponse(c, { error: "Worker not initialized" }, 500);
  }

  if (state.invocationQueue.activeInvocationId) {
    return jsonResponse(
      c,
      {
        error: "Cannot reset while invocation is running",
        code: "invocation_active",
      },
      409,
    );
  }

  state.invocationQueue.clear();
  state.sdkRunner.resetSession();
  state.historyStore.clear();

  logInfo("Worker reset", { instanceName: state.instanceName });
  countMetric("worker.reset", 1, { instanceName: state.instanceName ?? "" });

  return jsonResponse(c, {
    reset: true,
    instanceName: state.instanceName,
  });
});

workerRoutes.post("/message", dormantGuard, async (c) => {
  if (!state.invocationQueue || !state.historyStore) {
    return jsonResponse(c, { error: "Worker not initialized" }, 500);
  }

  const currentQueue = state.invocationQueue;

  const body = await c.req.json().catch(() => null);
  if (!body) {
    return jsonResponse(c, { error: "Invalid JSON body" }, 400);
  }

  const parsed = messageSchema.safeParse(body);
  if (!parsed.success) {
    const messages = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return jsonResponse(c, { error: messages }, 400);
  }

  const invocationId = crypto.randomUUID();

  logInfo("Message received", {
    invocationId,
    instanceName: state.instanceName,
    messageLength: parsed.data.message.length,
  });
  countMetric("message.received", 1, {
    instanceName: state.instanceName ?? "",
  });

  const httpSpan = deferSpanEnd(c);

  return streamSSE(c, async (stream) => {
    const abortController = new AbortController();
    let doneResolve: () => void;
    const donePromise = new Promise<void>((resolve) => {
      doneResolve = resolve;
    });

    stream.onAbort(() => {
      logInfo("Client disconnected, aborting invocation", { invocationId });
      abortController.abort();
      doneResolve();
    });

    const sseOnEvent = (event: SseEvent): void => {
      const writePromise = stream.writeSSE({
        event: event.event,
        data: JSON.stringify(event.data),
        id: invocationId,
      });

      // Terminal events: wait for write to flush, then close stream
      if (event.event === "done" || event.event === "error") {
        void writePromise.then(() => doneResolve());
      }
    };

    const onEvent = trackHistory(parsed.data.message, invocationId, sseOnEvent);

    let position: number;
    try {
      position = currentQueue.enqueue({
        invocationId,
        message: parsed.data.message,
        onEvent,
        signal: abortController.signal,
      });
    } catch (err) {
      if (err instanceof QueueFullError) {
        c.header("Retry-After", "5");
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({
            invocationId,
            error: "Queue is full",
            code: "queue_full",
          }),
          id: invocationId,
        });
        return;
      }
      throw err;
    }

    if (position > 0) {
      await stream.writeSSE({
        event: "queued",
        data: JSON.stringify({ invocationId, position }),
        id: invocationId,
      });
    }

    // Keep the stream open until the invocation completes or client disconnects
    await donePromise;
    httpSpan?.end();
  });
});
