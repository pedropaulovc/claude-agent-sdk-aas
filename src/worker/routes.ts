import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { jsonResponse } from "../telemetry/middleware.js";
import { logInfo, countMetric } from "../telemetry/helpers.js";
import type { WorkerConfig } from "./config.js";
import { InvocationQueue, QueueFullError } from "./queue.js";
import type { SseEvent } from "./queue.js";
import { SdkRunner } from "./sdk-runner.js";
import { HistoryStore, type HistoryMessage } from "./history.js";

let workerConfig: WorkerConfig | null = null;
let invocationQueue: InvocationQueue | null = null;
let sdkRunner: SdkRunner | null = null;
let historyStore: HistoryStore | null = null;
let startedAt: string | null = null;

const messageSchema = z.object({
  message: z.string().min(1, "message must be a non-empty string"),
  traceContext: z.object({
    sentryTrace: z.string(),
    baggage: z.string(),
  }).optional(),
});

export function initWorkerRoutes(config: WorkerConfig): void {
  workerConfig = config;
  const runner = new SdkRunner(config);
  sdkRunner = runner;
  invocationQueue = new InvocationQueue(25);
  invocationQueue.setRunner((message, invocationId, signal) =>
    runner.run(message, invocationId, signal),
  );
  historyStore = new HistoryStore();
  startedAt = new Date().toISOString();
}

export function getInvocationQueue(): InvocationQueue | null {
  return invocationQueue;
}

export function getSdkRunner(): SdkRunner | null {
  return sdkRunner;
}

export function getHistoryStore(): HistoryStore | null {
  return historyStore;
}

/**
 * Accumulates assistant text and tool calls from SSE events for a single invocation,
 * then appends the completed assistant message to the history store when done.
 */
function trackHistory(
  store: HistoryStore,
  userMessage: string,
  invocationId: string,
  originalOnEvent: (event: SseEvent) => void,
): (event: SseEvent) => void {
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

export const workerRoutes = new Hono();

workerRoutes.get("/health", (c) => {
  return jsonResponse(c, {
    status: "ok" as const,
    instanceName: workerConfig?.instanceName ?? "unknown",
  });
});

workerRoutes.get("/history", (c) => {
  if (!workerConfig || !historyStore) {
    return jsonResponse(c, { error: "Worker not initialized" }, 500);
  }

  return jsonResponse(c, {
    instanceName: workerConfig.instanceName,
    messages: historyStore.getAll(),
  });
});

workerRoutes.get("/status", (c) => {
  if (!workerConfig || !sdkRunner || !invocationQueue) {
    return jsonResponse(c, { error: "Worker not initialized" }, 500);
  }

  const uptime = startedAt
    ? Date.now() - new Date(startedAt).getTime()
    : 0;

  return jsonResponse(c, {
    instanceName: workerConfig.instanceName,
    model: workerConfig.model,
    sessionId: sdkRunner.sessionId,
    uptime,
    messageCount: sdkRunner.messageCount,
    totalCostUsd: sdkRunner.totalCostUsd,
    queueDepth: invocationQueue.depth,
    activeInvocationId: invocationQueue.activeInvocationId,
    startedAt: startedAt ?? new Date().toISOString(),
  });
});

workerRoutes.post("/abort", (c) => {
  if (!invocationQueue) {
    return jsonResponse(c, { error: "Worker not initialized" }, 500);
  }

  const result = invocationQueue.abort();
  if (!result.aborted) {
    return jsonResponse(c, { aborted: false, reason: "no_active_invocation" });
  }

  return jsonResponse(c, { aborted: true, invocationId: result.invocationId });
});

workerRoutes.post("/reset", (c) => {
  if (!workerConfig || !invocationQueue || !sdkRunner || !historyStore) {
    return jsonResponse(c, { error: "Worker not initialized" }, 500);
  }

  if (invocationQueue.activeInvocationId) {
    return jsonResponse(
      c,
      { error: "Cannot reset while invocation is running", code: "invocation_active" },
      409,
    );
  }

  invocationQueue.clear();
  sdkRunner.resetSession();
  historyStore.clear();

  logInfo("Worker reset", { instanceName: workerConfig.instanceName });
  countMetric("worker.reset", 1, { instanceName: workerConfig.instanceName });

  return jsonResponse(c, { reset: true, instanceName: workerConfig.instanceName });
});

workerRoutes.post("/message", async (c) => {
  if (!workerConfig || !invocationQueue || !historyStore) {
    return jsonResponse(c, { error: "Worker not initialized" }, 500);
  }

  const currentQueue = invocationQueue;
  const currentConfig = workerConfig;
  const currentHistory = historyStore;

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
    instanceName: currentConfig.instanceName,
    messageLength: parsed.data.message.length,
  });
  countMetric("message.received", 1, { instanceName: currentConfig.instanceName });

  return streamSSE(c, async (stream) => {
    const abortController = new AbortController();
    let doneResolve: () => void;
    const donePromise = new Promise<void>((resolve) => { doneResolve = resolve; });

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

    const onEvent = trackHistory(
      currentHistory,
      parsed.data.message,
      invocationId,
      sseOnEvent,
    );

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
  });
});
