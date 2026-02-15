import { Hono } from "hono";
import { sentryMiddleware } from "../telemetry/middleware.js";
import { workerRoutes } from "./routes.js";

export const workerApp = new Hono();

workerApp.use("*", sentryMiddleware);
workerApp.route("/", workerRoutes);
