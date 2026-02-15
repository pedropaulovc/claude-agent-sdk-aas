import { z } from "zod";
import {
  withSpan,
  logInfo,
  logError,
  countMetric,
  distributionMetric,
} from "../telemetry/helpers.js";

const RAILWAY_API_URL = "https://backboard.railway.com/graphql/v2";

const envSchema = z.object({
  RAILWAY_API_TOKEN: z.string().min(1, "RAILWAY_API_TOKEN is required"),
  RAILWAY_PROJECT_ID: z.string().min(1, "RAILWAY_PROJECT_ID is required"),
  RAILWAY_ENVIRONMENT_ID: z.string().min(1, "RAILWAY_ENVIRONMENT_ID is required"),
});

type RailwayEnv = z.infer<typeof envSchema>;

export class RailwayClient {
  private readonly env: RailwayEnv;

  constructor(env: RailwayEnv) {
    this.env = env;
  }

  async serviceCreate(
    name: string,
    source?: { repo: string; branch?: string },
  ): Promise<{ serviceId: string }> {
    return withSpan("railway.serviceCreate", "railway.api", async (span) => {
      span.setAttribute("railway.service.name", name);

      const input: Record<string, unknown> = {
        name,
        projectId: this.env.RAILWAY_PROJECT_ID,
      };

      if (source) {
        input.source = { repo: source.repo };
        if (source.branch) {
          input.branch = source.branch;
        }
      }

      const data = await this.execute<{ serviceCreate: { id: string } }>(
        "serviceCreate",
        `mutation serviceCreate($input: ServiceCreateInput!) {
          serviceCreate(input: $input) { id }
        }`,
        { input },
      );

      const serviceId = data.serviceCreate.id;
      span.setAttribute("railway.service.id", serviceId);
      return { serviceId };
    });
  }

  async serviceDelete(serviceId: string): Promise<void> {
    return withSpan("railway.serviceDelete", "railway.api", async (span) => {
      span.setAttribute("railway.service.id", serviceId);

      await this.execute<{ serviceDelete: boolean }>(
        "serviceDelete",
        `mutation serviceDelete($id: String!) {
          serviceDelete(id: $id)
        }`,
        { id: serviceId },
      );
    });
  }

  async variableCollectionUpsert(
    serviceId: string,
    vars: Record<string, string>,
  ): Promise<void> {
    return withSpan("railway.variableCollectionUpsert", "railway.api", async (span) => {
      span.setAttribute("railway.service.id", serviceId);
      span.setAttribute("railway.vars.count", Object.keys(vars).length);

      await this.execute<{ variableCollectionUpsert: boolean }>(
        "variableCollectionUpsert",
        `mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) {
          variableCollectionUpsert(input: $input)
        }`,
        {
          input: {
            projectId: this.env.RAILWAY_PROJECT_ID,
            environmentId: this.env.RAILWAY_ENVIRONMENT_ID,
            serviceId,
            variables: vars,
          },
        },
      );
    });
  }

  async environmentTriggersDeploy(serviceId: string): Promise<void> {
    return withSpan("railway.environmentTriggersDeploy", "railway.api", async (span) => {
      span.setAttribute("railway.service.id", serviceId);

      await this.execute<{ environmentTriggersDeploy: boolean }>(
        "environmentTriggersDeploy",
        `mutation environmentTriggersDeploy($input: EnvironmentTriggersDeployInput!) {
          environmentTriggersDeploy(input: $input)
        }`,
        {
          input: {
            projectId: this.env.RAILWAY_PROJECT_ID,
            environmentId: this.env.RAILWAY_ENVIRONMENT_ID,
            serviceId,
          },
        },
      );
    });
  }

  async serviceDomainCreate(serviceId: string): Promise<{ domain: string }> {
    return withSpan("railway.serviceDomainCreate", "railway.api", async (span) => {
      span.setAttribute("railway.service.id", serviceId);

      const data = await this.execute<{ serviceDomainCreate: { domain: string } }>(
        "serviceDomainCreate",
        `mutation serviceDomainCreate($input: ServiceDomainCreateInput!) {
          serviceDomainCreate(input: $input) { domain }
        }`,
        {
          input: {
            serviceId,
            environmentId: this.env.RAILWAY_ENVIRONMENT_ID,
          },
        },
      );

      const { domain } = data.serviceDomainCreate;
      span.setAttribute("railway.domain", domain);
      return { domain };
    });
  }

  private async execute<T>(
    method: string,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    logInfo(`railway.${method} starting`, { method, variables });

    const start = Date.now();
    let status = "success";

    try {
      const response = await fetch(RAILWAY_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.env.RAILWAY_API_TOKEN}`,
        },
        body: JSON.stringify({ query, variables }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new RailwayApiError(
          `Railway API returned HTTP ${response.status}: ${body}`,
          method,
        );
      }

      const json = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };

      if (json.errors && json.errors.length > 0) {
        const messages = json.errors.map((e) => e.message).join("; ");
        throw new RailwayApiError(
          `Railway API errors: ${messages}`,
          method,
        );
      }

      if (!json.data) {
        throw new RailwayApiError(
          "Railway API returned no data",
          method,
        );
      }

      logInfo(`railway.${method} succeeded`, { method });
      return json.data;
    } catch (err) {
      status = "error";

      if (err instanceof RailwayApiError) {
        logError(err.message, { method });
        throw err;
      }

      const message = err instanceof Error ? err.message : String(err);
      logError(`railway.${method} failed: ${message}`, { method });
      throw new RailwayApiError(
        `Railway API network error: ${message}`,
        method,
      );
    } finally {
      const latency = Date.now() - start;
      countMetric("railway_api.count", 1, { method, status });
      distributionMetric("railway_api.latency_ms", latency, "ms", { method });
    }
  }
}

export class RailwayApiError extends Error {
  readonly method: string;

  constructor(message: string, method: string) {
    super(message);
    this.name = "RailwayApiError";
    this.method = method;
  }
}

let singleton: RailwayClient | null = null;

export function getRailwayClient(): RailwayClient {
  if (singleton) {
    return singleton;
  }

  const parsed = envSchema.safeParse({
    RAILWAY_API_TOKEN: process.env.RAILWAY_API_TOKEN,
    RAILWAY_PROJECT_ID: process.env.RAILWAY_PROJECT_ID,
    RAILWAY_ENVIRONMENT_ID: process.env.RAILWAY_ENVIRONMENT_ID,
  });

  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => i.message).join("; ");
    throw new Error(`Railway env validation failed: ${issues}`);
  }

  singleton = new RailwayClient(parsed.data);
  return singleton;
}

/** Reset the singleton (for testing only). */
export function resetRailwayClient(): void {
  singleton = null;
}
