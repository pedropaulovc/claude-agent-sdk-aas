# Telemetry

Liberal observability via Sentry. Every instance operation, invocation, tool call, and API request is traced, logged, and measured. Telemetry is VITAL — when in doubt, add a span, log, or metric.

## Sentry Init

```typescript
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 1.0,   // 100% sampling
  enableLogs: true,
  beforeSendSpan: (span) => {
    // Console log every span for dev visibility
    console.log(`[sentry] ${span.op} | ${span.description} | ${span.timestamp - span.start_timestamp}ms | trace=${span.trace_id}`);
    return span;
  }
});
```

All traces are sampled at 100%. Every span is logged to console for grep-ability during development.

## Telemetry Helpers

Located in `src/telemetry/helpers.ts`:

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
dev/A/michael | invoke.start | invocationId=abc prompt.len=150
dev/A/michael | prompt.1 | [chunk 1/3] You are Michael Scott...
dev/A/michael | prompt.1 | [chunk 2/3] ...of Dunder Mifflin Scranton branch...
dev/A/michael | prompt.1 | [chunk 3/3] ...Your core memory: ...
dev/A/michael | assistant.1 | Let me check the recent messages...
dev/A/michael | tool_use.1 | send_message {"channelId":"general","text":"Hey!"}
dev/A/michael | tool_result.1 | send_message -> {"messageId":"uuid"}
dev/A/michael | assistant.2 | I've sent the message.
dev/A/michael | invoke.done | status=completed turns=2 cost=$0.003 duration=2500ms
```

### Text Chunking

Any text longer than 5000 characters is split into blocks, each logged separately as `[chunk N/M]`. This applies to:
- System prompts
- Tool inputs
- Tool results
- Assistant text

## Distributed Tracing

### 1. Incoming Trace Propagation

HTTP middleware extracts `sentry-trace` and `baggage` headers from incoming requests and continues the parent trace. All spans created during request handling are children of the incoming trace.

For the invoke endpoint, the request body's `traceContext` field is used instead of HTTP headers — this supports callers that cannot set custom headers (e.g., browser SSE via `EventSource`).

### 2. SDK Subprocess Tracing

The SDK `query()` call runs as a subprocess. Pass OTEL environment variables to propagate the trace into the subprocess:

1. Parse Sentry DSN to derive the OTLP endpoint
2. Set `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` (auth)
3. Set `OTEL_RESOURCE_ATTRIBUTES` with service name
4. Set `TRACEPARENT` env var with current span's trace context

This makes SDK-internal spans (LLM calls, tool execution) appear as children of the invocation span in Sentry.

### 3. MCP Trace Linking

When the SDK makes MCP calls to remote tool servers, a new trace is started with a **span link** back to the originating trace (not parent-child). This keeps the tool server's trace independent but connected.

Per OTEL semantic conventions, span links are appropriate when the linked operation is causally related but not a direct parent-child relationship.

## HTTP Middleware

Every incoming HTTP request is instrumented:

1. Extract `sentry-trace` + `baggage` headers
2. Start a server span with `continueTrace()`
3. Attach trace ID to response as `x-sentry-trace-id` header
4. Log: `[sentry] http.server | {METHOD} {PATH} | {duration}ms | trace={TRACE_ID}`

All API routes MUST use `jsonResponse()` / `emptyResponse()` helpers instead of raw `Response` constructors. These helpers automatically attach the `x-sentry-trace-id` response header.

## Metrics

| Metric | Type | Tags | Description |
|--------|------|------|-------------|
| `instance.count` | Gauge | — | Current number of instances |
| `invoke.count` | Counter | instance, model | Invocations started |
| `invoke.duration_ms` | Distribution | instance, model, status | Invocation duration |
| `invoke.error` | Counter | instance, error_type | Invocation errors |
| `invoke.cost_usd` | Distribution | instance, model | Cost per invocation |
| `invoke.turns` | Distribution | instance, model | Turns per invocation |
| `queue.depth` | Gauge | instance | Current queue depth |
| `nuke.count` | Counter | prefix | Nuke operations |
| `nuke.deleted` | Distribution | prefix | Instances deleted per nuke |

## Instrumentation Matrix

Comprehensive table of what gets instrumented and how:

| Operation | Span | Log | Metric |
|-----------|------|-----|--------|
| Instance provision | Yes | Yes (config summary) | `instance.count` |
| Instance delete/nuke | Yes | Yes (deleted count) | `nuke.count`, `nuke.deleted` |
| Invoke start | Yes (parent) | Yes (prompt, config) | `invoke.count` |
| SDK turn | Yes (child) | Yes (assistant text) | — |
| Tool use | Yes (grandchild) | Yes (tool name, input) | — |
| Tool result | — | Yes (result, chunked) | — |
| Invoke complete | — | Yes (summary) | `invoke.duration_ms`, `invoke.cost_usd`, `invoke.turns` |
| Invoke error | — | Yes (error details) | `invoke.error` |
| Queue enqueue | — | Yes | `queue.depth` |
| Queue dequeue | — | Yes | `queue.depth` |
| HTTP request | Yes | Yes (method, path, status) | — |

### Trace Hierarchy

```
HTTP Request (server span)
  +-- Invocation (parent span)
       +-- SDK Turn 1 (child span)
       |    +-- Tool Call A (grandchild span)
       |    +-- Tool Call B (grandchild span)
       +-- SDK Turn 2 (child span)
            +-- Tool Call C (grandchild span)
```

## Related

- **Invocation**: [invocation.md](invocation.md) — SSE events and invocation lifecycle
- **Instances**: [instances.md](instances.md) — instance operations that emit telemetry
