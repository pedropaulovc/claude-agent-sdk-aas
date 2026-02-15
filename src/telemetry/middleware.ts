import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import * as Sentry from "@sentry/node";

export const sentryMiddleware = createMiddleware(async (c, next) => {
  const sentryTrace = c.req.header("sentry-trace") ?? "";
  const baggage = c.req.header("baggage") ?? "";

  return Sentry.continueTrace({ sentryTrace, baggage }, () => {
    const span = Sentry.startInactiveSpan({
      name: `${c.req.method} ${c.req.path}`,
      op: "http.server",
    });

    return Sentry.withActiveSpan(span, async () => {
      await next();
      const traceId = span.spanContext().traceId;
      c.header("x-sentry-trace-id", traceId);
      // SSE handlers call deferSpanEnd() to take ownership of ending the span
      if (!c.get("sentrySpanDeferred" as never)) {
        span.end();
      }
    });
  });
});

/**
 * Defer the http.server span end for SSE responses. The caller is responsible
 * for calling span.end() when the stream closes. Returns the active span.
 */
export function deferSpanEnd(c: Context): Sentry.Span | undefined {
  c.set("sentrySpanDeferred" as never, true as never);
  return Sentry.getActiveSpan();
}

export function jsonResponse<T extends Record<string, unknown> | Record<string, unknown>[]>(
  c: Context,
  data: T,
  status: 200 | 201 | 202 | 400 | 404 | 409 | 429 | 500 | 503 = 200,
): Response {
  const traceId = Sentry.getActiveSpan()?.spanContext().traceId;
  if (traceId) {
    c.header("x-sentry-trace-id", traceId);
  }
  return c.json(data, status);
}
