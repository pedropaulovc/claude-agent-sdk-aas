import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { jsonResponse } from "../telemetry/middleware.js";
import { logInfo, countMetric } from "../telemetry/helpers.js";
import type { WorkerConfig } from "./config.js";
import { InvocationQueue, QueueFullError } from "./queue.js";
import { SdkRunner } from "./sdk-runner.js";

let workerConfig: WorkerConfig | null = null;
let invocationQueue: InvocationQueue | null = null;
let sdkRunner: SdkRunner | null = null;

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
}

export function getInvocationQueue(): InvocationQueue | null {
  return invocationQueue;
}

export function getSdkRunner(): SdkRunner | null {
  return sdkRunner;
}

export const workerRoutes = new Hono();

workerRoutes.get("/health", (c) => {
  return jsonResponse(c, {
    status: "ok" as const,
    instanceName: workerConfig?.instanceName ?? "unknown",
  });
});

workerRoutes.post("/message", async (c) => {
  if (!workerConfig || !invocationQueue) {
    return jsonResponse(c, { error: "Worker not initialized" }, 500);
  }

  const currentQueue = invocationQueue;
  const currentConfig = workerConfig;

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

    let position: number;
    try {
      position = currentQueue.enqueue({
        invocationId,
        message: parsed.data.message,
        onEvent: (event) => {
          void stream.writeSSE({
            event: event.event,
            data: JSON.stringify(event.data),
            id: invocationId,
          });

          // Terminal events close the stream
          if (event.event === "done" || event.event === "error") {
            doneResolve();
          }
        },
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
