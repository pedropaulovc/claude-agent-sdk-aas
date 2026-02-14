import { initSentry } from "./telemetry/init.js";
import { serve } from "@hono/node-server";
import { app } from "./server.js";

initSentry();

const PORT = Number(process.env["PORT"] ?? 8080);

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`Server started on port ${PORT}`);
});
