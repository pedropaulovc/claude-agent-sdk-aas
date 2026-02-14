import { describe, it, expect, vi, beforeEach } from "vitest";

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
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fmt: actual.logger.fmt,
    },
  };
});

const { InstanceQueue, QueueFullError } = await import("./instance-queue.js");

describe("InstanceQueue", () => {
  let queue: InstanceType<typeof InstanceQueue>;

  beforeEach(() => {
    queue = new InstanceQueue();
  });

  it("returns 0 depth for unknown instance", () => {
    expect(queue.depth("nonexistent")).toBe(0);
  });

  it("returns null when dequeuing from empty queue", () => {
    expect(queue.dequeue("empty")).toBeNull();
  });

  it("enqueues and dequeues in FIFO order", () => {
    const results: string[] = [];

    // Enqueue 3 items — promises resolve when dequeued and resolve() called
    const p1 = queue.enqueue("inst", "prompt-1", new AbortController());
    p1.then(() => results.push("prompt-1"));

    const p2 = queue.enqueue("inst", "prompt-2", new AbortController());
    p2.then(() => results.push("prompt-2"));

    const p3 = queue.enqueue("inst", "prompt-3", new AbortController());
    p3.then(() => results.push("prompt-3"));

    expect(queue.depth("inst")).toBe(3);

    // Dequeue first
    const first = queue.dequeue("inst");
    if (!first) throw new Error("expected item");
    expect(first.prompt).toBe("prompt-1");

    // Dequeue second
    const second = queue.dequeue("inst");
    if (!second) throw new Error("expected item");
    expect(second.prompt).toBe("prompt-2");

    // Dequeue third
    const third = queue.dequeue("inst");
    if (!third) throw new Error("expected item");
    expect(third.prompt).toBe("prompt-3");

    // Queue is now empty
    expect(queue.depth("inst")).toBe(0);
    expect(queue.dequeue("inst")).toBeNull();
  });

  it("tracks depth correctly as items are enqueued and dequeued", () => {
    queue.enqueue("inst", "a", new AbortController());
    expect(queue.depth("inst")).toBe(1);

    queue.enqueue("inst", "b", new AbortController());
    expect(queue.depth("inst")).toBe(2);

    queue.dequeue("inst");
    expect(queue.depth("inst")).toBe(1);

    queue.dequeue("inst");
    expect(queue.depth("inst")).toBe(0);
  });

  it("throws QueueFullError when exceeding MAX_QUEUE_DEPTH", () => {
    // Fill the queue to max (25)
    for (let i = 0; i < 25; i++) {
      queue.enqueue("inst", `prompt-${i}`, new AbortController());
    }
    expect(queue.depth("inst")).toBe(25);

    // 26th should throw
    expect(() => queue.enqueue("inst", "overflow", new AbortController())).toThrow(QueueFullError);
    expect(() => queue.enqueue("inst", "overflow", new AbortController())).toThrow(
      'Queue full for instance "inst"',
    );
  });

  it("clear rejects all pending promises", async () => {
    const rejections: string[] = [];

    const p1 = queue.enqueue("inst", "a", new AbortController());
    p1.catch((err: Error) => rejections.push(err.message));

    const p2 = queue.enqueue("inst", "b", new AbortController());
    p2.catch((err: Error) => rejections.push(err.message));

    const cleared = queue.clear("inst");
    expect(cleared).toBe(2);
    expect(queue.depth("inst")).toBe(0);

    // Let microtasks settle
    await new Promise((r) => setTimeout(r, 10));
    expect(rejections).toEqual(["Instance nuked", "Instance nuked"]);
  });

  it("clear returns 0 for unknown instance", () => {
    expect(queue.clear("unknown")).toBe(0);
  });

  it("clearByPrefix clears exact match and prefix matches", () => {
    queue.enqueue("org/a", "p1", new AbortController()).catch(() => {});
    queue.enqueue("org/b", "p2", new AbortController()).catch(() => {});
    queue.enqueue("org/b/nested", "p3", new AbortController()).catch(() => {});
    queue.enqueue("other", "p4", new AbortController()).catch(() => {});

    const cleared = queue.clearByPrefix("org");
    expect(cleared).toBe(3);

    // "other" should remain
    expect(queue.depth("other")).toBe(1);
    expect(queue.depth("org/a")).toBe(0);
    expect(queue.depth("org/b")).toBe(0);
    expect(queue.depth("org/b/nested")).toBe(0);
  });

  it("clearByPrefix does not clear partial name matches", () => {
    queue.enqueue("organ", "p1", new AbortController()).catch(() => {});
    queue.enqueue("org/a", "p2", new AbortController()).catch(() => {});

    const cleared = queue.clearByPrefix("org");
    // Should only clear "org/a" (prefix match), not "organ" (partial name)
    expect(cleared).toBe(1);
    expect(queue.depth("organ")).toBe(1);
  });

  it("maintains separate queues per instance", () => {
    queue.enqueue("inst-a", "a1", new AbortController());
    queue.enqueue("inst-a", "a2", new AbortController());
    queue.enqueue("inst-b", "b1", new AbortController());

    expect(queue.depth("inst-a")).toBe(2);
    expect(queue.depth("inst-b")).toBe(1);

    const fromA = queue.dequeue("inst-a");
    if (!fromA) throw new Error("expected item");
    expect(fromA.prompt).toBe("a1");

    const fromB = queue.dequeue("inst-b");
    if (!fromB) throw new Error("expected item");
    expect(fromB.prompt).toBe("b1");

    expect(queue.depth("inst-a")).toBe(1);
    expect(queue.depth("inst-b")).toBe(0);
  });
});
