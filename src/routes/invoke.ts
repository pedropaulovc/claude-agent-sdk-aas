import { Hono } from "hono";
import { z } from "zod";
import { store } from "../registry/store.js";
import { executeInvocation } from "../sdk/executor.js";
import { jsonResponse } from "../telemetry/middleware.js";
import { logInfo, logError, withSpan } from "../telemetry/helpers.js";
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

  logInfo(`api.invoke | start`, { instanceName: name, prompt: parsed.data.prompt.substring(0, 200) });

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      const sendEvent = (event: InvocationEvent) => {
        controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
      };

      try {
        await withSpan("api.invoke", "http.handler", async () => {
          for await (const event of executeInvocation(instance, parsed.data.prompt, abortController)) {
            sendEvent(event);
          }
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logError("api.invoke | stream_error", { instanceName: name, error: errorMsg });
        const errorEvent: InvocationEvent = { type: "error", invocationId: "unknown", error: errorMsg, code: "stream_error" };
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`));
      } finally {
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
