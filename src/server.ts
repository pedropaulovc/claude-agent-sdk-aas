import { Hono } from "hono";
import { healthRoutes } from "./routes/health.js";

export const app = new Hono();

app.route("/", healthRoutes);
