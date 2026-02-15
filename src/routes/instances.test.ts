import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Sentry from "@sentry/node";

vi.mock("@sentry/node", async () => {
  const actual = await vi.importActual<typeof Sentry>("@sentry/node");
  return {
    ...actual,
    startSpan: vi.fn((_opts, cb) =>
      cb({
        setAttribute: vi.fn(),
        spanContext: () => ({ traceId: "test-trace" }),
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

vi.mock("../railway/health-poller.js", () => ({
  healthPoller: {
    startOngoingPolling: vi.fn(),
    stopPolling: vi.fn(),
  },
}));

import { app } from "../server.js";
import { store } from "../registry/store.js";
import { setWorkerPool } from "./instances.js";
import { healthPoller } from "../railway/health-poller.js";
import type { WorkerPool, WorkerEntry } from "../railway/pool.js";

function makeWorkerEntry(overrides?: Partial<WorkerEntry>): WorkerEntry {
  return {
    workerNumber: 1,
    serviceId: "svc-w-1",
    workerUrl: "https://aas-w-1.up.railway.app",
    assignedAgent: null,
    status: "dormant",
    ...overrides,
  };
}

function makePool(overrides?: Partial<WorkerPool>): WorkerPool {
  return {
    claimWorker: vi.fn().mockReturnValue(makeWorkerEntry()),
    assignWorker: vi.fn(),
    releaseWorker: vi.fn().mockResolvedValue(undefined),
    ensurePoolSize: vi.fn().mockResolvedValue(undefined),
    startPoolMonitor: vi.fn(),
    stopPoolMonitor: vi.fn(),
    discoverExistingWorkers: vi.fn().mockResolvedValue(undefined),
    getDormantCount: vi.fn().mockReturnValue(5),
    getActiveCount: vi.fn().mockReturnValue(0),
    listWorkers: vi.fn().mockReturnValue([]),
    getWorkerByAgent: vi.fn().mockReturnValue(undefined),
    ...overrides,
  } as unknown as WorkerPool;
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "test/agent",
    systemPrompt: "You are a test agent.",
    ...overrides,
  };
}

async function provision(name: string) {
  return app.request("/v1/instances", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(validBody({ name })),
  });
}

function stubFetchOk(): ReturnType<typeof vi.fn> {
  const mock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve("OK"),
    json: () => Promise.resolve({ status: "activated" }),
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function stubFetchError(status = 500, body = "Internal Error"): ReturnType<typeof vi.fn> {
  const mock = vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: () => Promise.resolve(body),
    json: () => Promise.resolve({ error: body }),
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function stubFetchThrow(message = "ECONNREFUSED"): ReturnType<typeof vi.fn> {
  const mock = vi.fn().mockRejectedValue(new Error(message));
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** Wait for async tasks (fire-and-forget provision/update) to complete. */
async function flushAsync() {
  // Multiple ticks to allow promise chains to resolve
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe("Instance API Routes", () => {
  let mockPool: WorkerPool;

  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
    mockPool = makePool();
    setWorkerPool(mockPool);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // --- POST /v1/instances ---

  it("POST /v1/instances returns 202 with provisioning status", async () => {
    stubFetchOk();
    const res = await provision("test/agent");
    expect(res.status).toBe(202);

    const body = await res.json();
    expect(body.name).toBe("test/agent");
    expect(body.systemPrompt).toBe("You are a test agent.");
    expect(body.status).toBe("provisioning");
    expect(body.railwayServiceId).toBeNull();
    expect(body.workerUrl).toBeNull();
    expect(body.workerNumber).toBeNull();
    expect(body.provisionError).toBeNull();
    expect(body.model).toBe("claude-haiku-4-5-20251001");
  });

  it("POST /v1/instances claims worker and activates asynchronously", async () => {
    const fetchMock = stubFetchOk();
    await provision("test/agent");
    await flushAsync();

    expect(mockPool.claimWorker).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("https://aas-w-1.up.railway.app/activate");

    const instance = store.get("test/agent");
    expect(instance?.status).toBe("ready");
    expect(instance?.workerUrl).toBe("https://aas-w-1.up.railway.app");
    expect(instance?.railwayServiceId).toBe("svc-w-1");
    expect(instance?.workerNumber).toBe(1);
  });

  it("POST /v1/instances sends correct activation body", async () => {
    const fetchMock = stubFetchOk();
    await app.request("/v1/instances", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "my/agent",
        systemPrompt: "Be helpful.",
        mcpServers: [{ name: "github", url: "https://mcp.github.com" }],
        model: "claude-sonnet-4-20250514",
        maxTurns: 100,
        maxBudgetUsd: 5.0,
      }),
    });
    await flushAsync();

    const fetchBody = JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<string, unknown>;
    expect(fetchBody.instanceName).toBe("my/agent");
    expect(fetchBody.systemPrompt).toBe("Be helpful.");
    expect(fetchBody.mcpServers).toEqual([{ name: "github", url: "https://mcp.github.com" }]);
    expect(fetchBody.model).toBe("claude-sonnet-4-20250514");
    expect(fetchBody.maxTurns).toBe(100);
    expect(fetchBody.maxBudgetUsd).toBe(5.0);
  });

  it("POST /v1/instances assigns worker after activation", async () => {
    stubFetchOk();
    await provision("test/agent");
    await flushAsync();

    expect(mockPool.assignWorker).toHaveBeenCalledWith(1, "test/agent");
  });

  it("POST /v1/instances starts ongoing health polling after activation", async () => {
    stubFetchOk();
    await provision("test/agent");
    await flushAsync();

    expect(healthPoller.startOngoingPolling).toHaveBeenCalledWith(
      "test/agent",
      "https://aas-w-1.up.railway.app",
      store,
    );
  });

  it("POST /v1/instances sets error when no dormant workers", async () => {
    stubFetchOk();
    mockPool = makePool({
      claimWorker: vi.fn().mockReturnValue(null),
    });
    setWorkerPool(mockPool);

    await provision("test/agent");
    await flushAsync();

    const instance = store.get("test/agent");
    expect(instance?.status).toBe("error");
    expect(instance?.provisionError).toContain("No dormant workers");
  });

  it("POST /v1/instances sets error and releases worker on activation failure", async () => {
    stubFetchError(500, "activation failed");
    await provision("test/agent");
    await flushAsync();

    const instance = store.get("test/agent");
    expect(instance?.status).toBe("error");
    expect(instance?.provisionError).toContain("500");
    expect(mockPool.releaseWorker).toHaveBeenCalledWith(1);
  });

  it("POST /v1/instances sets error when activation fetch throws", async () => {
    stubFetchThrow("connection refused");
    await provision("test/agent");
    await flushAsync();

    const instance = store.get("test/agent");
    expect(instance?.status).toBe("error");
    expect(instance?.provisionError).toContain("connection refused");
    expect(mockPool.releaseWorker).toHaveBeenCalledWith(1);
  });

  it("POST /v1/instances returns 409 for duplicate name", async () => {
    stubFetchOk();
    await provision("dup/agent");
    const res = await provision("dup/agent");
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("POST /v1/instances returns 400 for missing name", async () => {
    const res = await app.request("/v1/instances", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ systemPrompt: "test" }),
    });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("POST /v1/instances returns 400 for invalid name", async () => {
    const res = await app.request("/v1/instances", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody({ name: "/invalid" })),
    });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  // --- GET /v1/instances ---

  it("GET /v1/instances lists all instances", async () => {
    stubFetchOk();
    await provision("a/one");
    await provision("b/two");

    const res = await app.request("/v1/instances");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
  });

  it("GET /v1/instances?prefix=dev filters by prefix", async () => {
    stubFetchOk();
    await provision("dev/agent1");
    await provision("dev/agent2");
    await provision("prod/agent1");

    const res = await app.request("/v1/instances?prefix=dev");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveLength(2);
    expect(body.every((i: { name: string }) => i.name.startsWith("dev/"))).toBe(true);
  });

  // --- GET /v1/instances/* ---

  it("GET /v1/instances/test/agent returns existing instance", async () => {
    stubFetchOk();
    await provision("test/agent");

    const res = await app.request("/v1/instances/test/agent");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.name).toBe("test/agent");
  });

  it("GET /v1/instances/missing returns 404", async () => {
    const res = await app.request("/v1/instances/missing");
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  // --- PATCH /v1/instances/* ---

  it("PATCH /v1/instances/test/agent returns 200 with deploying status", async () => {
    stubFetchOk();
    await provision("test/agent");
    await flushAsync();

    // Instance should be ready now
    const instance = store.get("test/agent");
    expect(instance?.status).toBe("ready");

    const res = await app.request("/v1/instances/test/agent", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514" }),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.model).toBe("claude-sonnet-4-20250514");
    expect(body.status).toBe("deploying");
  });

  it("PATCH releases old worker, claims new, and activates", async () => {
    const worker2 = makeWorkerEntry({ workerNumber: 2, serviceId: "svc-w-2", workerUrl: "https://aas-w-2.up.railway.app" });
    let claimCount = 0;
    mockPool = makePool({
      claimWorker: vi.fn().mockImplementation(() => {
        claimCount++;
        if (claimCount === 1) return makeWorkerEntry();
        return worker2;
      }),
    });
    setWorkerPool(mockPool);

    const fetchMock = stubFetchOk();
    await provision("test/agent");
    await flushAsync();

    // Reset mocks after provision
    vi.mocked(mockPool.releaseWorker).mockClear();
    fetchMock.mockClear();

    await app.request("/v1/instances/test/agent", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxTurns: 100 }),
    });
    await flushAsync();

    // Old worker (number 1) should have been released
    expect(mockPool.releaseWorker).toHaveBeenCalledWith(1);

    // Worker 2 should have been claimed and activated
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("https://aas-w-2.up.railway.app/activate");

    const instance = store.get("test/agent");
    expect(instance?.status).toBe("ready");
    expect(instance?.workerNumber).toBe(2);
    expect(instance?.workerUrl).toBe("https://aas-w-2.up.railway.app");
  });

  it("PATCH stops health polling before releasing old worker", async () => {
    stubFetchOk();
    await provision("test/agent");
    await flushAsync();

    vi.mocked(healthPoller.stopPolling).mockClear();

    await app.request("/v1/instances/test/agent", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "new-model" }),
    });
    await flushAsync();

    expect(healthPoller.stopPolling).toHaveBeenCalledWith("test/agent");
  });

  it("PATCH returns 409 when instance is provisioning", async () => {
    // Stub fetch to never resolve, so async provision stays in-flight
    const mock = vi.fn().mockReturnValue(new Promise(() => {}));
    vi.stubGlobal("fetch", mock);

    await provision("test/agent");
    // Instance is still provisioning because fetch never resolved

    const res = await app.request("/v1/instances/test/agent", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxTurns: 100 }),
    });
    expect(res.status).toBe(409);
  });

  it("PATCH returns 404 for non-existing instance", async () => {
    const res = await app.request("/v1/instances/missing", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "new-model" }),
    });
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("PATCH sets error when no dormant workers for re-provision", async () => {
    let claimCount = 0;
    mockPool = makePool({
      claimWorker: vi.fn().mockImplementation(() => {
        claimCount++;
        if (claimCount === 1) return makeWorkerEntry();
        return null; // No workers for second claim (update)
      }),
    });
    setWorkerPool(mockPool);

    stubFetchOk();
    await provision("test/agent");
    await flushAsync();

    await app.request("/v1/instances/test/agent", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "new-model" }),
    });
    await flushAsync();

    const instance = store.get("test/agent");
    expect(instance?.status).toBe("error");
    expect(instance?.provisionError).toContain("No dormant workers");
  });

  // --- DELETE /v1/instances/* ---

  it("DELETE /v1/instances/test/agent releases worker and removes from store", async () => {
    stubFetchOk();
    await provision("test/agent");
    await flushAsync();

    const res = await app.request("/v1/instances/test/agent", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.deleted).toBe(1);
    expect(store.get("test/agent")).toBeNull();
    expect(mockPool.releaseWorker).toHaveBeenCalledWith(1);
  });

  it("DELETE stops health polling for instance", async () => {
    stubFetchOk();
    await provision("test/agent");
    await flushAsync();

    vi.mocked(healthPoller.stopPolling).mockClear();

    await app.request("/v1/instances/test/agent", {
      method: "DELETE",
    });

    expect(healthPoller.stopPolling).toHaveBeenCalledWith("test/agent");
  });

  it("DELETE /v1/instances/test nukes by prefix and releases all workers", async () => {
    const workers = [
      makeWorkerEntry({ workerNumber: 1, serviceId: "svc-w-1", workerUrl: "https://aas-w-1.up.railway.app" }),
      makeWorkerEntry({ workerNumber: 2, serviceId: "svc-w-2", workerUrl: "https://aas-w-2.up.railway.app" }),
      makeWorkerEntry({ workerNumber: 3, serviceId: "svc-w-3", workerUrl: "https://aas-w-3.up.railway.app" }),
      makeWorkerEntry({ workerNumber: 4, serviceId: "svc-w-4", workerUrl: "https://aas-w-4.up.railway.app" }),
    ];
    let claimIdx = 0;
    mockPool = makePool({
      claimWorker: vi.fn().mockImplementation(() => workers[claimIdx++] ?? null),
    });
    setWorkerPool(mockPool);

    stubFetchOk();
    await provision("test/agent1");
    await provision("test/agent2");
    await provision("test/agent3");
    await provision("other/agent");
    await flushAsync();

    vi.mocked(mockPool.releaseWorker).mockClear();

    const res = await app.request("/v1/instances/test", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.deleted).toBe(3);

    // Workers 1, 2, 3 should have been released (test/* agents)
    expect(mockPool.releaseWorker).toHaveBeenCalledTimes(3);
    expect(mockPool.releaseWorker).toHaveBeenCalledWith(1);
    expect(mockPool.releaseWorker).toHaveBeenCalledWith(2);
    expect(mockPool.releaseWorker).toHaveBeenCalledWith(3);

    // "other/agent" should still exist
    expect(store.get("other/agent")).not.toBeNull();
  });

  it("DELETE /v1/instances/missing returns deleted 0", async () => {
    const res = await app.request("/v1/instances/missing", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.deleted).toBe(0);
  });

  it("DELETE does not call releaseWorker when instance has no workerNumber", async () => {
    stubFetchOk();
    // Provision without flushing so the instance remains in provisioning (no workerNumber)
    mockPool = makePool({
      // Never resolve claimWorker — simulating slow pool
      claimWorker: vi.fn().mockReturnValue(null),
    });
    setWorkerPool(mockPool);

    await provision("test/agent");
    await flushAsync();
    // Instance should be in error state with no workerNumber
    vi.mocked(mockPool.releaseWorker).mockClear();

    const res = await app.request("/v1/instances/test/agent", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(mockPool.releaseWorker).not.toHaveBeenCalled();
  });

  it("DELETE handles releaseWorker failure gracefully", async () => {
    stubFetchOk();
    await provision("test/agent");
    await flushAsync();

    vi.mocked(mockPool.releaseWorker).mockRejectedValueOnce(new Error("Railway API error"));

    const res = await app.request("/v1/instances/test/agent", {
      method: "DELETE",
    });
    // Should still succeed — release error is logged but not propagated
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.deleted).toBe(1);
  });
});
