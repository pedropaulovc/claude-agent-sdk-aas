# Railway Integration

The control plane manages worker containers via Railway's GraphQL API. In M5 pool architecture, Railway is used to provision pool workers (not per-instance workers). Each pool worker is a Railway service within a shared project and environment. The control plane handles service creation, health monitoring, and teardown. Instance-specific config is delivered via HTTP (`POST /configure`), not env vars.

## Railway GraphQL Client

Located at `src/railway/client.ts`. Wraps Railway's GraphQL API with typed methods.

### Configuration

| Env Var | Description | Source |
|---------|-------------|--------|
| `RAILWAY_API_TOKEN` | API token with project access | Set manually via `railway variables` |
| `RAILWAY_PROJECT_ID` | Target project ID | Auto-injected by Railway at runtime |
| `RAILWAY_ENVIRONMENT_ID` | Target environment ID | Auto-injected by Railway at runtime |

> **Note**: `RAILWAY_PROJECT_ID` and `RAILWAY_ENVIRONMENT_ID` are [automatically provided by Railway](https://docs.railway.com/reference/variables) to all deployments. Only `RAILWAY_API_TOKEN` needs to be set explicitly. This means PR preview environments automatically get the correct IDs — no per-branch config needed.

### API Methods

| Method | GraphQL Mutation/Query | Purpose |
|--------|----------------------|---------|
| `serviceCreate(name)` | `serviceCreate` | Create a new Railway service |
| `serviceDelete(serviceId)` | `serviceDelete` | Delete a Railway service |
| `variableCollectionUpsert(serviceId, vars)` | `variableCollectionUpsert` | Set environment variables on a service |
| `serviceDomainCreate(serviceId)` | `serviceDomainCreate` | Create an internal Railway domain |
| `serviceInstanceStatus(serviceId)` | `serviceInstance` | Check deployment status |

All methods are wrapped in Sentry spans for telemetry. See [telemetry.md](telemetry.md) for Railway API metrics.

## Pool Worker Provisioning

Located at `src/pool/replenisher.ts`. Creates Railway services for the worker pool.

### Pool Worker vs Per-Instance Worker

| | Pool Worker (M5) | Per-Instance Worker (M4 legacy) |
|---|---|---|
| **When created** | By pool replenisher to maintain target idle count | On `POST /v1/instances` when pool is empty |
| **Env vars** | Minimal: `AAS_ROLE=worker`, `ANTHROPIC_API_KEY`, `SENTRY_DSN` | Full: all instance config baked into env vars |
| **Config delivery** | Via HTTP `POST /configure` | Via env vars at deploy time |
| **Reusable** | Yes — recycled between instances | No — destroyed on instance delete |
| **Provisioning speed** | Pre-warmed, instant assignment | 2–5 min (Railway build + deploy) |

### Pool Worker Creation Sequence

```
1. Pool replenisher detects idle count below target
2. Call serviceCreate → get serviceId
3. Call variableCollectionUpsert with minimal env vars:
     - AAS_ROLE=worker
     - ANTHROPIC_API_KEY={from control plane env}
     - SENTRY_DSN={from control plane env}
4. Call serviceDomainCreate → get workerUrl
5. Health poll → wait for worker to become healthy
6. Add worker to pool as idle
```

### Per-Instance Provisioning (Fallback)

When the pool is empty and a new instance is requested:

```
1. Control plane receives POST /v1/instances
2. Pool has no idle workers → fall back to Railway provisioning
3. Create InstanceRecord with status "provisioning"
4. Return 202 Accepted to caller
5. [Background] Call serviceCreate → get serviceId
6. [Background] Call variableCollectionUpsert with full instance config:
     - AAS_ROLE=worker
     - AAS_INSTANCE_NAME={name}
     - AAS_SYSTEM_PROMPT={systemPrompt}
     - AAS_MCP_SERVERS={JSON.stringify(mcpServers)}
     - AAS_MODEL={model}
     - AAS_MAX_TURNS={maxTurns}
     - AAS_MAX_BUDGET_USD={maxBudgetUsd}
     - ANTHROPIC_API_KEY={from control plane env}
     - SENTRY_DSN={from control plane env}
7. [Background] Call serviceDomainCreate → get workerUrl
8. Update InstanceRecord: railwayServiceId, workerUrl, status → "deploying"
9. Health poller starts monitoring the worker
```

### Error Handling

If any Railway API call fails during provisioning:
1. Log the error with full context
2. Attempt cleanup: delete the partially-created service (best-effort)
3. Set InstanceRecord status → `error`, `provisionError` → error message
4. Emit `provision.count` metric with status=error

### Environment Variable Updates (PATCH) — Pool Workers

For pool workers, PATCH uses HTTP reconfiguration instead of Railway env var updates:

1. Call `POST /configure` on the worker with updated config (trace context propagated)
2. Worker applies config in-memory — no Railway redeploy needed
3. Status remains `ready` (no `deploying` transition)

### Environment Variable Updates (PATCH) — Legacy Workers

1. Call `variableCollectionUpsert` with updated values
2. Railway automatically redeploys the service when env vars change
3. Set status → `deploying`
4. Health poller monitors the redeployment

## Health Poller

Located at `src/railway/health-poller.ts`. Background process that monitors worker container health.

### Polling Strategy

Two polling modes with different intervals:

| Mode | Interval | Triggered By | Exits When |
|------|----------|-------------|------------|
| **Deploy** | 5s | Status transitions to `deploying` | Health check passes OR 120s timeout |
| **Ongoing** | 30s | Status transitions to `ready` | Instance is deleted or recycled |

### Deploy Mode

When an instance enters `deploying` status:
1. Poll `GET {workerUrl}/health` every 5 seconds
2. On first successful response (200), transition status → `ready`
3. If 120 seconds elapse without a successful response, transition status → `error` with `provisionError: "Deploy timeout: worker did not become healthy within 120s"`

### Ongoing Mode

When an instance is in `ready` status:
1. Poll `GET {workerUrl}/health` every 30 seconds
2. Track consecutive failures
3. After **3 consecutive failures**, transition status → `unreachable`
4. Continue polling — if health returns, transition status → `ready` (auto-recovery)

### Pool Worker Health Polling

Pool workers (idle) are also health-polled to ensure they remain available:
1. Poll `GET {workerUrl}/health` every 30 seconds
2. Check `state` field in response — should be `idle` or `active`
3. If an idle worker fails 3 consecutive health checks, remove it from pool and terminate the Railway service

### Health Check Request

```
GET {workerUrl}/health
Timeout: 5000ms
Expected: 200 { "status": "ok", "instanceName": "...", "state": "idle" | "active" }
```

Any non-200 response or timeout counts as a failure.

## Service Naming

Railway service names are derived from purpose:

**Pool workers:**
```
aas-pool-{index}     (e.g., aas-pool-0, aas-pool-1)
```

**Per-instance workers (legacy fallback):**
```
aas-w-{sanitized-instance-name}
```

Where sanitization:
- Replaces `/` with `-`
- Lowercases the entire string

### Name Collision on Re-provision

When nuking and immediately re-provisioning, the Railway service may not yet be fully deleted. The provisioner handles this by:
1. Attempting `serviceCreate` with the computed name
2. On name conflict error, retry after a 2s delay (max 3 retries)
3. If retries exhausted, fail with a descriptive error

## Pool Replenishment

Located at `src/pool/replenisher.ts`. Background loop that maintains the worker pool.

### Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `AAS_POOL_TARGET_IDLE` | `2` | Target number of idle workers |
| `AAS_POOL_MAX_TOTAL` | `10` | Maximum total workers (idle + active) |

### Replenishment Logic

```
Every 30 seconds:
  idle = pool.idleCount()
  total = pool.totalCount()

  if idle < targetIdle AND total < maxTotal:
    deficit = min(targetIdle - idle, maxTotal - total)
    for each deficit:
      create Railway service (minimal env vars)
      health poll → once healthy → add to pool as idle

  if idle > targetIdle + 2:  (hysteresis to avoid flapping)
    excess = idle - targetIdle
    for each excess:
      remove oldest idle worker from pool
      Railway serviceDelete
```

### Telemetry

- Span: `pool.replenish` wrapping the entire cycle
- Metrics: `pool.replenish.created`, `pool.replenish.terminated`
- Logs: created/terminated counts, pool status summary

## Build Strategy

Railway uses Railpack (zero-config builder) to auto-detect the Node.js/TypeScript app from `package.json`. No Dockerfile needed. Railpack runs `npm ci`, the `build` script (`tsc`), and uses the `start` script as the entry point.

A single codebase serves both roles — `entry.ts` reads `AAS_ROLE` to dispatch:

- `AAS_ROLE=control-plane` → boots the control plane server
- `AAS_ROLE=worker` → boots the worker server

The `start` script in `package.json` must point to the compiled entry point:

```json
"start": "node dist/entry.js"
```

Pool workers are provisioned with `AAS_ROLE=worker` and no `AAS_INSTANCE_NAME`, causing them to start in idle state.

## Service Deletion

### Pool Worker Recycling (Normal Path)

1. Call `POST /reset` on worker (trace context propagated)
2. Worker clears state and returns to idle
3. Release worker back to pool
4. Remove instance record (but NOT the Railway service — it stays alive for reuse)

### Non-Pool Worker Deletion

1. Set status → `destroying`
2. Stop health polling for this instance
3. Call `serviceDelete(railwayServiceId)` — fire-and-forget
4. Remove `InstanceRecord` from registry

### Prefix Nuke

1. Find all matching instances
2. For each:
   - Pool worker: call `POST /reset`, release to pool
   - Non-pool worker: set status → `destroying`, call `serviceDelete`
3. Remove all matching `InstanceRecord`s from registry
4. Return `{ deleted: N }`

### Pool Worker Termination (by replenisher)

When the pool has excess idle workers:
1. Remove worker from pool tracking
2. Call `serviceDelete(railwayServiceId)` — fire-and-forget
3. Log: `pool.terminate | workerId={id} reason=excess_idle`

## Related

- **Instances**: [instances.md](instances.md) — instance data model, lifecycle, CRUD
- **Hierarchy**: [hierarchy.md](hierarchy.md) — service naming convention
- **Telemetry**: [telemetry.md](telemetry.md) — Railway API call tracing, pool metrics
- **Worker API**: [worker-api.md](worker-api.md) — worker health endpoint, configure, reset
