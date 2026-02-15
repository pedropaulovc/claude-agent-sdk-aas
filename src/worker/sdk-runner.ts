import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKResultSuccess,
  SDKResultError,
  SpawnOptions,
  SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "child_process";
import type { WorkerConfig } from "./config.js";
import type { SseEvent } from "./queue.js";
import {
  withSpan,
  logInfo,
  logError,
  countMetric,
  distributionMetric,
} from "../telemetry/helpers.js";

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

    // Accumulate stderr to surface in error events
    const stderrChunks: string[] = [];

    const options: Record<string, unknown> = {
      systemPrompt: this.config.systemPrompt,
      model: this.config.model,
      maxTurns: this.config.maxTurns,
      maxBudgetUsd: this.config.maxBudgetUsd,
      permissionMode: "bypassPermissions" as const,
      allowDangerouslySkipPermissions: true,
      abortController,
      cwd: "/tmp",
      debug: true,
      stderr: (data: string) => {
        stderrChunks.push(data);
        logInfo("SDK stderr", { invocationId, data });
        console.log("[DEBUG sdk-runner] STDERR:", data);
      },
      spawnClaudeCodeProcess: (spawnOpts: SpawnOptions): SpawnedProcess => {
        logInfo("SDK spawn", {
          invocationId,
          command: spawnOpts.command,
          args: JSON.stringify(spawnOpts.args),
          cwd: spawnOpts.cwd ?? "none",
          envKeys: Object.keys(spawnOpts.env).join(","),
        });
        console.log("[DEBUG sdk-runner] SPAWN CMD:", spawnOpts.command);
        console.log("[DEBUG sdk-runner] SPAWN ARGS:", JSON.stringify(spawnOpts.args));

        const proc = spawn(spawnOpts.command, spawnOpts.args, {
          cwd: spawnOpts.cwd,
          stdio: ["pipe", "pipe", "pipe"],
          signal: spawnOpts.signal,
          env: spawnOpts.env as NodeJS.ProcessEnv,
          windowsHide: true,
        });

        proc.stderr?.on("data", (chunk: Buffer) => {
          const text = chunk.toString();
          logInfo("SDK proc stderr", { invocationId, stderr: text.substring(0, 1000) });
          stderrChunks.push(text);
        });

        proc.stdout?.on("data", (chunk: Buffer) => {
          logInfo("SDK proc stdout", { invocationId, stdout: chunk.toString().substring(0, 500) });
        });

        proc.on("exit", (code, sig) => {
          logInfo("SDK proc exit", { invocationId, code: code ?? -1, signal: sig ?? "none" });
          console.log("[DEBUG sdk-runner] PROC EXIT:", { code, signal: sig });
        });

        proc.on("error", (err) => {
          logError("SDK proc error", { invocationId, error: err.message });
          console.log("[DEBUG sdk-runner] PROC ERROR:", err.message);
        });

        return {
          stdin: proc.stdin!,
          stdout: proc.stdout!,
          get killed() { return proc.killed; },
          get exitCode() { return proc.exitCode; },
          kill: (sig: NodeJS.Signals) => proc.kill(sig),
          on: proc.on.bind(proc) as SpawnedProcess["on"],
          once: proc.once.bind(proc) as SpawnedProcess["once"],
          off: proc.off.bind(proc) as SpawnedProcess["off"],
        };
      },
    };

    if (Object.keys(mcpServers).length > 0) {
      options["mcpServers"] = mcpServers;
    }

    if (this.currentSessionId) {
      options["resume"] = this.currentSessionId;
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
    const WATCHDOG_TIMEOUT_MS = 30_000;
    let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
    let watchdogFired = false;

    const resetWatchdog = () => {
      if (watchdogTimer) clearTimeout(watchdogTimer);
      watchdogTimer = setTimeout(() => {
        watchdogFired = true;
        const stderrOutput = stderrChunks.join("");
        logError("SDK watchdog timeout — no events for 30s, aborting", {
          invocationId,
          stderr: stderrOutput,
        });
        console.log("[DEBUG sdk-runner] WATCHDOG FIRED", { invocationId, stderr: stderrOutput });
        abortController.abort();
      }, WATCHDOG_TIMEOUT_MS);
    };

    resetWatchdog();

    try {
      for await (const msg of q) {
        resetWatchdog();
        console.log("[DEBUG sdk-runner] SDK MSG:", msg.type, "subtype" in msg ? (msg as Record<string, unknown>).subtype : "", { invocationId });

        if (signal.aborted) {
          break;
        }

        yield* this.mapMessage(msg, invocationId, turn, () => {
          if (lastAssistantHadContent) {
            turn++;
          }
          lastAssistantHadContent = false;
        }, (hadContent: boolean) => {
          lastAssistantHadContent = hadContent;
        });

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
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const stderrOutput = stderrChunks.join("");

      if (watchdogFired) {
        logError("SDK invocation timed out (watchdog)", { invocationId, stderr: stderrOutput });
        countMetric("invocation.error", 1, { instanceName: this.config.instanceName });
        yield {
          event: "error",
          data: {
            invocationId,
            error: `SDK watchdog timeout: no events received within ${WATCHDOG_TIMEOUT_MS / 1000}s. stderr: ${stderrOutput || "(empty)"}`,
            code: "sdk_watchdog_timeout",
            stderr: stderrOutput,
          },
        };
      } else {
        console.log("[DEBUG sdk-runner] SDK LOOP THREW", { invocationId, error: errorMessage, stderr: stderrOutput });
        logError("SDK invocation threw", { invocationId, error: errorMessage, stderr: stderrOutput });
        countMetric("invocation.error", 1, { instanceName: this.config.instanceName });
        yield {
          event: "error",
          data: { invocationId, error: errorMessage, code: "sdk_error", stderr: stderrOutput },
        };
      }
    } finally {
      if (watchdogTimer) clearTimeout(watchdogTimer);
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
          yield {
            event: "assistant_text",
            data: { text: block.text, turn },
          };
        } else if (block.type === "tool_use") {
          hadContent = true;
          yield {
            event: "tool_use",
            data: {
              toolName: block.name,
              toolInput: block.input,
              toolUseId: block.id,
              turn,
            },
          };
        }
      }

      onAssistantEnd(hadContent);

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

// Helper to wrap an async generator in a Sentry span.
// withSpan expects a Promise, but we need a generator. So we manually
// start/end the span around the generator's lifecycle.
async function* withSpanGenerator(
  name: string,
  op: string,
  fn: () => AsyncGenerator<SseEvent>,
): AsyncGenerator<SseEvent> {
  // We can't use withSpan directly since it returns Promise<T>, not AsyncGenerator.
  // Instead, we call the function directly and rely on the telemetry
  // from logInfo/countMetric/distributionMetric within the runner.
  console.log("[DEBUG sdk-runner] withSpanGenerator ENTER", { name, op });
  const gen = await withSpan(name, op, async () => {
    return fn();
  });
  console.log("[DEBUG sdk-runner] withSpanGenerator GOT GENERATOR, starting yield*");
  yield* gen;
  console.log("[DEBUG sdk-runner] withSpanGenerator yield* COMPLETE");
}
