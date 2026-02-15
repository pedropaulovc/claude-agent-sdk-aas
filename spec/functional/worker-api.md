# Worker API

Each worker container runs a Hono HTTP server. Workers start in **dormant** mode — only `/health` and `/activate` respond. Once activated via `POST /activate`, all endpoints become available. Workers are configured at activation time via HTTP, not via environment variables.

## Configuration

### Boot Config (Environment Variables)

Workers boot with only secrets. Agent configuration is delivered at activation time.

| Env Var | Required | Default | Description |
|---------|----------|---------|-------------|
| `AAS_ROLE` | No | — | Baked into `Dockerfile.worker` as `worker` |
| `ANTHROPIC_API_KEY` | Yes | — | Anthropic API key |
| `SENTRY_DSN` | Yes | — | Sentry DSN for telemetry |
| `PORT` | No | `8080` | HTTP port (injected by Railway) |

### Activation Config (HTTP Body)

Delivered via `POST /activate` after the worker is running:

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `instanceName` | string | Yes | — | Hierarchical instance name (e.g., `dev/A/michael`) |
| `systemPrompt` | string | Yes | — | System prompt for the agent |
| `mcpServers` | McpServerConfig[] | No | `[]` | Remote MCP server configurations |
| `model` | string | No | `claude-haiku-4-5-20251001` | Claude model ID |
| `maxTurns` | number | No | `50` | Max turns per invocation |
| `maxBudgetUsd` | number | No | `1.0` | Max budget per invocation (USD) |

## Worker State Machine

```
dormant → [POST /activate] → active
```

No deactivation — workers are destroyed and replaced from the pool.

### Dormant State

When dormant:
- `/health` returns `{ status: "dormant", nodeVersion, platform, arch, uid }`
- `/activate` accepts activation requests
- **All other endpoints** return `503 { error: "Worker is dormant", code: "dormant" }`

### Active State

When active:
- All endpoints function normally
- `/health` returns `{ status: "ok", instanceName: "...", nodeVersion, platform, arch, uid }`
- `/activate` returns `409 Conflict` (already activated)

## Endpoints

| Method | Path | Dormant | Active | Purpose |
|--------|------|---------|--------|---------|
| POST | `/activate` | Yes | 409 | Activate worker with agent config |
| POST | `/message` | 503 | Yes | Send message → SSE stream response |
| GET | `/history` | 503 | Yes | Conversation history |
| GET | `/status` | 503 | Yes | Runtime status |
| GET | `/health` | Yes | Yes | Health check |
| POST | `/abort` | 503 | Yes | Abort current invocation |
| POST | `/reset` | 503 | Yes | Reset session + clear history |

---

### POST `/activate`

Transition the worker from dormant to active. Initializes the SDK runner, message queue, and history.

#### Request Body

```typescript
{
  "instanceName": "dev/A/michael",
  "systemPrompt": "You are Michael Scott...",
  "mcpServers": [{ "name": "slack", "url": "https://..." }],
  "model": "claude-haiku-4-5-20251001",
  "maxTurns": 50,
  "maxBudgetUsd": 1.0
}
```

Validated with `activationSchema` (Zod) in `src/shared/types.ts`.

#### Response

Success (200):
```typescript
{ "activated": true, "instanceName": "dev/A/michael" }
```

Already active (409):
```typescript
{ "error": "Worker is already active", "code": "already_active", "instanceName": "dev/A/michael" }
```

Invalid body (400):
```typescript
{ "error": "Validation error: ...", "code": "validation_error" }
```

---

### POST `/message`

Send a user message to the agent. Returns an SSE stream of events as the agent processes.

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
| `instanceName` | string | Instance name from activation |
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

Health check for Railway readiness probes and control-plane health polling.

#### Response

Dormant:
```typescript
{ "status": "dormant", "nodeVersion": "22.x.x", "platform": "linux", "arch": "x64", "uid": 1000 }
```

Active:
```typescript
{ "status": "ok", "instanceName": "dev/A/michael", "nodeVersion": "22.x.x", "platform": "linux", "arch": "x64", "uid": 1000 }
```

Returns 200 in both states. The `status` field distinguishes dormant from active workers. The control plane's pool manager uses `"dormant"` to identify available workers; the health poller uses `"ok"` to confirm active workers are healthy.

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

When no invocation is currently running, this:
1. Clears the invocation queue
2. Resets `sessionId` to null
3. Clears the conversation history

If an invocation is running, the reset is rejected → 409 Conflict. Callers should abort the invocation first.

## Error Handling

| Error | Response |
|-------|----------|
| Worker is dormant | 503 `{ error: "Worker is dormant", code: "dormant" }` |
| Invalid/empty message | 400 |
| Queue full | 429 with `Retry-After: 5` header |
| SDK error during invocation | SSE `error` event |
| Reset while running | 409 Conflict |
| Activate while already active | 409 Conflict |
| Invalid activation body | 400 |

## Related

- **Messaging**: [invocation.md](invocation.md) — control-plane proxy behavior, SSE event types
- **Instances**: [instances.md](instances.md) — instance configuration and lifecycle
- **Telemetry**: [telemetry.md](telemetry.md) — worker metrics and tracing
- **Railway Integration**: [railway-integration.md](railway-integration.md) — pool management, worker creation
