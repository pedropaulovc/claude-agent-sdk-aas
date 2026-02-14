# Instances

Each instance = one named Claude Agent SDK worker container on Railway. Instances are provisioned via the control-plane API, which creates a Railway service with the appropriate configuration. The worker container runs the SDK and exposes its own API for messaging and history.

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
| `provisioning` | Railway service creation in progress (API calls to Railway) |
| `deploying` | Railway service created, waiting for container to pass health check |
| `ready` | Worker container is healthy and accepting messages |
| `unreachable` | Worker failed 3 consecutive health checks (auto-recovers if health returns) |
| `error` | Provisioning failed or worker reported a fatal error |
| `destroying` | Railway service deletion in progress |

## CRUD Operations

| Operation | Method | Path | Body | Response |
|-----------|--------|------|------|----------|
| Provision | POST | `/v1/instances` | `{ name, systemPrompt, mcpServers?, model?, maxTurns?, maxBudgetUsd? }` | **202**: instance (status: `provisioning`) |
| List | GET | `/v1/instances?prefix=` | — | 200: instance[] |
| Get | GET | `/v1/instances/*` | — | 200: instance |
| Update | PATCH | `/v1/instances/*` | `{ systemPrompt?, mcpServers?, model?, maxTurns?, maxBudgetUsd? }` | 200: instance (status: `deploying`) |
| Delete | DELETE | `/v1/instances/*` | — | 200: `{ deleted: number }` |

### Provision (POST) — Async

Provisioning is **asynchronous**. The control plane returns `202 Accepted` immediately with the instance in `provisioning` status. The provisioning flow runs in the background:

1. Validate input, create `InstanceRecord` with status `provisioning`
2. Call Railway API to create a service (`serviceCreate`)
3. Set environment variables on the service (`variableCollectionUpsert`)
4. Create an internal domain (`serviceDomainCreate`)
5. Transition status to `deploying`
6. Health poller begins monitoring — once the worker's `/health` endpoint responds, status transitions to `ready`

If any step fails, status transitions to `error` with `provisionError` set.

### Update (PATCH) — Redeploy

Updates modify the worker's environment variables on Railway and trigger a redeploy:

1. Update the `InstanceRecord` fields locally
2. Call Railway API to update environment variables
3. Transition status to `deploying`
4. Health poller monitors the redeployment — transitions to `ready` when healthy

Cannot update while status is `provisioning` or `destroying` → 409 Conflict.

### Delete (DELETE) — Async Cleanup

1. Transition status to `destroying`
2. Call Railway API to delete the service (`serviceDelete`)
3. Remove `InstanceRecord` from the registry
4. Return immediately (Railway deletion is fire-and-forget)

## Lifecycle

```
(not exist) → [POST provision] → provisioning
provisioning → [Railway service created] → deploying
deploying → [health check passes] → ready
deploying → [120s timeout] → error
ready → [3 failed health checks] → unreachable
unreachable → [health check passes] → ready
ready → [PATCH update] → deploying (env vars updated, redeploy)
provisioning → [Railway API error] → error
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
- **Worker API**: [worker-api.md](worker-api.md) — worker container endpoints
- **Railway Integration**: [railway-integration.md](railway-integration.md) — provisioning flow, health polling
