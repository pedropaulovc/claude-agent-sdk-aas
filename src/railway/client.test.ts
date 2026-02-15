import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Sentry from "@sentry/node";

const mockSetAttribute = vi.fn();

vi.mock("@sentry/node", async () => {
  const actual = await vi.importActual<typeof Sentry>("@sentry/node");
  return {
    ...actual,
    startSpan: vi.fn((_opts, cb) =>
      cb({
        setAttribute: mockSetAttribute,
        spanContext: () => ({ traceId: "test-trace" }),
      }),
    ),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fmt: actual.logger.fmt,
    },
  };
});

import {
  RailwayClient,
  RailwayApiError,
  getRailwayClient,
  resetRailwayClient,
} from "./client.js";

function makeClient(): RailwayClient {
  return new RailwayClient({
    RAILWAY_API_TOKEN: "test-token",
    RAILWAY_PROJECT_ID: "proj-123",
    RAILWAY_ENVIRONMENT_ID: "env-456",
  });
}

function mockFetchSuccess(data: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data }),
      text: () => Promise.resolve(JSON.stringify({ data })),
    }),
  );
}

function mockFetchGraphQLErrors(errors: Array<{ message: string }>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ errors }),
      text: () => Promise.resolve(JSON.stringify({ errors })),
    }),
  );
}

function mockFetchHttpError(status: number, body: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: false,
      status,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(body),
    }),
  );
}

function mockFetchNetworkError(message: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new Error(message)),
  );
}

describe("RailwayClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetRailwayClient();
  });

  // --- serviceCreate ---

  it("serviceCreate returns serviceId on success", async () => {
    mockFetchSuccess({ serviceCreate: { id: "svc-abc" } });
    const client = makeClient();

    const result = await client.serviceCreate("my-service");

    expect(result).toEqual({ serviceId: "svc-abc" });
  });

  it("serviceCreate sends correct GraphQL payload", async () => {
    mockFetchSuccess({ serviceCreate: { id: "svc-abc" } });
    const client = makeClient();

    await client.serviceCreate("my-service");

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect(fetchCall[0]).toBe("https://backboard.railway.com/graphql/v2");
    const body = JSON.parse(fetchCall[1]?.body as string) as {
      query: string;
      variables: { input: { name: string; projectId: string } };
    };
    expect(body.variables.input.name).toBe("my-service");
    expect(body.variables.input.projectId).toBe("proj-123");
  });

  it("serviceCreate sets span attributes", async () => {
    mockFetchSuccess({ serviceCreate: { id: "svc-abc" } });
    const client = makeClient();

    await client.serviceCreate("my-service");

    expect(mockSetAttribute).toHaveBeenCalledWith("railway.service.name", "my-service");
    expect(mockSetAttribute).toHaveBeenCalledWith("railway.service.id", "svc-abc");
  });

  it("serviceCreate creates a Sentry span", async () => {
    mockFetchSuccess({ serviceCreate: { id: "svc-abc" } });
    const client = makeClient();

    await client.serviceCreate("my-service");

    expect(Sentry.startSpan).toHaveBeenCalledWith(
      { name: "railway.serviceCreate", op: "railway.api" },
      expect.any(Function),
    );
  });

  // --- serviceConnect ---

  it("serviceConnect sends correct GraphQL payload", async () => {
    mockFetchSuccess({ serviceConnect: { id: "svc-abc" } });
    const client = makeClient();

    await client.serviceConnect("svc-abc", "owner/repo", "main");

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(fetchCall[1]?.body as string) as {
      variables: { id: string; input: { repo: string; branch: string } };
    };
    expect(body.variables.id).toBe("svc-abc");
    expect(body.variables.input).toEqual({ repo: "owner/repo", branch: "main" });
  });

  it("serviceConnect sets span attributes", async () => {
    mockFetchSuccess({ serviceConnect: { id: "svc-abc" } });
    const client = makeClient();

    await client.serviceConnect("svc-abc", "owner/repo", "main");

    expect(mockSetAttribute).toHaveBeenCalledWith("railway.service.id", "svc-abc");
    expect(mockSetAttribute).toHaveBeenCalledWith("railway.repo", "owner/repo");
    expect(mockSetAttribute).toHaveBeenCalledWith("railway.branch", "main");
  });

  // --- serviceDelete ---

  it("serviceDelete completes without error on success", async () => {
    mockFetchSuccess({ serviceDelete: true });
    const client = makeClient();

    await expect(client.serviceDelete("svc-abc")).resolves.toBeUndefined();
  });

  it("serviceDelete sends correct variables", async () => {
    mockFetchSuccess({ serviceDelete: true });
    const client = makeClient();

    await client.serviceDelete("svc-abc");

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(fetchCall[1]?.body as string) as {
      variables: { id: string };
    };
    expect(body.variables.id).toBe("svc-abc");
  });

  // --- variableCollectionUpsert ---

  it("variableCollectionUpsert completes without error on success", async () => {
    mockFetchSuccess({ variableCollectionUpsert: true });
    const client = makeClient();

    await expect(
      client.variableCollectionUpsert("svc-abc", { KEY: "value" }),
    ).resolves.toBeUndefined();
  });

  it("variableCollectionUpsert sends correct input shape", async () => {
    mockFetchSuccess({ variableCollectionUpsert: true });
    const client = makeClient();

    await client.variableCollectionUpsert("svc-abc", { A: "1", B: "2" });

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(fetchCall[1]?.body as string) as {
      variables: {
        input: {
          projectId: string;
          environmentId: string;
          serviceId: string;
          variables: Record<string, string>;
        };
      };
    };
    expect(body.variables.input).toEqual({
      projectId: "proj-123",
      environmentId: "env-456",
      serviceId: "svc-abc",
      variables: { A: "1", B: "2" },
    });
  });

  it("variableCollectionUpsert sets vars count on span", async () => {
    mockFetchSuccess({ variableCollectionUpsert: true });
    const client = makeClient();

    await client.variableCollectionUpsert("svc-abc", { A: "1", B: "2" });

    expect(mockSetAttribute).toHaveBeenCalledWith("railway.vars.count", 2);
  });

  // --- serviceDomainCreate ---

  it("serviceDomainCreate returns domain on success", async () => {
    mockFetchSuccess({
      serviceDomainCreate: { domain: "my-svc.up.railway.app" },
    });
    const client = makeClient();

    const result = await client.serviceDomainCreate("svc-abc");

    expect(result).toEqual({ domain: "my-svc.up.railway.app" });
  });

  it("serviceDomainCreate sends correct input", async () => {
    mockFetchSuccess({
      serviceDomainCreate: { domain: "my-svc.up.railway.app" },
    });
    const client = makeClient();

    await client.serviceDomainCreate("svc-abc");

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(fetchCall[1]?.body as string) as {
      variables: {
        input: { serviceId: string; environmentId: string };
      };
    };
    expect(body.variables.input).toEqual({
      serviceId: "svc-abc",
      environmentId: "env-456",
    });
  });

  it("serviceDomainCreate sets domain on span", async () => {
    mockFetchSuccess({
      serviceDomainCreate: { domain: "my-svc.up.railway.app" },
    });
    const client = makeClient();

    await client.serviceDomainCreate("svc-abc");

    expect(mockSetAttribute).toHaveBeenCalledWith(
      "railway.domain",
      "my-svc.up.railway.app",
    );
  });

  // --- Error handling ---

  it("throws RailwayApiError on HTTP error", async () => {
    mockFetchHttpError(500, "Internal Server Error");
    const client = makeClient();

    await expect(client.serviceCreate("fail")).rejects.toThrow(RailwayApiError);
    await expect(client.serviceCreate("fail")).rejects.toThrow(
      /Railway API returned HTTP 500/,
    );
  });

  it("throws RailwayApiError on GraphQL errors", async () => {
    mockFetchGraphQLErrors([{ message: "Not authorized" }]);
    const client = makeClient();

    await expect(client.serviceCreate("fail")).rejects.toThrow(RailwayApiError);
    await expect(client.serviceCreate("fail")).rejects.toThrow(
      /Not authorized/,
    );
  });

  it("throws RailwayApiError on network failure", async () => {
    mockFetchNetworkError("DNS resolution failed");
    const client = makeClient();

    await expect(client.serviceCreate("fail")).rejects.toThrow(RailwayApiError);
    await expect(client.serviceCreate("fail")).rejects.toThrow(
      /network error.*DNS resolution failed/i,
    );
  });

  it("RailwayApiError includes method name", async () => {
    mockFetchHttpError(403, "Forbidden");
    const client = makeClient();

    try {
      await client.serviceCreate("fail");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RailwayApiError);
      expect((err as RailwayApiError).method).toBe("serviceCreate");
    }
  });

  it("throws RailwayApiError when response has no data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve("{}"),
      }),
    );
    const client = makeClient();

    await expect(client.serviceCreate("fail")).rejects.toThrow(
      /no data/,
    );
  });

  // --- Auth header ---

  it("sends Bearer token in Authorization header", async () => {
    mockFetchSuccess({ serviceDelete: true });
    const client = makeClient();

    await client.serviceDelete("svc-abc");

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const headers = fetchCall[1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  // --- Metrics ---

  it("emits count and distribution metrics on success", async () => {
    mockFetchSuccess({ serviceDelete: true });
    const client = makeClient();

    await client.serviceDelete("svc-abc");

    // countMetric and distributionMetric both call Sentry.startSpan
    // We check that startSpan was called for the main span + 2 metric spans
    const spanCalls = vi.mocked(Sentry.startSpan).mock.calls;
    const metricCalls = spanCalls.filter(
      (call) => (call[0] as { op: string }).op === "metric",
    );
    expect(metricCalls.length).toBe(2);

    const metricNames = metricCalls.map(
      (call) => (call[0] as { name: string }).name,
    );
    expect(metricNames).toContain("metric.railway_api.count");
    expect(metricNames).toContain("metric.railway_api.latency_ms");
  });

  it("emits error status metric on failure", async () => {
    mockFetchHttpError(500, "fail");
    const client = makeClient();

    await client.serviceCreate("fail").catch(() => {});

    const spanCalls = vi.mocked(Sentry.startSpan).mock.calls;
    const countCall = spanCalls.find(
      (call) => (call[0] as { name: string }).name === "metric.railway_api.count",
    );
    if (!countCall) {
      expect.fail("expected metric.railway_api.count span call");
      return;
    }

    // Execute the metric callback to verify attributes
    const setAttr = vi.fn();
    const callback = countCall[1] as (span: { setAttribute: typeof vi.fn }) => void;
    callback({ setAttribute: setAttr });
    expect(setAttr).toHaveBeenCalledWith("metric.tag.status", "error");
  });

  // --- getRailwayClient / env validation ---

  it("getRailwayClient throws when env vars are missing", () => {
    delete process.env.RAILWAY_API_TOKEN;
    delete process.env.RAILWAY_PROJECT_ID;
    delete process.env.RAILWAY_ENVIRONMENT_ID;

    expect(() => getRailwayClient()).toThrow(/env validation failed/);
  });

  it("getRailwayClient returns client when env vars are set", () => {
    process.env.RAILWAY_API_TOKEN = "tok";
    process.env.RAILWAY_PROJECT_ID = "proj";
    process.env.RAILWAY_ENVIRONMENT_ID = "env";

    const client = getRailwayClient();
    expect(client).toBeInstanceOf(RailwayClient);
  });

  it("getRailwayClient returns same singleton on subsequent calls", () => {
    process.env.RAILWAY_API_TOKEN = "tok";
    process.env.RAILWAY_PROJECT_ID = "proj";
    process.env.RAILWAY_ENVIRONMENT_ID = "env";

    const a = getRailwayClient();
    const b = getRailwayClient();
    expect(a).toBe(b);
  });

  it("resetRailwayClient clears the singleton", () => {
    process.env.RAILWAY_API_TOKEN = "tok";
    process.env.RAILWAY_PROJECT_ID = "proj";
    process.env.RAILWAY_ENVIRONMENT_ID = "env";

    const a = getRailwayClient();
    resetRailwayClient();
    const b = getRailwayClient();
    expect(a).not.toBe(b);
  });
});
