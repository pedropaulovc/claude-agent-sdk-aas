import { Hono } from "hono";
import * as Sentry from "@sentry/node";
import { subscribeToLogs } from "../telemetry/helpers.js";
import type { LogLine } from "../telemetry/helpers.js";

export const logRoutes = new Hono();

logRoutes.get("/v1/logs", (c) => {
  const prefix = c.req.query("prefix") || "";

  return Sentry.startSpan({ name: "sse.logs", op: "http.stream" }, (span) => {
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();

        const send = (data: string) => {
          controller.enqueue(encoder.encode(data));
        };

        // Send initial comment
        send(": connected\n\n");

        // Subscribe to log lines
        const unsubscribe = subscribeToLogs((line: LogLine) => {
          // Server-side prefix filter
          if (prefix && !line.message.startsWith(prefix) &&
              !(line.attributes?.instanceName as string)?.startsWith(prefix)) {
            return;
          }
          send(`event: log\ndata: ${JSON.stringify(line)}\n\n`);
        });

        // Keepalive every 30s
        const keepalive = setInterval(() => {
          send(": keepalive\n\n");
        }, 30000);

        // Cleanup on close - store refs for cancel
        (controller as unknown as Record<string, unknown>)._cleanup = () => {
          unsubscribe();
          clearInterval(keepalive);
          span.end();
        };
      },
      cancel(controller) {
        const ctrl = controller as unknown as Record<string, unknown>;
        if (typeof ctrl._cleanup === "function") {
          (ctrl._cleanup as () => void)();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  });
});
