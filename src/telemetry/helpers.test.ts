import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Sentry from "@sentry/node";
import {
  withSpan,
  chunkedLog,
  countMetric,
  distributionMetric,
  logInfo,
  logWarn,
  logError,
  subscribeToLogs,
} from "./helpers.js";
import type { LogLine } from "./helpers.js";

const mockSetAttribute = vi.fn();

vi.mock("@sentry/node", async () => {
  const actual = await vi.importActual<typeof Sentry>("@sentry/node");
  return {
    ...actual,
    startSpan: vi.fn((_opts, cb) =>
      cb({
        setAttribute: mockSetAttribute,
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

describe("telemetry helpers", () => {
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

  it("withSpan returns the function result", async () => {
    const result = await withSpan("test", "test.op", async () => 42);
    expect(result).toBe(42);
  });

  it("withSpan calls Sentry.startSpan with name and op", async () => {
    await withSpan("my-span", "my.op", async () => "ok");
    expect(Sentry.startSpan).toHaveBeenCalledWith(
      { name: "my-span", op: "my.op" },
      expect.any(Function),
    );
  });

  it("logInfo calls Sentry.logger.info with message", () => {
    logInfo("hello world");
    expect(Sentry.logger.info).toHaveBeenCalledWith("hello world", undefined);
  });

  it("logInfo passes attributes as second argument", () => {
    logInfo("event", { userId: 42 });
    expect(Sentry.logger.info).toHaveBeenCalledWith("event", { userId: 42 });
  });

  it("logWarn calls Sentry.logger.warn", () => {
    logWarn("warning", { code: "W001" });
    expect(Sentry.logger.warn).toHaveBeenCalledWith("warning", {
      code: "W001",
    });
  });

  it("logError calls Sentry.logger.error", () => {
    logError("failure", { stack: "trace" });
    expect(Sentry.logger.error).toHaveBeenCalledWith("failure", {
      stack: "trace",
    });
  });

  it("chunkedLog logs short text as single entry", () => {
    chunkedLog("test-prefix", "short text");
    expect(Sentry.logger.info).toHaveBeenCalledTimes(1);
  });

  it("chunkedLog splits long text into multiple chunks", () => {
    const longText = "x".repeat(12000);
    chunkedLog("pfx", longText, 5000);
    expect(Sentry.logger.info).toHaveBeenCalledTimes(3);
  });

  it("chunkedLog with exact boundary produces correct chunk count", () => {
    const text = "y".repeat(10000);
    chunkedLog("pfx", text, 5000);
    expect(Sentry.logger.info).toHaveBeenCalledTimes(2);
  });

  it("countMetric creates span with metric attributes", () => {
    countMetric("test.metric", 5, { env: "prod" });
    expect(Sentry.startSpan).toHaveBeenCalledWith(
      { name: "metric.test.metric", op: "metric" },
      expect.any(Function),
    );
    expect(mockSetAttribute).toHaveBeenCalledWith("metric.name", "test.metric");
    expect(mockSetAttribute).toHaveBeenCalledWith("metric.value", 5);
    expect(mockSetAttribute).toHaveBeenCalledWith("metric.tag.env", "prod");
  });

  it("distributionMetric creates span with unit attribute", () => {
    distributionMetric("latency", 150, "ms", { route: "/api" });
    expect(Sentry.startSpan).toHaveBeenCalledWith(
      { name: "metric.latency", op: "metric" },
      expect.any(Function),
    );
    expect(mockSetAttribute).toHaveBeenCalledWith("metric.name", "latency");
    expect(mockSetAttribute).toHaveBeenCalledWith("metric.value", 150);
    expect(mockSetAttribute).toHaveBeenCalledWith("metric.unit", "ms");
    expect(mockSetAttribute).toHaveBeenCalledWith("metric.tag.route", "/api");
  });

  it("subscribeToLogs receives log lines from logInfo", () => {
    const received: LogLine[] = [];
    const unsub = subscribeToLogs((line) => received.push(line));
    unsubscribes.push(unsub);

    logInfo("broadcast test", { key: "val" });

    expect(received).toHaveLength(1);
    expect(received[0].level).toBe("info");
    expect(received[0].message).toBe("broadcast test");
    expect(received[0].attributes).toEqual({ key: "val" });
    expect(typeof received[0].timestamp).toBe("string");
  });

  it("subscribeToLogs receives log lines from logWarn", () => {
    const received: LogLine[] = [];
    const unsub = subscribeToLogs((line) => received.push(line));
    unsubscribes.push(unsub);

    logWarn("warn broadcast");

    expect(received).toHaveLength(1);
    expect(received[0].level).toBe("warn");
    expect(received[0].message).toBe("warn broadcast");
  });

  it("subscribeToLogs receives log lines from logError", () => {
    const received: LogLine[] = [];
    const unsub = subscribeToLogs((line) => received.push(line));
    unsubscribes.push(unsub);

    logError("error broadcast", { stack: "trace" });

    expect(received).toHaveLength(1);
    expect(received[0].level).toBe("error");
    expect(received[0].message).toBe("error broadcast");
    expect(received[0].attributes).toEqual({ stack: "trace" });
  });

  it("unsubscribe stops receiving log lines", () => {
    const received: LogLine[] = [];
    const unsub = subscribeToLogs((line) => received.push(line));

    logInfo("before unsub");
    expect(received).toHaveLength(1);

    unsub();

    logInfo("after unsub");
    expect(received).toHaveLength(1);
  });

  it("broadcast failures do not break logging", () => {
    const badSubscriber = vi.fn(() => {
      throw new Error("subscriber exploded");
    });
    const goodReceived: LogLine[] = [];
    const unsub1 = subscribeToLogs(badSubscriber);
    const unsub2 = subscribeToLogs((line) => goodReceived.push(line));
    unsubscribes.push(unsub1, unsub2);

    // Should not throw
    logInfo("resilient message");

    // Bad subscriber was called but threw
    expect(badSubscriber).toHaveBeenCalledOnce();
    // Good subscriber still received the line
    expect(goodReceived).toHaveLength(1);
    expect(goodReceived[0].message).toBe("resilient message");
    // Sentry logger was still called
    expect(Sentry.logger.info).toHaveBeenCalledWith("resilient message", undefined);
  });
});
