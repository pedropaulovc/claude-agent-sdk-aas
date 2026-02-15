import { Hono } from "hono";
import { store, StoreError } from "../registry/store.js";
import { provisionSchema, updateSchema } from "../shared/types.js";
import type { InstanceRecord } from "../shared/types.js";
import type { WorkerPool, WorkerEntry } from "../railway/pool.js";
import { healthPoller } from "../railway/health-poller.js";
import { jsonResponse } from "../telemetry/middleware.js";
import {
  logInfo,
  logError,
  withSpan,
  countMetric,
  distributionMetric,
} from "../telemetry/helpers.js";

export const instanceRoutes = new Hono();

let pool: WorkerPool | null = null;

export function setWorkerPool(p: WorkerPool): void {
  pool = p;
}

function getPool(): WorkerPool {
  if (!pool) {
    throw new Error("WorkerPool not initialized — setWorkerPool() must be called before handling requests");
  }
  return pool;
}

const ACTIVATION_TIMEOUT_MS = 30_000;

async function activateWorker(
  worker: WorkerEntry,
  instance: InstanceRecord,
): Promise<void> {
  const body = {
    instanceName: instance.name,
    systemPrompt: instance.systemPrompt,
    mcpServers: instance.mcpServers,
    model: instance.model,
    maxTurns: instance.maxTurns,
    maxBudgetUsd: instance.maxBudgetUsd,
  };

  logInfo(`${instance.name} | activating worker ${worker.workerNumber}`, {
    workerUrl: worker.workerUrl,
    workerNumber: worker.workerNumber,
  });

  const response = await fetch(`${worker.workerUrl}/activate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ACTIVATION_TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "unknown");
    throw new Error(`Worker activation returned HTTP ${response.status}: ${text}`);
  }

  logInfo(`${instance.name} | worker ${worker.workerNumber} activated successfully`, {
    workerNumber: worker.workerNumber,
  });
}

async function asyncProvision(instance: InstanceRecord): Promise<void> {
  return withSpan("instance.asyncProvision", "provisioner", async () => {
    const start = Date.now();
    const workerPool = getPool();

    logInfo(`${instance.name} | async provision started`);

    const worker = workerPool.claimWorker();
    if (!worker) {
      instance.status = "error";
      instance.provisionError = "No dormant workers available in the pool";
      logError(`${instance.name} | no dormant workers available`);
      countMetric("provision.count", 1, { status: "error" });
      return;
    }

    try {
      await activateWorker(worker, instance);

      workerPool.assignWorker(worker.workerNumber, instance.name);

      instance.status = "ready";
      instance.workerUrl = worker.workerUrl;
      instance.railwayServiceId = worker.serviceId;
      instance.workerNumber = worker.workerNumber;
      instance.provisionError = null;

      const elapsed = Date.now() - start;
      countMetric("provision.count", 1, { status: "success" });
      distributionMetric("provision.duration_ms", elapsed, "ms");
      logInfo(`${instance.name} | provision complete, status -> ready`, {
        workerNumber: worker.workerNumber,
        workerUrl: worker.workerUrl,
        serviceId: worker.serviceId,
        elapsed,
      });

      healthPoller.startOngoingPolling(instance.name, worker.workerUrl, store);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const elapsed = Date.now() - start;

      instance.status = "error";
      instance.provisionError = message;

      logError(`${instance.name} | activation failed: ${message}`, {
        workerNumber: worker.workerNumber,
        elapsed,
      });
      countMetric("provision.count", 1, { status: "error" });

      try {
        await workerPool.releaseWorker(worker.workerNumber);
        logInfo(`${instance.name} | released failed worker ${worker.workerNumber}`);
      } catch (releaseErr: unknown) {
        const releaseMessage = releaseErr instanceof Error ? releaseErr.message : String(releaseErr);
        logError(`${instance.name} | failed to release worker ${worker.workerNumber}: ${releaseMessage}`);
      }
    }
  });
}

async function asyncUpdate(
  instance: InstanceRecord,
  oldWorkerNumber: number | null,
): Promise<void> {
  return withSpan("instance.asyncUpdate", "provisioner", async () => {
    const start = Date.now();
    const workerPool = getPool();

    logInfo(`${instance.name} | async update started`, {
      oldWorkerNumber,
    });

    // Release old worker
    if (oldWorkerNumber !== null) {
      healthPoller.stopPolling(instance.name);
      try {
        await workerPool.releaseWorker(oldWorkerNumber);
        logInfo(`${instance.name} | released old worker ${oldWorkerNumber}`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logError(`${instance.name} | failed to release old worker ${oldWorkerNumber}: ${message}`);
      }
    }

    // Claim a new worker
    const worker = workerPool.claimWorker();
    if (!worker) {
      instance.status = "error";
      instance.provisionError = "No dormant workers available in the pool";
      instance.workerUrl = null;
      instance.railwayServiceId = null;
      instance.workerNumber = null;
      logError(`${instance.name} | no dormant workers available for update`);
      countMetric("update.count", 1, { status: "error" });
      return;
    }

    try {
      await activateWorker(worker, instance);

      workerPool.assignWorker(worker.workerNumber, instance.name);

      instance.status = "ready";
      instance.workerUrl = worker.workerUrl;
      instance.railwayServiceId = worker.serviceId;
      instance.workerNumber = worker.workerNumber;
      instance.provisionError = null;

      const elapsed = Date.now() - start;
      countMetric("update.count", 1, { status: "success" });
      distributionMetric("update.duration_ms", elapsed, "ms");
      logInfo(`${instance.name} | update complete, status -> ready`, {
        workerNumber: worker.workerNumber,
        workerUrl: worker.workerUrl,
        elapsed,
      });

      healthPoller.startOngoingPolling(instance.name, worker.workerUrl, store);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const elapsed = Date.now() - start;

      instance.status = "error";
      instance.provisionError = message;
      instance.workerUrl = null;
      instance.railwayServiceId = null;
      instance.workerNumber = null;

      logError(`${instance.name} | update activation failed: ${message}`, {
        workerNumber: worker.workerNumber,
        elapsed,
      });
      countMetric("update.count", 1, { status: "error" });

      try {
        await workerPool.releaseWorker(worker.workerNumber);
      } catch (releaseErr: unknown) {
        const releaseMessage = releaseErr instanceof Error ? releaseErr.message : String(releaseErr);
        logError(`${instance.name} | failed to release worker after update failure: ${releaseMessage}`);
      }
    }
  });
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

      // Fire-and-forget: claim worker, activate, update store
      void asyncProvision(instance);

      logInfo("api.provision | accepted", { name: instance.name });
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

// PATCH /v1/instances/* — Update (destroy + re-provision with new config)
instanceRoutes.patch("/v1/instances/*", async (c) => {
  return withSpan("api.update", "http.handler", async () => {
    const name = c.req.param("*") ?? c.req.path.replace("/v1/instances/", "");
    const parsed = updateSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return jsonResponse(c, { error: parsed.error.message }, 400);
    }

    try {
      const updated = await store.update(name, parsed.data);
      const oldWorkerNumber = updated.workerNumber;

      // Fire-and-forget: release old worker, claim new, activate with merged config
      void asyncUpdate(updated, oldWorkerNumber);

      logInfo("api.update | accepted", { name });
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
instanceRoutes.delete("/v1/instances/*", async (c) => {
  return withSpan("api.delete", "http.handler", async () => {
    const name = c.req.param("*") ?? c.req.path.replace("/v1/instances/", "");
    const workerPool = getPool();

    // Gather instances to delete (prefix match)
    const instances = store.list(name);
    if (instances.length === 0) {
      logInfo("api.delete | nothing to delete", { name });
      return jsonResponse(c, { deleted: 0 }, 200);
    }

    // Release workers for all matching instances
    const releasePromises: Promise<void>[] = [];
    for (const instance of instances) {
      if (instance.workerNumber !== null) {
        healthPoller.stopPolling(instance.name);
        releasePromises.push(
          workerPool.releaseWorker(instance.workerNumber).catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            logError(`${instance.name} | failed to release worker on delete: ${message}`, {
              workerNumber: instance.workerNumber ?? 0,
            });
          }),
        );
      } else {
        healthPoller.stopPolling(instance.name);
      }
    }

    // Wait for all worker releases to complete
    await Promise.all(releasePromises);

    // Remove from store
    const deleted = store.nukeByPrefix(name);
    logInfo("api.delete | complete", { name, deleted });
    return jsonResponse(c, { deleted }, 200);
  });
});
