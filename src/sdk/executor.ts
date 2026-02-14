import { query } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerConfig as SdkMcpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "crypto";
import type { AgentInstance } from "../registry/types.js";
import type { InvocationEvent } from "./events.js";
import { mapAssistantMessage, mapResultMessage } from "./events.js";
import { buildOtelEnv } from "./env.js";
import { logInfo, logError, chunkedLog, countMetric, distributionMetric } from "../telemetry/helpers.js";

// Convert our McpServerConfig[] to the SDK's Record<string, McpServerConfig> format
function buildSdkMcpServers(servers: AgentInstance["mcpServers"]): Record<string, SdkMcpServerConfig> {
  const result: Record<string, SdkMcpServerConfig> = {};

  for (const server of servers) {
    if ("url" in server) {
      result[server.name] = { type: "http", url: server.url, headers: server.headers };
    } else if ("command" in server) {
      result[server.name] = { command: server.command, args: server.args, env: server.env };
    }
  }

  return result;
}

export async function* executeInvocation(
  instance: AgentInstance,
  prompt: string,
  abortController: AbortController,
): AsyncGenerator<InvocationEvent> {
  const invocationId = randomUUID();
  const startTime = Date.now();
  let currentTurn = 0;
  let lastStopReason = "end_turn";

  // Mark instance as running
  instance.status = "running";
  instance.activeInvocationId = invocationId;
  instance.invocationCount++;
  instance.lastInvokedAt = new Date();

  logInfo(`${instance.name} | invoke.start`, { invocationId, prompt: prompt.substring(0, 200) });
  chunkedLog(`${instance.name} | prompt`, prompt);
  countMetric("invoke.count", 1, { instance: instance.name, model: instance.model });

  yield { type: "init", invocationId, instanceName: instance.name, model: instance.model, turn: 0 };

  try {
    const otelEnv = buildOtelEnv(process.env["SENTRY_DSN"]);

    const q = query({
      prompt,
      options: {
        systemPrompt: instance.systemPrompt,
        model: instance.model,
        maxTurns: instance.maxTurns,
        maxBudgetUsd: instance.maxBudgetUsd,
        ...(instance.sessionId ? { resume: instance.sessionId } : {}),
        mcpServers: buildSdkMcpServers(instance.mcpServers),
        abortController,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        env: { ...otelEnv, CLAUDE_AGENT_SDK_CLIENT_APP: "claude-agent-sdk-aas/0.1.0" },
      },
    });

    for await (const message of q) {
      if (message.type === "assistant") {
        currentTurn++;
        const assistantMsg = message;

        for (const event of mapAssistantMessage(assistantMsg, currentTurn)) {
          if (event.type === "assistant_text") {
            logInfo(`${instance.name} | assistant.${currentTurn} | ${event.text.substring(0, 200)}`);
          }
          if (event.type === "tool_use") {
            logInfo(`${instance.name} | tool_use.${currentTurn} | ${event.toolName}`);
          }
          if (event.type === "turn_complete") {
            lastStopReason = event.stopReason;
          }
          yield event;
        }
        continue;
      }

      if (message.type === "result") {
        const durationMs = Date.now() - startTime;
        const resultEvent = mapResultMessage(message, invocationId, currentTurn, durationMs, lastStopReason);

        if (resultEvent.type === "done") {
          instance.sessionId = message.session_id;
          instance.status = "ready";
          instance.activeInvocationId = null;

          logInfo(`${instance.name} | invoke.done`, {
            invocationId,
            turns: currentTurn,
            costUsd: resultEvent.costUsd,
            durationMs,
          });
          distributionMetric("invoke.duration_ms", durationMs, "ms", { instance: instance.name, model: instance.model, status: "success" });
          distributionMetric("invoke.cost_usd", resultEvent.costUsd, "usd", { instance: instance.name, model: instance.model });
          distributionMetric("invoke.turns", currentTurn, "turns", { instance: instance.name, model: instance.model });
        } else if (resultEvent.type === "error") {
          instance.status = "error";
          instance.activeInvocationId = null;

          logError(`${instance.name} | invoke.error`, { invocationId, error: resultEvent.error, code: resultEvent.code });
          countMetric("invoke.error", 1, { instance: instance.name, error_type: resultEvent.code });
        }

        yield resultEvent;
      }
      // Ignore other message types (system, stream_event, etc.)
    }
  } catch (err) {
    // Don't mark as error if it was an abort
    if (abortController.signal.aborted) {
      instance.status = "ready";
      instance.activeInvocationId = null;
      logInfo(`${instance.name} | invoke.abort`, { invocationId });
      return;
    }

    const errorMsg = err instanceof Error ? err.message : String(err);
    instance.status = "error";
    instance.activeInvocationId = null;

    logError(`${instance.name} | invoke.error`, { invocationId, error: errorMsg });
    countMetric("invoke.error", 1, { instance: instance.name, error_type: "exception" });

    yield { type: "error", invocationId, error: errorMsg, code: "sdk_error" };
  }
}
