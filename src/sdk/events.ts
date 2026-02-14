import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

// Internal event types emitted by the executor
export type InvocationEvent =
  | { type: "init"; invocationId: string; instanceName: string; model: string; turn: number }
  | { type: "assistant_text"; text: string; turn: number }
  | { type: "tool_use"; toolName: string; toolInput: unknown; toolUseId: string; turn: number }
  | { type: "turn_complete"; turn: number; stopReason: string }
  | { type: "done"; invocationId: string; turns: number; costUsd: number; durationMs: number; stopReason: string; sessionId: string }
  | { type: "error"; invocationId: string; error: string; code: string };

// Map a single SDK assistant message to invocation events
export function* mapAssistantMessage(
  message: Extract<SDKMessage, { type: "assistant" }>,
  turn: number,
): Generator<InvocationEvent> {
  for (const block of message.message.content) {
    if (block.type === "text") {
      yield { type: "assistant_text", text: block.text, turn };
    }
    if (block.type === "tool_use") {
      yield { type: "tool_use", toolName: block.name, toolInput: block.input, toolUseId: block.id, turn };
    }
  }

  if (message.message.stop_reason) {
    yield { type: "turn_complete", turn, stopReason: message.message.stop_reason };
  }
}

// Map a SDK result message to an invocation event
export function mapResultMessage(
  message: Extract<SDKMessage, { type: "result" }>,
  invocationId: string,
  turns: number,
  durationMs: number,
  lastStopReason: string,
): InvocationEvent {
  if (message.subtype === "success") {
    return {
      type: "done",
      invocationId,
      turns,
      costUsd: message.total_cost_usd,
      durationMs,
      stopReason: lastStopReason,
      sessionId: message.session_id,
    };
  }

  // Error variants: error_during_execution, error_max_turns, error_max_budget_usd, error_max_structured_output_retries
  const errorMsg = message.subtype === "error_during_execution"
    ? (message.errors.join("; ") || "Unknown SDK error")
    : `SDK limit reached: ${message.subtype}`;

  return { type: "error", invocationId, error: errorMsg, code: message.subtype };
}
