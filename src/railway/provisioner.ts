import type { InstanceRecord } from "../shared/types.js";
import type { InstanceStore } from "../registry/store.js";
import type { RailwayClient } from "./client.js";
import {
  withSpan,
  logInfo,
  logError,
  countMetric,
} from "../telemetry/helpers.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const MAX_CREATE_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

export function sanitizeServiceName(name: string): string {
  return `aas-w-${name.replace(/\//g, "-").toLowerCase()}`;
}

async function createServiceWithRetry(
  railwayClient: RailwayClient,
  serviceName: string,
  instanceName: string,
  source: { repo: string; branch?: string },
): Promise<{ serviceId: string }> {
  for (let attempt = 1; attempt <= MAX_CREATE_RETRIES; attempt++) {
    try {
      return await railwayClient.serviceCreate(serviceName, source);
    } catch (err: unknown) {
      const isLastAttempt = attempt === MAX_CREATE_RETRIES;
      if (isLastAttempt) {
        throw err;
      }

      const message = err instanceof Error ? err.message : String(err);
      logInfo(`${instanceName} | serviceCreate attempt ${attempt} failed, retrying`, {
        attempt,
        error: message,
      });
      await sleep(RETRY_DELAY_MS);
    }
  }

  // Unreachable, but satisfies TypeScript
  throw new Error("createServiceWithRetry: exhausted retries");
}

async function cleanupService(
  railwayClient: RailwayClient,
  serviceId: string,
  instanceName: string,
): Promise<void> {
  try {
    await railwayClient.serviceDelete(serviceId);
    logInfo(`${instanceName} | cleanup: deleted service ${serviceId}`);
  } catch (cleanupErr: unknown) {
    const message = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
    logError(`${instanceName} | cleanup failed: ${message}`, { serviceId });
  }
}

function buildVariables(record: InstanceRecord): Record<string, string> {
  return {
    AAS_ROLE: "worker",
    AAS_INSTANCE_NAME: record.name,
    AAS_SYSTEM_PROMPT: record.systemPrompt,
    AAS_MCP_SERVERS: JSON.stringify(record.mcpServers),
    AAS_MODEL: record.model,
    AAS_MAX_TURNS: String(record.maxTurns),
    AAS_MAX_BUDGET_USD: String(record.maxBudgetUsd),
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
    SENTRY_DSN: process.env.SENTRY_DSN ?? "",
  };
}

export async function provisionInstance(
  record: InstanceRecord,
  store: InstanceStore,
  railwayClient: RailwayClient,
): Promise<void> {
  return withSpan("provision.instance", "provisioner", async () => {
    const serviceName = sanitizeServiceName(record.name);
    let serviceId: string | null = null;

    logInfo(`${record.name} | provisioning started`, { serviceName });

    try {
      const repo = process.env.RAILWAY_GIT_REPO ?? "pedropaulovc/claude-agent-sdk-aas";
      const branch = process.env.RAILWAY_GIT_BRANCH ?? "master";

      const createResult = await createServiceWithRetry(
        railwayClient, serviceName, record.name,
        { repo, branch },
      );
      serviceId = createResult.serviceId;

      logInfo(`${record.name} | service created`, { serviceId, repo, branch });

      // Wait for Railway to create the ServiceInstance in the environment
      // before setting variables (avoids "Cannot redeploy without a snapshot")
      await sleep(5000);

      const vars = buildVariables(record);
      await railwayClient.variableCollectionUpsert(serviceId, vars);

      logInfo(`${record.name} | variables set`);

      const { domain } = await railwayClient.serviceDomainCreate(serviceId);

      logInfo(`${record.name} | domain created`, { domain });

      record.railwayServiceId = serviceId;
      record.workerUrl = `https://${domain}`;
      record.status = "deploying";

      countMetric("provision.count", 1, { status: "success" });
      logInfo(`${record.name} | provisioning complete`, {
        serviceId,
        workerUrl: record.workerUrl,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logError(`${record.name} | provisioning failed: ${message}`, {
        serviceName,
        serviceId: serviceId ?? "none",
      });

      if (serviceId) {
        await cleanupService(railwayClient, serviceId, record.name);
      }

      record.status = "error";
      record.provisionError = message;

      countMetric("provision.count", 1, { status: "error" });
    }
  });
}
