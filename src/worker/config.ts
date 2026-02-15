import { z } from "zod";

const bootConfigSchema = z.object({
  anthropicApiKey: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  sentryDsn: z.string().min(1, "SENTRY_DSN is required"),
  port: z.coerce.number().int().positive().default(8080),
});

export type BootConfig = z.infer<typeof bootConfigSchema>;

export function parseBootConfig(
  env: Record<string, string | undefined> = process.env,
): BootConfig {
  const result = bootConfigSchema.safeParse({
    anthropicApiKey: env["ANTHROPIC_API_KEY"],
    sentryDsn: env["SENTRY_DSN"],
    port: env["PORT"] || undefined,
  });

  if (!result.success) {
    const messages = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Worker boot config validation failed: ${messages}`);
  }

  return result.data;
}
