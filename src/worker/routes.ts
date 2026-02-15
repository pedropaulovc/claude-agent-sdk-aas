import { Hono } from "hono";
import { jsonResponse } from "../telemetry/middleware.js";
import type { WorkerConfig } from "./config.js";

let workerConfig: WorkerConfig | null = null;

export function initWorkerRoutes(config: WorkerConfig): void {
  workerConfig = config;
}

export const workerRoutes = new Hono();

workerRoutes.get("/health", (c) => {
  return jsonResponse(c, {
    status: "ok" as const,
    instanceName: workerConfig?.instanceName ?? "unknown",
  });
});
