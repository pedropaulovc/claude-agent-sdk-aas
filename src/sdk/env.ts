// Build OTEL environment variables for SDK subprocess telemetry
export function buildOtelEnv(sentryDsn: string | undefined): Record<string, string> {
  if (!sentryDsn) return {};

  try {
    const url = new URL(sentryDsn);
    const key = url.username;
    const projectId = url.pathname.replace("/", "");
    const otlpEndpoint = `https://${url.host}/api/${projectId}/otlp/v1/traces`;

    if (!key || !projectId) return {};

    return {
      OTEL_EXPORTER_OTLP_ENDPOINT: otlpEndpoint,
      OTEL_EXPORTER_OTLP_HEADERS: `Authorization=DSN ${sentryDsn}`,
      OTEL_RESOURCE_ATTRIBUTES: "service.name=claude-agent-sdk-aas",
    };
  } catch {
    return {};
  }
}
