import { z } from "zod";

// MCP Server Config - remote only (no stdio in containers)
export const mcpServerSchema = z.object({
  name: z.string().min(1, "name is required"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});
export type McpServerConfig = z.infer<typeof mcpServerSchema>;

// Instance name validation
const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*(\/[a-zA-Z0-9][a-zA-Z0-9._-]*)*$/;
export const instanceNameSchema = z.string().regex(NAME_PATTERN, "Invalid instance name: must be alphanumeric segments separated by slashes");

// Provision request schema
export const provisionSchema = z.object({
  name: instanceNameSchema,
  systemPrompt: z.string().min(1, "systemPrompt is required"),
  mcpServers: z.array(mcpServerSchema).optional().default([]),
  model: z.string().optional().default("claude-haiku-4-5-20251001"),
  maxTurns: z.number().int().positive().optional().default(50),
  maxBudgetUsd: z.number().positive().optional().default(1.0),
});
export type ProvisionRequest = z.infer<typeof provisionSchema>;

// Update request schema (all fields optional)
export const updateSchema = z.object({
  systemPrompt: z.string().min(1, "systemPrompt cannot be empty").optional(),
  mcpServers: z.array(mcpServerSchema).optional(),
  model: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  maxBudgetUsd: z.number().positive().optional(),
});
export type UpdateRequest = z.infer<typeof updateSchema>;

// Activation request schema (POST /activate on worker)
export const activationSchema = z.object({
  instanceName: instanceNameSchema,
  systemPrompt: z.string().min(1, "systemPrompt is required"),
  mcpServers: z.array(mcpServerSchema).optional().default([]),
  model: z.string().optional().default("claude-haiku-4-5-20251001"),
  maxTurns: z.number().int().positive().optional().default(50),
  maxBudgetUsd: z.number().positive().optional().default(1.0),
});
export type ActivationRequest = z.infer<typeof activationSchema>;

// Instance status
export type InstanceStatus = "provisioning" | "deploying" | "ready" | "unreachable" | "error" | "destroying";

// Instance record
export type InstanceRecord = {
  name: string;
  systemPrompt: string;
  mcpServers: McpServerConfig[];
  model: string;
  maxTurns: number;
  maxBudgetUsd: number;
  status: InstanceStatus;
  railwayServiceId: string | null;
  workerUrl: string | null;
  workerNumber: number | null;
  provisionError: string | null;
  createdAt: Date;
};
