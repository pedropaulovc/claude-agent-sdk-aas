import { describe, it, expect } from "vitest";
import { createDormantState, activate } from "./activation.js";
import type { BootConfig } from "./config.js";

function makeBootConfig(overrides: Partial<BootConfig> = {}): BootConfig {
  return {
    anthropicApiKey: "sk-ant-test-key",
    sentryDsn: "https://test@sentry.io/123",
    port: 8080,
    ...overrides,
  };
}

function makeValidActivationBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    instanceName: "dev/A/michael",
    systemPrompt: "You are a helpful assistant.",
    ...overrides,
  };
}

function assertDefined<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  expect(value).not.toBeNull();
  return value as T;
}

describe("worker activation", () => {
  it("createDormantState returns correct initial state", () => {
    const bootConfig = makeBootConfig();
    const state = createDormantState(bootConfig);

    expect(state.status).toBe("dormant");
    expect(state.instanceName).toBeNull();
    expect(state.bootConfig).toBe(bootConfig);
    expect(state.sdkRunner).toBeNull();
    expect(state.invocationQueue).toBeNull();
    expect(state.historyStore).toBeNull();
    expect(typeof state.startedAt).toBe("string");
  });

  it("activate with valid body transitions to active", () => {
    const state = createDormantState(makeBootConfig());
    const result = activate(state, makeValidActivationBody());

    expect(result.success).toBe(true);
    expect(state.status).toBe("active");
    expect(state.instanceName).toBe("dev/A/michael");
    expect(state.sdkRunner).not.toBeNull();
    expect(state.invocationQueue).not.toBeNull();
    expect(state.historyStore).not.toBeNull();
  });

  it("activate applies default values for optional fields", () => {
    const state = createDormantState(makeBootConfig());
    activate(state, makeValidActivationBody());

    const runner = assertDefined(state.sdkRunner);
    expect(runner.config.model).toBe("claude-haiku-4-5-20251001");
    expect(runner.config.maxTurns).toBe(50);
    expect(runner.config.maxBudgetUsd).toBe(1.0);
    expect(runner.config.mcpServers).toEqual([]);
  });

  it("activate on already-active returns 409", () => {
    const state = createDormantState(makeBootConfig());
    activate(state, makeValidActivationBody());

    const result = activate(state, makeValidActivationBody());

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe("already_active");
      expect(result.status).toBe(409);
    }
  });

  it("activate with invalid body returns 400", () => {
    const state = createDormantState(makeBootConfig());

    // Missing required fields
    const result = activate(state, {});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe("validation_error");
      expect(result.status).toBe(400);
      expect(result.error).toContain("Validation error");
    }
  });

  it("activate with invalid instanceName returns 400", () => {
    const state = createDormantState(makeBootConfig());
    const result = activate(state, makeValidActivationBody({ instanceName: "!!invalid!!" }));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe("validation_error");
      expect(result.status).toBe(400);
    }
  });

  it("activate with empty systemPrompt returns 400", () => {
    const state = createDormantState(makeBootConfig());
    const result = activate(state, makeValidActivationBody({ systemPrompt: "" }));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe("validation_error");
      expect(result.status).toBe(400);
    }
  });

  it("activate passes boot config secrets to sdkRunner", () => {
    const bootConfig = makeBootConfig({ anthropicApiKey: "sk-ant-my-key", sentryDsn: "https://my@sentry.io/456" });
    const state = createDormantState(bootConfig);
    activate(state, makeValidActivationBody());

    const runner = assertDefined(state.sdkRunner);
    expect(runner.config.anthropicApiKey).toBe("sk-ant-my-key");
    expect(runner.config.sentryDsn).toBe("https://my@sentry.io/456");
  });

  it("activate with custom model and maxTurns", () => {
    const state = createDormantState(makeBootConfig());
    activate(state, makeValidActivationBody({
      model: "claude-sonnet-4-20250514",
      maxTurns: 100,
      maxBudgetUsd: 5.0,
    }));

    const runner = assertDefined(state.sdkRunner);
    expect(runner.config.model).toBe("claude-sonnet-4-20250514");
    expect(runner.config.maxTurns).toBe(100);
    expect(runner.config.maxBudgetUsd).toBe(5.0);
  });
});
