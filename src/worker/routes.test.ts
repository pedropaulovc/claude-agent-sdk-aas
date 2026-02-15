import { describe, it, expect, beforeEach } from "vitest";
import { workerApp } from "./server.js";
import { initWorkerState, getWorkerState } from "./routes.js";
import { createDormantState, activate } from "./activation.js";
import { parseBootConfig, type BootConfig } from "./config.js";
import type { RunFn } from "./queue.js";

function makeBootConfig(overrides: Partial<BootConfig> = {}): BootConfig {
  return {
    anthropicApiKey: "sk-ant-test-key",
    sentryDsn: "https://test@sentry.io/123",
    port: 8080,
    ...overrides,
  };
}

function makeActivationBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    instanceName: "dev/A/michael",
    systemPrompt: "You are a helpful assistant.",
    ...overrides,
  };
}

function tick(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertDefined<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  expect(value).not.toBeNull();
  return value as T;
}

describe("worker routes", () => {
  // --- Dormant state tests ---

  describe("dormant state", () => {
    beforeEach(() => {
      initWorkerState(createDormantState(makeBootConfig()));
    });

    it("GET /health returns 200 with status dormant", async () => {
      const res = await workerApp.request("/health");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.status).toBe("dormant");
      expect(typeof body.nodeVersion).toBe("string");
      expect(typeof body.platform).toBe("string");
      expect(typeof body.arch).toBe("string");
    });

    it("GET /history returns 503 when dormant", async () => {
      const res = await workerApp.request("/history");
      expect(res.status).toBe(503);

      const body = await res.json();
      expect(body.error).toBe("Worker is dormant");
      expect(body.code).toBe("dormant");
    });

    it("GET /status returns 503 when dormant", async () => {
      const res = await workerApp.request("/status");
      expect(res.status).toBe(503);

      const body = await res.json();
      expect(body.code).toBe("dormant");
    });

    it("POST /abort returns 503 when dormant", async () => {
      const res = await workerApp.request("/abort", { method: "POST" });
      expect(res.status).toBe(503);
    });

    it("POST /reset returns 503 when dormant", async () => {
      const res = await workerApp.request("/reset", { method: "POST" });
      expect(res.status).toBe(503);
    });

    it("POST /message returns 503 when dormant", async () => {
      const res = await workerApp.request("/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      });
      expect(res.status).toBe(503);
    });
  });

  // --- POST /activate tests ---

  describe("POST /activate", () => {
    beforeEach(() => {
      initWorkerState(createDormantState(makeBootConfig()));
    });

    it("activates a dormant worker", async () => {
      const res = await workerApp.request("/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makeActivationBody()),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.activated).toBe(true);
      expect(body.instanceName).toBe("dev/A/michael");

      const state = getWorkerState();
      expect(state.status).toBe("active");
    });

    it("returns 409 if already active", async () => {
      // Activate first
      await workerApp.request("/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makeActivationBody()),
      });

      // Try again
      const res = await workerApp.request("/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makeActivationBody()),
      });
      expect(res.status).toBe(409);

      const body = await res.json();
      expect(body.code).toBe("already_active");
    });

    it("returns 400 on invalid body", async () => {
      const res = await workerApp.request("/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.code).toBe("validation_error");
    });

    it("returns 400 on non-JSON body", async () => {
      const res = await workerApp.request("/activate", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "not json",
      });
      expect(res.status).toBe(400);
    });
  });

  // --- Active state tests ---

  describe("active state", () => {
    beforeEach(() => {
      const state = createDormantState(makeBootConfig());
      initWorkerState(state);
      activate(state, makeActivationBody());
    });

    it("GET /health returns 200 with status ok and instanceName", async () => {
      const res = await workerApp.request("/health");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body.instanceName).toBe("dev/A/michael");
      expect(typeof body.nodeVersion).toBe("string");
    });

    it("GET /history returns 200 with empty messages initially", async () => {
      const state = getWorkerState();
      state.historyStore?.clear();

      const res = await workerApp.request("/history");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.instanceName).toBe("dev/A/michael");
      expect(body.messages).toEqual([]);
    });

    it("GET /history returns accumulated messages", async () => {
      const state = getWorkerState();
      const store = assertDefined(state.historyStore);
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
      const state = getWorkerState();
      const queue = assertDefined(state.invocationQueue);

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
      const state = getWorkerState();
      const store = assertDefined(state.historyStore);
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
      const state = getWorkerState();
      const queue = assertDefined(state.invocationQueue);

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
  });

  // --- parseBootConfig tests ---

  describe("parseBootConfig", () => {
    it("succeeds with valid required-only env", () => {
      const config = parseBootConfig({
        ANTHROPIC_API_KEY: "sk-ant-test-key",
        SENTRY_DSN: "https://test@sentry.io/123",
      });
      expect(config.anthropicApiKey).toBe("sk-ant-test-key");
      expect(config.sentryDsn).toBe("https://test@sentry.io/123");
      expect(config.port).toBe(8080);
    });

    it("applies default port", () => {
      const config = parseBootConfig({
        ANTHROPIC_API_KEY: "sk-ant-test-key",
        SENTRY_DSN: "https://test@sentry.io/123",
      });
      expect(config.port).toBe(8080);
    });

    it("uses provided PORT value", () => {
      const config = parseBootConfig({
        ANTHROPIC_API_KEY: "sk-ant-test-key",
        SENTRY_DSN: "https://test@sentry.io/123",
        PORT: "3000",
      });
      expect(config.port).toBe(3000);
    });

    it("throws on missing ANTHROPIC_API_KEY", () => {
      expect(() =>
        parseBootConfig({ SENTRY_DSN: "https://test@sentry.io/123" }),
      ).toThrow("Worker boot config validation failed");
    });

    it("throws on missing SENTRY_DSN", () => {
      expect(() =>
        parseBootConfig({ ANTHROPIC_API_KEY: "sk-ant-test-key" }),
      ).toThrow("Worker boot config validation failed");
    });
  });
});
