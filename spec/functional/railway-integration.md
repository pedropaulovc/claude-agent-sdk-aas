# Railway Integration

The control plane manages worker containers via Railway's GraphQL API. Each instance maps to a Railway service within a shared project and environment. The control plane handles service creation, environment variable injection, domain assignment, health monitoring, and teardown.

## Railway GraphQL Client

Located at `src/railway/client.ts`. Wraps Railway's GraphQL API with typed methods.

### Configuration

| Env Var | Description |
|---------|-------------|
| `RAILWAY_API_TOKEN` | API token with project access |
| `RAILWAY_PROJECT_ID` | Target project ID |
| `RAILWAY_ENVIRONMENT_ID` | Target environment ID |

### API Methods

| Method | GraphQL Mutation/Query | Purpose |
|--------|----------------------|---------|
| `serviceCreate(name)` | `serviceCreate` | Create a new Railway service |
| `serviceDelete(serviceId)` | `serviceDelete` | Delete a Railway service |
| `variableCollectionUpsert(serviceId, vars)` | `variableCollectionUpsert` | Set environment variables on a service |
| `serviceDomainCreate(serviceId)` | `serviceDomainCreate` | Create an internal Railway domain |
| `serviceInstanceStatus(serviceId)` | `serviceInstance` | Check deployment status |

All methods are wrapped in Sentry spans for telemetry. See [telemetry.md](telemetry.md) for Railway API metrics.

## Provisioning Flow

Located at `src/railway/provisioner.ts`. Orchestrates the async creation of a worker container.

### Sequence

```
1. Control plane receives POST /v1/instances
2. Create InstanceRecord with status "provisioning"
3. Return 202 Accepted to caller
4. [Background] Call serviceCreate → get serviceId
5. [Background] Call variableCollectionUpsert with:
     - AAS_ROLE=worker
     - AAS_INSTANCE_NAME={name}
     - AAS_SYSTEM_PROMPT={systemPrompt}
     - AAS_MCP_SERVERS={JSON.stringify(mcpServers)}
     - AAS_MODEL={model}
     - AAS_MAX_TURNS={maxTurns}
     - AAS_MAX_BUDGET_USD={maxBudgetUsd}
     - ANTHROPIC_API_KEY={from control plane env}
     - SENTRY_DSN={from control plane env}
6. [Background] Call serviceDomainCreate → get workerUrl
7. Update InstanceRecord: railwayServiceId, workerUrl, status → "deploying"
8. Health poller starts monitoring the worker
```

### Error Handling

If any Railway API call fails during provisioning:
1. Log the error with full context
2. Attempt cleanup: delete the partially-created service (best-effort)
3. Set InstanceRecord status → `error`, `provisionError` → error message
4. Emit `provision.count` metric with status=error

### Environment Variable Updates (PATCH)

When an instance config is updated via PATCH:

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
| **Ongoing** | 30s | Status transitions to `ready` | Instance is deleted |

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

### Health Check Request

```
GET {workerUrl}/health
Timeout: 5000ms
Expected: 200 { "status": "ok", "instanceName": "..." }
```

Any non-200 response or timeout counts as a failure.

## Service Naming

Railway service names are derived from instance names:

```
aas-w-{sanitized-name}
```

Where sanitization:
- Replaces `/` with `-`
- Lowercases the entire string

See [hierarchy.md](hierarchy.md) for examples.

### Name Collision on Re-provision

When nuking and immediately re-provisioning, the Railway service may not yet be fully deleted. The provisioner handles this by:
1. Attempting `serviceCreate` with the computed name
2. On name conflict error, retry after a 2s delay (max 3 retries)
3. If retries exhausted, fail with a descriptive error

## Build Strategy

Railway uses Railpack (zero-config builder) to auto-detect the Node.js/TypeScript app from `package.json`. No Dockerfile needed. Railpack runs `npm ci`, the `build` script (`tsc`), and uses the `start` script as the entry point.

A single codebase serves both roles — `entry.ts` reads `AAS_ROLE` to dispatch:

- `AAS_ROLE=control-plane` → boots the control plane server
- `AAS_ROLE=worker` → boots the worker server

The `start` script in `package.json` must point to the compiled entry point:

```json
"start": "node dist/entry.js"
```

When creating a worker service, the control plane sets `AAS_ROLE=worker` in the service's environment variables. Railway builds the same codebase from the repo and Railpack produces the container image automatically.

## Service Deletion

### Single Instance Delete

1. Set status → `destroying`
2. Stop health polling for this instance
3. Call `serviceDelete(railwayServiceId)` — fire-and-forget
4. Remove `InstanceRecord` from registry

### Prefix Nuke

1. Find all matching instances
2. For each: set status → `destroying`, stop health polling
3. Call `serviceDelete` for each — fire-and-forget (parallel)
4. Remove all matching `InstanceRecord`s from registry
5. Return `{ deleted: N }`

Railway service deletion is fire-and-forget. The control plane does not wait for Railway to confirm deletion. If deletion fails silently, the orphaned service will remain on Railway until manually cleaned up.

## Related

- **Instances**: [instances.md](instances.md) — instance data model, lifecycle, CRUD
- **Hierarchy**: [hierarchy.md](hierarchy.md) — service naming convention
- **Telemetry**: [telemetry.md](telemetry.md) — Railway API call tracing and metrics
- **Worker API**: [worker-api.md](worker-api.md) — worker health endpoint
