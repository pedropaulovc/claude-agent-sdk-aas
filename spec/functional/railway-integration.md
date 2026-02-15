# Railway Integration

The control plane manages worker services via Railway's GraphQL API and a pre-built Docker image pool. Workers are created from GHCR images (no Railway builds), start dormant, and are activated via HTTP when an agent is provisioned. A background pool monitor ensures dormant workers are always available.

## Railway GraphQL Client

Located at `src/railway/client.ts`. Wraps Railway's GraphQL API with typed methods.

### Configuration

| Env Var | Description | Source |
|---------|-------------|--------|
| `RAILWAY_API_TOKEN` | API token with project access | Set manually via `railway variables` |
| `RAILWAY_PROJECT_ID` | Target project ID | Auto-injected by Railway at runtime |
| `RAILWAY_ENVIRONMENT_ID` | Target environment ID | Auto-injected by Railway at runtime |

> **Note**: `RAILWAY_PROJECT_ID` and `RAILWAY_ENVIRONMENT_ID` are [automatically provided by Railway](https://docs.railway.com/reference/variables) to all deployments. Only `RAILWAY_API_TOKEN` needs to be set explicitly.

### API Methods

| Method | GraphQL Mutation/Query | Purpose |
|--------|----------------------|---------|
| `serviceCreate(name, source?)` | `serviceCreate` | Create a Railway service (from repo or GHCR image) |
| `serviceDelete(serviceId)` | `serviceDelete` | Delete a Railway service |
| `variableCollectionUpsert(serviceId, vars)` | `variableCollectionUpsert` | Set environment variables on a service |
| `serviceDomainCreate(serviceId)` | `serviceDomainCreate` | Create an internal Railway domain |
| `serviceList()` | `services` | List all services in the project (for pool discovery) |

All methods are wrapped in Sentry spans for telemetry. See [telemetry.md](telemetry.md) for Railway API metrics.

### Image-Based Service Creation

The `serviceCreate` method supports two source types:

```typescript
// From GitHub repo (legacy, used for CP itself)
serviceCreate("aas-cp", { repo: "owner/repo", branch: "main" })

// From GHCR image (used for pool workers)
serviceCreate("aas-w-42", { image: "ghcr.io/owner/aas-worker:latest" })
```

When `source.image` is provided, Railway pulls the pre-built image directly from GHCR. No build step occurs on Railway.

## Worker Pool

Located at `src/railway/pool.ts`. Manages a pool of dormant worker services on Railway.

### Pool Data Model

```typescript
type WorkerEntry = {
  workerNumber: number          // monotonic, e.g. 1, 2, 3...
  serviceId: string             // Railway service ID
  workerUrl: string             // https://{domain}
  assignedAgent: string | null  // null = dormant
  status: 'creating' | 'dormant' | 'active' | 'error'
}
```

### Pool Operations

| Method | Purpose |
|--------|---------|
| `ensurePoolSize(target)` | Creates workers in batch until pool has `target` dormant workers |
| `claimWorker()` | Returns a dormant WorkerEntry, marks it as activating |
| `releaseWorker(workerNumber)` | Destroys the Railway service, removes from pool |
| `getDormantCount()` | Number of dormant workers |
| `startPoolMonitor()` | Background interval: if dormant < 10, create 10 more |
| `listWorkers()` | All workers with status |

### Worker Creation Flow

Each worker is created as follows:

```
1. serviceCreate("aas-w-{N}", { image: "ghcr.io/.../aas-worker:latest" })
2. variableCollectionUpsert(serviceId, { ANTHROPIC_API_KEY, SENTRY_DSN }) — secrets only
3. serviceDomainCreate(serviceId) → get URL
4. Health poll until worker responds with "dormant" status
5. Add to pool registry as dormant
```

Workers receive **only secrets** via env vars. Agent configuration (name, prompt, MCP, model, etc.) is delivered at activation time via `POST /activate`.

### Pool Monitor

The pool monitor runs as a background interval on the control plane:

- **Check interval**: 30s
- **Threshold**: if dormant count < 10, create 10 more worker services
- **Creation**: workers created in parallel batches
- **Health polling**: each new worker polled until `dormant` status confirmed

### Pool Discovery on Restart

When the CP restarts, it queries `serviceList()` to discover existing worker services (by `aas-w-` prefix). Workers that respond to health checks are re-added to the pool. Workers that don't respond within 30s are destroyed and replaced.

## Provisioning Flow

Located at `src/routes/instances.ts`. Orchestrates instant provisioning via the worker pool.

### Sequence

```
1. Control plane receives POST /v1/instances
2. Create InstanceRecord with status "provisioning"
3. Return 202 Accepted to caller
4. [Background] pool.claimWorker() → get dormant worker
5. [Background] POST {workerUrl}/activate with:
     - instanceName
     - systemPrompt
     - mcpServers
     - model
     - maxTurns
     - maxBudgetUsd
6. On success: status → "ready", link workerUrl and serviceId
7. On failure: status → "error", release worker back to pool (or destroy)
```

This flow completes in **seconds** (HTTP call to a running container), not minutes (Railpack build + deploy).

### Error Handling

If activation fails:
1. Log the error with full context
2. Release or destroy the worker
3. Set InstanceRecord status → `error`, `provisionError` → error message
4. Emit `provision.count` metric with status=error

### Config Updates (PATCH)

Workers don't support reconfiguration after activation. PATCH triggers a destroy + re-provision:

1. `pool.releaseWorker()` → destroy current worker's Railway service
2. `pool.claimWorker()` → get a new dormant worker
3. `POST {workerUrl}/activate` with updated config
4. Status: current → `deploying` → `ready`

## Health Poller

Located at `src/railway/health-poller.ts`. Monitors worker health.

### Polling Modes

| Mode | Interval | Triggered By | Exits When |
|------|----------|-------------|------------|
| **Pool creation** | 5s | Worker service created | Health check returns `dormant` status OR 120s timeout |
| **Ongoing** | 30s | Worker status is `ready` | Instance is deleted |

### Pool Creation Mode

When a new worker service is created by the pool manager:
1. Poll `GET {workerUrl}/health` every 5 seconds
2. On first response with `{ status: "dormant" }`, mark worker as dormant in pool
3. If 120 seconds elapse without a response, mark worker as `error`

### Ongoing Mode

When an activated worker is in `ready` status:
1. Poll `GET {workerUrl}/health` every 30 seconds
2. Track consecutive failures
3. After **3 consecutive failures**, transition instance status → `unreachable`
4. Continue polling — if health returns, transition status → `ready` (auto-recovery)

### Health Check Request

```
GET {workerUrl}/health
Timeout: 5000ms

Dormant response: 200 { "status": "dormant", "nodeVersion": "...", ... }
Active response:  200 { "status": "ok", "instanceName": "...", ... }
```

Any non-200 response or timeout counts as a failure.

## Service Naming

Workers are named with a monotonic counter:

```
aas-w-{number}
```

Examples: `aas-w-1`, `aas-w-2`, `aas-w-42`

This replaces the old name-based scheme (`aas-w-{sanitized-instance-name}`). Worker naming is decoupled from instance naming — the mapping lives in the InstanceRecord and pool registry.

## Build Strategy

Two separate Docker images are built and pushed to GHCR:

| Image | Dockerfile | Purpose |
|-------|-----------|---------|
| `ghcr.io/.../aas-cp:latest` | `Dockerfile.cp` | Control plane |
| `ghcr.io/.../aas-worker:latest` | `Dockerfile.worker` | Worker (with system deps: git, curl) |

The `AAS_ROLE` env var is baked into each Dockerfile — no per-service env var needed:

- `Dockerfile.cp` → `ENV AAS_ROLE=control-plane`
- `Dockerfile.worker` → `ENV AAS_ROLE=worker`

Build and push are done locally or in CI. Railway pulls the image directly from GHCR — no Railpack, no Railway builds.

## Service Deletion

### Single Instance Delete

1. Set status → `destroying`
2. Stop health polling for this instance
3. `pool.releaseWorker()` → calls `serviceDelete(railwayServiceId)` — fire-and-forget
4. Remove `InstanceRecord` from registry
5. Pool monitor creates a replacement dormant worker

### Prefix Nuke

1. Find all matching instances
2. For each: set status → `destroying`, stop health polling
3. `pool.releaseWorker()` for each — fire-and-forget (parallel)
4. Remove all matching `InstanceRecord`s from registry
5. Return `{ deleted: N }`
6. Pool monitor creates replacement dormant workers

## Related

- **Instances**: [instances.md](instances.md) — instance data model, lifecycle, CRUD
- **Hierarchy**: [hierarchy.md](hierarchy.md) — instance naming convention
- **Telemetry**: [telemetry.md](telemetry.md) — Railway API call tracing, pool metrics
- **Worker API**: [worker-api.md](worker-api.md) — worker health, activation, messaging endpoints
