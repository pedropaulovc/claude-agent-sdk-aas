import * as Sentry from "@sentry/node";

/**
 * Derive OTEL env vars from a Sentry DSN + active span so that a subprocess
 * (e.g. the Claude Agent SDK) exports its spans into the same Sentry trace.
 *
 * DSN format:  https://{PUBLIC_KEY}@{HOST}/{PROJECT_ID}
 * OTLP endpoint: https://{HOST}/api/{PROJECT_ID}/integration/otlp/v1/traces/
 */
export function getOtelEnvVars(
  sentryDsn: string,
  span: Sentry.Span | undefined,
  instanceName: string,
): Record<string, string> {
  const parsed = parseDsn(sentryDsn);
  if (!parsed) {
    return {};
  }

  const endpoint = `https://${parsed.host}/api/${parsed.projectId}/integration/otlp/v1/traces/`;
  const authHeader = `x-sentry-auth=sentry sentry_key=${parsed.publicKey}`;

  const vars: Record<string, string> = {
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpoint,
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: authHeader,
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
    OTEL_TRACES_SAMPLER: "always_on",
    OTEL_SERVICE_NAME: `aas-worker:${instanceName}`,
  };

  if (span) {
    const ctx = span.spanContext();
    // W3C Trace Context: 00-{trace_id}-{span_id}-{flags}
    vars["TRACEPARENT"] = `00-${ctx.traceId}-${ctx.spanId}-01`;
  }

  return vars;
}

function parseDsn(dsn: string): { publicKey: string; host: string; projectId: string } | null {
  try {
    const url = new URL(dsn);
    const publicKey = url.username;
    const host = url.host;
    const projectId = url.pathname.replace(/^\//, "");
    if (!publicKey || !host || !projectId) {
      return null;
    }
    return { publicKey, host, projectId };
  } catch {
    return null;
  }
}
