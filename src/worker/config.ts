import { z } from "zod";
import { mcpServerSchema } from "../shared/types.js";

const workerConfigSchema = z.object({
  instanceName: z.string().min(1, "AAS_INSTANCE_NAME is required"),
  systemPrompt: z.string().min(1, "AAS_SYSTEM_PROMPT is required"),
  mcpServers: z.array(mcpServerSchema).default([]),
  model: z.string().default("claude-haiku-4-5-20251001"),
  maxTurns: z.coerce.number().int().positive().default(50),
  maxBudgetUsd: z.coerce.number().positive().default(1.0),
  anthropicApiKey: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  sentryDsn: z.string().min(1, "SENTRY_DSN is required"),
  port: z.coerce.number().int().positive().default(8080),
});

export type WorkerConfig = z.infer<typeof workerConfigSchema>;

function parseMcpServers(raw: string | undefined): unknown {
  if (!raw || raw.trim() === "") {
    return [];
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`AAS_MCP_SERVERS contains invalid JSON: ${raw}`);
  }
}

export function parseWorkerConfig(
  env: Record<string, string | undefined> = process.env,
): WorkerConfig {
  const mcpServers = parseMcpServers(env["AAS_MCP_SERVERS"]);

  const result = workerConfigSchema.safeParse({
    instanceName: env["AAS_INSTANCE_NAME"],
    systemPrompt: env["AAS_SYSTEM_PROMPT"],
    mcpServers,
    model: env["AAS_MODEL"] || undefined,
    maxTurns: env["AAS_MAX_TURNS"] || undefined,
    maxBudgetUsd: env["AAS_MAX_BUDGET_USD"] || undefined,
    anthropicApiKey: env["ANTHROPIC_API_KEY"],
    sentryDsn: env["SENTRY_DSN"],
    port: env["PORT"] || undefined,
  });

  if (!result.success) {
    const messages = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Worker config validation failed: ${messages}`);
  }

  return result.data;
}
