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
  const { parseWorkerConfig } = await import("./worker/config.js");
  const { initWorkerRoutes } = await import("./worker/routes.js");
  const { workerApp } = await import("./worker/server.js");
  const { serve } = await import("@hono/node-server");

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
}
