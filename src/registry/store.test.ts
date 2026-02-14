import { describe, it, expect, beforeEach, vi } from "vitest";
import { InstanceStore, StoreError } from "./store.js";
import type { ProvisionRequest } from "../shared/types.js";

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

function makeRequest(overrides: Partial<ProvisionRequest> = {}): ProvisionRequest {
  return {
    name: "test/instance",
    systemPrompt: "You are a test agent.",
    mcpServers: [],
    model: "claude-haiku-4-5-20251001",
    maxTurns: 50,
    maxBudgetUsd: 1.0,
    ...overrides,
  };
}

describe("InstanceStore", () => {
  let store: InstanceStore;

  beforeEach(() => {
    store = new InstanceStore();
  });

  // --- provision ---

  it("provision creates instance with correct fields", async () => {
    const instance = await store.provision(makeRequest({ name: "michael" }));

    expect(instance.name).toBe("michael");
    expect(instance.systemPrompt).toBe("You are a test agent.");
    expect(instance.mcpServers).toEqual([]);
    expect(instance.model).toBe("claude-haiku-4-5-20251001");
    expect(instance.maxTurns).toBe(50);
    expect(instance.maxBudgetUsd).toBe(1.0);
    expect(instance.status).toBe("provisioning");
    expect(instance.railwayServiceId).toBeNull();
    expect(instance.workerUrl).toBeNull();
    expect(instance.provisionError).toBeNull();
    expect(instance.createdAt).toBeInstanceOf(Date);
  });

  it("provision increments store size", async () => {
    expect(store.size).toBe(0);
    await store.provision(makeRequest({ name: "a" }));
    expect(store.size).toBe(1);
    await store.provision(makeRequest({ name: "b" }));
    expect(store.size).toBe(2);
  });

  it("provision rejects duplicate names with conflict error", async () => {
    await store.provision(makeRequest({ name: "dup" }));

    await expect(store.provision(makeRequest({ name: "dup" }))).rejects.toThrow(StoreError);
    try {
      await store.provision(makeRequest({ name: "dup" }));
    } catch (err) {
      expect(err).toBeInstanceOf(StoreError);
      expect((err as StoreError).code).toBe("conflict");
    }
  });

  // --- get ---

  it("get returns instance when it exists", async () => {
    await store.provision(makeRequest({ name: "existing" }));
    const result = store.get("existing");
    expect(result).not.toBeNull();
    expect(result?.name).toBe("existing");
  });

  it("get returns null for non-existent instance", () => {
    expect(store.get("missing")).toBeNull();
  });

  // --- list ---

  it("list returns all instances when no prefix is given", async () => {
    await store.provision(makeRequest({ name: "a" }));
    await store.provision(makeRequest({ name: "b" }));
    await store.provision(makeRequest({ name: "c" }));

    const all = store.list();
    expect(all).toHaveLength(3);
  });

  it("list with prefix filters by exact match and prefix/ match", async () => {
    await store.provision(makeRequest({ name: "dev" }));
    await store.provision(makeRequest({ name: "dev/agent1" }));
    await store.provision(makeRequest({ name: "dev/agent2" }));
    await store.provision(makeRequest({ name: "prod/agent1" }));

    const devInstances = store.list("dev");
    expect(devInstances).toHaveLength(3);
    expect(devInstances.map((i) => i.name).sort()).toEqual(["dev", "dev/agent1", "dev/agent2"]);
  });

  it("list with prefix does not match substrings", async () => {
    await store.provision(makeRequest({ name: "devops" }));
    await store.provision(makeRequest({ name: "dev/agent" }));

    const result = store.list("dev");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("dev/agent");
  });

  it("list returns empty array when no instances exist", () => {
    expect(store.list()).toEqual([]);
  });

  // --- update ---

  it("update modifies only provided fields", async () => {
    await store.provision(makeRequest({ name: "u1", model: "old-model", maxTurns: 10 }));
    const instance = store.get("u1");
    if (!instance) throw new Error("expected instance");
    instance.status = "ready";

    const updated = await store.update("u1", { model: "new-model" });
    expect(updated.model).toBe("new-model");
    expect(updated.maxTurns).toBe(10);
    expect(updated.systemPrompt).toBe("You are a test agent.");
  });

  it("update transitions status to deploying", async () => {
    await store.provision(makeRequest({ name: "u2" }));
    const instance = store.get("u2");
    if (!instance) throw new Error("expected instance");
    instance.status = "ready";

    const updated = await store.update("u2", { model: "new-model" });
    expect(updated.status).toBe("deploying");
  });

  it("update rejects while status is provisioning with conflict error", async () => {
    await store.provision(makeRequest({ name: "prov-inst" }));

    try {
      await store.update("prov-inst", { model: "new-model" });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(StoreError);
      expect((err as StoreError).code).toBe("conflict");
    }
  });

  it("update rejects while status is destroying with conflict error", async () => {
    await store.provision(makeRequest({ name: "dest-inst" }));
    const instance = store.get("dest-inst");
    if (!instance) throw new Error("expected instance");
    instance.status = "destroying";

    try {
      await store.update("dest-inst", { model: "new-model" });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(StoreError);
      expect((err as StoreError).code).toBe("conflict");
    }
  });

  it("update throws not_found for non-existent instance", async () => {
    try {
      await store.update("ghost", { model: "new-model" });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(StoreError);
      expect((err as StoreError).code).toBe("not_found");
    }
  });

  // --- delete ---

  it("delete returns 1 for existing instance", async () => {
    await store.provision(makeRequest({ name: "del1" }));
    expect(store.delete("del1")).toBe(1);
    expect(store.size).toBe(0);
  });

  it("delete returns 0 for non-existing instance", () => {
    expect(store.delete("nope")).toBe(0);
  });

  it("delete removes the instance from the store", async () => {
    await store.provision(makeRequest({ name: "del2" }));
    store.delete("del2");
    expect(store.get("del2")).toBeNull();
  });

  // --- nukeByPrefix ---

  it("nukeByPrefix deletes all matching instances", async () => {
    await store.provision(makeRequest({ name: "ns" }));
    await store.provision(makeRequest({ name: "ns/a" }));
    await store.provision(makeRequest({ name: "ns/b" }));
    await store.provision(makeRequest({ name: "other" }));

    const deleted = store.nukeByPrefix("ns");
    expect(deleted).toBe(3);
    expect(store.size).toBe(1);
    expect(store.get("other")).not.toBeNull();
  });

  it("nukeByPrefix returns 0 for non-matching prefix", () => {
    expect(store.nukeByPrefix("nonexistent")).toBe(0);
  });

  it("nukeByPrefix does not match substring prefixes", async () => {
    await store.provision(makeRequest({ name: "testing" }));
    await store.provision(makeRequest({ name: "test/a" }));

    const deleted = store.nukeByPrefix("test");
    expect(deleted).toBe(1);
    expect(store.get("testing")).not.toBeNull();
    expect(store.get("test/a")).toBeNull();
  });
});
