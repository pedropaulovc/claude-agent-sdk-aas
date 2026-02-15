import { describe, it, expect, beforeAll } from "vitest";
import { workerApp } from "./server.js";
import { initWorkerRoutes } from "./routes.js";
import { parseWorkerConfig, type WorkerConfig } from "./config.js";

function makeValidEnv(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    AAS_INSTANCE_NAME: "dev/A/michael",
    AAS_SYSTEM_PROMPT: "You are a helpful assistant.",
    ANTHROPIC_API_KEY: "sk-ant-test-key",
    SENTRY_DSN: "https://test@sentry.io/123",
    ...overrides,
  };
}

function makeConfig(overrides: Record<string, string> = {}): WorkerConfig {
  return parseWorkerConfig(makeValidEnv(overrides));
}

describe("worker routes and config", () => {
  beforeAll(() => {
    initWorkerRoutes(makeConfig());
  });

  it("GET /health returns 200 with status ok and instanceName", async () => {
    const res = await workerApp.request("/health");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.instanceName).toBe("dev/A/michael");
  });

  it("parseWorkerConfig succeeds with valid required-only env", () => {
    const config = makeConfig();
    expect(config.instanceName).toBe("dev/A/michael");
    expect(config.systemPrompt).toBe("You are a helpful assistant.");
    expect(config.anthropicApiKey).toBe("sk-ant-test-key");
    expect(config.sentryDsn).toBe("https://test@sentry.io/123");
  });

  it("parseWorkerConfig applies defaults for optional vars", () => {
    const config = makeConfig();
    expect(config.mcpServers).toEqual([]);
    expect(config.model).toBe("claude-haiku-4-5-20251001");
    expect(config.maxTurns).toBe(50);
    expect(config.maxBudgetUsd).toBe(1.0);
    expect(config.port).toBe(8080);
  });

  it("parseWorkerConfig uses provided optional values", () => {
    const config = makeConfig({
      AAS_MODEL: "claude-sonnet-4-20250514",
      AAS_MAX_TURNS: "100",
      AAS_MAX_BUDGET_USD: "5.0",
      PORT: "3000",
    });
    expect(config.model).toBe("claude-sonnet-4-20250514");
    expect(config.maxTurns).toBe(100);
    expect(config.maxBudgetUsd).toBe(5.0);
    expect(config.port).toBe(3000);
  });

  it("parseWorkerConfig parses valid AAS_MCP_SERVERS JSON", () => {
    const servers = [
      { name: "test-mcp", url: "https://mcp.example.com" },
      {
        name: "auth-mcp",
        url: "https://auth.example.com",
        headers: { Authorization: "Bearer token" },
      },
    ];
    const config = makeConfig({
      AAS_MCP_SERVERS: JSON.stringify(servers),
    });
    expect(config.mcpServers).toHaveLength(2);
    expect(config.mcpServers[0].name).toBe("test-mcp");
    expect(config.mcpServers[1].headers).toEqual({
      Authorization: "Bearer token",
    });
  });

  it("parseWorkerConfig throws on missing required AAS_INSTANCE_NAME", () => {
    const env = makeValidEnv();
    delete env["AAS_INSTANCE_NAME"];
    expect(() => parseWorkerConfig(env)).toThrow("Worker config validation failed");
    expect(() => parseWorkerConfig(env)).toThrow("instanceName");
  });

  it("parseWorkerConfig throws on missing required AAS_SYSTEM_PROMPT", () => {
    const env = makeValidEnv();
    delete env["AAS_SYSTEM_PROMPT"];
    expect(() => parseWorkerConfig(env)).toThrow("Worker config validation failed");
    expect(() => parseWorkerConfig(env)).toThrow("systemPrompt");
  });

  it("parseWorkerConfig throws on missing required ANTHROPIC_API_KEY", () => {
    const env = makeValidEnv();
    delete env["ANTHROPIC_API_KEY"];
    expect(() => parseWorkerConfig(env)).toThrow("Worker config validation failed");
    expect(() => parseWorkerConfig(env)).toThrow("anthropicApiKey");
  });

  it("parseWorkerConfig throws on invalid JSON for AAS_MCP_SERVERS", () => {
    expect(() =>
      parseWorkerConfig(makeValidEnv({ AAS_MCP_SERVERS: "not-json" })),
    ).toThrow("invalid JSON");
  });

  it("parseWorkerConfig throws on invalid MCP server schema", () => {
    const invalidServers = [{ name: "", url: "not-a-url" }];
    expect(() =>
      parseWorkerConfig(
        makeValidEnv({ AAS_MCP_SERVERS: JSON.stringify(invalidServers) }),
      ),
    ).toThrow("Worker config validation failed");
  });
});
