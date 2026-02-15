import { describe, it, expect, beforeAll } from "vitest";
import { workerApp } from "./server.js";
import { initWorkerRoutes, getInvocationQueue, getHistoryStore } from "./routes.js";
import { parseWorkerConfig, type WorkerConfig } from "./config.js";
import type { RunFn } from "./queue.js";

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

function tick(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertDefined<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  return value as T;
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

  it("GET /history returns 200 with empty messages initially", async () => {
    const store = getHistoryStore();
    store?.clear();

    const res = await workerApp.request("/history");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.instanceName).toBe("dev/A/michael");
    expect(body.messages).toEqual([]);
  });

  it("GET /history returns accumulated messages", async () => {
    const store = assertDefined(getHistoryStore());
    store.clear();
    store.append({
      role: "user",
      content: "Hello",
      timestamp: "2026-02-14T00:00:00.000Z",
      invocationId: "inv-1",
    });
    store.append({
      role: "assistant",
      content: "Hi there!",
      timestamp: "2026-02-14T00:00:01.000Z",
      invocationId: "inv-1",
    });

    const res = await workerApp.request("/history");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].content).toBe("Hello");
    expect(body.messages[1].role).toBe("assistant");
    expect(body.messages[1].content).toBe("Hi there!");
  });

  it("GET /status returns 200 with runtime status fields", async () => {
    const res = await workerApp.request("/status");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.instanceName).toBe("dev/A/michael");
    expect(body.model).toBe("claude-haiku-4-5-20251001");
    expect(body.sessionId).toBeNull();
    expect(typeof body.uptime).toBe("number");
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    expect(body.messageCount).toBe(0);
    expect(body.totalCostUsd).toBe(0);
    expect(body.queueDepth).toBe(0);
    expect(body.activeInvocationId).toBeNull();
    expect(typeof body.startedAt).toBe("string");
  });

  it("POST /abort returns aborted false when no invocation active", async () => {
    const res = await workerApp.request("/abort", { method: "POST" });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.aborted).toBe(false);
    expect(body.reason).toBe("no_active_invocation");
  });

  it("POST /abort returns aborted true when invocation is active", async () => {
    const queue = assertDefined(getInvocationQueue());

    // Set up a runner that blocks until aborted
    const neverFinish: RunFn = async function* (_msg, _id, signal) {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    };
    queue.setRunner(neverFinish);

    // Enqueue an item to make it active
    queue.enqueue({
      invocationId: "abort-test-inv",
      message: "test",
      onEvent: () => {},
      signal: new AbortController().signal,
    });
    await tick();

    const res = await workerApp.request("/abort", { method: "POST" });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.aborted).toBe(true);
    expect(body.invocationId).toBe("abort-test-inv");

    await tick(50); // let the queue drain
  });

  it("POST /reset clears history, queue, and session", async () => {
    const store = assertDefined(getHistoryStore());
    store.append({
      role: "user",
      content: "will be cleared",
      timestamp: new Date().toISOString(),
      invocationId: "inv-reset",
    });

    const res = await workerApp.request("/reset", { method: "POST" });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.reset).toBe(true);
    expect(body.instanceName).toBe("dev/A/michael");

    expect(store.count).toBe(0);
  });

  it("POST /reset returns 409 when invocation is running", async () => {
    const queue = assertDefined(getInvocationQueue());

    const neverFinish: RunFn = async function* (_msg, _id, signal) {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    };
    queue.setRunner(neverFinish);

    queue.enqueue({
      invocationId: "active-inv",
      message: "test",
      onEvent: () => {},
      signal: new AbortController().signal,
    });
    await tick();

    const res = await workerApp.request("/reset", { method: "POST" });
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.error).toBe("Cannot reset while invocation is running");
    expect(body.code).toBe("invocation_active");

    // Clean up: abort the active invocation
    queue.abort();
    await tick(50);
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
