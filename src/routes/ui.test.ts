import { describe, it, expect, vi } from "vitest";

// Mock Sentry
vi.mock("@sentry/node", async () => {
  const actual = await vi.importActual<typeof import("@sentry/node")>("@sentry/node");
  return {
    ...actual,
    startSpan: vi.fn((_opts, cb) =>
      cb({
        setAttribute: vi.fn(),
        spanContext: () => ({ traceId: "test-trace" }),
      }),
    ),
    continueTrace: vi.fn((_opts, cb) => cb()),
    getActiveSpan: vi.fn(() => ({ spanContext: () => ({ traceId: "test-trace" }) })),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fmt: actual.logger.fmt,
    },
  };
});

const { app } = await import("../server.js");

describe("UI Routes", () => {
  it("GET /ui returns HTML dashboard", async () => {
    const res = await app.request("/ui");
    expect(res.status).toBe(200);

    const contentType = res.headers.get("content-type");
    expect(contentType).toContain("text/html");

    const body = await res.text();
    expect(body).toContain("AAS Control");
    expect(body).toContain("tree-container");
    expect(body).toContain("/v1/instances");
  });

  it("dashboard contains instance tree sidebar", async () => {
    const res = await app.request("/ui");
    const body = await res.text();
    expect(body).toContain("sidebar");
    expect(body).toContain("Instances");
  });

  it("dashboard contains status bar", async () => {
    const res = await app.request("/ui");
    const body = await res.text();
    expect(body).toContain("status-bar");
    expect(body).toContain("stat-instances");
    expect(body).toContain("stat-running");
    expect(body).toContain("stat-queued");
  });

  it("dashboard contains send panel placeholder", async () => {
    const res = await app.request("/ui");
    const body = await res.text();
    expect(body).toContain("send-panel");
    expect(body).toContain("send-instance");
    expect(body).toContain("send-prompt");
  });
});
