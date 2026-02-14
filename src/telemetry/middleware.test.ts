import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { sentryMiddleware, jsonResponse } from "./middleware.js";

describe("telemetry middleware", () => {
  it("jsonResponse returns correct status and body", async () => {
    const testApp = new Hono();
    testApp.get("/test", (c) => {
      return jsonResponse(c, { message: "hello" }, 201);
    });

    const res = await testApp.request("/test");
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.message).toBe("hello");
  });

  it("jsonResponse defaults to 200 status", async () => {
    const testApp = new Hono();
    testApp.get("/test", (c) => {
      return jsonResponse(c, { ok: true });
    });

    const res = await testApp.request("/test");
    expect(res.status).toBe(200);
  });

  it("middleware attaches x-sentry-trace-id header", async () => {
    const testApp = new Hono();
    testApp.use("*", sentryMiddleware);
    testApp.get("/test", (c) => {
      return c.json({ ok: true });
    });

    const res = await testApp.request("/test");
    expect(res.status).toBe(200);
    // Trace ID header should be present (Sentry generates one even without DSN)
    const traceId = res.headers.get("x-sentry-trace-id");
    expect(traceId).toBeTruthy();
    expect(typeof traceId).toBe("string");
  });
});
