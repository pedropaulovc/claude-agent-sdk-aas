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

import type { RailwayClient } from "./client.js";
import { WorkerPool } from "./pool.js";
import type { PoolConfig } from "./pool.js";

let workerServiceCounter = 0;

function makeRailwayClient(overrides?: Partial<RailwayClient>): RailwayClient {
  return {
    serviceCreate: vi.fn().mockImplementation(() => {
      workerServiceCounter++;
      return Promise.resolve({ serviceId: `svc-${workerServiceCounter}` });
    }),
    serviceDelete: vi.fn().mockResolvedValue(undefined),
    variableCollectionUpsert: vi.fn().mockResolvedValue(undefined),
    serviceDomainCreate: vi.fn().mockImplementation((serviceId: string) =>
      Promise.resolve({ domain: `${serviceId}.up.railway.app` }),
    ),
    serviceList: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as RailwayClient;
}

function makePoolConfig(overrides?: Partial<PoolConfig>): PoolConfig {
  return {
    railwayClient: makeRailwayClient(),
    ghcrImage: "ghcr.io/test/aas-worker:latest",
    minDormant: 10,
    monitorIntervalMs: 60_000,
    secrets: {
      ANTHROPIC_API_KEY: "sk-ant-test",
      SENTRY_DSN: "https://sentry.test/123",
    },
    ...overrides,
  };
}

function mockHealthyFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ status: 200 }),
  );
}

function mockUnhealthyFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new Error("connection refused")),
  );
}

describe("WorkerPool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workerServiceCounter = 0;
    mockHealthyFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // --- ensurePoolSize ---

  it("ensurePoolSize creates the right number of workers", async () => {
    const config = makePoolConfig();
    const pool = new WorkerPool(config);

    await pool.ensurePoolSize(3);

    expect(pool.getDormantCount()).toBe(3);
    expect(pool.listWorkers()).toHaveLength(3);
  });

  it("ensurePoolSize calls serviceCreate with image source", async () => {
    const client = makeRailwayClient();
    const config = makePoolConfig({ railwayClient: client });
    const pool = new WorkerPool(config);

    await pool.ensurePoolSize(1);

    expect(client.serviceCreate).toHaveBeenCalledWith(
      "aas-w-1",
      { image: "ghcr.io/test/aas-worker:latest" },
    );
  });

  it("ensurePoolSize sets env vars (only secrets, no agent config)", async () => {
    const client = makeRailwayClient();
    const config = makePoolConfig({ railwayClient: client });
    const pool = new WorkerPool(config);

    await pool.ensurePoolSize(1);

    expect(client.variableCollectionUpsert).toHaveBeenCalledWith(
      expect.any(String),
      {
        ANTHROPIC_API_KEY: "sk-ant-test",
        SENTRY_DSN: "https://sentry.test/123",
      },
    );
  });

  it("ensurePoolSize does not create workers when already at target", async () => {
    const client = makeRailwayClient();
    const config = makePoolConfig({ railwayClient: client });
    const pool = new WorkerPool(config);

    await pool.ensurePoolSize(2);
    vi.mocked(client.serviceCreate).mockClear();

    await pool.ensurePoolSize(2);

    expect(client.serviceCreate).not.toHaveBeenCalled();
  });

  it("ensurePoolSize handles individual worker creation failure gracefully", async () => {
    const client = makeRailwayClient({
      serviceCreate: vi.fn()
        .mockResolvedValueOnce({ serviceId: "svc-ok" })
        .mockRejectedValueOnce(new Error("creation failed"))
        .mockResolvedValueOnce({ serviceId: "svc-ok-2" }),
    });
    const config = makePoolConfig({ railwayClient: client });
    const pool = new WorkerPool(config);

    await pool.ensurePoolSize(3);

    const workers = pool.listWorkers();
    expect(workers).toHaveLength(3);

    const dormant = workers.filter((w) => w.status === "dormant");
    const errored = workers.filter((w) => w.status === "error");
    expect(dormant).toHaveLength(2);
    expect(errored).toHaveLength(1);
  });

  it("ensurePoolSize creates workers with monotonic worker numbers", async () => {
    const config = makePoolConfig();
    const pool = new WorkerPool(config);

    await pool.ensurePoolSize(3);

    const workers = pool.listWorkers();
    const numbers = workers.map((w) => w.workerNumber).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3]);
  });

  // --- claimWorker ---

  it("claimWorker returns a dormant worker and marks it active", async () => {
    const config = makePoolConfig();
    const pool = new WorkerPool(config);
    await pool.ensurePoolSize(2);

    const claimed = pool.claimWorker();

    if (!claimed) {
      expect.fail("expected a claimed worker");
      return;
    }
    expect(claimed.status).toBe("active");
    expect(pool.getDormantCount()).toBe(1);
    expect(pool.getActiveCount()).toBe(1);
  });

  it("claimWorker returns null when no dormant workers", async () => {
    const config = makePoolConfig();
    const pool = new WorkerPool(config);

    const claimed = pool.claimWorker();

    expect(claimed).toBeNull();
  });

  it("claimWorker does not return error workers", async () => {
    const client = makeRailwayClient({
      serviceCreate: vi.fn().mockRejectedValue(new Error("fail")),
    });
    const config = makePoolConfig({ railwayClient: client });
    const pool = new WorkerPool(config);
    await pool.ensurePoolSize(2);

    const claimed = pool.claimWorker();

    expect(claimed).toBeNull();
  });

  // --- assignWorker ---

  it("assignWorker sets assignedAgent", async () => {
    const config = makePoolConfig();
    const pool = new WorkerPool(config);
    await pool.ensurePoolSize(1);

    const claimed = pool.claimWorker();
    if (!claimed) {
      expect.fail("expected a claimed worker");
      return;
    }
    pool.assignWorker(claimed.workerNumber, "my-agent");

    const found = pool.getWorkerByAgent("my-agent");
    if (!found) {
      expect.fail("expected to find worker by agent");
      return;
    }
    expect(found.assignedAgent).toBe("my-agent");
    expect(found.workerNumber).toBe(claimed.workerNumber);
  });

  it("assignWorker on non-existent worker is a no-op", () => {
    const config = makePoolConfig();
    const pool = new WorkerPool(config);

    // Should not throw
    pool.assignWorker(999, "my-agent");

    expect(pool.getWorkerByAgent("my-agent")).toBeUndefined();
  });

  // --- releaseWorker ---

  it("releaseWorker calls serviceDelete and removes from pool", async () => {
    const client = makeRailwayClient();
    const config = makePoolConfig({ railwayClient: client });
    const pool = new WorkerPool(config);
    await pool.ensurePoolSize(1);

    const worker = pool.listWorkers()[0];
    await pool.releaseWorker(worker.workerNumber);

    expect(client.serviceDelete).toHaveBeenCalledWith(worker.serviceId);
    expect(pool.listWorkers()).toHaveLength(0);
  });

  it("releaseWorker on non-existent worker is a no-op", async () => {
    const client = makeRailwayClient();
    const config = makePoolConfig({ railwayClient: client });
    const pool = new WorkerPool(config);

    await pool.releaseWorker(999);

    expect(client.serviceDelete).not.toHaveBeenCalled();
  });

  // --- getDormantCount / getActiveCount ---

  it("getDormantCount and getActiveCount return correct values", async () => {
    const config = makePoolConfig();
    const pool = new WorkerPool(config);
    await pool.ensurePoolSize(3);

    expect(pool.getDormantCount()).toBe(3);
    expect(pool.getActiveCount()).toBe(0);

    pool.claimWorker();

    expect(pool.getDormantCount()).toBe(2);
    expect(pool.getActiveCount()).toBe(1);

    pool.claimWorker();

    expect(pool.getDormantCount()).toBe(1);
    expect(pool.getActiveCount()).toBe(2);
  });

  // --- getWorkerByAgent ---

  it("getWorkerByAgent finds by agent name", async () => {
    const config = makePoolConfig();
    const pool = new WorkerPool(config);
    await pool.ensurePoolSize(2);

    const claimed = pool.claimWorker();
    if (!claimed) {
      expect.fail("expected a claimed worker");
      return;
    }
    pool.assignWorker(claimed.workerNumber, "agent-x");

    const found = pool.getWorkerByAgent("agent-x");
    if (!found) {
      expect.fail("expected to find worker by agent");
      return;
    }
    expect(found.workerNumber).toBe(claimed.workerNumber);
  });

  it("getWorkerByAgent returns undefined for unknown agent", async () => {
    const config = makePoolConfig();
    const pool = new WorkerPool(config);
    await pool.ensurePoolSize(1);

    expect(pool.getWorkerByAgent("nonexistent")).toBeUndefined();
  });

  // --- listWorkers ---

  it("listWorkers returns all entries as a copy", async () => {
    const config = makePoolConfig();
    const pool = new WorkerPool(config);
    await pool.ensurePoolSize(2);

    const list = pool.listWorkers();

    expect(list).toHaveLength(2);
    // Verify it's a copy (modifying the returned array doesn't affect pool)
    list.pop();
    expect(pool.listWorkers()).toHaveLength(2);
  });

  // --- startPoolMonitor / stopPoolMonitor ---

  it("startPoolMonitor triggers ensurePoolSize when dormant < minDormant", async () => {
    vi.useFakeTimers();
    const config = makePoolConfig({ minDormant: 2, monitorIntervalMs: 1000 });
    const pool = new WorkerPool(config);

    pool.startPoolMonitor();

    expect(pool.getDormantCount()).toBe(0);

    // Advance timer to trigger the interval
    await vi.advanceTimersByTimeAsync(1000);

    // ensurePoolSize should have been called, creating workers
    // With fake timers, the health polling might not resolve,
    // but the monitor fires
    expect(pool.getDormantCount()).toBe(2);

    pool.stopPoolMonitor();
  });

  it("stopPoolMonitor clears the interval", () => {
    vi.useFakeTimers();
    const config = makePoolConfig({ monitorIntervalMs: 1000 });
    const pool = new WorkerPool(config);

    pool.startPoolMonitor();
    pool.stopPoolMonitor();

    // After stopping, advancing timers should not trigger any activity
    // This shouldn't throw or create workers
    vi.advanceTimersByTime(5000);

    expect(pool.listWorkers()).toHaveLength(0);
  });

  it("startPoolMonitor is idempotent", () => {
    vi.useFakeTimers();
    const config = makePoolConfig({ monitorIntervalMs: 1000 });
    const pool = new WorkerPool(config);

    pool.startPoolMonitor();
    pool.startPoolMonitor(); // second call should be no-op

    pool.stopPoolMonitor();
  });

  // --- discoverExistingWorkers ---

  it("discoverExistingWorkers populates pool from serviceList", async () => {
    const client = makeRailwayClient({
      serviceList: vi.fn().mockResolvedValue([
        { id: "svc-10", name: "aas-w-10" },
        { id: "svc-20", name: "aas-w-20" },
        { id: "svc-cp", name: "aas-control-plane" },
      ]),
    });
    const config = makePoolConfig({ railwayClient: client });
    const pool = new WorkerPool(config);

    await pool.discoverExistingWorkers();

    const workers = pool.listWorkers();
    expect(workers).toHaveLength(2);

    const numbers = workers.map((w) => w.workerNumber).sort((a, b) => a - b);
    expect(numbers).toEqual([10, 20]);
  });

  it("discoverExistingWorkers marks healthy workers as dormant", async () => {
    const client = makeRailwayClient({
      serviceList: vi.fn().mockResolvedValue([
        { id: "svc-5", name: "aas-w-5" },
      ]),
    });
    // fetch returns 200 (healthy)
    const config = makePoolConfig({ railwayClient: client });
    const pool = new WorkerPool(config);

    await pool.discoverExistingWorkers();

    const workers = pool.listWorkers();
    expect(workers).toHaveLength(1);
    expect(workers[0].status).toBe("dormant");
  });

  it("discoverExistingWorkers marks unreachable workers as error", async () => {
    const client = makeRailwayClient({
      serviceList: vi.fn().mockResolvedValue([
        { id: "svc-5", name: "aas-w-5" },
      ]),
    });
    mockUnhealthyFetch();
    const config = makePoolConfig({ railwayClient: client });
    const pool = new WorkerPool(config);

    await pool.discoverExistingWorkers();

    const workers = pool.listWorkers();
    expect(workers).toHaveLength(1);
    expect(workers[0].status).toBe("error");
  });

  it("discoverExistingWorkers ignores non-worker services", async () => {
    const client = makeRailwayClient({
      serviceList: vi.fn().mockResolvedValue([
        { id: "svc-1", name: "aas-control-plane" },
        { id: "svc-2", name: "my-other-service" },
      ]),
    });
    const config = makePoolConfig({ railwayClient: client });
    const pool = new WorkerPool(config);

    await pool.discoverExistingWorkers();

    expect(pool.listWorkers()).toHaveLength(0);
  });

  it("discoverExistingWorkers updates worker counter to avoid collisions", async () => {
    const client = makeRailwayClient({
      serviceList: vi.fn().mockResolvedValue([
        { id: "svc-50", name: "aas-w-50" },
      ]),
    });
    const config = makePoolConfig({ railwayClient: client });
    const pool = new WorkerPool(config);

    await pool.discoverExistingWorkers();

    // New workers should get numbers > 50
    await pool.ensurePoolSize(2);

    const workers = pool.listWorkers();
    const newWorkers = workers.filter((w) => w.workerNumber > 50);
    expect(newWorkers).toHaveLength(1);
  });
});
