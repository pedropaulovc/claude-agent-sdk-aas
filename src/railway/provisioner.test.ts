import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Sentry from "@sentry/node";

const mockSetAttribute = vi.fn();

vi.mock("@sentry/node", async () => {
  const actual = await vi.importActual<typeof Sentry>("@sentry/node");
  return {
    ...actual,
    startSpan: vi.fn((_opts, cb) =>
      cb({
        setAttribute: mockSetAttribute,
        spanContext: () => ({ traceId: "test-trace" }),
      }),
    ),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fmt: actual.logger.fmt,
    },
  };
});

import type { InstanceRecord, McpServerConfig } from "../shared/types.js";
import type { InstanceStore } from "../registry/store.js";
import type { RailwayClient } from "./client.js";
import { provisionInstance, sanitizeServiceName } from "./provisioner.js";

function makeRecord(overrides?: Partial<InstanceRecord>): InstanceRecord {
  return {
    name: "my-agent",
    systemPrompt: "You are helpful.",
    mcpServers: [] as McpServerConfig[],
    model: "claude-haiku-4-5-20251001",
    maxTurns: 50,
    maxBudgetUsd: 1.0,
    status: "provisioning",
    railwayServiceId: null,
    workerUrl: null,
    provisionError: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeStore(): InstanceStore {
  return {
    get: vi.fn(),
    provision: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    clear: vi.fn(),
    nukeByPrefix: vi.fn(),
    size: 0,
  } as unknown as InstanceStore;
}

function makeRailwayClient(overrides?: Partial<RailwayClient>): RailwayClient {
  return {
    serviceCreate: vi.fn().mockResolvedValue({ serviceId: "svc-123" }),
    serviceDelete: vi.fn().mockResolvedValue(undefined),
    variableCollectionUpsert: vi.fn().mockResolvedValue(undefined),
    serviceDomainCreate: vi.fn().mockResolvedValue({ domain: "my-agent.up.railway.app" }),
    ...overrides,
  } as unknown as RailwayClient;
}

describe("provisioner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.SENTRY_DSN = "https://sentry.test/123";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- sanitizeServiceName ---

  it("sanitizeServiceName lowercases and prefixes with aas-w-", () => {
    expect(sanitizeServiceName("MyAgent")).toBe("aas-w-myagent");
  });

  it("sanitizeServiceName replaces slashes with dashes", () => {
    expect(sanitizeServiceName("team/project/agent")).toBe("aas-w-team-project-agent");
  });

  it("sanitizeServiceName handles already-lowercase names", () => {
    expect(sanitizeServiceName("simple")).toBe("aas-w-simple");
  });

  // --- Happy path ---

  it("provisions full sequence and sets record to deploying", async () => {
    const record = makeRecord();
    const store = makeStore();
    const client = makeRailwayClient();

    await provisionInstance(record, store, client);

    expect(client.serviceCreate).toHaveBeenCalledWith("aas-w-my-agent");
    expect(client.variableCollectionUpsert).toHaveBeenCalledWith("svc-123", expect.objectContaining({
      AAS_ROLE: "worker",
      AAS_INSTANCE_NAME: "my-agent",
      AAS_SYSTEM_PROMPT: "You are helpful.",
      AAS_MCP_SERVERS: "[]",
      AAS_MODEL: "claude-haiku-4-5-20251001",
      AAS_MAX_TURNS: "50",
      AAS_MAX_BUDGET_USD: "1",
      ANTHROPIC_API_KEY: "sk-ant-test",
      SENTRY_DSN: "https://sentry.test/123",
    }));
    expect(client.serviceDomainCreate).toHaveBeenCalledWith("svc-123");

    expect(record.railwayServiceId).toBe("svc-123");
    expect(record.workerUrl).toBe("https://my-agent.up.railway.app");
    expect(record.status).toBe("deploying");
    expect(record.provisionError).toBeNull();
  });

  it("passes MCP servers as JSON string", async () => {
    const mcpServers: McpServerConfig[] = [
      { name: "github", url: "https://mcp.github.com" },
    ];
    const record = makeRecord({ mcpServers });
    const store = makeStore();
    const client = makeRailwayClient();

    await provisionInstance(record, store, client);

    const upsertCall = vi.mocked(client.variableCollectionUpsert).mock.calls[0];
    const vars = upsertCall[1];
    expect(vars.AAS_MCP_SERVERS).toBe(JSON.stringify(mcpServers));
  });

  // --- Name sanitization in provisioning flow ---

  it("sanitizes name with slashes during provisioning", async () => {
    const record = makeRecord({ name: "Team/Project/Agent" });
    const store = makeStore();
    const client = makeRailwayClient();

    await provisionInstance(record, store, client);

    expect(client.serviceCreate).toHaveBeenCalledWith("aas-w-team-project-agent");
  });

  // --- Name collision retry ---

  it("retries serviceCreate on failure and succeeds on third attempt", async () => {
    const record = makeRecord();
    const store = makeStore();
    const serviceCreate = vi.fn()
      .mockRejectedValueOnce(new Error("name conflict"))
      .mockRejectedValueOnce(new Error("name conflict"))
      .mockResolvedValueOnce({ serviceId: "svc-retry" });
    const client = makeRailwayClient({ serviceCreate } as unknown as Partial<RailwayClient>);

    const promise = provisionInstance(record, store, client);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(serviceCreate).toHaveBeenCalledTimes(3);
    expect(record.railwayServiceId).toBe("svc-retry");
    expect(record.status).toBe("deploying");
  });

  // --- Provisioning failure ---

  it("sets status to error when serviceCreate fails after all retries", async () => {
    const record = makeRecord();
    const store = makeStore();
    const serviceCreate = vi.fn().mockRejectedValue(new Error("permanent failure"));
    const client = makeRailwayClient({ serviceCreate } as unknown as Partial<RailwayClient>);

    const promise = provisionInstance(record, store, client);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(record.status).toBe("error");
    expect(record.provisionError).toBe("permanent failure");
    expect(record.railwayServiceId).toBeNull();
    expect(record.workerUrl).toBeNull();
  });

  it("does not attempt cleanup when serviceCreate fails (no serviceId yet)", async () => {
    const record = makeRecord();
    const store = makeStore();
    const serviceCreate = vi.fn().mockRejectedValue(new Error("fail"));
    const client = makeRailwayClient({ serviceCreate } as unknown as Partial<RailwayClient>);

    const promise = provisionInstance(record, store, client);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(client.serviceDelete).not.toHaveBeenCalled();
  });

  // --- Cleanup on failure after service created ---

  it("calls serviceDelete when variableCollectionUpsert fails", async () => {
    const record = makeRecord();
    const store = makeStore();
    const variableCollectionUpsert = vi.fn().mockRejectedValue(new Error("vars failed"));
    const client = makeRailwayClient({ variableCollectionUpsert } as unknown as Partial<RailwayClient>);

    await provisionInstance(record, store, client);

    expect(client.serviceDelete).toHaveBeenCalledWith("svc-123");
    expect(record.status).toBe("error");
    expect(record.provisionError).toBe("vars failed");
  });

  it("calls serviceDelete when serviceDomainCreate fails", async () => {
    const record = makeRecord();
    const store = makeStore();
    const serviceDomainCreate = vi.fn().mockRejectedValue(new Error("domain failed"));
    const client = makeRailwayClient({ serviceDomainCreate } as unknown as Partial<RailwayClient>);

    await provisionInstance(record, store, client);

    expect(client.serviceDelete).toHaveBeenCalledWith("svc-123");
    expect(record.status).toBe("error");
    expect(record.provisionError).toBe("domain failed");
  });

  it("sets error status even when cleanup also fails", async () => {
    const record = makeRecord();
    const store = makeStore();
    const variableCollectionUpsert = vi.fn().mockRejectedValue(new Error("vars failed"));
    const serviceDelete = vi.fn().mockRejectedValue(new Error("cleanup also failed"));
    const client = makeRailwayClient({
      variableCollectionUpsert,
      serviceDelete,
    } as unknown as Partial<RailwayClient>);

    await provisionInstance(record, store, client);

    expect(record.status).toBe("error");
    expect(record.provisionError).toBe("vars failed");
  });

  // --- Metric emission ---

  it("emits provision.count metric with status=success on happy path", async () => {
    const record = makeRecord();
    const store = makeStore();
    const client = makeRailwayClient();

    await provisionInstance(record, store, client);

    const spanCalls = vi.mocked(Sentry.startSpan).mock.calls;
    const provisionMetric = spanCalls.find(
      (call) => (call[0] as { name: string }).name === "metric.provision.count",
    );
    if (!provisionMetric) {
      expect.fail("expected metric.provision.count span call");
      return;
    }

    // Execute the metric callback to verify attributes
    const setAttr = vi.fn();
    const callback = provisionMetric[1] as (span: { setAttribute: typeof vi.fn }) => void;
    callback({ setAttribute: setAttr });
    expect(setAttr).toHaveBeenCalledWith("metric.tag.status", "success");
  });

  it("emits provision.count metric with status=error on failure", async () => {
    const record = makeRecord();
    const store = makeStore();
    const serviceCreate = vi.fn().mockRejectedValue(new Error("fail"));
    const client = makeRailwayClient({ serviceCreate } as unknown as Partial<RailwayClient>);

    const promise = provisionInstance(record, store, client);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    const spanCalls = vi.mocked(Sentry.startSpan).mock.calls;
    const provisionMetric = spanCalls.find(
      (call) => (call[0] as { name: string }).name === "metric.provision.count",
    );
    if (!provisionMetric) {
      expect.fail("expected metric.provision.count span call");
      return;
    }

    const setAttr = vi.fn();
    const callback = provisionMetric[1] as (span: { setAttribute: typeof vi.fn }) => void;
    callback({ setAttribute: setAttr });
    expect(setAttr).toHaveBeenCalledWith("metric.tag.status", "error");
  });
});
