import { Hono } from "hono";
import { sentryMiddleware } from "./telemetry/middleware.js";
import { healthRoutes } from "./routes/health.js";

export const app = new Hono();

app.use("*", sentryMiddleware);
app.route("/", healthRoutes);
