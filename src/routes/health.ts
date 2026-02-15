import { Hono } from "hono";
import { jsonResponse } from "../telemetry/middleware.js";
import { store } from "../registry/store.js";

export const healthRoutes = new Hono();

healthRoutes.get("/v1/health", (c) => {
  return jsonResponse(c, {
    status: "ok" as const,
    uptime: process.uptime(),
    instanceCount: store.size,
    gitBranch: process.env.RAILWAY_GIT_BRANCH ?? null,
    gitRepo: process.env.RAILWAY_GIT_REPO_NAME ?? null,
  });
});
