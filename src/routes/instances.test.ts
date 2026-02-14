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

  it("POST /v1/instances — provision with valid body returns 201", async () => {
    const res = await provision("test/agent");
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.name).toBe("test/agent");
    expect(body.systemPrompt).toBe("You are a test agent.");
    expect(body.status).toBe("ready");
    expect(body.sessionId).toBeNull();
    expect(body.invocationCount).toBe(0);
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

  it("POST /v1/instances — provision with invalid name (leading slash) returns 400", async () => {
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

  it("PATCH /v1/instances/test/agent — update existing returns 200 with updated fields", async () => {
    await provision("test/agent");

    const res = await app.request("/v1/instances/test/agent", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514" }),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.model).toBe("claude-sonnet-4-20250514");
    expect(body.name).toBe("test/agent");
  });

  it("PATCH /v1/instances/test/agent — update resets sessionId", async () => {
    await provision("test/agent");

    // Manually set a sessionId to simulate an active session
    const instance = store.get("test/agent");
    if (!instance) throw new Error("expected instance");
    instance.sessionId = "session-abc";

    const res = await app.request("/v1/instances/test/agent", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxTurns: 100 }),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.sessionId).toBeNull();
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

  it("DELETE /v1/instances/test/agent — delete existing returns 200 with deleted count", async () => {
    await provision("test/agent");

    const res = await app.request("/v1/instances/test/agent", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.deleted).toBe(1);
  });

  it("DELETE /v1/instances/test — nuke prefix returns 200 with total deleted count", async () => {
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

    // Verify "other/agent" is untouched
    expect(store.get("other/agent")).not.toBeNull();
  });

  it("DELETE /v1/instances/missing — delete non-existing returns 200 with deleted 0", async () => {
    const res = await app.request("/v1/instances/missing", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.deleted).toBe(0);
  });
});
