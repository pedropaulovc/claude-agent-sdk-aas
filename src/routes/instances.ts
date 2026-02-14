import { Hono } from "hono";
import { store, StoreError } from "../registry/store.js";
import { provisionSchema, updateSchema } from "../registry/types.js";
import { jsonResponse } from "../telemetry/middleware.js";
import { logInfo, withSpan } from "../telemetry/helpers.js";

export const instanceRoutes = new Hono();

// POST /v1/instances — Provision (async, returns 202)
instanceRoutes.post("/v1/instances", async (c) => {
  return withSpan("api.provision", "http.handler", async () => {
    const parsed = provisionSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return jsonResponse(c, { error: parsed.error.message }, 400);
    }

    try {
      const instance = await store.provision(parsed.data);
      logInfo("api.provision | success", { name: instance.name });
      return jsonResponse(c, instance as unknown as Record<string, unknown>, 202);
    } catch (err) {
      if (err instanceof StoreError && err.code === "conflict") {
        return jsonResponse(c, { error: err.message }, 409);
      }
      throw err;
    }
  });
});

// GET /v1/instances — List
instanceRoutes.get("/v1/instances", (c) => {
  const prefix = c.req.query("prefix");
  const instances = store.list(prefix);
  logInfo("api.list", { prefix: prefix ?? "all", count: instances.length });
  return jsonResponse(c, instances as unknown as Record<string, unknown>[], 200);
});

// GET /v1/instances/* — Get by name
instanceRoutes.get("/v1/instances/*", (c) => {
  const name = c.req.param("*") ?? c.req.path.replace("/v1/instances/", "");
  const instance = store.get(name);
  if (!instance) {
    return jsonResponse(c, { error: `Instance "${name}" not found` }, 404);
  }
  return jsonResponse(c, instance as unknown as Record<string, unknown>, 200);
});

// PATCH /v1/instances/* — Update
instanceRoutes.patch("/v1/instances/*", async (c) => {
  return withSpan("api.update", "http.handler", async () => {
    const name = c.req.param("*") ?? c.req.path.replace("/v1/instances/", "");
    const parsed = updateSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return jsonResponse(c, { error: parsed.error.message }, 400);
    }

    try {
      const updated = await store.update(name, parsed.data);
      logInfo("api.update | success", { name });
      return jsonResponse(c, updated as unknown as Record<string, unknown>, 200);
    } catch (err) {
      if (err instanceof StoreError && err.code === "not_found") {
        return jsonResponse(c, { error: err.message }, 404);
      }
      if (err instanceof StoreError && err.code === "conflict") {
        return jsonResponse(c, { error: err.message }, 409);
      }
      throw err;
    }
  });
});

// DELETE /v1/instances/* — Delete exact or nuke by prefix
instanceRoutes.delete("/v1/instances/*", (c) => {
  const name = c.req.param("*") ?? c.req.path.replace("/v1/instances/", "");
  const deleted = store.nukeByPrefix(name);
  logInfo("api.delete", { name, deleted });
  return jsonResponse(c, { deleted }, 200);
});
