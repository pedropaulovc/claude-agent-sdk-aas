# Telemetry

Liberal observability via Sentry. Every instance operation, proxy request, worker invocation, tool call, and API request is traced, logged, and measured. Both the control plane and worker containers run their own Sentry instances. Telemetry is VITAL — when in doubt, add a span, log, or metric.

## Sentry Init

Both roles initialize Sentry with different service names:

```typescript
// Control plane
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 1.0,
  enableLogs: true,
  environment: 'production',
  serverName: 'aas-control-plane',
  beforeSendSpan: (span) => {
    console.log(`[sentry] ${span.op} | ${span.description} | ${(span.timestamp - span.start_timestamp) * 1000}ms | trace=${span.trace_id}`);
    return span;
  }
});

// Worker
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 1.0,
  enableLogs: true,
  environment: 'production',
  serverName: `aas-worker-${process.env.AAS_INSTANCE_NAME}`,
  beforeSendSpan: (span) => {
    console.log(`[sentry] ${span.op} | ${span.description} | ${(span.timestamp - span.start_timestamp) * 1000}ms | trace=${span.trace_id}`);
    return span;
  }
});
```

All traces are sampled at 100%. Every span is logged to console for grep-ability during development.

## Telemetry Helpers

Located in `src/telemetry/helpers.ts` (shared between both roles):

| Helper | Signature | Purpose |
|--------|-----------|---------|
| `withSpan` | `(name, op, fn) -> Promise<T>` | Wrap any function in a traced span |
| `logInfo` | `(message, attributes?) -> void` | Structured info log |
| `logWarn` | `(message, attributes?) -> void` | Structured warning log |
| `logError` | `(message, attributes?) -> void` | Structured error log |
| `countMetric` | `(name, value?, attributes?) -> void` | Counter metric |
| `distributionMetric` | `(name, value, unit, attributes?) -> void` | Distribution metric |
| `chunkedLog` | `(prefix, text, maxLen?) -> void` | Log long text in chunks |

## Log Line Format

All console log lines follow a structured format for grep-ability and management UI display:

```
{instanceName} | {event}.{turn} | {content/attributes}
```

### Examples

```
dev/A/michael | provision | prompt.len=2500 mcpServers=1 model=claude-haiku-4-5
dev/A/michael | deploy.start | railwayServiceId=svc-123
dev/A/michael | deploy.healthy | workerUrl=https://aas-w-dev-a-michael.up.railway.app
dev/A/michael | message.start | invocationId=abc prompt.len=150
dev/A/michael | prompt.1 | [chunk 1/3] You are Michael Scott...
dev/A/michael | assistant.1 | Let me check the recent messages...
dev/A/michael | tool_use.1 | send_message {"channelId":"general","text":"Hey!"}
dev/A/michael | tool_result.1 | send_message -> {"messageId":"uuid"}
dev/A/michael | assistant.2 | I've sent the message.
dev/A/michael | message.done | status=completed turns=2 cost=$0.003 duration=2500ms
```

### Text Chunking

Any text longer than 5000 characters is split into blocks, each logged separately as `[chunk N/M]`. This applies to:
- System prompts
- Tool inputs
- Tool results
- Assistant text

## Distributed Tracing

### Trace Hierarchy

The full trace spans from caller through control plane to worker:

```
Caller Span (external)
  └── Control Plane: HTTP Request (server span)
        └── Control Plane: Proxy Request (child span)
              └── Worker: HTTP Request (server span, continued trace)
                    └── Worker: Invocation (parent span)
                         ├── SDK Turn 1 (child span)
                         │    ├── Tool Call A (grandchild span)
                         │    └── Tool Call B (grandchild span)
                         └── SDK Turn 2 (child span)
                              └── Tool Call C (grandchild span)
```

### 1. Incoming Trace Propagation (Both Roles)

HTTP middleware on **both** control plane and worker extracts `sentry-trace` and `baggage` headers from incoming requests, then calls `Sentry.continueTrace()` to create a server span that is a child of the caller's trace. All spans created during request handling are children of this server span.

On the control plane's message endpoint specifically, the request body's `traceContext` field takes precedence over HTTP headers — this supports callers that cannot set custom headers (e.g., browser SSE via `EventSource`).

### 2. Proxy Trace Propagation (Control Plane → Worker)

When the control plane proxies **any** request to a worker (`/message`, `/history`, `/status`), it attaches `sentry-trace` and `baggage` headers derived from the active span to the outgoing request. The worker's HTTP middleware picks these up via `continueTrace()`, making the worker's spans children of the control plane's proxy span. This creates an unbroken trace from caller → control plane → worker.

### 3. SDK Subprocess Tracing (Worker)

The SDK `query()` call runs as a subprocess. Pass OTEL environment variables to propagate the trace into the subprocess:

1. Parse Sentry DSN to derive the OTLP endpoint
2. Set `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` (auth)
3. Set `OTEL_RESOURCE_ATTRIBUTES` with service name
4. Set `TRACEPARENT` env var with current span's trace context

This makes SDK-internal spans (LLM calls, tool execution) appear as children of the invocation span in Sentry.

### 4. MCP Trace Linking (Worker)

When the SDK makes MCP calls to remote tool servers, a new trace is started with a **span link** back to the originating trace (not parent-child). This keeps the tool server's trace independent but connected.

### 5. Railway API Tracing (Control Plane)

All Railway GraphQL API calls are wrapped in Sentry spans:

```
Control Plane: Provision Instance
  ├── Railway: serviceCreate
  ├── Railway: variableCollectionUpsert
  └── Railway: serviceDomainCreate
```

## HTTP Middleware

Every incoming HTTP request is instrumented (both roles):

1. Extract `sentry-trace` + `baggage` headers
2. Start a server span with `continueTrace()`
3. Attach trace ID to response as `x-sentry-trace-id` header
4. Log: `[sentry] http.server | {METHOD} {PATH} | {duration}ms | trace={TRACE_ID}`

All API routes MUST use `jsonResponse()` / `streamResponse()` helpers instead of raw `Response` constructors. These helpers automatically attach the `x-sentry-trace-id` response header.

## Metrics

### Control Plane Metrics

| Metric | Type | Tags | Description |
|--------|------|------|-------------|
| `instance.count` | Gauge | — | Current number of instances |
| `provision.count` | Counter | status | Provision attempts (success/error) |
| `provision.duration_ms` | Distribution | — | Time from provision request to ready |
| `proxy.count` | Counter | instance, route | Proxied requests |
| `proxy.duration_ms` | Distribution | instance, route | Proxy latency |
| `proxy.error` | Counter | instance, error_type | Proxy errors |
| `nuke.count` | Counter | prefix | Nuke operations |
| `nuke.deleted` | Distribution | prefix | Instances deleted per nuke |
| `health_poll.count` | Counter | instance, result | Health check results |
| `health_poll.latency_ms` | Distribution | instance | Health check latency |
| `railway_api.count` | Counter | operation, status | Railway API calls |
| `railway_api.duration_ms` | Distribution | operation | Railway API latency |

### Worker Metrics

| Metric | Type | Tags | Description |
|--------|------|------|-------------|
| `message.count` | Counter | model | Messages processed |
| `message.duration_ms` | Distribution | model, status | Message processing duration |
| `message.error` | Counter | error_type | Message errors |
| `message.cost_usd` | Distribution | model | Cost per message |
| `message.turns` | Distribution | model | Turns per message |
| `queue.depth` | Gauge | — | Current queue depth |

## Instrumentation Matrix

### Control Plane

| Operation | Span | Log | Metric |
|-----------|------|-----|--------|
| Instance provision | Yes | Yes (config summary) | `instance.count`, `provision.count` |
| Instance delete/nuke | Yes | Yes (deleted count) | `nuke.count`, `nuke.deleted` |
| Railway API call | Yes | Yes (operation, response) | `railway_api.count`, `railway_api.duration_ms` |
| Health poll | Yes | Yes (instance, result) | `health_poll.count`, `health_poll.latency_ms` |
| Proxy request | Yes | Yes (instance, route) | `proxy.count`, `proxy.duration_ms` |
| HTTP request | Yes | Yes (method, path, status) | — |

### Worker

| Operation | Span | Log | Metric |
|-----------|------|-----|--------|
| Message start | Yes (parent) | Yes (prompt, config) | `message.count` |
| SDK turn | Yes (child) | Yes (assistant text) | — |
| Tool use | Yes (grandchild) | Yes (tool name, input) | — |
| Tool result | — | Yes (result, chunked) | — |
| Message complete | — | Yes (summary) | `message.duration_ms`, `message.cost_usd`, `message.turns` |
| Message error | — | Yes (error details) | `message.error` |
| Queue enqueue | — | Yes | `queue.depth` |
| Queue dequeue | — | Yes | `queue.depth` |
| HTTP request | Yes | Yes (method, path, status) | — |

## Related

- **Messaging**: [invocation.md](invocation.md) — SSE events and messaging lifecycle
- **Instances**: [instances.md](instances.md) — instance operations that emit telemetry
- **Worker API**: [worker-api.md](worker-api.md) — worker endpoints
- **Railway Integration**: [railway-integration.md](railway-integration.md) — Railway API calls
