import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InvocationEvent } from "../sdk/events.js";

// Mock Sentry (must be before any imports that use it)
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
    getActiveSpan: vi.fn(() => ({
      spanContext: () => ({ traceId: "test-trace" }),
    })),
    continueTrace: vi.fn((_traceData, cb) => cb()),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fmt: actual.logger.fmt,
    },
  };
});

// Mock the SDK executor
const mockExecuteInvocation = vi.fn();
vi.mock("../sdk/executor.js", () => ({
  executeInvocation: mockExecuteInvocation,
}));

// Import after mocks
const { app } = await import("../server.js");
const { store } = await import("../registry/store.js");
const { instanceQueue } = await import("../queue/instance-queue.js");

// Helper: create mock async generator from events
async function* mockGenerator(events: InvocationEvent[]): AsyncGenerator<InvocationEvent> {
  for (const event of events) {
    yield event;
  }
}

// Helper: provision a test instance directly in the store
async function provisionTestInstance(name: string, statusOverride?: "ready" | "running" | "error") {
  await store.provision({
    name,
    systemPrompt: "You are a test agent.",
    mcpServers: [],
    model: "claude-haiku-4-5-20251001",
    maxTurns: 50,
    maxBudgetUsd: 1.0,
  });
  if (statusOverride) {
    const instance = store.get(name);
    if (instance) instance.status = statusOverride;
  }
}

// Helper: parse SSE text into structured events
function parseSSE(text: string): Array<{ event: string; data: unknown }> {
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      const eventLine = lines.find((l) => l.startsWith("event: "));
      const dataLine = lines.find((l) => l.startsWith("data: "));
      return {
        event: eventLine?.replace("event: ", "") ?? "",
        data: dataLine ? JSON.parse(dataLine.replace("data: ", "")) : null,
      };
    });
}

describe("POST /v1/instances/*/invoke", () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
    // Clear any leftover queue state
    instanceQueue.clearByPrefix("");
  });

  it("returns 200 with SSE content-type for valid prompt", async () => {
    await provisionTestInstance("test/agent");

    const events: InvocationEvent[] = [
      { type: "init", invocationId: "inv-1", instanceName: "test/agent", model: "claude-haiku-4-5-20251001", turn: 0 },
      { type: "assistant_text", text: "Hello!", turn: 1 },
      { type: "done", invocationId: "inv-1", turns: 1, costUsd: 0.01, durationMs: 100, stopReason: "end_turn", sessionId: "sess-1" },
    ];
    mockExecuteInvocation.mockReturnValue(mockGenerator(events));

    const res = await app.request("/v1/instances/test/agent/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Hello" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("streams correct SSE event format with event and data lines", async () => {
    await provisionTestInstance("test/agent");

    const events: InvocationEvent[] = [
      { type: "init", invocationId: "inv-1", instanceName: "test/agent", model: "claude-haiku-4-5-20251001", turn: 0 },
      { type: "assistant_text", text: "Hi there!", turn: 1 },
      { type: "turn_complete", turn: 1, stopReason: "end_turn" },
      { type: "done", invocationId: "inv-1", turns: 1, costUsd: 0.02, durationMs: 200, stopReason: "end_turn", sessionId: "sess-1" },
    ];
    mockExecuteInvocation.mockReturnValue(mockGenerator(events));

    const res = await app.request("/v1/instances/test/agent/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Hi" }),
    });

    const text = await res.text();
    const parsed = parseSSE(text);

    expect(parsed).toHaveLength(4);
    expect(parsed[0].event).toBe("init");
    expect(parsed[1].event).toBe("assistant_text");
    expect(parsed[2].event).toBe("turn_complete");
    expect(parsed[3].event).toBe("done");

    // Verify data payloads
    const initData = parsed[0].data as Record<string, unknown>;
    expect(initData.invocationId).toBe("inv-1");
    expect(initData.instanceName).toBe("test/agent");

    const textData = parsed[1].data as Record<string, unknown>;
    expect(textData.text).toBe("Hi there!");
    expect(textData.turn).toBe(1);

    const doneData = parsed[3].data as Record<string, unknown>;
    expect(doneData.costUsd).toBe(0.02);
    expect(doneData.sessionId).toBe("sess-1");
  });

  it("verifies SSE wire format has correct newline separators", async () => {
    await provisionTestInstance("test/agent");

    const events: InvocationEvent[] = [
      { type: "init", invocationId: "inv-1", instanceName: "test/agent", model: "claude-haiku-4-5-20251001", turn: 0 },
    ];
    mockExecuteInvocation.mockReturnValue(mockGenerator(events));

    const res = await app.request("/v1/instances/test/agent/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Test" }),
    });

    const text = await res.text();
    // Each SSE event block should be: "event: {type}\ndata: {json}\n\n"
    expect(text).toContain("event: init\n");
    expect(text).toContain("data: ");
    // Blocks are separated by double newlines
    expect(text.endsWith("\n\n")).toBe(true);
  });

  it("returns 400 for missing prompt", async () => {
    await provisionTestInstance("test/agent");

    const res = await app.request("/v1/instances/test/agent/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("returns 400 for empty prompt", async () => {
    await provisionTestInstance("test/agent");

    const res = await app.request("/v1/instances/test/agent/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("returns 404 for non-existing instance", async () => {
    const res = await app.request("/v1/instances/nonexistent/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Hello" }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("not found");
  });

  it("returns 503 for instance in error state", async () => {
    await provisionTestInstance("broken/agent", "error");

    const res = await app.request("/v1/instances/broken/agent/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Hello" }),
    });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain("error state");
  });

  it("streams error event when executor throws", async () => {
    await provisionTestInstance("test/agent");

    mockExecuteInvocation.mockReturnValue((async function* () {
      throw new Error("SDK connection failed");
    })());

    const res = await app.request("/v1/instances/test/agent/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Hello" }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    const parsed = parseSSE(text);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].event).toBe("error");
    const errorData = parsed[0].data as Record<string, unknown>;
    expect(errorData.error).toBe("SDK connection failed");
    expect(errorData.code).toBe("stream_error");
  });

  it("works with nested instance names containing slashes", async () => {
    await provisionTestInstance("org/team/agent");

    const events: InvocationEvent[] = [
      { type: "init", invocationId: "inv-1", instanceName: "org/team/agent", model: "claude-haiku-4-5-20251001", turn: 0 },
      { type: "done", invocationId: "inv-1", turns: 0, costUsd: 0.001, durationMs: 50, stopReason: "end_turn", sessionId: "sess-1" },
    ];
    mockExecuteInvocation.mockReturnValue(mockGenerator(events));

    const res = await app.request("/v1/instances/org/team/agent/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Go" }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    const parsed = parseSSE(text);
    expect(parsed[0].event).toBe("init");
  });

  it("passes the correct instance and prompt to executeInvocation", async () => {
    await provisionTestInstance("test/agent");

    const events: InvocationEvent[] = [
      { type: "init", invocationId: "inv-1", instanceName: "test/agent", model: "claude-haiku-4-5-20251001", turn: 0 },
      { type: "done", invocationId: "inv-1", turns: 0, costUsd: 0.001, durationMs: 50, stopReason: "end_turn", sessionId: "sess-1" },
    ];
    mockExecuteInvocation.mockReturnValue(mockGenerator(events));

    await app.request("/v1/instances/test/agent/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Do the thing" }),
    });

    expect(mockExecuteInvocation).toHaveBeenCalledOnce();
    const [instance, prompt, abortCtrl] = mockExecuteInvocation.mock.calls[0];
    expect(instance.name).toBe("test/agent");
    expect(prompt).toBe("Do the thing");
    expect(abortCtrl).toBeInstanceOf(AbortController);
  });

  it("returns 429 with queue_full code when queue is full", async () => {
    await provisionTestInstance("busy/agent", "running");

    // Fill the queue to max (25)
    for (let i = 0; i < 25; i++) {
      instanceQueue.enqueue("busy/agent", `prompt-${i}`, new AbortController());
    }

    const res = await app.request("/v1/instances/busy/agent/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "overflow" }),
    });

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toContain("Queue full");
    expect(body.code).toBe("queue_full");
  });

  it("sends queued event when instance is running then proceeds after resolve", async () => {
    await provisionTestInstance("q/agent", "running");

    const events: InvocationEvent[] = [
      { type: "init", invocationId: "inv-q", instanceName: "q/agent", model: "claude-haiku-4-5-20251001", turn: 0 },
      { type: "done", invocationId: "inv-q", turns: 0, costUsd: 0.001, durationMs: 50, stopReason: "end_turn", sessionId: "sess-q" },
    ];
    mockExecuteInvocation.mockReturnValue(mockGenerator(events));

    // Start the invoke request (instance is running, so it will be queued)
    const responsePromise = app.request("/v1/instances/q/agent/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Queued prompt" }),
    });

    // Give the stream time to send the queued event
    await new Promise((r) => setTimeout(r, 50));

    // Now dequeue and resolve the queued invocation to unblock it
    const queued = instanceQueue.dequeue("q/agent");
    if (!queued) throw new Error("expected queued item");
    queued.resolve();

    const res = await responsePromise;
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    const text = await res.text();
    const parsed = parseSSE(text);

    // First event should be "queued"
    expect(parsed[0].event).toBe("queued");
    const queuedData = parsed[0].data as Record<string, unknown>;
    expect(queuedData.position).toBeDefined();

    // After unblocking, normal events should follow
    expect(parsed[1].event).toBe("init");
    expect(parsed[parsed.length - 1].event).toBe("done");
  });

  it("does not send queued event when instance is ready", async () => {
    await provisionTestInstance("ready/agent");

    const events: InvocationEvent[] = [
      { type: "init", invocationId: "inv-1", instanceName: "ready/agent", model: "claude-haiku-4-5-20251001", turn: 0 },
      { type: "done", invocationId: "inv-1", turns: 0, costUsd: 0.001, durationMs: 50, stopReason: "end_turn", sessionId: "sess-1" },
    ];
    mockExecuteInvocation.mockReturnValue(mockGenerator(events));

    const res = await app.request("/v1/instances/ready/agent/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Go" }),
    });

    const text = await res.text();
    const parsed = parseSSE(text);

    // No queued event — starts directly with init
    expect(parsed[0].event).toBe("init");
    expect(parsed.find((e) => e.event === "queued")).toBeUndefined();
  });
});
