// Build OTEL environment variables for SDK subprocess telemetry
export function buildOtelEnv(
  sentryDsn: string | undefined,
  traceparent?: string,
): Record<string, string> {
  const env: Record<string, string> = {};

  if (traceparent) {
    env.TRACEPARENT = traceparent;
  }

  if (!sentryDsn) return env;

  try {
    const url = new URL(sentryDsn);
    const key = url.username;
    const projectId = url.pathname.replace("/", "");
    const otlpEndpoint = `https://${url.host}/api/${projectId}/otlp/v1/traces`;

    if (!key || !projectId) return env;

    return {
      ...env,
      OTEL_EXPORTER_OTLP_ENDPOINT: otlpEndpoint,
      OTEL_EXPORTER_OTLP_HEADERS: `Authorization=DSN ${sentryDsn}`,
      OTEL_RESOURCE_ATTRIBUTES: "service.name=claude-agent-sdk-aas",
    };
  } catch {
    return env;
  }
}
