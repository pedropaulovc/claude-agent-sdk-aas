import { describe, it, expect } from "vitest";
import type { SDKAssistantMessage, SDKResultSuccess, SDKResultError } from "@anthropic-ai/claude-agent-sdk";
import { mapAssistantMessage, mapResultMessage } from "./events.js";

// Factory for BetaMessage-like objects used by SDKAssistantMessage
function makeAssistantMessage(overrides: {
  content?: Array<{ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown }>;
  stop_reason?: string | null;
} = {}): SDKAssistantMessage {
  return {
    type: "assistant",
    message: {
      id: "msg_123",
      type: "message",
      role: "assistant",
      content: overrides.content ?? [{ type: "text", text: "Hello world" }],
      model: "claude-haiku-4-5-20251001",
      stop_reason: "stop_reason" in overrides ? overrides.stop_reason : "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    parent_tool_use_id: null,
    uuid: "00000000-0000-0000-0000-000000000001" as `${string}-${string}-${string}-${string}-${string}`,
    session_id: "session-abc",
  } as SDKAssistantMessage;
}

function makeSuccessResult(overrides: Partial<SDKResultSuccess> = {}): SDKResultSuccess {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 1500,
    duration_api_ms: 1200,
    is_error: false,
    num_turns: 2,
    result: "Done",
    stop_reason: "end_turn",
    total_cost_usd: 0.05,
    usage: { input_tokens: 100, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    uuid: "00000000-0000-0000-0000-000000000002" as `${string}-${string}-${string}-${string}-${string}`,
    session_id: "session-abc",
    ...overrides,
  } as SDKResultSuccess;
}

function makeErrorResult(overrides: Partial<SDKResultError> = {}): SDKResultError {
  return {
    type: "result",
    subtype: "error_during_execution",
    duration_ms: 500,
    duration_api_ms: 400,
    is_error: true,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0.01,
    usage: { input_tokens: 50, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    errors: ["Something went wrong"],
    uuid: "00000000-0000-0000-0000-000000000003" as `${string}-${string}-${string}-${string}-${string}`,
    session_id: "session-abc",
    ...overrides,
  } as SDKResultError;
}

describe("SDK event mapping", () => {
  // --- mapAssistantMessage ---

  it("mapAssistantMessage yields text event for text content block", () => {
    const msg = makeAssistantMessage({ content: [{ type: "text", text: "Hi there" }] });
    const events = Array.from(mapAssistantMessage(msg, 1));

    expect(events).toHaveLength(2); // text + turn_complete
    expect(events[0]).toEqual({ type: "assistant_text", text: "Hi there", turn: 1 });
  });

  it("mapAssistantMessage yields tool_use event for tool_use content block", () => {
    const msg = makeAssistantMessage({
      content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } }],
      stop_reason: "tool_use",
    });
    const events = Array.from(mapAssistantMessage(msg, 3));

    expect(events[0]).toEqual({
      type: "tool_use",
      toolName: "Bash",
      toolInput: { command: "ls" },
      toolUseId: "tu_1",
      turn: 3,
    });
  });

  it("mapAssistantMessage yields multiple events for mixed content blocks", () => {
    const msg = makeAssistantMessage({
      content: [
        { type: "text", text: "Let me check" },
        { type: "tool_use", id: "tu_2", name: "Read", input: { file_path: "/tmp/f.txt" } },
      ],
      stop_reason: "tool_use",
    });
    const events = Array.from(mapAssistantMessage(msg, 2));

    expect(events).toHaveLength(3); // text + tool_use + turn_complete
    expect(events[0].type).toBe("assistant_text");
    expect(events[1].type).toBe("tool_use");
    expect(events[2]).toEqual({ type: "turn_complete", turn: 2, stopReason: "tool_use" });
  });

  it("mapAssistantMessage yields turn_complete with stop_reason", () => {
    const msg = makeAssistantMessage({ stop_reason: "max_tokens" });
    const events = Array.from(mapAssistantMessage(msg, 5));
    const turnComplete = events.find((e) => e.type === "turn_complete");

    expect(turnComplete).toEqual({ type: "turn_complete", turn: 5, stopReason: "max_tokens" });
  });

  it("mapAssistantMessage skips turn_complete when stop_reason is null", () => {
    const msg = makeAssistantMessage({ stop_reason: null });
    const events = Array.from(mapAssistantMessage(msg, 1));

    expect(events.every((e) => e.type !== "turn_complete")).toBe(true);
  });

  // --- mapResultMessage ---

  it("mapResultMessage returns done event for success result", () => {
    const result = makeSuccessResult({ total_cost_usd: 0.12, session_id: "sess-xyz" });
    const event = mapResultMessage(result, "inv-1", 3, 2500, "end_turn");

    expect(event).toEqual({
      type: "done",
      invocationId: "inv-1",
      turns: 3,
      costUsd: 0.12,
      durationMs: 2500,
      stopReason: "end_turn",
      sessionId: "sess-xyz",
    });
  });

  it("mapResultMessage returns error event for error_during_execution", () => {
    const result = makeErrorResult({
      subtype: "error_during_execution",
      errors: ["API call failed", "Timeout"],
    });
    const event = mapResultMessage(result, "inv-2", 1, 800, "end_turn");

    expect(event).toEqual({
      type: "error",
      invocationId: "inv-2",
      error: "API call failed; Timeout",
      code: "error_during_execution",
    });
  });

  it("mapResultMessage returns error event for error_max_turns", () => {
    const result = makeErrorResult({ subtype: "error_max_turns", errors: [] });
    const event = mapResultMessage(result, "inv-3", 50, 60000, "end_turn");

    expect(event).toEqual({
      type: "error",
      invocationId: "inv-3",
      error: "SDK limit reached: error_max_turns",
      code: "error_max_turns",
    });
  });

  it("mapResultMessage returns error event for error_max_budget_usd", () => {
    const result = makeErrorResult({ subtype: "error_max_budget_usd", errors: [] });
    const event = mapResultMessage(result, "inv-4", 10, 30000, "end_turn");

    expect(event).toEqual({
      type: "error",
      invocationId: "inv-4",
      error: "SDK limit reached: error_max_budget_usd",
      code: "error_max_budget_usd",
    });
  });
});
