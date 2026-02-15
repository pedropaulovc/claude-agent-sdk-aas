import { describe, it, expect } from "vitest";
import { getOtelEnvVars } from "./otel-env.js";

describe("otel-env", () => {
  const DSN = "https://abc123@o99999.ingest.us.sentry.io/1234567890";

  it("derives OTLP endpoint and auth from DSN", () => {
    const vars = getOtelEnvVars(DSN, undefined, "test/agent");

    expect(vars.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe(
      "https://o99999.ingest.us.sentry.io/api/1234567890/integration/otlp/v1/traces/",
    );
    expect(vars.OTEL_EXPORTER_OTLP_TRACES_HEADERS).toBe(
      "x-sentry-auth=sentry sentry_key=abc123",
    );
    expect(vars.OTEL_EXPORTER_OTLP_PROTOCOL).toBe("http/protobuf");
    expect(vars.OTEL_TRACES_SAMPLER).toBe("always_on");
    expect(vars.OTEL_SERVICE_NAME).toBe("aas-worker:test/agent");
  });

  it("includes TRACEPARENT when span is provided", () => {
    const mockSpan = {
      spanContext: () => ({
        traceId: "aaaabbbbccccddddeeeeffffgggghhhh",
        spanId: "1122334455667788",
        traceFlags: 1,
      }),
    } as never;

    const vars = getOtelEnvVars(DSN, mockSpan, "test/agent");

    expect(vars.TRACEPARENT).toBe(
      "00-aaaabbbbccccddddeeeeffffgggghhhh-1122334455667788-01",
    );
  });

  it("returns empty object for invalid DSN", () => {
    const vars = getOtelEnvVars("not-a-url", undefined, "test/agent");
    expect(vars).toEqual({});
  });

  it("omits TRACEPARENT when no span", () => {
    const vars = getOtelEnvVars(DSN, undefined, "test/agent");
    expect(vars.TRACEPARENT).toBeUndefined();
  });
});
