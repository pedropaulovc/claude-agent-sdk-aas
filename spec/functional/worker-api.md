# Worker API

Each worker container runs a Hono HTTP server exposing endpoints for messaging, history, status, and health. Workers are configured entirely via environment variables injected by the control plane during provisioning.

## Configuration

Workers read all configuration from environment variables (set by the control plane via Railway):

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

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/message` | Send message → SSE stream response |
| GET | `/history` | Conversation history |
| GET | `/status` | Runtime status |
| GET | `/health` | Health check (Railway readiness) |
| POST | `/abort` | Abort current invocation |
| POST | `/reset` | Reset session + clear history |

---

### POST `/message`

Send a user message to the agent. Returns an SSE stream of events as the agent processes.

#### Request Body

```typescript
{
  "message": "What do you think about the new project?"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string | Yes | Non-empty user message |

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
3. Stream SDK events as SSE to the caller
4. On completion, store the returned `sessionId` for next invocation
5. Accumulate messages in history

---

### GET `/history`

Returns the full in-memory conversation history.

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
- History is lost on container restart (in-memory only)
- Each message includes: `role` (`user` | `assistant`), `content`, `timestamp`, `invocationId`, and optional `toolCalls`

---

### GET `/status`

Returns runtime status for the worker.

#### Response

```typescript
{
  "instanceName": "dev/A/michael",
  "model": "claude-haiku-4-5-20251001",
  "sessionId": "sess-789",
  "uptime": 3600000,
  "messageCount": 42,
  "totalCostUsd": 0.15,
  "queueDepth": 0,
  "activeInvocationId": null,
  "startedAt": "2026-02-14T09:30:00.000Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `instanceName` | string | Instance name from env var |
| `model` | string | Claude model ID |
| `sessionId` | string \| null | Current SDK session ID |
| `uptime` | number | Milliseconds since worker start |
| `messageCount` | number | Total messages processed |
| `totalCostUsd` | number | Cumulative cost across all invocations |
| `queueDepth` | number | Current queue size |
| `activeInvocationId` | string \| null | Currently running invocation |
| `startedAt` | string | ISO timestamp of worker start |

---

### GET `/health`

Simple health check for Railway readiness probes and control-plane health polling.

#### Response

```typescript
{ "status": "ok", "instanceName": "dev/A/michael" }
```

Returns 200 if the worker is running and ready to accept messages. This endpoint is called by the control plane's health poller to determine when a deploying worker becomes `ready`.

---

### POST `/abort`

Abort the currently running invocation.

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

Reset the worker's session and clear conversation history.

#### Response

```typescript
{ "reset": true, "instanceName": "dev/A/michael" }
```

This:
1. Aborts any active invocation
2. Clears the invocation queue
3. Resets `sessionId` to null
4. Clears the conversation history

Cannot reset while an invocation is running → 409 Conflict. Callers should abort first.

## Error Handling

| Error | Response |
|-------|----------|
| Invalid/empty message | 400 |
| Queue full | 429 with `Retry-After: 5` header |
| SDK error during invocation | SSE `error` event |
| Reset while running | 409 Conflict |

## Related

- **Messaging**: [invocation.md](invocation.md) — control-plane proxy behavior, SSE event types
- **Instances**: [instances.md](instances.md) — instance configuration and lifecycle
- **Telemetry**: [telemetry.md](telemetry.md) — worker metrics and tracing
