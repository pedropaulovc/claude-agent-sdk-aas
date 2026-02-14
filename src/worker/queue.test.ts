import { describe, it, expect, beforeEach, vi } from "vitest";
import { InvocationQueue, QueueFullError } from "./queue.js";
import type { SseEvent, QueueItem, RunFn } from "./queue.js";

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

function makeItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    invocationId: overrides.invocationId ?? crypto.randomUUID(),
    message: overrides.message ?? "test message",
    onEvent: overrides.onEvent ?? vi.fn(),
    signal: overrides.signal ?? new AbortController().signal,
  };
}

function makeRunner(events: SseEvent[] = []): RunFn {
  return async function* () {
    for (const event of events) {
      yield event;
    }
  };
}

function makeDoneEvent(invocationId: string): SseEvent {
  return {
    event: "done",
    data: {
      invocationId,
      turns: 1,
      costUsd: 0.01,
      durationMs: 100,
      stopReason: "end_turn",
      sessionId: "sess-1",
    },
  };
}

// Helper to wait for microtask queue to flush
function tick(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("InvocationQueue", () => {
  let queue: InvocationQueue;

  beforeEach(() => {
    queue = new InvocationQueue(25);
  });

  it("single message runs immediately at position 0", () => {
    const runner = makeRunner([]);
    queue.setRunner(runner);

    const position = queue.enqueue(makeItem());
    expect(position).toBe(0);
  });

  it("concurrent messages are queued with correct positions", () => {
    // Use a runner that never finishes to keep the first item active
    const neverFinish: RunFn = async function* () {
      await new Promise(() => {}); // never resolves
    };
    queue.setRunner(neverFinish);

    const pos0 = queue.enqueue(makeItem({ invocationId: "first" }));
    const pos1 = queue.enqueue(makeItem({ invocationId: "second" }));
    const pos2 = queue.enqueue(makeItem({ invocationId: "third" }));

    expect(pos0).toBe(0);
    expect(pos1).toBe(1);
    expect(pos2).toBe(2);
  });

  it("queue full throws QueueFullError", () => {
    const neverFinish: RunFn = async function* () {
      await new Promise(() => {});
    };
    // maxSize=2: first item is dequeued for processing immediately,
    // so we can enqueue 2 more before the queue is full (items waiting = 2)
    queue = new InvocationQueue(2);
    queue.setRunner(neverFinish);

    queue.enqueue(makeItem()); // processed immediately, queue empty
    queue.enqueue(makeItem()); // queue: 1
    queue.enqueue(makeItem()); // queue: 2 (at max)

    expect(() => queue.enqueue(makeItem())).toThrow(QueueFullError);
  });

  it("depth reflects current queue size", () => {
    const neverFinish: RunFn = async function* () {
      await new Promise(() => {});
    };
    queue.setRunner(neverFinish);

    expect(queue.depth).toBe(0);
    queue.enqueue(makeItem());
    expect(queue.depth).toBe(0); // first item is dequeued immediately for processing
    queue.enqueue(makeItem());
    expect(queue.depth).toBe(1);
    queue.enqueue(makeItem());
    expect(queue.depth).toBe(2);
  });

  it("activeInvocationId reflects currently running invocation", async () => {
    expect(queue.activeInvocationId).toBeNull();

    let resolveRunner: (() => void) | undefined;
    const controlledRunner: RunFn = async function* () {
      await new Promise<void>((resolve) => { resolveRunner = resolve; });
    };
    queue.setRunner(controlledRunner);

    queue.enqueue(makeItem({ invocationId: "active-one" }));
    await tick();
    expect(queue.activeInvocationId).toBe("active-one");

    if (resolveRunner) resolveRunner();
    await tick();
    expect(queue.activeInvocationId).toBeNull();
  });

  it("abort stops active invocation", async () => {
    let capturedSignal: AbortSignal | null = null;
    const controlledRunner: RunFn = async function* (_msg, _id, signal) {
      capturedSignal = signal;
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    };
    queue.setRunner(controlledRunner);

    queue.enqueue(makeItem({ invocationId: "abort-me" }));
    await tick();

    const result = queue.abort();
    expect(result.aborted).toBe(true);
    expect(result.invocationId).toBe("abort-me");
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("abort returns false when nothing active", () => {
    queue.setRunner(makeRunner([]));
    const result = queue.abort();
    expect(result.aborted).toBe(false);
    expect(result.invocationId).toBeNull();
  });

  it("clear empties pending queue items", () => {
    const neverFinish: RunFn = async function* () {
      await new Promise(() => {});
    };
    queue.setRunner(neverFinish);

    queue.enqueue(makeItem());
    queue.enqueue(makeItem());
    queue.enqueue(makeItem());
    expect(queue.depth).toBe(2);

    queue.clear();
    expect(queue.depth).toBe(0);
  });

  it("emits events to onEvent callback", async () => {
    const events: SseEvent[] = [];
    const invocationId = "events-test";

    const runner: RunFn = async function* (_msg, id) {
      yield {
        event: "init" as const,
        data: { invocationId: id, instanceName: "test", model: "haiku", turn: 0 },
      };
      yield makeDoneEvent(id);
    };
    queue.setRunner(runner);

    queue.enqueue(makeItem({
      invocationId,
      onEvent: (event) => events.push(event),
    }));
    await tick(50);

    expect(events.length).toBe(2);
    expect(events[0].event).toBe("init");
    expect(events[1].event).toBe("done");
  });

  it("after completion, next item starts automatically", async () => {
    const processed: string[] = [];

    const runner: RunFn = async function* (_msg, id) {
      processed.push(id);
      yield makeDoneEvent(id);
    };
    queue.setRunner(runner);

    queue.enqueue(makeItem({ invocationId: "first" }));
    queue.enqueue(makeItem({ invocationId: "second" }));
    await tick(50);

    expect(processed).toEqual(["first", "second"]);
  });

  it("runner error emits error event to callback", async () => {
    const events: SseEvent[] = [];

    const failingRunner: RunFn = async function* () {
      throw new Error("runner exploded");
    };
    queue.setRunner(failingRunner);

    queue.enqueue(makeItem({
      invocationId: "fail-test",
      onEvent: (event) => events.push(event),
    }));
    await tick(50);

    expect(events.length).toBe(1);
    expect(events[0].event).toBe("error");
    if (events[0].event === "error") {
      expect(events[0].data.error).toBe("runner exploded");
    }
  });

  it("emits error when no runner function is set", async () => {
    const events: SseEvent[] = [];

    queue.enqueue(makeItem({
      invocationId: "no-runner",
      onEvent: (event) => events.push(event),
    }));
    await tick(50);

    expect(events.length).toBe(1);
    expect(events[0].event).toBe("error");
    if (events[0].event === "error") {
      expect(events[0].data.code).toBe("runner_not_configured");
    }
  });

  it("item signal abort propagates to runner", async () => {
    let capturedSignal: AbortSignal | null = null;
    const controlledRunner: RunFn = async function* (_msg, _id, signal) {
      capturedSignal = signal;
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    };
    queue.setRunner(controlledRunner);

    const itemAbortController = new AbortController();
    queue.enqueue(makeItem({
      invocationId: "signal-test",
      signal: itemAbortController.signal,
    }));
    await tick();

    expect(capturedSignal?.aborted).toBe(false);
    itemAbortController.abort();
    await tick();
    expect(capturedSignal?.aborted).toBe(true);
  });
});
