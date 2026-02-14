import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock Sentry (must be before any imports that use it)
vi.mock("@sentry/node", async () => {
  const actual = await vi.importActual<typeof import("@sentry/node")>("@sentry/node");
  return {
    ...actual,
    startSpan: vi.fn((_opts, cb) =>
      cb({
        setAttribute: vi.fn(),
        end: vi.fn(),
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

// Import after mocks
const { app } = await import("../server.js");
const { logInfo, logWarn, logError, subscribeToLogs } = await import(
  "../telemetry/helpers.js"
);

/** Read chunks from an SSE ReadableStream until we have enough data or timeout. */
async function readStreamChunks(
  body: ReadableStream<Uint8Array>,
  opts: { waitMs?: number; afterConnect?: () => void } = {},
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let result = "";
  const waitMs = opts.waitMs ?? 100;

  // Read chunks in a loop with a timeout
  const deadline = Date.now() + waitMs;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: true }), Math.max(1, deadline - Date.now())),
        ),
      ]);

      if (value) {
        result += decoder.decode(value, { stream: true });
      }

      // Call afterConnect callback once we have the initial connected comment
      if (opts.afterConnect && result.includes(": connected\n\n")) {
        opts.afterConnect();
        opts.afterConnect = undefined; // only call once
      }

      if (done) break;
    }
  } finally {
    reader.cancel().catch(() => { /* ignore */ });
  }

  return result;
}

describe("GET /v1/logs", () => {
  let unsubscribes: Array<() => void> = [];

  beforeEach(() => {
    vi.clearAllMocks();
    unsubscribes = [];
  });

  afterEach(() => {
    for (const unsub of unsubscribes) {
      unsub();
    }
  });

  it("returns text/event-stream content type", async () => {
    const res = await app.request("/v1/logs");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("returns : connected initial comment", async () => {
    const res = await app.request("/v1/logs");
    if (!res.body) throw new Error("expected body");

    const text = await readStreamChunks(res.body, { waitMs: 200 });
    expect(text).toContain(": connected\n\n");
  });

  it("streams log lines when logInfo is called", () => {
    const received: unknown[] = [];
    const unsub = subscribeToLogs((line) => {
      received.push(line);
    });
    unsubscribes.push(unsub);

    logInfo("test message", { instanceName: "demo/agent" });

    expect(received).toHaveLength(1);
    const line = received[0] as Record<string, unknown>;
    expect(line.level).toBe("info");
    expect(line.message).toBe("test message");
    expect(typeof line.timestamp).toBe("string");
  });

  it("streams log lines when logWarn is called", () => {
    const received: unknown[] = [];
    const unsub = subscribeToLogs((line) => {
      received.push(line);
    });
    unsubscribes.push(unsub);

    logWarn("warning message");

    expect(received).toHaveLength(1);
    const line = received[0] as Record<string, unknown>;
    expect(line.level).toBe("warn");
    expect(line.message).toBe("warning message");
  });

  it("streams log lines when logError is called", () => {
    const received: unknown[] = [];
    const unsub = subscribeToLogs((line) => {
      received.push(line);
    });
    unsubscribes.push(unsub);

    logError("error message", { code: "E001" });

    expect(received).toHaveLength(1);
    const line = received[0] as Record<string, unknown>;
    expect(line.level).toBe("error");
    expect(line.message).toBe("error message");
    expect((line.attributes as Record<string, unknown>).code).toBe("E001");
  });

  it("filters by prefix query parameter on message", async () => {
    const res = await app.request("/v1/logs?prefix=provision");
    if (!res.body) throw new Error("expected body");

    const text = await readStreamChunks(res.body, {
      waitMs: 200,
      afterConnect() {
        logInfo("provision instance created");
        logInfo("invoke started");
        logInfo("provision complete");
      },
    });

    // Should contain the provision lines
    expect(text).toContain("provision instance created");
    expect(text).toContain("provision complete");
    // Should NOT contain the invoke line
    expect(text).not.toContain("invoke started");
  });

  it("filters by prefix on instanceName attribute", async () => {
    const res = await app.request("/v1/logs?prefix=myapp");
    if (!res.body) throw new Error("expected body");

    const text = await readStreamChunks(res.body, {
      waitMs: 200,
      afterConnect() {
        logInfo("something happened", { instanceName: "myapp/agent" });
        logInfo("other thing", { instanceName: "other/agent" });
      },
    });

    expect(text).toContain("something happened");
    expect(text).not.toContain("other thing");
  });
});
