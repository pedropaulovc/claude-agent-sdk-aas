# Instances

Each instance = one named Claude Agent SDK worker. In M5 pool architecture, instances are backed by pre-warmed workers from a pool — provisioning assigns an idle worker and configures it via HTTP (< 1 second). When no pool workers are available, the system falls back to creating a dedicated Railway service (2–5 min).

## Data Model

```
InstanceRecord
  name                string           -- hierarchical, e.g., "dev/A/michael"
  systemPrompt        string           -- opaque, caller assembles full prompt
  mcpServers          McpServerConfig[] -- remote URLs only (no stdio in containers)
  model               string           -- default: "claude-haiku-4-5-20251001"
  maxTurns            number           -- default: 50
  maxBudgetUsd        number           -- default: 1.0
  status              "provisioning" | "deploying" | "ready" | "unreachable" | "error" | "destroying" | "recycling"
  railwayServiceId    string | null    -- Railway service ID for the worker
  workerUrl           string | null    -- Internal Railway URL for the worker container
  poolWorkerId        string | null    -- Pool worker ID (null for non-pool workers)
  configuredAt        string | null    -- ISO timestamp of last POST /configure
  provisionError      string | null    -- Error message if provisioning failed
  createdAt           Date
```

## MCP Server Config

Only remote MCP servers are supported (stdio is not available in isolated containers):

```typescript
// Remote (HTTP/SSE)
{ name: string, url: string, headers?: Record<string, string> }
```

## Status Union

| Status | Meaning |
|--------|---------|
| `provisioning` | Railway service creation in progress (pool miss — slow path) |
| `deploying` | Railway service created, waiting for container to pass health check |
| `ready` | Worker is healthy and accepting messages |
| `unreachable` | Worker failed 3 consecutive health checks (auto-recovers if health returns) |
| `error` | Provisioning failed or worker reported a fatal error |
| `destroying` | Railway service deletion in progress (non-pool workers) |
| `recycling` | Worker being reset and returned to pool |

## CRUD Operations

| Operation | Method | Path | Body | Response |
|-----------|--------|------|------|----------|
| Provision | POST | `/v1/instances` | `{ name, systemPrompt, mcpServers?, model?, maxTurns?, maxBudgetUsd? }` | **202**: instance |
| List | GET | `/v1/instances?prefix=` | — | 200: instance[] |
| Get | GET | `/v1/instances/*` | — | 200: instance |
| Update | PATCH | `/v1/instances/*` | `{ systemPrompt?, mcpServers?, model?, maxTurns?, maxBudgetUsd? }` | 200: instance |
| Delete | DELETE | `/v1/instances/*` | — | 200: `{ deleted: number }` |

### Provision (POST) — Pool-Aware

Provisioning first attempts to assign a worker from the pool. If the pool is empty, it falls back to Railway service creation.

**Pool Hit (fast path — < 1 second):**
1. Validate input, create `InstanceRecord`
2. Acquire idle worker from pool
3. Call `POST /configure` on worker with instance config (trace context propagated)
4. On success: set `poolWorkerId`, `workerUrl`, status → `ready`, `configuredAt`
5. Return 202 with instance

**Pool Miss (slow path — 2–5 min):**
1. Validate input, create `InstanceRecord` with status `provisioning`
2. Call Railway API to create a service (`serviceCreate`)
3. Set environment variables on the service (`variableCollectionUpsert`)
4. Create an internal domain (`serviceDomainCreate`)
5. Transition status to `deploying`
6. Health poller begins monitoring — once the worker's `/health` endpoint responds, status transitions to `ready`

If any step fails, status transitions to `error` with `provisionError` set.

### Update (PATCH) — In-Place Reconfigure

Updates reconfigure the worker in-place via `POST /configure` — no Railway redeploy needed for pool workers.

**Pool worker:**
1. Update the `InstanceRecord` fields locally
2. Call `POST /configure` on the worker with updated config (trace context propagated)
3. Status briefly → `configuring`, then → `ready`

**Non-pool worker (legacy):**
1. Update the `InstanceRecord` fields locally
2. Call Railway API to update environment variables
3. Transition status to `deploying`
4. Health poller monitors the redeployment — transitions to `ready` when healthy

Cannot update while status is `provisioning` or `destroying` → 409 Conflict.

### Delete (DELETE) — Pool-Aware Recycling

**Pool worker:**
1. Transition status to `recycling`
2. Call `POST /reset` on worker (trace context propagated)
3. Release worker back to idle pool
4. Remove `InstanceRecord` from the registry

**Non-pool worker:**
1. Transition status to `destroying`
2. Call Railway API to delete the service (`serviceDelete`)
3. Remove `InstanceRecord` from the registry
4. Return immediately (Railway deletion is fire-and-forget)

## Lifecycle

### Pool Path (M5)

```
(not exist) → [POST, pool hit] → ready                        (< 1 second)
(not exist) → [POST, pool miss] → provisioning → deploying → ready  (2-5 min)
ready → [PATCH] → ready                                       (in-place reconfigure)
ready → [3 failed health checks] → unreachable
unreachable → [health check passes] → ready
ready → [DELETE] → recycling → (not exist)                     (worker returns to pool)
error → [DELETE] → destroying → (not exist)
```

### Legacy Path (M4)

```
(not exist) → [POST] → provisioning → deploying → ready
deploying → [120s timeout] → error
ready → [PATCH] → deploying → ready
ready → [DELETE] → destroying → (not exist)
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
- `mcpServers`: optional array, each entry must be remote format (url required)
- Duplicate name → 409 Conflict

## Related

- **Hierarchy**: [hierarchy.md](hierarchy.md) — naming scheme, prefix operations, nuke
- **Messaging**: [invocation.md](invocation.md) — proxy-based messaging, SSE streaming
- **Worker API**: [worker-api.md](worker-api.md) — worker container endpoints, configure, reset
- **Railway Integration**: [railway-integration.md](railway-integration.md) — provisioning flow, health polling, pool replenishment
