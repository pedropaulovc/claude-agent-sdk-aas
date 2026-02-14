# Agent Invocation

Invoke an agent instance to process a prompt. The response is streamed via SSE. Each instance has a FIFO queue allowing one invocation at a time. Sessions persist across invocations for conversation continuity.

## Invoke Request

`POST /v1/instances/{name}/invoke` — invoke an agent instance with a prompt.

### Request Body

```typescript
{
  "prompt": "What do you think about the new project?",
  "traceContext": {           // optional, for distributed tracing
    "sentryTrace": "...",
    "baggage": "..."
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | string | Yes | Non-empty user message to send to the agent |
| `traceContext` | object | No | If provided, the invocation trace is linked to the caller's trace |
| `traceContext.sentryTrace` | string | — | Sentry trace header value |
| `traceContext.baggage` | string | — | W3C baggage header value |

Returns 400 if `prompt` is missing or empty.

## SSE Response

Response content-type: `text/event-stream`. The connection stays open for the duration of the invocation, emitting events as the agent processes.

### Event Types

| Event | Data | Description |
|-------|------|-------------|
| `init` | `{ invocationId, instanceName, model, turn: 0 }` | Invocation started |
| `assistant_text` | `{ text, turn }` | Chunk of assistant text output |
| `tool_use` | `{ toolName, toolInput, toolUseId, turn }` | Agent is calling a tool |
| `tool_result` | `{ toolUseId, result, turn }` | Tool execution result |
| `turn_complete` | `{ turn, stopReason }` | One LLM turn completed |
| `done` | `{ invocationId, turns, costUsd, durationMs, stopReason, sessionId }` | Invocation finished successfully |
| `error` | `{ invocationId, error, code }` | Invocation failed |

### Example SSE Stream

```
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

## Invocation Queue

Each instance has a FIFO queue. Only one invocation runs at a time per instance.

### Behavior

```
Instance status: ready
  -> invoke arrives -> status becomes "running", invocation starts immediately

Instance status: running
  -> invoke arrives -> queued (FIFO)
  -> current invocation completes -> next in queue starts automatically

Queue full (25 items):
  -> invoke arrives -> 429 Too Many Requests
```

- New invocations while one is running are queued in FIFO order
- Queue has a configurable max depth (default: 25)
- When queue is full, return 429 Too Many Requests with `Retry-After` header
- Queue depth is visible in instance details (`queueDepth` field)
- When the active invocation completes, the next queued invocation starts automatically

## Session Management

Sessions provide conversation continuity across invocations. The agent remembers prior turns within a session.

- First invocation on an instance creates a new SDK session
- `sessionId` is stored on the instance after invocation completes
- Subsequent invocations use the SDK `resume` parameter with the stored sessionId
- PATCH update on an instance resets `sessionId` (forces new session on next invoke)
- Sessions are in-memory only — lost on process restart

### Session Lifecycle

```
Instance created -> sessionId: null
  -> first invoke completes -> sessionId: "sess-123"
  -> second invoke starts -> resume with "sess-123"
  -> second invoke completes -> sessionId: "sess-456" (updated)
  -> PATCH instance -> sessionId: null (reset)
  -> next invoke -> creates new session
```

## Abort

If the client disconnects (closes the SSE connection), the active invocation is cancelled:

1. SDK subprocess is killed
2. Invocation marked as cancelled
3. Instance status returns to "ready"
4. Next queued invocation starts automatically

No error event is emitted on client-initiated disconnect.

## Error Handling

| Error | Response |
|-------|----------|
| Instance not found | 404 |
| Instance in error state | 503 with error details |
| Queue full | 429 with `Retry-After` header |
| SDK error during invocation | SSE `error` event, instance status -> "error" |
| Client disconnect | Invocation cancelled, no error |
| Invalid/empty prompt | 400 |

### SDK Error Recovery

When an SDK error occurs during invocation:
1. An SSE `error` event is emitted with the error details and a code
2. The instance status transitions to "error"
3. The instance must be explicitly recovered (e.g., via PATCH or delete/recreate) before new invocations can run
4. Queued invocations receive 503 responses and are discarded

## Related

- **Instances**: [instances.md](instances.md) — instance lifecycle and configuration
- **Telemetry**: [telemetry.md](telemetry.md) — invocation tracing, logging, and metrics
