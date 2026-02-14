# Instances

Each instance = one named Claude Agent SDK configuration with an in-memory session. Instances are provisioned via API, configured with system prompts and MCP servers, and invoked to run agent conversations.

## Data Model

```
AgentInstance
  name                string           -- hierarchical, e.g., "dev/A/michael"
  systemPrompt        string           -- opaque, caller assembles full prompt
  mcpServers          McpServerConfig[] -- remote URLs or stdio commands
  model               string           -- default: "claude-haiku-4-5-20251001"
  maxTurns            number           -- default: 50
  maxBudgetUsd        number           -- default: 1.0
  sessionId           string | null    -- SDK session ID for resume
  status              "ready" | "running" | "error"
  createdAt           Date
  lastInvokedAt       Date | null
  invocationCount     number
  activeInvocationId  string | null
  queueDepth          number           -- current queue size
```

## MCP Server Config

Two formats are supported:

```typescript
// Remote (HTTP/SSE)
{ name: string, url: string, headers?: Record<string, string> }

// Stdio (local process)
{ name: string, command: string, args?: string[], env?: Record<string, string> }
```

## CRUD Operations

| Operation | Method | Path | Body | Response |
|-----------|--------|------|------|----------|
| Provision | POST | `/v1/instances` | `{ name, systemPrompt, mcpServers, model?, maxTurns?, maxBudgetUsd? }` | 201: instance |
| List | GET | `/v1/instances?prefix=` | — | 200: instance[] |
| Get | GET | `/v1/instances/*` | — | 200: instance |
| Update | PATCH | `/v1/instances/*` | `{ systemPrompt?, mcpServers?, model?, maxTurns?, maxBudgetUsd? }` | 200: instance |
| Delete | DELETE | `/v1/instances/*` | — | 200: `{ deleted: number }` |

## Lifecycle

```
(not exist) → [POST provision] → ready
ready → [POST invoke] → running → [invoke completes] → ready
ready → [PATCH update] → ready (session reset)
ready → [DELETE] → (not exist)
running → [invoke completes] → ready
running → [invoke fails] → error
error → [PATCH update] → ready (session reset)
error → [DELETE] → (not exist)
```

## Defaults

| Field | Default | Notes |
|-------|---------|-------|
| `model` | `claude-haiku-4-5-20251001` | Cheapest, fastest |
| `maxTurns` | 50 | SDK default |
| `maxBudgetUsd` | 1.0 | Per invocation |

## Validation Rules

- `name`: required, validated per hierarchy rules (see [hierarchy.md](hierarchy.md))
- `systemPrompt`: required, non-empty string
- `mcpServers`: optional array, each entry validated for required fields
- Duplicate name → 409 Conflict

## Update Semantics

- Only provided fields are updated (partial PATCH)
- Any config update resets `sessionId` to null (forces new session on next invoke)
- Cannot update while status is `"running"` → 409 Conflict

## Related

- **Hierarchy**: [hierarchy.md](hierarchy.md) — naming scheme, prefix operations, nuke
- **Invocation**: invocation.md — SSE streaming, queueing, sessions
