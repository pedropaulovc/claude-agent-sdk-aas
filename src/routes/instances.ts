import { Hono } from "hono";
import { store, StoreError } from "../registry/store.js";
import { provisionSchema, updateSchema } from "../shared/types.js";
import type { InstanceRecord } from "../shared/types.js";
import { jsonResponse } from "../telemetry/middleware.js";
import { logInfo, logError, withSpan, countMetric } from "../telemetry/helpers.js";
import { provisionInstance } from "../railway/provisioner.js";
import { healthPoller } from "../railway/health-poller.js";
import { getRailwayClient } from "../railway/client.js";

export const instanceRoutes = new Hono();

/**
 * Build the env vars to push to Railway when an instance is updated.
 * Mirrors the shape from provisioner.ts buildVariables, but only includes
 * config vars (secrets like ANTHROPIC_API_KEY are already set during provisioning).
 */
function buildUpdateVariables(record: InstanceRecord): Record<string, string> {
  return {
    AAS_SYSTEM_PROMPT: record.systemPrompt,
    AAS_MCP_SERVERS: JSON.stringify(record.mcpServers),
    AAS_MODEL: record.model,
    AAS_MAX_TURNS: String(record.maxTurns),
    AAS_MAX_BUDGET_USD: String(record.maxBudgetUsd),
  };
}

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

      // Fire-and-forget: provision on Railway, then start health polling
      const railwayClient = getRailwayClient();
      void provisionInstance(instance, store, railwayClient).then(() => {
        if (instance.status === "deploying" && instance.workerUrl) {
          healthPoller.startDeployPolling(instance.name, instance.workerUrl, store);
        }
      });

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

      // Fire-and-forget: push updated env vars to Railway
      if (updated.railwayServiceId) {
        const railwayClient = getRailwayClient();
        const serviceId = updated.railwayServiceId;
        void (async () => {
          try {
            const vars = buildUpdateVariables(updated);
            await railwayClient.variableCollectionUpsert(serviceId, vars);
            logInfo(`${name} | env vars updated on Railway`, { serviceId });
            countMetric("instance.update_vars", 1, { status: "success" });

            if (updated.workerUrl) {
              healthPoller.startDeployPolling(name, updated.workerUrl, store);
            }
          } catch (err) {
            logError(`${name} | failed to update Railway env vars`, { error: String(err) });
            countMetric("instance.update_vars", 1, { status: "error" });
            updated.status = "error";
            updated.provisionError = `Update failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        })();
      }

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
  return withSpan("api.delete", "http.handler", async () => {
    const name = c.req.param("*") ?? c.req.path.replace("/v1/instances/", "");

    // Get all matching instances (exact + prefix/) to clean up Railway resources
    const instances = store.list(name);
    if (instances.length === 0) {
      logInfo("api.delete | no matches", { name });
      return jsonResponse(c, { deleted: 0 }, 200);
    }

    const railwayClient = getRailwayClient();
    for (const inst of instances) {
      inst.status = "destroying";
      healthPoller.stopPolling(inst.name);

      if (inst.railwayServiceId) {
        void railwayClient.serviceDelete(inst.railwayServiceId).catch((err) => {
          logError(`${inst.name} | Railway service deletion failed`, {
            error: String(err),
            serviceId: inst.railwayServiceId ?? "unknown",
          });
        });
      }
    }

    const deleted = store.nukeByPrefix(name);
    logInfo("api.delete", { name, deleted });
    countMetric("instance.delete", deleted);
    return jsonResponse(c, { deleted }, 200);
  });
});
