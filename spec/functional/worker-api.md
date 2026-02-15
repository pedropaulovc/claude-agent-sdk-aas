# Worker API

Each worker container runs a Hono HTTP server exposing endpoints for configuration, messaging, history, status, and health. Workers can operate in two modes:

1. **Pool mode** (M5): Worker starts idle with minimal config, receives full instance config via `POST /configure`, and can be recycled via `POST /reset`.
2. **Standalone mode** (M4 compat): Worker reads config from environment variables and starts active immediately.

## Worker State Machine

```
(deployed, no AAS_INSTANCE_NAME) → idle
(deployed, AAS_INSTANCE_NAME set) → active     (standalone mode)

idle → [POST /configure] → configuring → active
active → [POST /reset] → resetting → idle
active → [POST /configure] → configuring → active  (re-assign without reset)
```

| State | Description | `/message` | `/configure` | `/reset` |
|-------|-------------|-----------|-------------|---------|
| `idle` | Running, no instance config. Waiting for assignment. | 503 | Allowed | 200 (no-op) |
| `configuring` | Applying new config. Brief transitional state. | 503 | 409 | 409 |
| `active` | Fully configured, processing messages. | Allowed | Allowed (re-assign) | Allowed |
| `resetting` | Clearing state. Brief transitional state. | 503 | 409 | 409 |

## Configuration

### Pool Mode (M5)

Workers start with minimal environment variables:

| Env Var | Required | Description |
|---------|----------|-------------|
| `AAS_ROLE` | Yes | Must be `worker` |
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key |
| `SENTRY_DSN` | Yes | Sentry DSN for telemetry |
| `PORT` | No | HTTP port (default 8080, injected by Railway) |

Full instance config is received via `POST /configure`.

### Standalone Mode (M4 compat)

Workers read all configuration from environment variables:

| Env Var | Required | Default | Description |
|---------|----------|---------|-------------|
| `AAS_ROLE` | Yes | — | Must be `worker` |
| `AAS_INSTANCE_NAME` | Yes | — | Hierarchical instance name (e.g., `dev/A/michael`) |
| `AAS_SYSTEM_PROMPT` | Yes | — | System prompt for the agent |
| `AAS_MCP_SERVERS` | No | `[]` | JSON-encoded `McpServerConfig[]` |
| `AAS_MODEL` | No | `claude-haiku-4-5-20251001` | Claude model ID |
| `AAS_MAX_TURNS` | No | `50` | Max turns per invocation |
| `AAS_MAX_BUDGET_USD` | No | `1.0` | Max budget per invocation (USD) |
| `ANTHROPIC_API_KEY` | Yes | — | Anthropic API key |
| `SENTRY_DSN` | Yes | — | Sentry DSN for telemetry |
| `PORT` | No | `8080` | HTTP port (injected by Railway) |

When `AAS_INSTANCE_NAME` is set, the worker starts directly in `active` state.

## Endpoints

| Method | Path | Purpose | Requires Active |
|--------|------|---------|----------------|
| POST | `/configure` | Apply instance config (pool mode) | No (idle or active) |
| POST | `/message` | Send message → SSE stream response | Yes |
| GET | `/history` | Conversation history | Yes |
| GET | `/status` | Runtime status | No |
| GET | `/health` | Health check (Railway readiness) | No |
| POST | `/abort` | Abort current invocation | Yes |
| POST | `/reset` | Reset → return to idle | Yes |

---

### POST `/configure`

Apply instance configuration to an idle or active worker. This is the primary mechanism for pool-based provisioning.

#### Request Body

```typescript
{
  instanceName: string,
  systemPrompt: string,
  mcpServers: McpServerConfig[],
  model: string,               // default: "claude-haiku-4-5-20251001"
  maxTurns: number,            // default: 50
  maxBudgetUsd: number,        // default: 1.0
  traceContext?: {
    sentryTrace: string,
    baggage: string,
  }
}
```

#### Behavior

1. Validate the payload with Zod
2. If worker is `active`: clear session, history, and queue first (implicit reset)
3. Apply the new config in-memory
4. Initialize fresh SdkRunner and HistoryStore
5. Update Sentry service name to `aas-worker-{instanceName}`
6. Transition state: `idle` → `configuring` → `active`
7. **Log the full system prompt** via `chunkedLog` (verbose — this is the most important debugging artifact)
8. Log config summary: `{instanceName} | configure | prompt.len={n} mcpServers={n} model={model}`

#### Response

```typescript
{ configured: true, instanceName: "dev/A/michael", state: "active" }
```

Returns 409 if worker is in `configuring` or `resetting` state.

#### Telemetry

- Span: `worker.configure` wrapping the entire operation
- Log: system prompt chunked, config summary
- Metrics: `configure.count`, `configure.duration_ms`
- Trace context from request used as parent span

---

### POST `/message`

Send a user message to the agent. Returns an SSE stream of events as the agent processes.

**Requires worker state: `active`**. Returns 503 if idle, configuring, or resetting.

#### Request Body

```typescript
{
  "message": "What do you think about the new project?",
  "traceContext": {           // optional, forwarded by control plane
    "sentryTrace": "...",
    "baggage": "..."
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string | Yes | Non-empty user message |
| `traceContext` | object | No | Forwarded by control plane from caller. Worker uses it to continue the distributed trace. |

Returns 400 if `message` is missing or empty.

#### Response

Content-type: `text/event-stream`. See [invocation.md](invocation.md) for the full SSE event type reference.

#### Queue Behavior

The worker maintains a FIFO queue (max 25 items). Only one invocation runs at a time.

```
No active invocation:
  → message arrives → invocation starts immediately, streams SSE

Active invocation running:
  → message arrives → queued, `queued` SSE event sent with position
  → active invocation completes → next in queue starts automatically

Queue full (25 items):
  → message arrives → 429 Too Many Requests with Retry-After header
```

#### SDK Execution

1. If no `sessionId` exists, call SDK `query()` to start a new session
2. If `sessionId` exists, call SDK `query()` with `resume` parameter
3. **Pass OTEL env vars** to `query()` for subprocess trace propagation (see [telemetry.md](telemetry.md))
4. Stream SDK events as SSE to the caller
5. **Log every SDK event verbosely** (system prompt, assistant text, tool calls, tool results, reasoning)
6. On completion, store the returned `sessionId` for next invocation
7. Accumulate messages in history

#### Verbose Logging

Every SDK event is logged with full content. See [telemetry.md](telemetry.md) for the complete list of mandatory log events. Key events:

```
{instanceName} | message.start | invocationId={id} prompt.len={n}
{instanceName} | user.{turn} | {full user message}
{instanceName} | assistant.{turn} | {full assistant text, chunked}
{instanceName} | tool_use.{turn} | {toolName} {full JSON input, chunked}
{instanceName} | tool_result.{turn} | {toolName} -> {full result, chunked}
{instanceName} | reasoning.{turn} | {full reasoning text, chunked}
{instanceName} | message.done | status={s} turns={n} cost=${c} duration={d}ms
```

---

### GET `/history`

Returns the full in-memory conversation history.

**Requires worker state: `active`**. Returns 503 if idle.

#### Response

```typescript
{
  "instanceName": "dev/A/michael",
  "messages": [
    {
      "role": "user",
      "content": "What do you think about the new project?",
      "timestamp": "2026-02-14T10:30:00.000Z",
      "invocationId": "abc-123"
    },
    {
      "role": "assistant",
      "content": "Let me check the recent messages...",
      "timestamp": "2026-02-14T10:30:01.500Z",
      "invocationId": "abc-123",
      "toolCalls": [
        { "toolName": "send_message", "toolInput": { "channelId": "general" } }
      ]
    }
  ]
}
```

#### History Model

- In-memory array of `HistoryMessage` objects
- Capped at **1000 messages** — oldest messages are evicted when the cap is reached
- History is cleared on `POST /configure` (new instance assignment) and `POST /reset`
- Each message includes: `role` (`user` | `assistant`), `content`, `timestamp`, `invocationId`, and optional `toolCalls`

---

### GET `/status`

Returns runtime status for the worker. Available in any state.

#### Response

```typescript
{
  "instanceName": "dev/A/michael",  // null when idle
  "state": "active",                // "idle" | "configuring" | "active" | "resetting"
  "model": "claude-haiku-4-5-20251001",
  "sessionId": "sess-789",
  "uptime": 3600000,
  "messageCount": 42,
  "totalCostUsd": 0.15,
  "queueDepth": 0,
  "activeInvocationId": null,
  "startedAt": "2026-02-14T09:30:00.000Z",
  "configuredAt": "2026-02-14T09:31:00.000Z"  // null when idle
}
```

| Field | Type | Description |
|-------|------|-------------|
| `instanceName` | string \| null | Instance name (null when idle) |
| `state` | string | Worker state machine state |
| `model` | string \| null | Claude model ID (null when idle) |
| `sessionId` | string \| null | Current SDK session ID |
| `uptime` | number | Milliseconds since worker process start |
| `messageCount` | number | Total messages processed (across all assignments) |
| `totalCostUsd` | number | Cumulative cost (across all assignments) |
| `queueDepth` | number | Current queue size |
| `activeInvocationId` | string \| null | Currently running invocation |
| `startedAt` | string | ISO timestamp of worker process start |
| `configuredAt` | string \| null | ISO timestamp of last `POST /configure` |

---

### GET `/health`

Health check for Railway readiness probes and control-plane health polling.

#### Response

```typescript
{
  "status": "ok",
  "instanceName": "dev/A/michael",  // null when idle
  "state": "active"                 // "idle" | "active" | etc.
}
```

Returns 200 if the worker process is running. The `state` field tells the control plane whether the worker is idle (available for pool assignment) or active (serving an instance).

---

### POST `/abort`

Abort the currently running invocation.

**Requires worker state: `active`**.

#### Response

```typescript
{ "aborted": true, "invocationId": "abc-123" }
```

Returns 200 if an invocation was aborted, or:

```typescript
{ "aborted": false, "reason": "no_active_invocation" }
```

If no invocation is running. The abort kills the SDK subprocess and starts the next queued message.

---

### POST `/reset`

Reset the worker and return it to idle state. Used by the pool manager to recycle workers.

#### Response

```typescript
{ "reset": true, "instanceName": "dev/A/michael", "state": "idle" }
```

When no invocation is currently running, this:
1. Transitions state to `resetting`
2. Clears the invocation queue
3. Resets `sessionId` to null
4. Clears the conversation history
5. Clears instance config (instanceName, systemPrompt, etc.)
6. Updates Sentry service name to `aas-worker-idle`
7. Transitions state to `idle`

If an invocation is running, the reset is rejected → 409 Conflict. Callers should abort the invocation first.

#### Telemetry

- Span: `worker.reset`
- Log: `{instanceName} | reset | returning to idle`
- Metric: `reset.count`

## Error Handling

| Error | Response |
|-------|----------|
| Invalid/empty message | 400 |
| Worker not active (idle/configuring/resetting) for message/history/abort | 503 |
| Queue full | 429 with `Retry-After: 5` header |
| SDK error during invocation | SSE `error` event |
| Reset while running | 409 Conflict |
| Configure while configuring/resetting | 409 Conflict |
| Invalid configure payload | 400 |

## Related

- **Messaging**: [invocation.md](invocation.md) — control-plane proxy behavior, SSE event types
- **Instances**: [instances.md](instances.md) — instance configuration and lifecycle
- **Telemetry**: [telemetry.md](telemetry.md) — worker metrics, verbose logging, OTEL subprocess tracing
