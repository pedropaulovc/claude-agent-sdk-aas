import { Hono } from "hono";
import { sentryMiddleware } from "./telemetry/middleware.js";
import { healthRoutes } from "./routes/health.js";
import { instanceRoutes } from "./routes/instances.js";
import { invokeRoutes } from "./routes/invoke.js";
import { uiRoutes } from "./routes/ui.js";

export const app = new Hono();

app.use("*", sentryMiddleware);
app.route("/", uiRoutes);
app.route("/", healthRoutes);
app.route("/", invokeRoutes);
app.route("/", instanceRoutes);
