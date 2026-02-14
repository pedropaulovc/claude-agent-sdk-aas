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
  logInfo("worker mode selected — placeholder, exiting");
  console.log("Worker mode: not yet implemented. Exiting.");
  process.exit(0);
}
