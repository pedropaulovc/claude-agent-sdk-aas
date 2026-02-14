import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dashboardHtml = readFileSync(resolve(__dirname, "../ui/dashboard.html"), "utf-8");

export const uiRoutes = new Hono();

uiRoutes.get("/ui", (c) => {
  return c.html(dashboardHtml);
});
