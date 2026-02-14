import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentInstance } from "../registry/types.js";
import type { InvocationEvent } from "./events.js";

// Mock Sentry (must be before any imports that use it)
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
    getActiveSpan: vi.fn(() => ({
      spanContext: () => ({ traceId: "aaa111aaa111aaa111aaa111aaa111aa", spanId: "bbb222bbb222bbb2" }),
    })),
    continueTrace: vi.fn((_traceData, cb) => cb()),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fmt: actual.logger.fmt,
    },
  };
});

// Mock the SDK query function
const mockQuery = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockQuery,
}));

// Import after mocks are set up
const { executeInvocation } = await import("./executor.js");

function makeInstance(overrides: Partial<AgentInstance> = {}): AgentInstance {
  return {
    name: "test/agent",
    systemPrompt: "You are a test assistant.",
    mcpServers: [],
    model: "claude-haiku-4-5-20251001",
    maxTurns: 50,
    maxBudgetUsd: 1.0,
    sessionId: null,
    status: "ready",
    createdAt: new Date(),
    lastInvokedAt: null,
    invocationCount: 0,
    activeInvocationId: null,
    queueDepth: 0,
    ...overrides,
  };
}

// Helper to create a mock async generator from an array of SDK messages
async function* mockSdkMessages(messages: unknown[]): AsyncGenerator<unknown, void> {
  for (const msg of messages) {
    yield msg;
  }
}

// Collect all events from the executor generator
async function collectEvents(gen: AsyncGenerator<InvocationEvent>): Promise<InvocationEvent[]> {
  const events: InvocationEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

describe("executeInvocation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("yields init event and marks instance as running", async () => {
    mockQuery.mockReturnValue(mockSdkMessages([
      {
        type: "result",
        subtype: "success",
        total_cost_usd: 0.01,
        duration_ms: 100,
        duration_api_ms: 80,
        is_error: false,
        num_turns: 0,
        result: "",
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        modelUsage: {},
        permission_denials: [],
        session_id: "sess-1",
        uuid: "00000000-0000-0000-0000-000000000001",
      },
    ]));

    const instance = makeInstance();
    const abort = new AbortController();
    const events = await collectEvents(executeInvocation(instance, "Hello", abort));

    expect(events[0].type).toBe("init");
    if (events[0].type === "init") {
      expect(events[0].instanceName).toBe("test/agent");
      expect(events[0].model).toBe("claude-haiku-4-5-20251001");
    }
    // Instance was marked running during execution
    expect(instance.invocationCount).toBe(1);
    expect(instance.lastInvokedAt).toBeInstanceOf(Date);
  });

  it("processes assistant messages and yields text + turn_complete events", async () => {
    mockQuery.mockReturnValue(mockSdkMessages([
      {
        type: "assistant",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Hello there!" }],
          model: "claude-haiku-4-5-20251001",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        uuid: "00000000-0000-0000-0000-000000000001",
        session_id: "sess-1",
      },
      {
        type: "result",
        subtype: "success",
        total_cost_usd: 0.02,
        duration_ms: 200,
        duration_api_ms: 150,
        is_error: false,
        num_turns: 1,
        result: "Hello there!",
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        modelUsage: {},
        permission_denials: [],
        session_id: "sess-1",
        uuid: "00000000-0000-0000-0000-000000000002",
      },
    ]));

    const instance = makeInstance();
    const events = await collectEvents(executeInvocation(instance, "Hi", new AbortController()));

    const types = events.map((e) => e.type);
    expect(types).toContain("init");
    expect(types).toContain("assistant_text");
    expect(types).toContain("turn_complete");
    expect(types).toContain("done");

    const textEvent = events.find((e) => e.type === "assistant_text");
    if (textEvent?.type === "assistant_text") {
      expect(textEvent.text).toBe("Hello there!");
      expect(textEvent.turn).toBe(1);
    }
  });

  it("processes tool_use content blocks", async () => {
    mockQuery.mockReturnValue(mockSdkMessages([
      {
        type: "assistant",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [
            { type: "text", text: "Let me run a command" },
            { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } },
          ],
          model: "claude-haiku-4-5-20251001",
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        uuid: "00000000-0000-0000-0000-000000000001",
        session_id: "sess-1",
      },
      {
        type: "result",
        subtype: "success",
        total_cost_usd: 0.03,
        duration_ms: 300,
        duration_api_ms: 250,
        is_error: false,
        num_turns: 1,
        result: "",
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        modelUsage: {},
        permission_denials: [],
        session_id: "sess-1",
        uuid: "00000000-0000-0000-0000-000000000002",
      },
    ]));

    const instance = makeInstance();
    const events = await collectEvents(executeInvocation(instance, "Run ls", new AbortController()));

    const toolEvent = events.find((e) => e.type === "tool_use");
    expect(toolEvent).toBeDefined();
    if (toolEvent?.type === "tool_use") {
      expect(toolEvent.toolName).toBe("Bash");
      expect(toolEvent.toolInput).toEqual({ command: "ls" });
      expect(toolEvent.toolUseId).toBe("tu_1");
    }
  });

  it("sets instance to ready and stores sessionId on success", async () => {
    mockQuery.mockReturnValue(mockSdkMessages([
      {
        type: "result",
        subtype: "success",
        total_cost_usd: 0.01,
        duration_ms: 100,
        duration_api_ms: 80,
        is_error: false,
        num_turns: 0,
        result: "",
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        modelUsage: {},
        permission_denials: [],
        session_id: "sess-new",
        uuid: "00000000-0000-0000-0000-000000000001",
      },
    ]));

    const instance = makeInstance();
    await collectEvents(executeInvocation(instance, "Hello", new AbortController()));

    expect(instance.status).toBe("ready");
    expect(instance.sessionId).toBe("sess-new");
    expect(instance.activeInvocationId).toBeNull();
  });

  it("sets instance to error state on SDK error result", async () => {
    mockQuery.mockReturnValue(mockSdkMessages([
      {
        type: "result",
        subtype: "error_during_execution",
        duration_ms: 100,
        duration_api_ms: 80,
        is_error: true,
        num_turns: 0,
        stop_reason: null,
        total_cost_usd: 0.001,
        usage: { input_tokens: 5, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        modelUsage: {},
        permission_denials: [],
        errors: ["Rate limited"],
        session_id: "sess-err",
        uuid: "00000000-0000-0000-0000-000000000001",
      },
    ]));

    const instance = makeInstance();
    const events = await collectEvents(executeInvocation(instance, "Hello", new AbortController()));

    expect(instance.status).toBe("error");
    expect(instance.activeInvocationId).toBeNull();

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === "error") {
      expect(errorEvent.error).toBe("Rate limited");
      expect(errorEvent.code).toBe("error_during_execution");
    }
  });

  it("sets instance to error state on thrown exception", async () => {
    mockQuery.mockReturnValue((async function* () {
      throw new Error("Connection refused");
    })());

    const instance = makeInstance();
    const events = await collectEvents(executeInvocation(instance, "Hello", new AbortController()));

    expect(instance.status).toBe("error");
    expect(instance.activeInvocationId).toBeNull();

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === "error") {
      expect(errorEvent.error).toBe("Connection refused");
      expect(errorEvent.code).toBe("sdk_error");
    }
  });

  it("sets instance to ready (not error) on abort", async () => {
    const abortController = new AbortController();

    mockQuery.mockReturnValue((async function* () {
      abortController.abort();
      throw new Error("Aborted");
    })());

    const instance = makeInstance();
    const events = await collectEvents(executeInvocation(instance, "Hello", abortController));

    expect(instance.status).toBe("ready");
    expect(instance.activeInvocationId).toBeNull();
    // No error event should be yielded on abort
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("passes resume sessionId when instance has one", async () => {
    mockQuery.mockReturnValue(mockSdkMessages([
      {
        type: "result",
        subtype: "success",
        total_cost_usd: 0.01,
        duration_ms: 100,
        duration_api_ms: 80,
        is_error: false,
        num_turns: 0,
        result: "",
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        modelUsage: {},
        permission_denials: [],
        session_id: "sess-existing",
        uuid: "00000000-0000-0000-0000-000000000001",
      },
    ]));

    const instance = makeInstance({ sessionId: "sess-existing" });
    await collectEvents(executeInvocation(instance, "Continue", new AbortController()));

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Continue",
        options: expect.objectContaining({
          resume: "sess-existing",
        }),
      }),
    );
  });

  it("does not pass resume when instance has no sessionId", async () => {
    mockQuery.mockReturnValue(mockSdkMessages([
      {
        type: "result",
        subtype: "success",
        total_cost_usd: 0.01,
        duration_ms: 100,
        duration_api_ms: 80,
        is_error: false,
        num_turns: 0,
        result: "",
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        modelUsage: {},
        permission_denials: [],
        session_id: "sess-new",
        uuid: "00000000-0000-0000-0000-000000000001",
      },
    ]));

    const instance = makeInstance({ sessionId: null });
    await collectEvents(executeInvocation(instance, "Hello", new AbortController()));

    const callArgs = mockQuery.mock.calls[0][0];
    expect(callArgs.options.resume).toBeUndefined();
  });

  it("yields done event with correct cost and duration", async () => {
    mockQuery.mockReturnValue(mockSdkMessages([
      {
        type: "assistant",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Response" }],
          model: "claude-haiku-4-5-20251001",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        uuid: "00000000-0000-0000-0000-000000000001",
        session_id: "sess-1",
      },
      {
        type: "result",
        subtype: "success",
        total_cost_usd: 0.15,
        duration_ms: 3000,
        duration_api_ms: 2500,
        is_error: false,
        num_turns: 1,
        result: "Response",
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        modelUsage: {},
        permission_denials: [],
        session_id: "sess-1",
        uuid: "00000000-0000-0000-0000-000000000002",
      },
    ]));

    const instance = makeInstance();
    const events = await collectEvents(executeInvocation(instance, "Question", new AbortController()));

    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    if (doneEvent?.type === "done") {
      expect(doneEvent.costUsd).toBe(0.15);
      expect(doneEvent.turns).toBe(1);
      expect(doneEvent.sessionId).toBe("sess-1");
      expect(doneEvent.stopReason).toBe("end_turn");
      expect(doneEvent.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("converts MCP servers to SDK format", async () => {
    mockQuery.mockReturnValue(mockSdkMessages([
      {
        type: "result",
        subtype: "success",
        total_cost_usd: 0.01,
        duration_ms: 100,
        duration_api_ms: 80,
        is_error: false,
        num_turns: 0,
        result: "",
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        modelUsage: {},
        permission_denials: [],
        session_id: "sess-1",
        uuid: "00000000-0000-0000-0000-000000000001",
      },
    ]));

    const instance = makeInstance({
      mcpServers: [
        { name: "remote-server", url: "http://localhost:3000", headers: { "X-Key": "abc" } },
        { name: "local-tool", command: "node", args: ["server.js"], env: { PORT: "3001" } },
      ],
    });
    await collectEvents(executeInvocation(instance, "Hello", new AbortController()));

    const callArgs = mockQuery.mock.calls[0][0];
    expect(callArgs.options.mcpServers).toEqual({
      "remote-server": { type: "http", url: "http://localhost:3000", headers: { "X-Key": "abc" } },
      "local-tool": { command: "node", args: ["server.js"], env: { PORT: "3001" } },
    });
  });

  it("increments invocationCount on each call", async () => {
    mockQuery.mockReturnValue(mockSdkMessages([
      {
        type: "result",
        subtype: "success",
        total_cost_usd: 0.01,
        duration_ms: 100,
        duration_api_ms: 80,
        is_error: false,
        num_turns: 0,
        result: "",
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        modelUsage: {},
        permission_denials: [],
        session_id: "sess-1",
        uuid: "00000000-0000-0000-0000-000000000001",
      },
    ]));

    const instance = makeInstance();
    await collectEvents(executeInvocation(instance, "First", new AbortController()));

    mockQuery.mockReturnValue(mockSdkMessages([
      {
        type: "result",
        subtype: "success",
        total_cost_usd: 0.01,
        duration_ms: 100,
        duration_api_ms: 80,
        is_error: false,
        num_turns: 0,
        result: "",
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        modelUsage: {},
        permission_denials: [],
        session_id: "sess-2",
        uuid: "00000000-0000-0000-0000-000000000002",
      },
    ]));

    await collectEvents(executeInvocation(instance, "Second", new AbortController()));
    expect(instance.invocationCount).toBe(2);
  });

  it("includes TRACEPARENT in env when active span exists", async () => {
    mockQuery.mockReturnValue(mockSdkMessages([
      {
        type: "result",
        subtype: "success",
        total_cost_usd: 0.01,
        duration_ms: 100,
        duration_api_ms: 80,
        is_error: false,
        num_turns: 0,
        result: "",
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        modelUsage: {},
        permission_denials: [],
        session_id: "sess-1",
        uuid: "00000000-0000-0000-0000-000000000001",
      },
    ]));

    const instance = makeInstance();
    await collectEvents(executeInvocation(instance, "Hello", new AbortController()));

    const callArgs = mockQuery.mock.calls[0][0];
    expect(callArgs.options.env.TRACEPARENT).toBe(
      "00-aaa111aaa111aaa111aaa111aaa111aa-bbb222bbb222bbb2-01",
    );
  });

  it("passes traceContext parameter through without error", async () => {
    mockQuery.mockReturnValue(mockSdkMessages([
      {
        type: "result",
        subtype: "success",
        total_cost_usd: 0.01,
        duration_ms: 100,
        duration_api_ms: 80,
        is_error: false,
        num_turns: 0,
        result: "",
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        modelUsage: {},
        permission_denials: [],
        session_id: "sess-1",
        uuid: "00000000-0000-0000-0000-000000000001",
      },
    ]));

    const instance = makeInstance();
    const traceContext = { sentryTrace: "abc123-def456-1", baggage: "sentry-trace_id=abc123" };
    const events = await collectEvents(executeInvocation(instance, "Hello", new AbortController(), traceContext));

    // Should complete normally — the traceContext is accepted without error
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("ignores non-assistant non-result SDK messages", async () => {
    mockQuery.mockReturnValue(mockSdkMessages([
      {
        type: "system",
        subtype: "init",
        uuid: "00000000-0000-0000-0000-000000000001",
        session_id: "sess-1",
        tools: [],
        mcp_servers: [],
        model: "claude-haiku-4-5-20251001",
        permissionMode: "bypassPermissions",
        slash_commands: [],
        output_style: "text",
        skills: [],
        plugins: [],
        apiKeySource: "user",
        claude_code_version: "1.0.0",
        cwd: "/tmp",
      },
      {
        type: "result",
        subtype: "success",
        total_cost_usd: 0.01,
        duration_ms: 100,
        duration_api_ms: 80,
        is_error: false,
        num_turns: 0,
        result: "",
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        modelUsage: {},
        permission_denials: [],
        session_id: "sess-1",
        uuid: "00000000-0000-0000-0000-000000000002",
      },
    ]));

    const instance = makeInstance();
    const events = await collectEvents(executeInvocation(instance, "Hello", new AbortController()));

    // Should only have init + done (system message is ignored)
    const types = events.map((e) => e.type);
    expect(types).toEqual(["init", "done"]);
  });
});
