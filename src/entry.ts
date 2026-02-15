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
