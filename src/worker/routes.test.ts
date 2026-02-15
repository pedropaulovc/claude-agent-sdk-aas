import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import * as Sentry from "@sentry/node";
import { workerApp } from "./server.js";
import {
  initWorkerRoutes,
  initWorkerPoolMode,
  getInvocationQueue,
  getHistoryStore,
  getWorkerState,
  getInstanceName,
} from "./routes.js";
import {
  parseWorkerConfig,
  parseMinimalWorkerConfig,
  type WorkerConfig,
  type MinimalWorkerConfig,
} from "./config.js";
import type { RunFn } from "./queue.js";

const mockSetTag = vi.fn();

vi.mock("@sentry/node", async () => {
  const actual = await vi.importActual<typeof Sentry>("@sentry/node");
  return {
    ...actual,
    startSpan: vi.fn((_opts, cb) =>
      cb({
        setAttribute: vi.fn(),
        spanContext: () => ({ traceId: "test-trace-id" }),
      }),
    ),
    getActiveSpan: vi.fn(() => ({
      spanContext: () => ({ traceId: "test-trace-id" }),
    })),
    continueTrace: vi.fn((_opts, cb) => cb()),
    getCurrentScope: vi.fn(() => ({
      setTag: mockSetTag,
    })),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
});

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

function makeMinimalConfig(
  overrides: Record<string, string> = {},
): MinimalWorkerConfig {
  return parseMinimalWorkerConfig({
    ANTHROPIC_API_KEY: "sk-ant-test-key",
    SENTRY_DSN: "https://test@sentry.io/123",
    ...overrides,
  });
}

function makeConfigurePayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    instanceName: "pool/worker-1",
    systemPrompt: "You are a pool worker.",
    mcpServers: [],
    model: "claude-haiku-4-5-20251001",
    maxTurns: 50,
    maxBudgetUsd: 1.0,
    ...overrides,
  };
}

function tick(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertDefined<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  return value as T;
}

describe("worker routes and config", () => {
  // --- Standalone (M4 compat) mode tests ---

  describe("standalone mode", () => {
    beforeAll(() => {
      initWorkerRoutes(makeConfig());
    });

    it("Worker starts in active state when AAS_INSTANCE_NAME is set", () => {
      expect(getWorkerState()).toBe("active");
      expect(getInstanceName()).toBe("dev/A/michael");
    });

    it("GET /health returns 200 with status ok, instanceName, and state", async () => {
      const res = await workerApp.request("/health");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body.instanceName).toBe("dev/A/michael");
      expect(body.state).toBe("active");
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

      const neverFinish: RunFn = async function* (_msg, _id, signal) {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      };
      queue.setRunner(neverFinish);

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

      await tick(50);
    });

    it("POST /reset clears history, queue, and session (standalone mode)", async () => {
      // Re-init to ensure clean state
      initWorkerRoutes(makeConfig());
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
      expect(body.state).toBe("idle");
      // After reset, worker goes to idle
      expect(getWorkerState()).toBe("idle");
    });

    it("POST /reset returns 409 when invocation is running (standalone mode)", async () => {
      initWorkerRoutes(makeConfig());
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
      expect(body.error).toBe("Cannot reset while invocation is active");
      expect(body.code).toBe("invocation_active");

      queue.abort();
      await tick(50);
    });
  });

  // --- Pool mode tests ---

  describe("pool mode", () => {
    beforeEach(() => {
      mockSetTag.mockClear();
      initWorkerPoolMode(makeMinimalConfig());
    });

    it("Worker starts in idle state when no AAS_INSTANCE_NAME", () => {
      expect(getWorkerState()).toBe("idle");
      expect(getInstanceName()).toBeNull();
    });

    it("GET /health includes state and instanceName when idle", async () => {
      const res = await workerApp.request("/health");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body.instanceName).toBeNull();
      expect(body.state).toBe("idle");
    });

    it("POST /message returns 503 when idle", async () => {
      const res = await workerApp.request("/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      });
      expect(res.status).toBe(503);

      const body = await res.json();
      expect(body.error).toBe("Worker is idle");
      expect(body.state).toBe("idle");
    });

    it("GET /history returns 503 when idle", async () => {
      const res = await workerApp.request("/history");
      expect(res.status).toBe(503);

      const body = await res.json();
      expect(body.error).toBe("Worker is idle");
      expect(body.state).toBe("idle");
    });

    it("POST /abort returns 503 when idle", async () => {
      const res = await workerApp.request("/abort", { method: "POST" });
      expect(res.status).toBe(503);

      const body = await res.json();
      expect(body.error).toBe("Worker is idle");
      expect(body.state).toBe("idle");
    });

    it("POST /configure transitions idle -> active", async () => {
      const res = await workerApp.request("/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makeConfigurePayload()),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.configured).toBe(true);
      expect(body.instanceName).toBe("pool/worker-1");
      expect(body.state).toBe("active");
      expect(getWorkerState()).toBe("active");
      expect(getInstanceName()).toBe("pool/worker-1");
    });

    it("POST /configure on active worker resets first, then applies new config", async () => {
      // First configure
      await workerApp.request("/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makeConfigurePayload({ instanceName: "pool/first" })),
      });
      expect(getWorkerState()).toBe("active");
      expect(getInstanceName()).toBe("pool/first");

      // Add some history
      const store = assertDefined(getHistoryStore());
      store.append({
        role: "user",
        content: "old message",
        timestamp: new Date().toISOString(),
        invocationId: "old-inv",
      });
      expect(store.count).toBe(1);

      // Reconfigure with different instance
      const res = await workerApp.request("/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makeConfigurePayload({
          instanceName: "pool/second",
          systemPrompt: "New prompt",
        })),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.configured).toBe(true);
      expect(body.instanceName).toBe("pool/second");
      expect(body.state).toBe("active");
      expect(getInstanceName()).toBe("pool/second");

      // History should be fresh (cleared during implicit reset)
      const newStore = assertDefined(getHistoryStore());
      expect(newStore.count).toBe(0);
    });

    it("POST /configure returns 400 for invalid payload", async () => {
      const res = await workerApp.request("/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instanceName: "" }),
      });
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toBeDefined();
    });

    it("POST /configure returns 400 for invalid JSON", async () => {
      const res = await workerApp.request("/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      });
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toBe("Invalid JSON body");
    });

    it("POST /reset from active -> idle", async () => {
      // Configure first
      await workerApp.request("/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makeConfigurePayload()),
      });
      expect(getWorkerState()).toBe("active");

      // Reset
      const res = await workerApp.request("/reset", { method: "POST" });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.reset).toBe(true);
      expect(body.instanceName).toBe("pool/worker-1");
      expect(body.state).toBe("idle");
      expect(getWorkerState()).toBe("idle");
      expect(getInstanceName()).toBeNull();
    });

    it("POST /reset when idle is no-op (200)", async () => {
      expect(getWorkerState()).toBe("idle");

      const res = await workerApp.request("/reset", { method: "POST" });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.reset).toBe(true);
      expect(body.instanceName).toBeNull();
      expect(body.state).toBe("idle");
      expect(getWorkerState()).toBe("idle");
    });

    it("POST /reset returns 409 when invocation is active", async () => {
      // Configure first
      await workerApp.request("/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makeConfigurePayload()),
      });

      const queue = assertDefined(getInvocationQueue());

      const neverFinish: RunFn = async function* (_msg, _id, signal) {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      };
      queue.setRunner(neverFinish);

      queue.enqueue({
        invocationId: "active-pool-inv",
        message: "test",
        onEvent: () => {},
        signal: new AbortController().signal,
      });
      await tick();

      const res = await workerApp.request("/reset", { method: "POST" });
      expect(res.status).toBe(409);

      const body = await res.json();
      expect(body.error).toBe("Cannot reset while invocation is active");
      expect(body.code).toBe("invocation_active");

      queue.abort();
      await tick(50);
    });

    it("GET /health includes state and instanceName after configure", async () => {
      await workerApp.request("/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makeConfigurePayload()),
      });

      const res = await workerApp.request("/health");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body.instanceName).toBe("pool/worker-1");
      expect(body.state).toBe("active");
    });

    it("endpoints work after configure", async () => {
      await workerApp.request("/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makeConfigurePayload()),
      });

      // /history should work
      const historyRes = await workerApp.request("/history");
      expect(historyRes.status).toBe(200);
      const historyBody = await historyRes.json();
      expect(historyBody.instanceName).toBe("pool/worker-1");
      expect(historyBody.messages).toEqual([]);

      // /abort should work (no active invocation)
      const abortRes = await workerApp.request("/abort", { method: "POST" });
      expect(abortRes.status).toBe(200);
      const abortBody = await abortRes.json();
      expect(abortBody.aborted).toBe(false);
    });

    it("POST /configure sets Sentry service name tag", async () => {
      await workerApp.request("/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makeConfigurePayload({ instanceName: "pool/sentry-test" })),
      });

      expect(mockSetTag).toHaveBeenCalledWith("service.name", "aas-worker-pool/sentry-test");
    });

    it("POST /reset resets Sentry service name tag to idle", async () => {
      await workerApp.request("/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makeConfigurePayload()),
      });
      mockSetTag.mockClear();

      await workerApp.request("/reset", { method: "POST" });

      expect(mockSetTag).toHaveBeenCalledWith("service.name", "aas-worker-idle");
    });

    it("GET /status returns 200 with null fields when idle", async () => {
      const res = await workerApp.request("/status");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.instanceName).toBeNull();
      expect(body.state).toBe("idle");
      expect(body.model).toBeNull();
      expect(body.sessionId).toBeNull();
      expect(body.messageCount).toBe(0);
      expect(body.totalCostUsd).toBe(0);
      expect(body.queueDepth).toBe(0);
      expect(body.activeInvocationId).toBeNull();
      expect(body.configuredAt).toBeNull();
      expect(typeof body.uptime).toBe("number");
      expect(typeof body.startedAt).toBe("string");
    });

    it("GET /status includes configuredAt when active", async () => {
      await workerApp.request("/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makeConfigurePayload()),
      });

      const res = await workerApp.request("/status");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.instanceName).toBe("pool/worker-1");
      expect(body.state).toBe("active");
      expect(body.model).toBe("claude-haiku-4-5-20251001");
      expect(typeof body.configuredAt).toBe("string");
      expect(body.configuredAt).not.toBeNull();
    });

    it("POST /configure returns 409 when active worker has running invocation", async () => {
      // Configure first
      await workerApp.request("/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makeConfigurePayload()),
      });

      const queue = assertDefined(getInvocationQueue());

      const neverFinish: RunFn = async function* (_msg, _id, signal) {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      };
      queue.setRunner(neverFinish);

      queue.enqueue({
        invocationId: "active-reconfig-inv",
        message: "test",
        onEvent: () => {},
        signal: new AbortController().signal,
      });
      await tick();

      // Try to reconfigure while invocation is active
      const res = await workerApp.request("/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makeConfigurePayload({ instanceName: "pool/new-instance" })),
      });
      expect(res.status).toBe(409);

      const body = await res.json();
      expect(body.error).toBe("Cannot reconfigure while invocation is active");

      queue.abort();
      await tick(50);
    });
  });

  // --- Config parsing tests ---

  describe("config parsing", () => {
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

    it("parseMinimalWorkerConfig succeeds with valid env", () => {
      const config = makeMinimalConfig();
      expect(config.anthropicApiKey).toBe("sk-ant-test-key");
      expect(config.sentryDsn).toBe("https://test@sentry.io/123");
      expect(config.port).toBe(8080);
    });

    it("parseMinimalWorkerConfig uses custom PORT", () => {
      const config = makeMinimalConfig({ PORT: "3000" });
      expect(config.port).toBe(3000);
    });

    it("parseMinimalWorkerConfig throws on missing ANTHROPIC_API_KEY", () => {
      expect(() =>
        parseMinimalWorkerConfig({ SENTRY_DSN: "https://test@sentry.io/123" }),
      ).toThrow("Minimal worker config validation failed");
    });
  });
});
