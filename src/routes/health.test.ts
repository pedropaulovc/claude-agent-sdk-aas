import { describe, it, expect } from "vitest";
import { app } from "../server.js";

describe("GET /v1/health", () => {
  it("returns ok status with expected shape", async () => {
    const res = await app.request("/v1/health");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.uptime).toBe("number");
    expect(body.instanceCount).toBe(0);
  });

  it("returns uptime as a positive number", async () => {
    const res = await app.request("/v1/health");
    const body = await res.json();
    expect(body.uptime).toBeGreaterThan(0);
  });
});
