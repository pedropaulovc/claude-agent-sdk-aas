# Claude Agent SDK as a Service (AAS) — Functional Specification

AI agent instance management service. The control plane runs as a long-lived container on Railway, managing named Claude Agent SDK instances. Each instance maps to a worker service from a pre-provisioned pool. Workers start dormant and are activated via HTTP with agent configuration. The control plane handles pool management, activation, health monitoring, and proxying messages to workers. Distributed tracing with OTel via Sentry is fundamental — every operation carries trace context end-to-end from caller through control plane to worker to SDK subprocess.

## Architecture

```
Build Pipeline:
  docker build -f Dockerfile.cp     → ghcr.io/.../aas-cp:latest     → push
  docker build -f Dockerfile.worker → ghcr.io/.../aas-worker:latest → push

Railway:
  CP service (1x, pulls aas-cp image from GHCR)
    ├── Instance Registry (in-memory Map)
    ├── Worker Pool Manager
    │     └── Creates worker services from GHCR image
    │     └── Background monitor: dormant < 10 → create 10 more
    ├── Health Poller
    └── Proxy routes → worker /message, /history, /status

  Worker services (Nx, each pulls aas-worker image from GHCR)
    ├── Starts DORMANT (HTTP server up, no SDK)
    ├── POST /activate → receives agent config → initializes SDK → ACTIVE
    ├── SDK query() + OTEL subprocess tracing
    ├── Verbose logging (system prompts, tool calls, results, reasoning)
    └── POST /message, GET /history, GET /status, POST /abort, POST /reset

Provisioning:
  POST /v1/instances → pool.claimWorker() → POST /activate → ready (seconds)

Callers:
  Vercel App ──HTTP──▶ Control Plane ──proxy──▶ Worker
```

## Tech Stack

| Layer | Technology | Package | Purpose |
|-------|-----------|---------|---------|
| **HTTP Server** | Hono | `hono` + `@hono/node-server` | Lightweight, fast HTTP framework |
| **AI Foundation** | Claude Agent SDK | `@anthropic-ai/claude-agent-sdk` | Agent orchestration, LLM calls, tool execution, sessions |
| **Telemetry** | Sentry | `@sentry/node` | Distributed tracing, logs, metrics, OTEL export |
| **Validation** | Zod | `zod` | Input validation at API boundaries |
| **Language** | TypeScript | `typescript` | Everything |
| **Runtime** | Node.js 22+ | — | Long-lived container process |
| **Container** | Docker | — | Two images: `Dockerfile.cp`, `Dockerfile.worker` |
| **Registry** | GHCR | — | Pre-built Docker images, pulled by Railway |
| **Deployment** | Railway | `@railway/cli` | Container hosting, pool of worker services |

## API Surface

### Control Plane

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/v1/instances` | Provision instance (pool-based, returns 202) |
| GET | `/v1/instances` | List (query: `?prefix=dev/A`) |
| GET | `/v1/instances/*` | Get by name |
| PATCH | `/v1/instances/*` | Update config (destroy + re-provision) |
| DELETE | `/v1/instances/*` | Delete exact or nuke prefix |
| POST | `/v1/instances/*/message` | Proxy message to worker → SSE stream |
| GET | `/v1/instances/*/history` | Proxy: get conversation history from worker |
| GET | `/v1/instances/*/status` | Proxy: get runtime status from worker |
| GET | `/v1/health` | Health + instance count |
| GET | `/v1/logs` | SSE stream of rolling logs |
| GET | `/ui` | Management dashboard |

### Worker

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/activate` | Activate dormant worker with agent config |
| POST | `/message` | Execute SDK invocation → SSE stream |
| GET | `/history` | Return conversation history |
| GET | `/status` | Return runtime status |
| POST | `/abort` | Cancel active invocation |
| POST | `/reset` | Clear session, history, and queue |
| GET | `/health` | Health check (dormant or active) |

## Capability Index

| # | Capability | Spec File | Summary |
|---|-----------|-----------|---------|
| 1 | Instances | [instances.md](instances.md) | Pool-based provisioning, configuration, lifecycle management |
| 2 | Hierarchy | [hierarchy.md](hierarchy.md) | Naming scheme, prefix operations, nuke |
| 3 | Messaging | [invocation.md](invocation.md) | Proxy-based messaging, SSE streaming, sessions |
| 4 | Telemetry | [telemetry.md](telemetry.md) | Sentry, OTEL subprocess tracing, verbose logging, distributed tracing, metrics |
| 5 | Management UI | [management-ui.md](management-ui.md) | Dashboard, rolling logs, instance actions |
| 6 | Railway Integration | [railway-integration.md](railway-integration.md) | GHCR images, worker pool, health polling |
| 7 | Worker API | [worker-api.md](worker-api.md) | Dormant/active states, activation, endpoints |

## Environment Variables

### Control Plane

```
AAS_ROLE=control-plane          # Baked into Dockerfile.cp
ANTHROPIC_API_KEY=sk-ant-...    # Required
SENTRY_DSN=https://...          # Required
RAILWAY_API_TOKEN=...           # Required (for Railway API calls)
PORT=8080                       # Optional, default 8080
```

`RAILWAY_PROJECT_ID` and `RAILWAY_ENVIRONMENT_ID` are auto-injected by Railway at runtime.

### Worker

```
AAS_ROLE=worker                 # Baked into Dockerfile.worker
ANTHROPIC_API_KEY=sk-ant-...    # Required (injected by pool manager)
SENTRY_DSN=https://...          # Required (injected by pool manager)
PORT=8080                       # Optional (injected by Railway)
```

Agent config (instanceName, systemPrompt, mcpServers, model, maxTurns, maxBudgetUsd) is delivered at activation time via `POST /activate`, not via env vars.

## What We Do NOT Build

| Feature | Why Skip |
|---------|----------|
| Authentication | Internal service, trusted network |
| Persistent sessions | In-memory only, reprovisioned on restart |
| Database | All state in-memory |
| Frontend framework | Single HTML file, no build step |
| Multi-model routing | Caller specifies model at provisioning |
| Worker reconfiguration | Destroy + replace from pool (clean state) |
