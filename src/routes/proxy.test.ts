import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Sentry from "@sentry/node";

const mockSetAttribute = vi.fn();

vi.mock("@sentry/node", async () => {
  const actual = await vi.importActual<typeof Sentry>("@sentry/node");
  return {
    ...actual,
    startSpan: vi.fn((_opts, cb) =>
      cb({
        setAttribute: mockSetAttribute,
        spanContext: () => ({ traceId: "test-trace", spanId: "test-span" }),
      }),
    ),
    getActiveSpan: vi.fn(() => ({
      spanContext: () => ({ traceId: "abc123", spanId: "def456" }),
    })),
    continueTrace: vi.fn((_opts, cb) => cb()),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fmt: actual.logger.fmt,
    },
  };
});

import { app } from "../server.js";
import { store } from "../registry/store.js";
import type { InstanceRecord, McpServerConfig } from "../shared/types.js";

function makeRecord(
  overrides?: Partial<InstanceRecord>,
): InstanceRecord {
  return {
    name: "test/agent",
    systemPrompt: "You are helpful.",
    mcpServers: [] as McpServerConfig[],
    model: "claude-haiku-4-5-20251001",
    maxTurns: 50,
    maxBudgetUsd: 1.0,
    status: "ready",
    railwayServiceId: "svc-123",
    workerUrl: "https://test-agent.up.railway.app",
    workerNumber: 1,
    provisionError: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

async function seedInstance(
  overrides?: Partial<InstanceRecord>,
): Promise<void> {
  const record = makeRecord(overrides);
  store.clear();
  // Provision then manually set fields
  await store.provision({
    name: record.name,
    systemPrompt: record.systemPrompt,
    mcpServers: record.mcpServers,
    model: record.model,
    maxTurns: record.maxTurns,
    maxBudgetUsd: record.maxBudgetUsd,
  });
  const instance = store.get(record.name);
  if (!instance) throw new Error("expected instance after provision");
  instance.status = record.status;
  instance.workerUrl = record.workerUrl;
  instance.railwayServiceId = record.railwayServiceId;
}

function makeReadableStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function mockFetchStream(body: string): ReturnType<typeof vi.fn> {
  const mock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    body: makeReadableStream(body),
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function mockFetchJson(data: unknown, status = 200): ReturnType<typeof vi.fn> {
  const mock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function mockFetchError(message: string): ReturnType<typeof vi.fn> {
  const mock = vi.fn().mockRejectedValue(new Error(message));
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("Proxy Routes", () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // --- POST /v1/instances/{name}/message ---

  it("POST /message — proxies to worker when ready, returns SSE stream", async () => {
    await seedInstance({ name: "test/agent", status: "ready" });
    const sseData = 'data: {"type":"text","content":"hello"}\n\n';
    const fetchMock = mockFetchStream(sseData);

    const res = await app.request("/v1/instances/test/agent/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe(sseData);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://test-agent.up.railway.app/message",
    );
  });

  it("POST /message — returns 503 when instance not ready (deploying)", async () => {
    await seedInstance({ name: "test/agent", status: "deploying" });
    mockFetchJson({});

    const res = await app.request("/v1/instances/test/agent/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("Instance not ready");
    expect(body.status).toBe("deploying");
  });

  it("POST /message — returns 404 when instance not found", async () => {
    mockFetchJson({});

    const res = await app.request("/v1/instances/nonexistent/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("not found");
  });

  // --- GET /v1/instances/{name}/history ---

  it("GET /history — proxies to worker when ready", async () => {
    await seedInstance({ name: "test/agent", status: "ready" });
    const historyData = { messages: [{ role: "user", content: "hi" }] };
    const fetchMock = mockFetchJson(historyData);

    const res = await app.request("/v1/instances/test/agent/history");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://test-agent.up.railway.app/history",
    );
  });

  it("GET /history — allowed when unreachable", async () => {
    await seedInstance({ name: "test/agent", status: "unreachable" });
    const historyData = { messages: [] };
    mockFetchJson(historyData);

    const res = await app.request("/v1/instances/test/agent/history");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toEqual([]);
  });

  it("GET /history — returns 503 when deploying", async () => {
    await seedInstance({ name: "test/agent", status: "deploying" });
    mockFetchJson({});

    const res = await app.request("/v1/instances/test/agent/history");

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("Instance not ready");
    expect(body.status).toBe("deploying");
  });

  // --- GET /v1/instances/{name}/status ---

  it("GET /status — proxies to worker when ready", async () => {
    await seedInstance({ name: "test/agent", status: "ready" });
    const statusData = { queueDepth: 0, invocationState: "idle" };
    const fetchMock = mockFetchJson(statusData);

    const res = await app.request("/v1/instances/test/agent/status");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.queueDepth).toBe(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://test-agent.up.railway.app/status",
    );
  });

  // --- Instance without workerUrl ---

  it("returns 503 when instance has no workerUrl", async () => {
    await seedInstance({
      name: "test/agent",
      status: "ready",
      workerUrl: null,
    });
    mockFetchJson({});

    const res = await app.request("/v1/instances/test/agent/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain("worker URL");
  });

  // --- Trace headers forwarded ---

  it("forwards trace headers to worker", async () => {
    await seedInstance({ name: "test/agent", status: "ready" });
    const fetchMock = mockFetchJson({ messages: [] });

    await app.request("/v1/instances/test/agent/history");

    expect(fetchMock).toHaveBeenCalledOnce();
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<
      string,
      string
    >;
    expect(headers["sentry-trace"]).toBe("abc123-def456-1");
    expect(headers["baggage"]).toBe("sentry-trace_id=abc123");
  });

  // --- Worker error response proxied through ---

  it("proxies worker error response through", async () => {
    await seedInstance({ name: "test/agent", status: "ready" });
    mockFetchJson({ error: "Internal worker error" }, 500);

    const res = await app.request("/v1/instances/test/agent/history");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBe("Internal worker error");
  });

  // --- Worker unreachable ---

  it("returns 503 when worker fetch throws", async () => {
    await seedInstance({ name: "test/agent", status: "ready" });
    mockFetchError("ECONNREFUSED");

    const res = await app.request("/v1/instances/test/agent/history");

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("Failed to reach worker");
  });

  // --- Metrics emitted ---

  it("emits proxy.count and proxy.duration_ms metrics", async () => {
    await seedInstance({ name: "test/agent", status: "ready" });
    mockFetchJson({ messages: [] });

    await app.request("/v1/instances/test/agent/history");

    // Check that Sentry.startSpan was called with metric spans
    const spanCalls = vi.mocked(Sentry.startSpan).mock.calls;
    const metricNames = spanCalls
      .map((call) => (call[0] as { name: string }).name)
      .filter((name) => name.startsWith("metric."));

    expect(metricNames).toContain("metric.proxy.count");
    expect(metricNames).toContain("metric.proxy.duration_ms");
  });
});
