import { Hono } from "hono";

export const healthRoutes = new Hono();

healthRoutes.get("/v1/health", (c) => {
  return c.json({
    status: "ok",
    uptime: process.uptime(),
    instanceCount: 0,
  });
});
