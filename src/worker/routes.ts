import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import * as Sentry from "@sentry/node";
import { jsonResponse } from "../telemetry/middleware.js";
import {
  withSpan,
  logInfo,
  countMetric,
  chunkedLog,
} from "../telemetry/helpers.js";
import type { WorkerConfig, MinimalWorkerConfig, WorkerState } from "./config.js";
import { configurePayloadSchema } from "./config.js";
import { InvocationQueue, QueueFullError } from "./queue.js";
import type { SseEvent } from "./queue.js";
import { SdkRunner } from "./sdk-runner.js";
import { HistoryStore, type HistoryMessage } from "./history.js";

// Mutable worker state
let workerState: WorkerState = "idle";
let instanceName: string | null = null;
let anthropicApiKey: string | null = null;
let sentryDsn = "";
let invocationQueue: InvocationQueue | null = null;
let sdkRunner: SdkRunner | null = null;
let historyStore: HistoryStore | null = null;
let startedAt: string | null = null;
let configuredAt: string | null = null;

// Current dynamic config (stored for /status)
let currentModel: string | null = null;

const messageSchema = z.object({
  message: z.string().min(1, "message must be a non-empty string"),
  traceContext: z.object({
    sentryTrace: z.string(),
    baggage: z.string(),
  }).optional(),
});

/**
 * Initialize worker in standalone (M4 compat) mode.
 * Worker starts immediately in 'active' state.
 */
export function initWorkerRoutes(config: WorkerConfig): void {
  anthropicApiKey = config.anthropicApiKey;
  instanceName = config.instanceName;
  currentModel = config.model;

  const runner = new SdkRunner(config);
  sdkRunner = runner;
  invocationQueue = new InvocationQueue(25);
  invocationQueue.setRunner((message, invocationId, signal) =>
    runner.run(message, invocationId, signal),
  );
  historyStore = new HistoryStore();
  startedAt = new Date().toISOString();
  workerState = "active";
}

/**
 * Initialize worker in pool mode.
 * Worker starts in 'idle' state and waits for POST /configure.
 */
export function initWorkerPoolMode(minimalConfig: MinimalWorkerConfig): void {
  anthropicApiKey = minimalConfig.anthropicApiKey;
  sentryDsn = minimalConfig.sentryDsn;
  workerState = "idle";
  instanceName = null;
  sdkRunner = null;
  invocationQueue = null;
  historyStore = null;
  startedAt = new Date().toISOString();
  configuredAt = null;
  currentModel = null;
}

export function getWorkerState(): WorkerState {
  return workerState;
}

export function getInstanceName(): string | null {
  return instanceName;
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
    instanceName: instanceName ?? null,
    state: workerState,
  });
});

workerRoutes.get("/history", (c) => {
  if (workerState !== "active") {
    return jsonResponse(c, { error: "Worker is idle", state: workerState }, 503);
  }

  if (!historyStore) {
    return jsonResponse(c, { error: "Worker not initialized" }, 500);
  }

  return jsonResponse(c, {
    instanceName,
    messages: historyStore.getAll(),
  });
});

workerRoutes.get("/status", (c) => {
  const uptime = startedAt
    ? Date.now() - new Date(startedAt).getTime()
    : 0;

  return jsonResponse(c, {
    instanceName,
    state: workerState,
    model: currentModel,
    sessionId: sdkRunner?.sessionId ?? null,
    uptime,
    messageCount: sdkRunner?.messageCount ?? 0,
    totalCostUsd: sdkRunner?.totalCostUsd ?? 0,
    queueDepth: invocationQueue?.depth ?? 0,
    activeInvocationId: invocationQueue?.activeInvocationId ?? null,
    startedAt: startedAt ?? new Date().toISOString(),
    configuredAt,
  });
});

workerRoutes.post("/abort", (c) => {
  if (workerState !== "active") {
    return jsonResponse(c, { error: "Worker is idle", state: workerState }, 503);
  }

  if (!invocationQueue) {
    return jsonResponse(c, { error: "Worker not initialized" }, 500);
  }

  const result = invocationQueue.abort();
  if (!result.aborted) {
    return jsonResponse(c, { aborted: false, reason: "no_active_invocation" });
  }

  return jsonResponse(c, { aborted: true, invocationId: result.invocationId });
});

workerRoutes.post("/configure", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) {
    return jsonResponse(c, { error: "Invalid JSON body" }, 400);
  }

  const parsed = configurePayloadSchema.safeParse(body);
  if (!parsed.success) {
    const messages = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return jsonResponse(c, { error: messages }, 400);
  }

  if (workerState === "configuring" || workerState === "resetting") {
    return jsonResponse(
      c,
      { error: `Cannot configure while worker is ${workerState}`, code: "invalid_state" },
      409,
    );
  }

  return withSpan("worker.configure", "worker.configure", async () => {
    const payload = parsed.data;

    // Implicit reset if currently active
    if (workerState === "active" && invocationQueue && sdkRunner && historyStore) {
      if (invocationQueue.activeInvocationId) {
        return jsonResponse(c, { error: "Cannot reconfigure while invocation is active", state: workerState }, 409);
      }
      invocationQueue.clear();
      sdkRunner.resetSession();
      historyStore.clear();
    }

    workerState = "configuring";

    if (!anthropicApiKey) {
      workerState = "idle";
      return jsonResponse(c, { error: "No API key configured" }, 500);
    }

    // Build a WorkerConfig from the payload + stored API key
    const runnerConfig: WorkerConfig = {
      instanceName: payload.instanceName,
      systemPrompt: payload.systemPrompt,
      mcpServers: payload.mcpServers,
      model: payload.model,
      maxTurns: payload.maxTurns,
      maxBudgetUsd: payload.maxBudgetUsd,
      anthropicApiKey,
      sentryDsn,
      port: 0,       // Not needed by SdkRunner
    };

    const runner = new SdkRunner(runnerConfig);
    sdkRunner = runner;

    const queue = new InvocationQueue(25);
    queue.setRunner((message, invocationId, signal) =>
      runner.run(message, invocationId, signal),
    );
    invocationQueue = queue;

    historyStore = new HistoryStore();
    instanceName = payload.instanceName;
    currentModel = payload.model;
    configuredAt = new Date().toISOString();
    workerState = "active";

    Sentry.getCurrentScope().setTag("service.name", `aas-worker-${payload.instanceName}`);

    chunkedLog(
      `${payload.instanceName} | configure.prompt`,
      payload.systemPrompt,
    );
    logInfo(`${payload.instanceName} | configure`, {
      "prompt.len": payload.systemPrompt.length,
      mcpServers: payload.mcpServers.length,
      model: payload.model,
    });
    countMetric("worker.configured", 1, { instanceName: payload.instanceName });

    return jsonResponse(c, {
      configured: true,
      instanceName: payload.instanceName,
      state: "active" as const,
    });
  });
});

workerRoutes.post("/reset", async (c) => {
  if (workerState === "idle") {
    return jsonResponse(c, { reset: true, instanceName: null, state: "idle" as const });
  }

  if (workerState === "configuring" || workerState === "resetting") {
    return jsonResponse(
      c,
      { error: `Cannot reset while worker is ${workerState}`, code: "invalid_state" },
      409,
    );
  }

  if (invocationQueue?.activeInvocationId) {
    return jsonResponse(
      c,
      { error: "Cannot reset while invocation is active", code: "invocation_active" },
      409,
    );
  }

  return withSpan("worker.reset", "worker.reset", async () => {
    const previousName = instanceName;
    workerState = "resetting";

    invocationQueue?.clear();
    sdkRunner?.resetSession();
    historyStore?.clear();

    sdkRunner = null;
    invocationQueue = null;
    historyStore = null;
    instanceName = null;
    currentModel = null;
    configuredAt = null;
    workerState = "idle";

    Sentry.getCurrentScope().setTag("service.name", "aas-worker-idle");

    logInfo(`${previousName} | reset | returning to idle`);
    countMetric("worker.reset", 1, { instanceName: previousName ?? "unknown" });

    return jsonResponse(c, {
      reset: true,
      instanceName: previousName,
      state: "idle" as const,
    });
  });
});

workerRoutes.post("/message", async (c) => {
  if (workerState !== "active") {
    return jsonResponse(c, { error: "Worker is idle", state: workerState }, 503);
  }

  if (!invocationQueue || !historyStore) {
    return jsonResponse(c, { error: "Worker not initialized" }, 500);
  }

  const currentQueue = invocationQueue;
  const currentInstanceName = instanceName;
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
    instanceName: currentInstanceName,
    messageLength: parsed.data.message.length,
  });
  countMetric("message.received", 1, { instanceName: currentInstanceName ?? "unknown" });

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
