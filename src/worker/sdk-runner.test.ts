import { describe, it, expect, beforeEach, vi } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { UUID } from "crypto";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

vi.mock("@sentry/node", async () => {
  const actual = await vi.importActual<typeof import("@sentry/node")>("@sentry/node");
  return {
    ...actual,
    startSpan: vi.fn((_opts, cb) =>
      cb({
        setAttribute: vi.fn(),
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

import { query } from "@anthropic-ai/claude-agent-sdk";
import { SdkRunner } from "./sdk-runner.js";
import type { WorkerConfig } from "./config.js";
import type { SseEvent } from "./queue.js";

const mockQuery = vi.mocked(query);

function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    instanceName: "test/instance",
    systemPrompt: "You are a test agent.",
    mcpServers: [],
    model: "claude-haiku-4-5-20251001",
    maxTurns: 50,
    maxBudgetUsd: 1.0,
    anthropicApiKey: "sk-ant-test-key",
    sentryDsn: "https://test@sentry.io/123",
    port: 8080,
    ...overrides,
  };
}

const TEST_UUID = "00000000-0000-0000-0000-000000000001" as UUID;
const TEST_SESSION_ID = "test-session-id";

function makeAssistantMessage(text: string): SDKMessage {
  return {
    type: "assistant",
    message: {
      id: "msg-1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
      model: "claude-haiku-4-5-20251001",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    parent_tool_use_id: null,
    uuid: TEST_UUID,
    session_id: TEST_SESSION_ID,
  } as unknown as SDKMessage;
}

function makeToolUseAssistantMessage(toolName: string, toolInput: unknown, toolUseId: string): SDKMessage {
  return {
    type: "assistant",
    message: {
      id: "msg-2",
      type: "message",
      role: "assistant",
      content: [{ type: "tool_use", name: toolName, input: toolInput, id: toolUseId }],
      model: "claude-haiku-4-5-20251001",
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    parent_tool_use_id: null,
    uuid: TEST_UUID,
    session_id: TEST_SESSION_ID,
  } as unknown as SDKMessage;
}

function makeUserToolResultMessage(toolUseId: string, content: unknown): SDKMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
    },
    parent_tool_use_id: null,
    uuid: TEST_UUID,
    session_id: TEST_SESSION_ID,
  } as unknown as SDKMessage;
}

function makeSuccessResult(overrides: Record<string, unknown> = {}): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 500,
    duration_api_ms: 400,
    is_error: false,
    num_turns: 1,
    result: "done",
    stop_reason: "end_turn",
    total_cost_usd: 0.01,
    usage: {
      input_tokens: 100,
      output_tokens: 200,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: TEST_UUID,
    session_id: TEST_SESSION_ID,
    ...overrides,
  } as unknown as SDKMessage;
}

function makeErrorResult(errors: string[] = ["something failed"], subtype = "error_during_execution"): SDKMessage {
  return {
    type: "result",
    subtype,
    duration_ms: 100,
    duration_api_ms: 80,
    is_error: true,
    num_turns: 0,
    stop_reason: null,
    total_cost_usd: 0.005,
    usage: {
      input_tokens: 50,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    errors,
    uuid: TEST_UUID,
    session_id: TEST_SESSION_ID,
  } as unknown as SDKMessage;
}

function mockQueryWithMessages(messages: SDKMessage[]): void {
  const asyncGen = (async function* () {
    for (const msg of messages) {
      yield msg;
    }
  })();

  mockQuery.mockReturnValue(asyncGen as ReturnType<typeof query>);
}

async function collectEvents(gen: AsyncGenerator<SseEvent>): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

describe("SdkRunner", () => {
  let runner: SdkRunner;
  let abortController: AbortController;

  beforeEach(() => {
    vi.clearAllMocks();
    runner = new SdkRunner(makeConfig());
    abortController = new AbortController();
  });

  it("yields init and done events on happy path", async () => {
    mockQueryWithMessages([
      makeAssistantMessage("Hello!"),
      makeSuccessResult(),
    ]);

    const events = await collectEvents(
      runner.run("test", "inv-1", abortController.signal),
    );

    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toContain("init");
    expect(eventTypes).toContain("assistant_text");
    expect(eventTypes).toContain("turn_complete");
    expect(eventTypes).toContain("done");
  });

  it("yields assistant_text for text content blocks", async () => {
    mockQueryWithMessages([
      makeAssistantMessage("Hello world!"),
      makeSuccessResult(),
    ]);

    const events = await collectEvents(
      runner.run("test", "inv-2", abortController.signal),
    );

    const textEvents = events.filter((e) => e.event === "assistant_text");
    expect(textEvents).toHaveLength(1);
    if (textEvents[0].event === "assistant_text") {
      expect(textEvents[0].data.text).toBe("Hello world!");
    }
  });

  it("yields tool_use and tool_result events", async () => {
    mockQueryWithMessages([
      makeToolUseAssistantMessage("ReadFile", { path: "/test" }, "tu-1"),
      makeUserToolResultMessage("tu-1", "file contents"),
      makeAssistantMessage("I read the file."),
      makeSuccessResult({ num_turns: 2 }),
    ]);

    const events = await collectEvents(
      runner.run("test", "inv-3", abortController.signal),
    );

    const toolUseEvents = events.filter((e) => e.event === "tool_use");
    expect(toolUseEvents).toHaveLength(1);
    if (toolUseEvents[0].event === "tool_use") {
      expect(toolUseEvents[0].data.toolName).toBe("ReadFile");
      expect(toolUseEvents[0].data.toolUseId).toBe("tu-1");
    }

    const toolResultEvents = events.filter((e) => e.event === "tool_result");
    expect(toolResultEvents).toHaveLength(1);
    if (toolResultEvents[0].event === "tool_result") {
      expect(toolResultEvents[0].data.toolUseId).toBe("tu-1");
      expect(toolResultEvents[0].data.result).toBe("file contents");
    }
  });

  it("yields error event on SDK result error", async () => {
    mockQueryWithMessages([
      makeErrorResult(["API key invalid"]),
    ]);

    const events = await collectEvents(
      runner.run("test", "inv-4", abortController.signal),
    );

    const errorEvents = events.filter((e) => e.event === "error");
    expect(errorEvents).toHaveLength(1);
    if (errorEvents[0].event === "error") {
      expect(errorEvents[0].data.error).toContain("API key invalid");
    }
  });

  it("yields error event when SDK throws", async () => {
    const asyncGen = (async function* (): AsyncGenerator<SDKMessage, void> {
      throw new Error("SDK crashed");
    })();
    mockQuery.mockReturnValue(asyncGen as ReturnType<typeof query>);

    const events = await collectEvents(
      runner.run("test", "inv-5", abortController.signal),
    );

    const errorEvents = events.filter((e) => e.event === "error");
    expect(errorEvents).toHaveLength(1);
    if (errorEvents[0].event === "error") {
      expect(errorEvents[0].data.error).toBe("SDK crashed");
      expect(errorEvents[0].data.code).toBe("sdk_error");
    }
  });

  it("session resume passes session_id on second invocation", async () => {
    mockQueryWithMessages([
      makeAssistantMessage("First response"),
      makeSuccessResult({ session_id: "sess-abc" }),
    ]);

    await collectEvents(runner.run("first", "inv-6a", abortController.signal));
    expect(runner.sessionId).toBe("sess-abc");

    mockQueryWithMessages([
      makeAssistantMessage("Second response"),
      makeSuccessResult({ session_id: "sess-abc" }),
    ]);

    await collectEvents(runner.run("second", "inv-6b", abortController.signal));

    expect(mockQuery).toHaveBeenCalledTimes(2);
    const secondCallOptions = mockQuery.mock.calls[1][0].options as Record<string, unknown>;
    expect(secondCallOptions["resume"]).toBe("sess-abc");
  });

  it("resetSession clears the session ID", async () => {
    mockQueryWithMessages([
      makeAssistantMessage("response"),
      makeSuccessResult({ session_id: "sess-reset" }),
    ]);

    await collectEvents(runner.run("msg", "inv-7", abortController.signal));
    expect(runner.sessionId).toBe("sess-reset");

    runner.resetSession();
    expect(runner.sessionId).toBeNull();
  });

  it("cost tracking accumulates across invocations", async () => {
    expect(runner.totalCostUsd).toBe(0);

    mockQueryWithMessages([
      makeAssistantMessage("r1"),
      makeSuccessResult({ total_cost_usd: 0.05 }),
    ]);
    await collectEvents(runner.run("m1", "inv-8a", abortController.signal));
    expect(runner.totalCostUsd).toBe(0.05);

    mockQueryWithMessages([
      makeAssistantMessage("r2"),
      makeSuccessResult({ total_cost_usd: 0.03 }),
    ]);
    await collectEvents(runner.run("m2", "inv-8b", abortController.signal));
    expect(runner.totalCostUsd).toBeCloseTo(0.08);
  });

  it("message count increments per invocation", async () => {
    expect(runner.messageCount).toBe(0);

    mockQueryWithMessages([
      makeAssistantMessage("r1"),
      makeSuccessResult(),
    ]);
    await collectEvents(runner.run("m1", "inv-9a", abortController.signal));
    expect(runner.messageCount).toBe(1);

    mockQueryWithMessages([
      makeAssistantMessage("r2"),
      makeSuccessResult(),
    ]);
    await collectEvents(runner.run("m2", "inv-9b", abortController.signal));
    expect(runner.messageCount).toBe(2);
  });

  it("maps MCP servers from array to record format", async () => {
    const configWithMcp = makeConfig({
      mcpServers: [
        { name: "server-a", url: "https://a.example.com" },
        { name: "server-b", url: "https://b.example.com", headers: { Authorization: "Bearer token" } },
      ],
    });
    const mcpRunner = new SdkRunner(configWithMcp);

    mockQueryWithMessages([
      makeAssistantMessage("response"),
      makeSuccessResult(),
    ]);

    await collectEvents(mcpRunner.run("msg", "inv-mcp", abortController.signal));

    const callOptions = mockQuery.mock.calls[0][0].options as Record<string, unknown>;
    const mcpServers = callOptions["mcpServers"] as Record<string, unknown>;
    expect(mcpServers["server-a"]).toEqual({ type: "http", url: "https://a.example.com" });
    expect(mcpServers["server-b"]).toEqual({
      type: "http",
      url: "https://b.example.com",
      headers: { Authorization: "Bearer token" },
    });
  });

  it("init event has correct data", async () => {
    mockQueryWithMessages([
      makeAssistantMessage("hi"),
      makeSuccessResult(),
    ]);

    const events = await collectEvents(
      runner.run("test", "inv-init", abortController.signal),
    );

    const initEvent = events.find((e) => e.event === "init");
    expect(initEvent).toBeDefined();
    if (initEvent?.event === "init") {
      expect(initEvent.data.invocationId).toBe("inv-init");
      expect(initEvent.data.instanceName).toBe("test/instance");
      expect(initEvent.data.model).toBe("claude-haiku-4-5-20251001");
      expect(initEvent.data.turn).toBe(0);
    }
  });

  it("done event has correct data", async () => {
    mockQueryWithMessages([
      makeAssistantMessage("hi"),
      makeSuccessResult({
        num_turns: 3,
        total_cost_usd: 0.15,
        duration_ms: 2000,
        stop_reason: "end_turn",
        session_id: "sess-done",
      }),
    ]);

    const events = await collectEvents(
      runner.run("test", "inv-done", abortController.signal),
    );

    const doneEvent = events.find((e) => e.event === "done");
    expect(doneEvent).toBeDefined();
    if (doneEvent?.event === "done") {
      expect(doneEvent.data.invocationId).toBe("inv-done");
      expect(doneEvent.data.turns).toBe(3);
      expect(doneEvent.data.costUsd).toBe(0.15);
      expect(doneEvent.data.durationMs).toBe(2000);
      expect(doneEvent.data.stopReason).toBe("end_turn");
      expect(doneEvent.data.sessionId).toBe("sess-done");
    }
  });

  it("ignores system messages", async () => {
    const systemMsg: SDKMessage = {
      type: "system",
      subtype: "init",
      agents: [],
      apiKeySource: "user",
      claude_code_version: "1.0.0",
      cwd: "/tmp",
      tools: [],
      mcp_servers: [],
      model: "haiku",
      permissionMode: "bypassPermissions",
      slash_commands: [],
      output_style: "text",
      skills: [],
      plugins: [],
      uuid: TEST_UUID,
      session_id: TEST_SESSION_ID,
    } as unknown as SDKMessage;

    mockQueryWithMessages([
      systemMsg,
      makeAssistantMessage("hello"),
      makeSuccessResult(),
    ]);

    const events = await collectEvents(
      runner.run("test", "inv-sys", abortController.signal),
    );

    // No events should be generated from system messages
    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).not.toContain("system");
    // But we should still see init, assistant_text, turn_complete, done
    expect(eventTypes).toContain("init");
    expect(eventTypes).toContain("assistant_text");
    expect(eventTypes).toContain("done");
  });
});
