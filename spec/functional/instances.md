# Instances

Each instance = one named Claude Agent SDK worker on Railway. Instances are provisioned by claiming a dormant worker from the pool and activating it with agent configuration via HTTP. The worker runs the SDK and exposes its own API for messaging and history.

## Data Model

```
InstanceRecord
  name                string           -- hierarchical, e.g., "dev/A/michael"
  systemPrompt        string           -- opaque, caller assembles full prompt
  mcpServers          McpServerConfig[] -- remote URLs only (no stdio in containers)
  model               string           -- default: "claude-haiku-4-5-20251001"
  maxTurns            number           -- default: 50
  maxBudgetUsd        number           -- default: 1.0
  status              "provisioning" | "deploying" | "ready" | "unreachable" | "error" | "destroying"
  railwayServiceId    string | null    -- Railway service ID for this worker
  workerUrl           string | null    -- Internal Railway URL for the worker container
  workerNumber        number | null    -- Pool worker number (links to WorkerEntry)
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
| `provisioning` | Claiming a dormant worker from the pool + sending activation request (seconds) |
| `deploying` | Worker being replaced (PATCH triggered destroy + re-provision) |
| `ready` | Worker is active and accepting messages |
| `unreachable` | Worker failed 3 consecutive health checks (auto-recovers if health returns) |
| `error` | Activation failed or worker reported a fatal error |
| `destroying` | Railway service deletion in progress |

## CRUD Operations

| Operation | Method | Path | Body | Response |
|-----------|--------|------|------|----------|
| Provision | POST | `/v1/instances` | `{ name, systemPrompt, mcpServers?, model?, maxTurns?, maxBudgetUsd? }` | **202**: instance (status: `provisioning`) |
| List | GET | `/v1/instances?prefix=` | — | 200: instance[] |
| Get | GET | `/v1/instances/*` | — | 200: instance |
| Update | PATCH | `/v1/instances/*` | `{ systemPrompt?, mcpServers?, model?, maxTurns?, maxBudgetUsd? }` | 200: instance (status: `deploying`) |
| Delete | DELETE | `/v1/instances/*` | — | 200: `{ deleted: number }` |

### Provision (POST) — Pool-Based

Provisioning claims a dormant worker from the pool and activates it. The control plane returns `202 Accepted` immediately with the instance in `provisioning` status. The flow completes in **seconds**:

1. Validate input, create `InstanceRecord` with status `provisioning`
2. `pool.claimWorker()` → get a dormant worker from the pool
3. `POST {workerUrl}/activate` with agent config (instanceName, systemPrompt, mcpServers, model, maxTurns, maxBudgetUsd)
4. On success: status → `ready`, link workerUrl, serviceId, workerNumber
5. On failure: status → `error`, release/destroy worker

If the pool has no dormant workers available, the request waits briefly for the pool monitor to create more. If none become available within 30s, status → `error` with `provisionError: "No dormant workers available"`.

### Update (PATCH) — Destroy + Re-Provision

Workers don't support reconfiguration after activation. PATCH destroys the current worker and provisions a new one:

1. `pool.releaseWorker()` → destroy current worker's Railway service
2. Status → `deploying`
3. `pool.claimWorker()` → get a new dormant worker
4. `POST {workerUrl}/activate` with updated config
5. On success: status → `ready`, link new workerUrl, serviceId, workerNumber
6. On failure: status → `error`

Cannot update while status is `provisioning` or `destroying` → 409 Conflict.

### Delete (DELETE) — Pool Release

1. Transition status to `destroying`
2. `pool.releaseWorker()` → Railway service deleted (fire-and-forget)
3. Remove `InstanceRecord` from the registry
4. Pool monitor creates a replacement dormant worker in the background

## Lifecycle

```
(not exist) → [POST provision] → provisioning
provisioning → [worker activated] → ready
provisioning → [activation failed] → error
ready → [3 failed health checks] → unreachable
unreachable → [health check passes] → ready
ready → [PATCH update] → deploying (destroy + re-provision)
deploying → [new worker activated] → ready
deploying → [activation failed] → error
error → [DELETE] → destroying → (not exist)
ready → [DELETE] → destroying → (not exist)
unreachable → [DELETE] → destroying → (not exist)
deploying → [DELETE] → destroying → (not exist)
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
- **Worker API**: [worker-api.md](worker-api.md) — worker container endpoints, activation
- **Railway Integration**: [railway-integration.md](railway-integration.md) — pool management, service creation
