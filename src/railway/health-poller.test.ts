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

import type { InstanceRecord, McpServerConfig } from "../shared/types.js";
import type { InstanceStore } from "../registry/store.js";
import { HealthPoller } from "./health-poller.js";

function makeRecord(overrides?: Partial<InstanceRecord>): InstanceRecord {
  return {
    name: "my-agent",
    systemPrompt: "You are helpful.",
    mcpServers: [] as McpServerConfig[],
    model: "claude-haiku-4-5-20251001",
    maxTurns: 50,
    maxBudgetUsd: 1.0,
    status: "deploying",
    railwayServiceId: "svc-123",
    workerUrl: "https://my-agent.up.railway.app",
    workerNumber: 1,
    provisionError: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeStore(record: InstanceRecord | null): InstanceStore {
  return {
    get: vi.fn(() => record),
    provision: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    clear: vi.fn(),
    nukeByPrefix: vi.fn(),
    size: 0,
  } as unknown as InstanceStore;
}

function mockFetchOk(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      status: 200,
      json: () =>
        Promise.resolve({ status: "ok", instanceName: "my-agent" }),
    }),
  );
}

function mockFetchFail(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new Error("connection refused")),
  );
}

describe("HealthPoller", () => {
  let poller: HealthPoller;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    poller = new HealthPoller();
  });

  afterEach(() => {
    poller.stopAll();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // --- Deploy mode: success ---

  it("transitions status to ready on first successful deploy health check", async () => {
    mockFetchOk();
    const record = makeRecord({ status: "deploying" });
    const store = makeStore(record);

    poller.startDeployPolling("my-agent", "https://my-agent.up.railway.app", store);

    // Advance past the first 5s interval
    await vi.advanceTimersByTimeAsync(5_000);

    expect(record.status).toBe("ready");
    // Should have switched to ongoing polling
    expect(poller.isPolling("my-agent")).toBe(true);
  });

  // --- Deploy mode: timeout ---

  it("transitions status to error after 120s deploy timeout", async () => {
    mockFetchFail();
    const record = makeRecord({ status: "deploying" });
    const store = makeStore(record);

    poller.startDeployPolling("my-agent", "https://my-agent.up.railway.app", store);

    // Advance past 120s timeout
    await vi.advanceTimersByTimeAsync(120_000);

    expect(record.status).toBe("error");
    expect(record.provisionError).toBe(
      "Deploy timeout: worker did not become healthy within 120s",
    );
    expect(poller.isPolling("my-agent")).toBe(false);
  });

  // --- Ongoing mode: 3 consecutive failures ---

  it("transitions status to unreachable after 3 consecutive ongoing failures", async () => {
    mockFetchFail();
    const record = makeRecord({ status: "ready" });
    const store = makeStore(record);

    poller.startOngoingPolling("my-agent", "https://my-agent.up.railway.app", store);

    // 3 intervals at 30s each = 90s
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(record.status).toBe("unreachable");
  });

  // --- Ongoing mode: auto-recovery ---

  it("auto-recovers from unreachable back to ready when health returns", async () => {
    mockFetchFail();
    const record = makeRecord({ status: "ready" });
    const store = makeStore(record);

    poller.startOngoingPolling("my-agent", "https://my-agent.up.railway.app", store);

    // 3 failures to become unreachable
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(record.status).toBe("unreachable");

    // Now health returns
    mockFetchOk();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(record.status).toBe("ready");
  });

  // --- stopPolling ---

  it("stopPolling removes the timer", () => {
    mockFetchOk();
    const record = makeRecord();
    const store = makeStore(record);

    poller.startDeployPolling("my-agent", "https://my-agent.up.railway.app", store);
    expect(poller.isPolling("my-agent")).toBe(true);

    poller.stopPolling("my-agent");
    expect(poller.isPolling("my-agent")).toBe(false);
  });

  // --- Deleted instance ---

  it("stops polling when instance is deleted from store", async () => {
    mockFetchOk();
    const store = makeStore(null); // store.get returns null (deleted)

    poller.startOngoingPolling("my-agent", "https://my-agent.up.railway.app", store);
    expect(poller.isPolling("my-agent")).toBe(true);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(poller.isPolling("my-agent")).toBe(false);
  });

  // --- Fetch timeout ---

  it("uses AbortSignal.timeout for 5000ms fetch timeout", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const record = makeRecord({ status: "deploying" });
    const store = makeStore(record);

    poller.startDeployPolling("my-agent", "https://my-agent.up.railway.app", store);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://my-agent.up.railway.app/health",
      { signal: expect.any(AbortSignal) },
    );
  });

  // --- Deploy polling stops on delete mid-deploy ---

  it("stops deploy polling when instance is deleted from store during deploy", async () => {
    mockFetchFail();
    const store = makeStore(null); // instance already deleted

    poller.startDeployPolling("my-agent", "https://my-agent.up.railway.app", store);
    expect(poller.isPolling("my-agent")).toBe(true);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(poller.isPolling("my-agent")).toBe(false);
  });

  // --- Non-200 counts as failure ---

  it("treats non-200 response as failure in deploy mode", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ status: 503 }),
    );
    const record = makeRecord({ status: "deploying" });
    const store = makeStore(record);

    poller.startDeployPolling("my-agent", "https://my-agent.up.railway.app", store);
    await vi.advanceTimersByTimeAsync(5_000);

    // Status should still be deploying (not ready)
    expect(record.status).toBe("deploying");
  });
});
