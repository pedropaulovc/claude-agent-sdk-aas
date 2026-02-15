import type { RailwayClient } from "./client.js";
import {
  withSpan,
  logInfo,
  logError,
  countMetric,
  distributionMetric,
} from "../telemetry/helpers.js";

type WorkerStatus = "creating" | "dormant" | "active" | "error";

export type WorkerEntry = {
  workerNumber: number;
  serviceId: string;
  workerUrl: string;
  assignedAgent: string | null;
  status: WorkerStatus;
};

export type PoolConfig = {
  railwayClient: RailwayClient;
  ghcrImage: string;
  minDormant: number;
  monitorIntervalMs: number;
  secrets: Record<string, string>;
};

const HEALTH_POLL_INTERVAL_MS = 5_000;
const HEALTH_POLL_TIMEOUT_MS = 120_000;
const FETCH_TIMEOUT_MS = 5_000;

async function pollUntilHealthy(workerUrl: string): Promise<void> {
  const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${workerUrl}/health`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (response.status === 200) {
        return;
      }
    } catch {
      // Worker not ready yet, keep polling
    }

    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
  }

  throw new Error(`Worker at ${workerUrl} did not become healthy within ${HEALTH_POLL_TIMEOUT_MS}ms`);
}

export class WorkerPool {
  private readonly config: PoolConfig;
  private readonly workers: Map<number, WorkerEntry> = new Map();
  private workerCounter = 0;
  private monitorInterval: NodeJS.Timeout | null = null;

  constructor(config: PoolConfig) {
    this.config = config;
  }

  async ensurePoolSize(target: number): Promise<void> {
    return withSpan("pool.ensurePoolSize", "pool", async (span) => {
      const currentDormant = this.getDormantCount();
      const needed = target - currentDormant;
      span.setAttribute("pool.target", target);
      span.setAttribute("pool.current_dormant", currentDormant);
      span.setAttribute("pool.needed", needed);

      if (needed <= 0) {
        logInfo("pool.ensurePoolSize: already at target", {
          target,
          currentDormant,
        });
        return;
      }

      logInfo(`pool.ensurePoolSize: creating ${needed} workers`, {
        target,
        currentDormant,
        needed,
      });

      const creationPromises = Array.from({ length: needed }, () =>
        this.createWorker(),
      );

      await Promise.all(creationPromises);

      logInfo("pool.ensurePoolSize: batch complete", {
        dormant: this.getDormantCount(),
        total: this.workers.size,
      });
    });
  }

  claimWorker(): WorkerEntry | null {
    for (const entry of this.workers.values()) {
      if (entry.status !== "dormant") {
        continue;
      }

      entry.status = "active";
      logInfo(`pool.claimWorker: claimed worker ${entry.workerNumber}`, {
        workerNumber: entry.workerNumber,
        serviceId: entry.serviceId,
      });
      countMetric("pool.worker_claimed", 1);
      return entry;
    }

    logInfo("pool.claimWorker: no dormant workers available");
    return null;
  }

  assignWorker(workerNumber: number, agentName: string): void {
    const entry = this.workers.get(workerNumber);
    if (!entry) {
      logError(`pool.assignWorker: worker ${workerNumber} not found`, {
        workerNumber,
        agentName,
      });
      return;
    }

    entry.assignedAgent = agentName;
    logInfo(`pool.assignWorker: worker ${workerNumber} assigned to ${agentName}`, {
      workerNumber,
      agentName,
      serviceId: entry.serviceId,
    });
  }

  async releaseWorker(workerNumber: number): Promise<void> {
    return withSpan("pool.releaseWorker", "pool", async (span) => {
      span.setAttribute("pool.worker_number", workerNumber);

      const entry = this.workers.get(workerNumber);
      if (!entry) {
        logInfo(`pool.releaseWorker: worker ${workerNumber} not found, no-op`);
        return;
      }

      span.setAttribute("pool.service_id", entry.serviceId);

      try {
        await this.config.railwayClient.serviceDelete(entry.serviceId);
        logInfo(`pool.releaseWorker: deleted service for worker ${workerNumber}`, {
          workerNumber,
          serviceId: entry.serviceId,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logError(`pool.releaseWorker: failed to delete service for worker ${workerNumber}: ${message}`, {
          workerNumber,
          serviceId: entry.serviceId,
        });
        throw err;
      } finally {
        this.workers.delete(workerNumber);
        countMetric("pool.worker_released", 1);
      }
    });
  }

  getDormantCount(): number {
    let count = 0;
    for (const entry of this.workers.values()) {
      if (entry.status === "dormant") {
        count++;
      }
    }
    return count;
  }

  getActiveCount(): number {
    let count = 0;
    for (const entry of this.workers.values()) {
      if (entry.status === "active") {
        count++;
      }
    }
    return count;
  }

  listWorkers(): WorkerEntry[] {
    return [...this.workers.values()];
  }

  getWorkerByAgent(agentName: string): WorkerEntry | undefined {
    for (const entry of this.workers.values()) {
      if (entry.assignedAgent === agentName) {
        return entry;
      }
    }
    return undefined;
  }

  startPoolMonitor(): void {
    if (this.monitorInterval) {
      return;
    }

    logInfo("pool.monitor: starting", {
      intervalMs: this.config.monitorIntervalMs,
      minDormant: this.config.minDormant,
    });

    this.monitorInterval = setInterval(() => {
      const dormant = this.getDormantCount();
      logInfo("pool.monitor: checking pool size", {
        dormant,
        minDormant: this.config.minDormant,
      });

      if (dormant < this.config.minDormant) {
        void this.ensurePoolSize(this.config.minDormant);
      }
    }, this.config.monitorIntervalMs);
  }

  stopPoolMonitor(): void {
    if (!this.monitorInterval) {
      return;
    }

    clearInterval(this.monitorInterval);
    this.monitorInterval = null;
    logInfo("pool.monitor: stopped");
  }

  async discoverExistingWorkers(): Promise<void> {
    return withSpan("pool.discoverExistingWorkers", "pool", async (span) => {
      logInfo("pool.discover: listing existing services");

      const services = await this.config.railwayClient.serviceList();
      const workerPattern = /^aas-w-(\d+)$/;
      const workerServices = services.filter((svc) => workerPattern.test(svc.name));

      span.setAttribute("pool.discovered_candidates", workerServices.length);
      logInfo(`pool.discover: found ${workerServices.length} orphan worker services — cleaning up`, {
        total: services.length,
        candidates: workerServices.length,
      });

      // Clean up orphan workers from previous CP instances.
      // We can't reliably determine their URLs or state, so delete them
      // and let ensurePoolSize create fresh workers with known URLs.
      for (const svc of workerServices) {
        const match = workerPattern.exec(svc.name);
        if (!match) continue;

        const workerNumber = parseInt(match[1], 10);
        if (workerNumber >= this.workerCounter) {
          this.workerCounter = workerNumber;
        }

        try {
          await this.config.railwayClient.serviceDelete(svc.id);
          logInfo(`pool.discover: deleted orphan worker ${svc.name}`, {
            workerNumber,
            serviceId: svc.id,
          });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          logError(`pool.discover: failed to delete orphan ${svc.name}: ${message}`, {
            serviceId: svc.id,
          });
        }
      }

      span.setAttribute("pool.orphans_cleaned", workerServices.length);
      logInfo("pool.discover: cleanup complete", {
        cleaned: workerServices.length,
        counterAt: this.workerCounter,
      });
    });
  }

  private async createWorker(): Promise<void> {
    this.workerCounter++;
    const workerNumber = this.workerCounter;
    const serviceName = `aas-w-${workerNumber}`;
    const start = Date.now();

    logInfo(`pool.createWorker: starting worker ${workerNumber}`, {
      workerNumber,
      serviceName,
      image: this.config.ghcrImage,
    });

    try {
      const { serviceId } = await this.config.railwayClient.serviceCreate(
        serviceName,
        { image: this.config.ghcrImage },
      );

      await this.config.railwayClient.variableCollectionUpsert(
        serviceId,
        this.config.secrets,
      );

      await this.config.railwayClient.serviceInstanceDeploy(serviceId);

      const { domain } = await this.config.railwayClient.serviceDomainCreate(serviceId);
      const workerUrl = `https://${domain}`;

      await pollUntilHealthy(workerUrl);

      const entry: WorkerEntry = {
        workerNumber,
        serviceId,
        workerUrl,
        assignedAgent: null,
        status: "dormant",
      };

      this.workers.set(workerNumber, entry);

      const elapsed = Date.now() - start;
      countMetric("pool.worker_created", 1);
      distributionMetric("pool.creation_time_ms", elapsed, "ms");
      logInfo(`pool.createWorker: worker ${workerNumber} ready`, {
        workerNumber,
        serviceId,
        workerUrl,
        elapsed,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const elapsed = Date.now() - start;

      this.workers.set(workerNumber, {
        workerNumber,
        serviceId: "",
        workerUrl: "",
        assignedAgent: null,
        status: "error",
      });

      logError(`pool.createWorker: worker ${workerNumber} failed: ${message}`, {
        workerNumber,
        serviceName,
        elapsed,
      });
      distributionMetric("pool.creation_time_ms", elapsed, "ms");
    }
  }
}
