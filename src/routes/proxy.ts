import { Hono } from "hono";
import type { Context, Next } from "hono";
import { stream } from "hono/streaming";
import * as Sentry from "@sentry/node";
import { store } from "../registry/store.js";
import { jsonResponse } from "../telemetry/middleware.js";
import {
  withSpan,
  logInfo,
  logError,
  countMetric,
  distributionMetric,
} from "../telemetry/helpers.js";
import type { InstanceStatus } from "../shared/types.js";

export const proxyRoutes = new Hono();

function getTraceHeaders(): Record<string, string> {
  const span = Sentry.getActiveSpan();
  if (!span) return {};

  const { traceId, spanId } = span.spanContext();
  return {
    "sentry-trace": `${traceId}-${spanId}-1`,
    baggage: `sentry-trace_id=${traceId}`,
  };
}

function extractName(path: string, suffix: string): string {
  return path
    .replace("/v1/instances/", "")
    .replace(new RegExp(`/${suffix}$`), "");
}

type GuardResult =
  | { ok: true; workerUrl: string }
  | { ok: false; response: Response };

function guardInstance(
  c: Context,
  name: string,
  allowedStatuses: InstanceStatus[],
): GuardResult {
  const instance = store.get(name);
  if (!instance) {
    return {
      ok: false,
      response: jsonResponse(
        c,
        { error: `Instance "${name}" not found` },
        404,
      ),
    };
  }

  if (!allowedStatuses.includes(instance.status)) {
    return {
      ok: false,
      response: jsonResponse(
        c,
        { error: "Instance not ready", status: instance.status },
        503,
      ),
    };
  }

  if (!instance.workerUrl) {
    return {
      ok: false,
      response: jsonResponse(
        c,
        { error: "Instance has no worker URL", status: instance.status },
        503,
      ),
    };
  }

  return { ok: true, workerUrl: instance.workerUrl };
}

// POST /v1/instances/*/message — proxy to worker POST /message (SSE stream)
// Uses wildcard + suffix check because instance names can contain slashes
proxyRoutes.post("/v1/instances/*", async (c: Context, next: Next) => {
  if (!c.req.path.endsWith("/message")) return next();

  const name = extractName(c.req.path, "message");

  return withSpan("proxy.message", "http.proxy", async () => {
    const start = Date.now();
    countMetric("proxy.count", 1, { route: "message" });

    const guard = guardInstance(c, name, ["ready"]);
    if (!guard.ok) return guard.response;

    const { workerUrl } = guard;
    logInfo(`${name} | proxy.message`, { workerUrl });

    const traceHeaders = getTraceHeaders();
    const requestBody = await c.req.json();

    let workerResponse: Response;
    try {
      workerResponse = await fetch(`${workerUrl}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...traceHeaders },
        body: JSON.stringify(requestBody),
      });
    } catch (err) {
      const duration = Date.now() - start;
      distributionMetric("proxy.duration_ms", duration, "millisecond", {
        route: "message",
      });
      countMetric("proxy.error", 1, { route: "message" });
      logError(`${name} | proxy.message fetch error`, {
        error: String(err),
      });
      return jsonResponse(c, { error: "Failed to reach worker" }, 503);
    }

    const duration = Date.now() - start;
    distributionMetric("proxy.duration_ms", duration, "millisecond", {
      route: "message",
    });

    return stream(c, async (s) => {
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      c.header("Connection", "keep-alive");

      const reader = workerResponse.body?.getReader();
      if (!reader) return;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await s.write(value);
        }
      } catch (err) {
        countMetric("proxy.error", 1, { route: "message" });
        logError(`${name} | proxy.message stream error`, {
          error: String(err),
        });
      }
    });
  });
});

// GET /v1/instances/*/history and /status — proxy to worker
// Uses wildcard + suffix check because instance names can contain slashes
proxyRoutes.get("/v1/instances/*", async (c: Context, next: Next) => {
  const path = c.req.path;
  const isHistory = path.endsWith("/history");
  const isStatus = path.endsWith("/status");

  if (!isHistory && !isStatus) return next();

  const suffix = isHistory ? "history" : "status";
  const name = extractName(path, suffix);
  const allowedStatuses: InstanceStatus[] = ["ready", "unreachable"];

  return withSpan(`proxy.${suffix}`, "http.proxy", async () => {
    const start = Date.now();
    countMetric("proxy.count", 1, { route: suffix });

    const guard = guardInstance(c, name, allowedStatuses);
    if (!guard.ok) return guard.response;

    const { workerUrl } = guard;
    logInfo(`${name} | proxy.${suffix}`, { workerUrl });

    const traceHeaders = getTraceHeaders();

    let workerResponse: Response;
    try {
      workerResponse = await fetch(`${workerUrl}/${suffix}`, {
        headers: traceHeaders,
      });
    } catch (err) {
      const duration = Date.now() - start;
      distributionMetric("proxy.duration_ms", duration, "millisecond", {
        route: suffix,
      });
      countMetric("proxy.error", 1, { route: suffix });
      logError(`${name} | proxy.${suffix} fetch error`, {
        error: String(err),
      });
      return jsonResponse(c, { error: "Failed to reach worker" }, 503);
    }

    const duration = Date.now() - start;
    distributionMetric("proxy.duration_ms", duration, "millisecond", {
      route: suffix,
    });

    const data = await workerResponse.json();
    return jsonResponse(c, data as Record<string, unknown>);
  });
});
