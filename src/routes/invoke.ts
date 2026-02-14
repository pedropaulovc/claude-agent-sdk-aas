import { Hono } from "hono";
import { z } from "zod";
import * as Sentry from "@sentry/node";
import { store } from "../registry/store.js";
import { executeInvocation } from "../sdk/executor.js";
import type { TraceContext } from "../sdk/executor.js";
import { instanceQueue, QueueFullError } from "../queue/instance-queue.js";
import { jsonResponse } from "../telemetry/middleware.js";
import { logInfo, logError, withSpan, countMetric } from "../telemetry/helpers.js";
import type { InvocationEvent } from "../sdk/events.js";

const invokeBodySchema = z.object({
  prompt: z.string().min(1, "prompt is required"),
  traceContext: z
    .object({
      sentryTrace: z.string(),
      baggage: z.string(),
    })
    .optional(),
});

export const invokeRoutes = new Hono();

/** After an invocation finishes, dequeue the next waiting one and resolve its promise */
function drainNext(instanceName: string): void {
  const next = instanceQueue.dequeue(instanceName);
  if (!next) return;

  logInfo(`${instanceName} | queue.drain_next`, { remaining: instanceQueue.depth(instanceName) });
  next.resolve();
}

invokeRoutes.post("/v1/instances/*", async (c, next) => {
  // Only handle paths ending with /invoke — fall through otherwise
  if (!c.req.path.endsWith("/invoke")) {
    return next();
  }

  // Extract name - everything between /v1/instances/ and /invoke
  const name = c.req.path.replace("/v1/instances/", "").replace(/\/invoke$/, "");

  const parsed = invokeBodySchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return jsonResponse(c, { error: parsed.error.message }, 400);
  }

  const instance = store.get(name);
  if (!instance) {
    return jsonResponse(c, { error: `Instance "${name}" not found` }, 404);
  }

  if (instance.status === "error") {
    return jsonResponse(c, { error: `Instance "${name}" is in error state` }, 503);
  }

  const abortController = new AbortController();
  const needsQueue = instance.status === "running";

  // If instance is busy, try to enqueue. Reject with 429 if full.
  let queuePromise: Promise<void> | null = null;
  if (needsQueue) {
    try {
      queuePromise = instanceQueue.enqueue(name, parsed.data.prompt, abortController);
      instance.queueDepth = instanceQueue.depth(name);
    } catch (err) {
      if (err instanceof QueueFullError) {
        countMetric("queue.rejected", 1, { instance: name });
        return jsonResponse(c, { error: err.message, code: "queue_full" }, 429);
      }
      throw err;
    }
  }

  const traceContext: TraceContext | undefined = parsed.data.traceContext;

  logInfo(`api.invoke | start`, {
    instanceName: name,
    prompt: parsed.data.prompt.substring(0, 200),
    queued: needsQueue,
    hasTraceContext: !!traceContext,
  });

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      const sendEvent = (event: InvocationEvent | { type: "queued"; position: number }) => {
        controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
      };

      const runInvocation = async () => {
        // If queued, send the queued event and wait for our turn
        if (queuePromise) {
          sendEvent({ type: "queued", position: instanceQueue.depth(name) });
          logInfo(`api.invoke | queued`, { instanceName: name, position: instanceQueue.depth(name) });
          await queuePromise;
          logInfo(`api.invoke | dequeued`, { instanceName: name });
        }

        await withSpan("api.invoke", "http.handler", async () => {
          for await (const event of executeInvocation(instance, parsed.data.prompt, abortController, traceContext)) {
            sendEvent(event);
          }
        });
      };

      try {
        // If caller provided traceContext, continue their distributed trace
        // so this invocation appears as a child span in their trace.
        if (traceContext) {
          await Sentry.continueTrace(
            { sentryTrace: traceContext.sentryTrace, baggage: traceContext.baggage },
            runInvocation,
          );
        } else {
          await runInvocation();
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logError("api.invoke | stream_error", { instanceName: name, error: errorMsg });
        const errorEvent: InvocationEvent = { type: "error", invocationId: "unknown", error: errorMsg, code: "stream_error" };
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`));
      } finally {
        instance.queueDepth = instanceQueue.depth(name);
        drainNext(name);
        controller.close();
      }
    },
    cancel() {
      logInfo("api.invoke | client_disconnect", { instanceName: name });
      abortController.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});
