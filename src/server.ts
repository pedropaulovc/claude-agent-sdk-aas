import { Hono } from "hono";
import { sentryMiddleware } from "./telemetry/middleware.js";
import { healthRoutes } from "./routes/health.js";
import { instanceRoutes } from "./routes/instances.js";

export const app = new Hono();

app.use("*", sentryMiddleware);
app.route("/", healthRoutes);
app.route("/", instanceRoutes);
