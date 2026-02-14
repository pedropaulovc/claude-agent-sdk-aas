import { describe, it, expect } from "vitest";
import { buildOtelEnv } from "./env.js";

describe("buildOtelEnv", () => {
  it("returns empty object when DSN is undefined", () => {
    expect(buildOtelEnv(undefined)).toEqual({});
  });

  it("returns empty object when DSN is empty string", () => {
    expect(buildOtelEnv("")).toEqual({});
  });

  it("returns empty object for malformed DSN", () => {
    expect(buildOtelEnv("not-a-url")).toEqual({});
  });

  it("parses valid Sentry DSN into OTEL env vars", () => {
    const dsn = "https://abc123@o12345.ingest.sentry.io/67890";
    const result = buildOtelEnv(dsn);

    expect(result).toEqual({
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://o12345.ingest.sentry.io/api/67890/otlp/v1/traces",
      OTEL_EXPORTER_OTLP_HEADERS: `Authorization=DSN ${dsn}`,
      OTEL_RESOURCE_ATTRIBUTES: "service.name=claude-agent-sdk-aas",
    });
  });

  it("handles DSN with port in host", () => {
    const dsn = "https://key123@sentry.example.com:9000/42";
    const result = buildOtelEnv(dsn);

    expect(result.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(
      "https://sentry.example.com:9000/api/42/otlp/v1/traces",
    );
  });

  it("returns empty object when DSN has no username (key)", () => {
    // URL with no username portion
    const dsn = "https://sentry.example.com/42";
    const result = buildOtelEnv(dsn);

    expect(result).toEqual({});
  });
});
