import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKResultSuccess,
  SDKResultError,
} from "@anthropic-ai/claude-agent-sdk";
import type { WorkerConfig } from "./config.js";
import type { SseEvent } from "./queue.js";
import * as Sentry from "@sentry/node";
import {
  withSpan,
  logInfo,
  logError,
  countMetric,
  distributionMetric,
  chunkedLog,
} from "../telemetry/helpers.js";
import { getOtelEnvVars } from "../telemetry/otel-env.js";

type McpServersRecord = Record<string, { type: "http"; url: string; headers?: Record<string, string> }>;

function buildMcpServers(config: WorkerConfig): McpServersRecord {
  const result: McpServersRecord = {};
  for (const server of config.mcpServers) {
    result[server.name] = {
      type: "http" as const,
      url: server.url,
      ...(server.headers ? { headers: server.headers } : {}),
    };
  }
  return result;
}

export class SdkRunner {
  private readonly config: WorkerConfig;
  private currentSessionId: string | null = null;
  private costAccumulator = 0;
  private messageCounter = 0;

  constructor(config: WorkerConfig) {
    this.config = config;
  }

  get sessionId(): string | null {
    return this.currentSessionId;
  }

  resetSession(): void {
    this.currentSessionId = null;
    logInfo("Session reset", { instanceName: this.config.instanceName });
  }

  get totalCostUsd(): number {
    return this.costAccumulator;
  }

  get messageCount(): number {
    return this.messageCounter;
  }

  async *run(
    message: string,
    invocationId: string,
    signal: AbortSignal,
  ): AsyncGenerator<SseEvent> {
    yield* withSpanGenerator(
      `sdk.invoke:${invocationId}`,
      "sdk.invoke",
      () => this.runInner(message, invocationId, signal),
    );
  }

  private async *runInner(
    message: string,
    invocationId: string,
    signal: AbortSignal,
  ): AsyncGenerator<SseEvent> {
    this.messageCounter++;
    let turn = 0;

    logInfo("SDK invocation starting", {
      invocationId,
      instanceName: this.config.instanceName,
      model: this.config.model,
      resumeSession: this.currentSessionId ?? "none",
    });
    chunkedLog("System prompt", this.config.systemPrompt);
    chunkedLog("User message", message);
    countMetric("invocation.started", 1, { instanceName: this.config.instanceName });

    yield {
      event: "init",
      data: {
        invocationId,
        instanceName: this.config.instanceName,
        model: this.config.model,
        turn,
      },
    };

    const abortController = new AbortController();

    // Link external signal to our internal controller
    if (signal.aborted) {
      abortController.abort();
    } else {
      signal.addEventListener("abort", () => abortController.abort(), { once: true });
    }

    const mcpServers = buildMcpServers(this.config);

    const options: Record<string, unknown> = {
      systemPrompt: this.config.systemPrompt,
      model: this.config.model,
      maxTurns: this.config.maxTurns,
      maxBudgetUsd: this.config.maxBudgetUsd,
      permissionMode: "bypassPermissions" as const,
      allowDangerouslySkipPermissions: true,
      abortController,
      stderr: (data: string) => {
        logInfo("SDK stderr", { invocationId, data });
        console.log("[DEBUG sdk-runner] STDERR:", data);
      },
    };

    if (Object.keys(mcpServers).length > 0) {
      options["mcpServers"] = mcpServers;
    }

    if (this.currentSessionId) {
      options["resume"] = this.currentSessionId;
    }

    // Set OTEL env vars so the SDK subprocess exports spans into this trace
    const otelVars = getOtelEnvVars(
      this.config.sentryDsn,
      Sentry.getActiveSpan(),
      this.config.instanceName,
    );
    for (const [key, value] of Object.entries(otelVars)) {
      process.env[key] = value;
    }

    let q: AsyncGenerator<SDKMessage, void>;
    try {
      q = query({ prompt: message, options });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logError("SDK query() failed to start", { invocationId, error: errorMessage });
      yield {
        event: "error",
        data: { invocationId, error: errorMessage, code: "sdk_init_error" },
      };
      return;
    }

    console.log("[DEBUG sdk-runner] SDK QUERY STARTED", { invocationId });

    let lastAssistantHadContent = false;
    const querySpan = Sentry.startInactiveSpan({ name: "sdk.query", op: "sdk.query" });

    try {
      for await (const msg of q) {
        console.log("[DEBUG sdk-runner] SDK MSG:", msg.type, "subtype" in msg ? (msg as Record<string, unknown>).subtype : "", { invocationId });

        if (signal.aborted) {
          break;
        }

        yield* this.mapMessage(msg, invocationId, turn, () => {
          // Called when we see an assistant message — increment turn
          if (lastAssistantHadContent) {
            turn++;
          }
          lastAssistantHadContent = false;
        }, (hadContent: boolean) => {
          lastAssistantHadContent = hadContent;
        });

        // Handle result messages
        if (msg.type === "result") {
          if (msg.subtype === "success") {
            const success = msg as SDKResultSuccess;
            this.currentSessionId = success.session_id;
            this.costAccumulator += success.total_cost_usd;

            distributionMetric(
              "invocation.cost",
              success.total_cost_usd,
              "usd",
              { instanceName: this.config.instanceName },
            );
            distributionMetric(
              "invocation.duration",
              success.duration_ms,
              "ms",
              { instanceName: this.config.instanceName },
            );
            countMetric("invocation.completed", 1, { instanceName: this.config.instanceName });

            logInfo("SDK invocation completed", {
              invocationId,
              turns: success.num_turns,
              costUsd: success.total_cost_usd,
              durationMs: success.duration_ms,
              sessionId: success.session_id,
            });
          } else {
            const error = msg as SDKResultError;
            this.currentSessionId = error.session_id;
            this.costAccumulator += error.total_cost_usd;
            countMetric("invocation.error", 1, { instanceName: this.config.instanceName });

            logError("SDK invocation errored", {
              invocationId,
              subtype: error.subtype,
              errors: error.errors,
            });
          }
        }
      }
      console.log("[DEBUG sdk-runner] SDK LOOP DONE", { invocationId });
      querySpan.end();
    } catch (err) {
      querySpan.setStatus({ code: 2, message: String(err) });
      querySpan.end();
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.log("[DEBUG sdk-runner] SDK LOOP THREW", { invocationId, error: errorMessage });
      logError("SDK invocation threw", { invocationId, error: errorMessage });
      countMetric("invocation.error", 1, { instanceName: this.config.instanceName });
      yield {
        event: "error",
        data: { invocationId, error: errorMessage, code: "sdk_error" },
      };
    }
  }

  private *mapMessage(
    msg: SDKMessage,
    invocationId: string,
    turn: number,
    onAssistantStart: () => void,
    onAssistantEnd: (hadContent: boolean) => void,
  ): Generator<SseEvent> {
    if (msg.type === "assistant") {
      onAssistantStart();
      const assistantMsg = msg as SDKAssistantMessage;
      let hadContent = false;

      for (const block of assistantMsg.message.content) {
        if (block.type === "text") {
          hadContent = true;
          const textSpan = Sentry.startInactiveSpan({ name: `assistant_text (turn ${turn})`, op: "sdk.event" });
          chunkedLog("Assistant text", block.text);
          textSpan.end();
          yield {
            event: "assistant_text",
            data: { text: block.text, turn },
          };
        } else if (block.type === "tool_use") {
          hadContent = true;
          const toolSpan = Sentry.startInactiveSpan({ name: `tool_use: ${block.name}`, op: "sdk.tool" });
          toolSpan.setAttribute("tool.name", block.name);
          toolSpan.setAttribute("tool.id", block.id);
          logInfo("Tool use", { toolName: block.name, toolUseId: block.id, toolInput: JSON.stringify(block.input) });
          toolSpan.end();
          yield {
            event: "tool_use",
            data: {
              toolName: block.name,
              toolInput: block.input,
              toolUseId: block.id,
              turn,
            },
          };
        } else if (block.type === "thinking") {
          const thinkSpan = Sentry.startInactiveSpan({ name: "reasoning", op: "sdk.event" });
          chunkedLog("Reasoning", (block as { type: string; thinking: string }).thinking);
          thinkSpan.end();
        }
      }

      onAssistantEnd(hadContent);

      logInfo("Turn complete", { turn, stopReason: assistantMsg.message.stop_reason ?? "unknown" });
      yield {
        event: "turn_complete",
        data: { turn, stopReason: assistantMsg.message.stop_reason ?? "unknown" },
      };
      return;
    }

    if (msg.type === "user") {
      const userMsg = msg as SDKUserMessage;
      if (!Array.isArray(userMsg.message.content)) {
        return;
      }

      for (const block of userMsg.message.content) {
        if (typeof block === "object" && block !== null && "type" in block && block.type === "tool_result") {
          const toolResultBlock = block as { type: "tool_result"; tool_use_id: string; content: unknown };
          const resultSpan = Sentry.startInactiveSpan({ name: `tool_result: ${toolResultBlock.tool_use_id}`, op: "sdk.tool_result" });
          chunkedLog("Tool result", typeof toolResultBlock.content === 'string' ? toolResultBlock.content : JSON.stringify(toolResultBlock.content));
          resultSpan.end();
          yield {
            event: "tool_result",
            data: {
              toolUseId: toolResultBlock.tool_use_id,
              result: toolResultBlock.content,
              turn,
            },
          };
        }
      }
      return;
    }

    if (msg.type === "result") {
      if (msg.subtype === "success") {
        const success = msg as SDKResultSuccess;
        yield {
          event: "done",
          data: {
            invocationId,
            turns: success.num_turns,
            costUsd: success.total_cost_usd,
            durationMs: success.duration_ms,
            stopReason: success.stop_reason ?? "unknown",
            sessionId: success.session_id,
          },
        };
      } else {
        const error = msg as SDKResultError;
        yield {
          event: "error",
          data: {
            invocationId,
            error: error.errors.join("; ") || `Invocation failed: ${error.subtype}`,
            code: error.subtype,
          },
        };
      }
      return;
    }

    // Other message types are ignored (system, stream_event, etc.)
  }
}

// Wrap an async generator in a Sentry span that covers the full iteration
// lifecycle. startInactiveSpan + manual end() is required because we can't
// yield from inside a startSpan callback.
async function* withSpanGenerator(
  name: string,
  op: string,
  fn: () => AsyncGenerator<SseEvent>,
): AsyncGenerator<SseEvent> {
  const span = Sentry.startInactiveSpan({ name, op });
  console.log("[DEBUG sdk-runner] withSpanGenerator ENTER", { name, op });
  try {
    yield* fn();
    console.log("[DEBUG sdk-runner] withSpanGenerator yield* COMPLETE");
  } catch (err) {
    span.setStatus({ code: 2, message: String(err) });
    throw err;
  } finally {
    span.end();
  }
}
