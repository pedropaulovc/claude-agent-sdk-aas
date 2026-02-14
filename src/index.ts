import { serve } from "@hono/node-server";
import { app } from "./server.js";

const PORT = Number(process.env["PORT"] ?? 8080);

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`Server started on port ${PORT}`);
});
