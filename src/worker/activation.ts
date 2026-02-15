import { logInfo, countMetric } from "../telemetry/helpers.js";
import { activationSchema } from "../shared/types.js";
import type { BootConfig } from "./config.js";
import { SdkRunner } from "./sdk-runner.js";
import { InvocationQueue } from "./queue.js";
import { HistoryStore } from "./history.js";

export type WorkerState = {
  status: "dormant" | "active";
  instanceName: string | null;
  bootConfig: BootConfig;
  sdkRunner: SdkRunner | null;
  invocationQueue: InvocationQueue | null;
  historyStore: HistoryStore | null;
  startedAt: string;
};

export function createDormantState(bootConfig: BootConfig): WorkerState {
  return {
    status: "dormant",
    instanceName: null,
    bootConfig,
    sdkRunner: null,
    invocationQueue: null,
    historyStore: null,
    startedAt: new Date().toISOString(),
  };
}

export function activate(
  state: WorkerState,
  body: unknown,
): { success: true } | { success: false; error: string; code: string; status: number } {
  if (state.status === "active") {
    return {
      success: false,
      error: "Worker is already active",
      code: "already_active",
      status: 409,
    };
  }

  const parsed = activationSchema.safeParse(body);
  if (!parsed.success) {
    const messages = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return {
      success: false,
      error: `Validation error: ${messages}`,
      code: "validation_error",
      status: 400,
    };
  }

  const config = parsed.data;

  // Build a config object compatible with SdkRunner
  const sdkConfig = {
    instanceName: config.instanceName,
    systemPrompt: config.systemPrompt,
    mcpServers: config.mcpServers,
    model: config.model,
    maxTurns: config.maxTurns,
    maxBudgetUsd: config.maxBudgetUsd,
    anthropicApiKey: state.bootConfig.anthropicApiKey,
    sentryDsn: state.bootConfig.sentryDsn,
    port: state.bootConfig.port,
  };

  const runner = new SdkRunner(sdkConfig);
  const queue = new InvocationQueue(25);
  queue.setRunner((message, invocationId, signal) =>
    runner.run(message, invocationId, signal),
  );

  state.status = "active";
  state.instanceName = config.instanceName;
  state.sdkRunner = runner;
  state.invocationQueue = queue;
  state.historyStore = new HistoryStore();

  logInfo("Worker activated", {
    instanceName: config.instanceName,
    model: config.model,
  });
  countMetric("worker.activated", 1, { instanceName: config.instanceName });

  return { success: true };
}
