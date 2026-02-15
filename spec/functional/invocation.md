# Messaging

Send messages to agent instances through the control plane. The control plane proxies requests to the worker (activated from the dormant pool), which runs the Claude Agent SDK and streams the response back via SSE.

## Message Request

`POST /v1/instances/{name}/message` — send a message to an agent instance.

### Request Body

```typescript
{
  "message": "What do you think about the new project?",
  "traceContext": {           // optional, for distributed tracing
    "sentryTrace": "...",
    "baggage": "..."
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string | Yes | Non-empty user message to send to the agent |
| `traceContext` | object | No | If provided, the invocation trace is linked to the caller's trace |
| `traceContext.sentryTrace` | string | — | Sentry trace header value |
| `traceContext.baggage` | string | — | W3C baggage header value |

Returns 400 if `message` is missing or empty.

## Proxy Behavior

The control plane does **not** run the SDK itself. It proxies the request to the worker container:

1. Look up `InstanceRecord` by name
2. **Guard**: if instance status is not `ready`, return 503 with `{ error: "Instance not ready", status: "{current_status}" }`
3. Forward `POST /message` to the worker's internal URL (`workerUrl`)
4. Stream the worker's SSE response directly back to the caller (pass-through)

### Trace Context Propagation

The control plane propagates distributed trace context on **every** proxied request (`/message`, `/history`, `/status`):

1. **Incoming**: The control plane HTTP middleware extracts `sentry-trace` and `baggage` from the caller's request headers (standard W3C/Sentry propagation) and starts a server span via `Sentry.continueTrace()`
2. **Body override** (message only): For `POST /message`, the `traceContext` body field takes precedence over HTTP headers — this supports callers that cannot set custom headers (e.g., browser `EventSource` for SSE)
3. **Outgoing**: The control plane attaches `sentry-trace` and `baggage` headers to the proxied request to the worker, derived from the active span. This makes the worker's spans children of the control plane's proxy span.
4. **Worker receives**: The worker's HTTP middleware extracts the incoming `sentry-trace` and `baggage` headers via `Sentry.continueTrace()`, connecting its spans to the caller's trace.

This ensures a single unbroken trace from caller → control plane → worker → SDK.

## SSE Response

Response content-type: `text/event-stream`. The connection stays open for the duration of the invocation, emitting events as the agent processes.

### Event Types

| Event | Data | Description |
|-------|------|-------------|
| `queued` | `{ position, instanceName }` | Message is queued (worker queue not empty) |
| `init` | `{ invocationId, instanceName, model, turn: 0 }` | Invocation started |
| `assistant_text` | `{ text, turn }` | Chunk of assistant text output |
| `tool_use` | `{ toolName, toolInput, toolUseId, turn }` | Agent is calling a tool |
| `tool_result` | `{ toolUseId, result, turn }` | Tool execution result |
| `turn_complete` | `{ turn, stopReason }` | One LLM turn completed |
| `done` | `{ invocationId, turns, costUsd, durationMs, stopReason, sessionId }` | Invocation finished successfully |
| `error` | `{ invocationId, error, code }` | Invocation failed |

### Example SSE Stream

```
event: queued
data: {"position":1,"instanceName":"dev/A/michael"}

event: init
data: {"invocationId":"abc-123","instanceName":"dev/A/michael","model":"claude-haiku-4-5-20251001","turn":0}

event: assistant_text
data: {"text":"Let me check ","turn":1}

event: assistant_text
data: {"text":"the recent messages...","turn":1}

event: tool_use
data: {"toolName":"send_message","toolInput":{"channelId":"general","text":"Hey everyone!"},"toolUseId":"tu_1","turn":1}

event: tool_result
data: {"toolUseId":"tu_1","result":{"messageId":"msg-456"},"turn":1}

event: turn_complete
data: {"turn":1,"stopReason":"end_turn"}

event: done
data: {"invocationId":"abc-123","turns":1,"costUsd":0.003,"durationMs":2500,"stopReason":"end_turn","sessionId":"sess-789"}
```

## Conversation History

`GET /v1/instances/{name}/history` — retrieve conversation history from the worker.

The control plane proxies this to the worker's `GET /history` endpoint. Returns the full in-memory conversation history maintained by the worker. See [worker-api.md](worker-api.md) for history format details.

**Guard**: returns 503 if instance status is not `ready` or `unreachable`.

## Worker Status

`GET /v1/instances/{name}/status` — retrieve runtime status from the worker.

The control plane proxies this to the worker's `GET /status` endpoint. Returns session info, invocation counts, uptime, and cost tracking. See [worker-api.md](worker-api.md) for status format details.

**Guard**: returns 503 if instance status is not `ready` or `unreachable`.

## Session Management

Sessions provide conversation continuity across messages. The agent remembers prior turns within a session. Session management is handled entirely by the worker container.

- Worker creates a new SDK session on first message
- Subsequent messages use the SDK `resume` parameter with the stored sessionId
- Config updates (PATCH on control plane) trigger a destroy + re-provision from the pool, which resets the session
- Sessions are in-memory only — lost on container restart

## Abort

If the caller disconnects (closes the SSE connection), the control plane closes the proxied connection to the worker. The worker detects this and cancels the active invocation:

1. SDK subprocess is killed
2. Invocation marked as cancelled
3. Next queued message starts automatically

Callers can also explicitly abort via `POST /v1/instances/{name}/abort` (not yet implemented — future enhancement).

## Error Handling

| Error | Response |
|-------|----------|
| Instance not found | 404 |
| Instance not `ready` | 503 with current status |
| Worker returns error | Proxied error response |
| Worker unreachable | 503 with `{ error: "Worker unreachable" }` |
| Invalid/empty message | 400 |
| Worker queue full | 429 (proxied from worker) |

## Related

- **Instances**: [instances.md](instances.md) — instance lifecycle and configuration
- **Worker API**: [worker-api.md](worker-api.md) — worker endpoints, queue, history
- **Telemetry**: [telemetry.md](telemetry.md) — invocation tracing, logging, and metrics
