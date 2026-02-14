import { describe, it, expect, beforeEach } from "vitest";
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

  it("DELETE /v1/instances/missing — delete non-existing returns deleted 0", async () => {
    const res = await app.request("/v1/instances/missing", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.deleted).toBe(0);
  });
});
