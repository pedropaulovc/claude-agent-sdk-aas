import { initSentry } from "./telemetry/init.js";
import { logInfo } from "./telemetry/helpers.js";
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

  const PORT = Number(process.env["PORT"] ?? 8080);
  serve({ fetch: app.fetch, port: PORT }, () => {
    logInfo("control-plane started", { port: PORT });
    console.log(`Control plane started on port ${PORT}`);
  });
} else {
  const { parseWorkerConfig, parseMinimalWorkerConfig } = await import("./worker/config.js");
  const { initWorkerRoutes, initWorkerPoolMode } = await import("./worker/routes.js");
  const { workerApp } = await import("./worker/server.js");
  const { serve } = await import("@hono/node-server");

  const hasInstanceName = Boolean(process.env["AAS_INSTANCE_NAME"]);

  if (hasInstanceName) {
    // Standalone / M4 compat mode
    let config;
    try {
      config = parseWorkerConfig();
    } catch (err) {
      console.error(`Fatal: ${(err as Error).message}`);
      process.exit(1);
    }

    initWorkerRoutes(config);
    logInfo("worker config parsed", {
      instanceName: config.instanceName,
      model: config.model,
    });

    serve({ fetch: workerApp.fetch, port: config.port }, () => {
      logInfo("worker started", {
        instanceName: config.instanceName,
        port: config.port,
      });
      console.log(
        `Worker started on port ${config.port} for instance ${config.instanceName}`,
      );
    });
  } else {
    // Pool mode — start idle, await POST /configure
    let minimalConfig;
    try {
      minimalConfig = parseMinimalWorkerConfig();
    } catch (err) {
      console.error(`Fatal: ${(err as Error).message}`);
      process.exit(1);
    }

    initWorkerPoolMode(minimalConfig);
    logInfo("worker started in pool mode (idle)", { port: minimalConfig.port });

    serve({ fetch: workerApp.fetch, port: minimalConfig.port }, () => {
      logInfo("worker listening", { port: minimalConfig.port, mode: "pool" });
      console.log(
        `Worker started on port ${minimalConfig.port} in pool mode (idle)`,
      );
    });
  }
}
