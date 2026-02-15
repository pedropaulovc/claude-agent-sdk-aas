import type { InstanceStore } from "../registry/store.js";
import {
  logInfo,
  logWarn,
  logError,
  countMetric,
  distributionMetric,
} from "../telemetry/helpers.js";

const DEPLOY_INTERVAL_MS = 5_000;
const DEPLOY_TIMEOUT_MS = 120_000;
const ONGOING_INTERVAL_MS = 30_000;
const FETCH_TIMEOUT_MS = 5_000;
const CONSECUTIVE_FAILURES_THRESHOLD = 3;

type PollingEntry = {
  interval: NodeJS.Timeout;
  deployTimeout?: NodeJS.Timeout;
  consecutiveFailures: number;
  mode: "deploy" | "ongoing";
};

async function checkHealth(
  workerUrl: string,
): Promise<{ ok: boolean; latencyMs: number }> {
  const start = Date.now();
  try {
    const response = await fetch(`${workerUrl}/health`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - start;
    return { ok: response.status === 200, latencyMs };
  } catch {
    const latencyMs = Date.now() - start;
    return { ok: false, latencyMs };
  }
}

export class HealthPoller {
  private entries = new Map<string, PollingEntry>();

  startDeployPolling(
    instanceName: string,
    workerUrl: string,
    store: InstanceStore,
  ): void {
    this.stopPolling(instanceName);

    const entry: PollingEntry = {
      consecutiveFailures: 0,
      mode: "deploy",
      interval: setInterval(() => {
        void this.pollDeploy(instanceName, workerUrl, store);
      }, DEPLOY_INTERVAL_MS),
      deployTimeout: setTimeout(() => {
        this.handleDeployTimeout(instanceName, store);
      }, DEPLOY_TIMEOUT_MS),
    };

    this.entries.set(instanceName, entry);
    logInfo(`${instanceName} | deploy polling started`, { workerUrl });
  }

  startOngoingPolling(
    instanceName: string,
    workerUrl: string,
    store: InstanceStore,
  ): void {
    this.stopPolling(instanceName);

    const entry: PollingEntry = {
      consecutiveFailures: 0,
      mode: "ongoing",
      interval: setInterval(() => {
        void this.pollOngoing(instanceName, workerUrl, store);
      }, ONGOING_INTERVAL_MS),
    };

    this.entries.set(instanceName, entry);
    logInfo(`${instanceName} | ongoing polling started`, { workerUrl });
  }

  stopPolling(instanceName: string): void {
    const entry = this.entries.get(instanceName);
    if (!entry) return;

    clearInterval(entry.interval);
    if (entry.deployTimeout) {
      clearTimeout(entry.deployTimeout);
    }
    this.entries.delete(instanceName);
    logInfo(`${instanceName} | polling stopped`);
  }

  stopAll(): void {
    for (const [name] of this.entries) {
      this.stopPolling(name);
    }
  }

  isPolling(instanceName: string): boolean {
    return this.entries.has(instanceName);
  }

  private async pollDeploy(
    instanceName: string,
    workerUrl: string,
    store: InstanceStore,
  ): Promise<void> {
    const instance = store.get(instanceName);
    if (!instance) {
      this.stopPolling(instanceName);
      return;
    }

    const { ok, latencyMs } = await checkHealth(workerUrl);
    const status = ok ? "success" : "failure";

    countMetric("health_poll.count", 1, { status, mode: "deploy" });
    distributionMetric("health_poll.latency_ms", latencyMs, "millisecond", {
      mode: "deploy",
    });
    logInfo(`${instanceName} | deploy poll`, { status, latencyMs });

    if (!ok) return;

    // Health check passed — transition to ready and switch to ongoing polling
    instance.status = "ready";
    logInfo(`${instanceName} | deploy health check passed, status → ready`);
    this.startOngoingPolling(instanceName, workerUrl, store);
  }

  private handleDeployTimeout(
    instanceName: string,
    store: InstanceStore,
  ): void {
    const entry = this.entries.get(instanceName);
    if (!entry || entry.mode !== "deploy") return;

    const instance = store.get(instanceName);
    if (instance) {
      instance.status = "error";
      instance.provisionError =
        "Deploy timeout: worker did not become healthy within 120s";
      logError(`${instanceName} | deploy timeout`, {
        timeoutMs: DEPLOY_TIMEOUT_MS,
      });
    }

    this.stopPolling(instanceName);
  }

  private async pollOngoing(
    instanceName: string,
    workerUrl: string,
    store: InstanceStore,
  ): Promise<void> {
    const instance = store.get(instanceName);
    if (!instance) {
      this.stopPolling(instanceName);
      return;
    }

    const { ok, latencyMs } = await checkHealth(workerUrl);
    const status = ok ? "success" : "failure";

    countMetric("health_poll.count", 1, { status, mode: "ongoing" });
    distributionMetric("health_poll.latency_ms", latencyMs, "millisecond", {
      mode: "ongoing",
    });
    logInfo(`${instanceName} | ongoing poll`, { status, latencyMs });

    const entry = this.entries.get(instanceName);
    if (!entry) return;

    if (ok) {
      entry.consecutiveFailures = 0;
      if (instance.status === "unreachable") {
        instance.status = "ready";
        logInfo(`${instanceName} | auto-recovered, status → ready`);
      }
      return;
    }

    entry.consecutiveFailures++;
    if (entry.consecutiveFailures >= CONSECUTIVE_FAILURES_THRESHOLD) {
      if (instance.status !== "unreachable") {
        instance.status = "unreachable";
        logWarn(`${instanceName} | ${CONSECUTIVE_FAILURES_THRESHOLD} consecutive failures, status → unreachable`, {
          consecutiveFailures: entry.consecutiveFailures,
        });
      }
    }
  }
}

export const healthPoller = new HealthPoller();
