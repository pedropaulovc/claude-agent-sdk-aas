import { initSentry } from "./telemetry/init.js";
import { logInfo, logError } from "./telemetry/helpers.js";
import { validateRole } from "./shared/role.js";

let role;
try {
  role = validateRole(process.env["AAS_ROLE"]);
} catch (err) {
  console.error(`Fatal: ${(err as Error).message}`);
  process.exit(1);
}

initSentry();
logInfo("entry | role selected", { role });

if (role === "control-plane") {
  const { serve } = await import("@hono/node-server");
  const { app } = await import("./server.js");
  const { WorkerPool } = await import("./railway/pool.js");
  const { getRailwayClient } = await import("./railway/client.js");
  const { setWorkerPool } = await import("./routes/instances.js");

  const PORT = Number(process.env["PORT"] ?? 8080);
  const MIN_DORMANT = Number(process.env["AAS_MIN_DORMANT"] ?? 10);
  const MONITOR_INTERVAL_MS = Number(process.env["AAS_MONITOR_INTERVAL_MS"] ?? 60_000);
  const GHCR_IMAGE = process.env["AAS_GHCR_IMAGE"] ?? "ghcr.io/pedropaulovc/aas-worker:latest";

  serve({ fetch: app.fetch, port: PORT }, () => {
    logInfo("control-plane started", { port: PORT });
    console.log(`Control plane started on port ${PORT}`);

    // Boot the worker pool asynchronously after server is listening
    void (async () => {
      try {
        const railwayClient = getRailwayClient();

        const pool = new WorkerPool({
          railwayClient,
          ghcrImage: GHCR_IMAGE,
          minDormant: MIN_DORMANT,
          monitorIntervalMs: MONITOR_INTERVAL_MS,
          secrets: {
            ANTHROPIC_API_KEY: process.env["ANTHROPIC_API_KEY"] ?? "",
            SENTRY_DSN: process.env["SENTRY_DSN"] ?? "",
          },
        });

        setWorkerPool(pool);

        logInfo("pool | discovering existing workers");
        await pool.discoverExistingWorkers();

        logInfo("pool | ensuring minimum pool size", { minDormant: MIN_DORMANT });
        await pool.ensurePoolSize(MIN_DORMANT);

        pool.startPoolMonitor();
        logInfo("pool | monitor started", {
          minDormant: MIN_DORMANT,
          monitorIntervalMs: MONITOR_INTERVAL_MS,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logError(`pool | boot failed: ${message}`);
        console.error(`Pool boot failed: ${message}`);
      }
    })();
  });
} else {
  const { parseBootConfig } = await import("./worker/config.js");
  const { createDormantState } = await import("./worker/activation.js");
  const { initWorkerState } = await import("./worker/routes.js");
  const { workerApp } = await import("./worker/server.js");
  const { serve } = await import("@hono/node-server");

  let bootConfig;
  try {
    bootConfig = parseBootConfig();
  } catch (err) {
    console.error(`Fatal: ${(err as Error).message}`);
    process.exit(1);
  }

  const workerState = createDormantState(bootConfig);
  initWorkerState(workerState);

  logInfo("worker booting dormant", { port: bootConfig.port });

  serve({ fetch: workerApp.fetch, port: bootConfig.port }, () => {
    logInfo("worker started (dormant)", { port: bootConfig.port });
    console.log(`Worker started on port ${bootConfig.port} (dormant)`);
  });
}
