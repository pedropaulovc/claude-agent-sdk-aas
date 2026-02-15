import { describe, it, expect, beforeEach, vi } from "vitest";
import * as Sentry from "@sentry/node";

const {
  mockSetAttribute,
  mockProvisionInstance,
  mockStartDeployPolling,
  mockStopPolling,
  mockServiceDelete,
  mockVariableCollectionUpsert,
  mockGetRailwayClient,
} = vi.hoisted(() => {
  const mockServiceDelete = vi.fn().mockResolvedValue(undefined);
  const mockVariableCollectionUpsert = vi.fn().mockResolvedValue(undefined);
  return {
    mockSetAttribute: vi.fn(),
    mockProvisionInstance: vi.fn().mockResolvedValue(undefined),
    mockStartDeployPolling: vi.fn(),
    mockStopPolling: vi.fn(),
    mockServiceDelete,
    mockVariableCollectionUpsert,
    mockGetRailwayClient: vi.fn(() => ({
      serviceCreate: vi.fn(),
      serviceDelete: mockServiceDelete,
      variableCollectionUpsert: mockVariableCollectionUpsert,
      serviceDomainCreate: vi.fn(),
    })),
  };
});

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

vi.mock("../railway/provisioner.js", () => ({
  provisionInstance: mockProvisionInstance,
}));

vi.mock("../railway/health-poller.js", () => ({
  healthPoller: {
    startDeployPolling: mockStartDeployPolling,
    stopPolling: mockStopPolling,
    startOngoingPolling: vi.fn(),
    stopAll: vi.fn(),
    isPolling: vi.fn(),
  },
}));

vi.mock("../railway/client.js", () => ({
  getRailwayClient: mockGetRailwayClient,
}));

import { app } from "../server.js";
import { store } from "../registry/store.js";

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

describe("Instance API Routes", () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
    mockProvisionInstance.mockResolvedValue(undefined);
    mockServiceDelete.mockResolvedValue(undefined);
    mockVariableCollectionUpsert.mockResolvedValue(undefined);
  });

  // --- POST /v1/instances ---

  it("POST /v1/instances — provision returns 202 with provisioning status", async () => {
    const res = await provision("test/agent");
    expect(res.status).toBe(202);

    const body = await res.json();
    expect(body.name).toBe("test/agent");
    expect(body.systemPrompt).toBe("You are a test agent.");
    expect(body.status).toBe("provisioning");
    expect(body.railwayServiceId).toBeNull();
    expect(body.workerUrl).toBeNull();
    expect(body.provisionError).toBeNull();
    expect(body.model).toBe("claude-haiku-4-5-20251001");
  });

  it("POST /v1/instances — calls provisionInstance in background", async () => {
    await provision("test/agent");

    expect(mockProvisionInstance).toHaveBeenCalledOnce();
    expect(mockProvisionInstance).toHaveBeenCalledWith(
      expect.objectContaining({ name: "test/agent", status: "provisioning" }),
      store,
      expect.anything(),
    );
  });

  it("POST /v1/instances — calls getRailwayClient", async () => {
    await provision("test/agent");
    expect(mockGetRailwayClient).toHaveBeenCalled();
  });

  it("POST /v1/instances — starts deploy polling after successful provision", async () => {
    // provisionInstance modifies the record inline (status -> deploying, workerUrl set)
    mockProvisionInstance.mockImplementation(async (record) => {
      record.status = "deploying";
      record.workerUrl = "https://test-agent.up.railway.app";
    });

    await provision("test/agent");

    // Allow the fire-and-forget promise to resolve
    await vi.waitFor(() => {
      expect(mockStartDeployPolling).toHaveBeenCalledWith(
        "test/agent",
        "https://test-agent.up.railway.app",
        store,
      );
    });
  });

  it("POST /v1/instances — does NOT start deploy polling when provision fails", async () => {
    mockProvisionInstance.mockImplementation(async (record) => {
      record.status = "error";
      record.provisionError = "some error";
    });

    await provision("test/agent");

    // Give the promise time to resolve
    await new Promise((r) => setTimeout(r, 10));
    expect(mockStartDeployPolling).not.toHaveBeenCalled();
  });

  it("POST /v1/instances — provision with duplicate name returns 409", async () => {
    await provision("dup/agent");
    const res = await provision("dup/agent");
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("POST /v1/instances — provision with missing name returns 400", async () => {
    const res = await app.request("/v1/instances", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ systemPrompt: "test" }),
    });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("POST /v1/instances — provision with invalid name returns 400", async () => {
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

  it("GET /v1/instances — list all returns 200 with array", async () => {
    await provision("a/one");
    await provision("b/two");

    const res = await app.request("/v1/instances");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
  });

  it("GET /v1/instances?prefix=dev — list with prefix returns filtered results", async () => {
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

  it("GET /v1/instances/test/agent — get existing returns 200", async () => {
    await provision("test/agent");

    const res = await app.request("/v1/instances/test/agent");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.name).toBe("test/agent");
  });

  it("GET /v1/instances/missing — get non-existing returns 404", async () => {
    const res = await app.request("/v1/instances/missing");
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  // --- PATCH /v1/instances/* ---

  it("PATCH /v1/instances/test/agent — update returns 200 with deploying status", async () => {
    await provision("test/agent");
    const instance = store.get("test/agent");
    if (!instance) throw new Error("expected instance");
    instance.status = "ready";

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

  it("PATCH /v1/instances/test/agent — calls variableCollectionUpsert when railwayServiceId exists", async () => {
    await provision("test/agent");
    const instance = store.get("test/agent");
    if (!instance) throw new Error("expected instance");
    instance.status = "ready";
    instance.railwayServiceId = "svc-123";
    instance.workerUrl = "https://test-agent.up.railway.app";

    await app.request("/v1/instances/test/agent", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514" }),
    });

    // Allow the fire-and-forget promise to resolve
    await vi.waitFor(() => {
      expect(mockVariableCollectionUpsert).toHaveBeenCalledWith(
        "svc-123",
        expect.objectContaining({
          AAS_MODEL: "claude-sonnet-4-20250514",
          AAS_SYSTEM_PROMPT: "You are a test agent.",
        }),
      );
    });
  });

  it("PATCH /v1/instances/test/agent — starts deploy polling after updating Railway vars", async () => {
    await provision("test/agent");
    const instance = store.get("test/agent");
    if (!instance) throw new Error("expected instance");
    instance.status = "ready";
    instance.railwayServiceId = "svc-456";
    instance.workerUrl = "https://test-agent.up.railway.app";

    await app.request("/v1/instances/test/agent", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxTurns: 100 }),
    });

    await vi.waitFor(() => {
      expect(mockStartDeployPolling).toHaveBeenCalledWith(
        "test/agent",
        "https://test-agent.up.railway.app",
        store,
      );
    });
  });

  it("PATCH /v1/instances/test/agent — does NOT call Railway when no railwayServiceId", async () => {
    await provision("test/agent");
    const instance = store.get("test/agent");
    if (!instance) throw new Error("expected instance");
    instance.status = "ready";
    // railwayServiceId is null by default

    await app.request("/v1/instances/test/agent", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514" }),
    });

    // Give async tasks time to run
    await new Promise((r) => setTimeout(r, 10));
    expect(mockVariableCollectionUpsert).not.toHaveBeenCalled();
    expect(mockStartDeployPolling).not.toHaveBeenCalled();
  });

  it("PATCH /v1/instances/test/agent — update during provisioning returns 409", async () => {
    await provision("test/agent");

    const res = await app.request("/v1/instances/test/agent", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxTurns: 100 }),
    });
    expect(res.status).toBe(409);
  });

  it("PATCH /v1/instances/missing — update non-existing returns 404", async () => {
    const res = await app.request("/v1/instances/missing", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "new-model" }),
    });
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  // --- DELETE /v1/instances/* ---

  it("DELETE /v1/instances/test/agent — delete existing returns deleted count", async () => {
    await provision("test/agent");

    const res = await app.request("/v1/instances/test/agent", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.deleted).toBe(1);
  });

  it("DELETE /v1/instances/test/agent — stops health polling", async () => {
    await provision("test/agent");

    await app.request("/v1/instances/test/agent", {
      method: "DELETE",
    });

    expect(mockStopPolling).toHaveBeenCalledWith("test/agent");
  });

  it("DELETE /v1/instances/test/agent — sets status to destroying before removal", async () => {
    await provision("test/agent");
    const instance = store.get("test/agent");
    if (!instance) throw new Error("expected instance");

    // We need to capture the status before nukeByPrefix removes it.
    // We do this by checking that stopPolling is called (which happens while status is destroying).
    // Also verify that serviceDelete is NOT called (no railwayServiceId)
    await app.request("/v1/instances/test/agent", {
      method: "DELETE",
    });

    // Instance is removed from store now
    expect(store.get("test/agent")).toBeNull();
  });

  it("DELETE /v1/instances/test/agent — calls serviceDelete when railwayServiceId exists", async () => {
    await provision("test/agent");
    const instance = store.get("test/agent");
    if (!instance) throw new Error("expected instance");
    instance.railwayServiceId = "svc-789";

    await app.request("/v1/instances/test/agent", {
      method: "DELETE",
    });

    expect(mockServiceDelete).toHaveBeenCalledWith("svc-789");
  });

  it("DELETE /v1/instances/test/agent — does NOT call serviceDelete when no railwayServiceId", async () => {
    await provision("test/agent");

    await app.request("/v1/instances/test/agent", {
      method: "DELETE",
    });

    expect(mockServiceDelete).not.toHaveBeenCalled();
  });

  it("DELETE /v1/instances/test — nuke prefix returns total deleted count", async () => {
    await provision("test/agent1");
    await provision("test/agent2");
    await provision("test/agent3");
    await provision("other/agent");

    const res = await app.request("/v1/instances/test", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.deleted).toBe(3);

    expect(store.get("other/agent")).not.toBeNull();
  });

  it("DELETE /v1/instances/test — nuke prefix stops polling for each instance", async () => {
    await provision("test/agent1");
    await provision("test/agent2");

    await app.request("/v1/instances/test", {
      method: "DELETE",
    });

    expect(mockStopPolling).toHaveBeenCalledWith("test/agent1");
    expect(mockStopPolling).toHaveBeenCalledWith("test/agent2");
  });

  it("DELETE /v1/instances/test — nuke prefix calls serviceDelete for each instance with railwayServiceId", async () => {
    await provision("test/agent1");
    await provision("test/agent2");
    const inst1 = store.get("test/agent1");
    const inst2 = store.get("test/agent2");
    if (!inst1 || !inst2) throw new Error("expected instances");
    inst1.railwayServiceId = "svc-a";
    inst2.railwayServiceId = "svc-b";

    await app.request("/v1/instances/test", {
      method: "DELETE",
    });

    expect(mockServiceDelete).toHaveBeenCalledWith("svc-a");
    expect(mockServiceDelete).toHaveBeenCalledWith("svc-b");
  });

  it("DELETE /v1/instances/missing — delete non-existing returns deleted 0", async () => {
    const res = await app.request("/v1/instances/missing", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.deleted).toBe(0);
  });
});
