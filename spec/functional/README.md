# Claude Agent SDK as a Service (AAS) — Functional Specification

AI agent instance management service. Each instance gets its own long-lived Docker container on Railway running the Claude Agent SDK. A **control plane** provisions and manages worker containers via Railway's API, proxying all caller traffic. No auth (internal service, trusted network). Worker state is in-memory (no crash recovery).

## Architecture

```
Callers ──HTTP──▶ Control Plane (Railway, Hono)
                     ├── Instance Registry (in-memory)
                     ├── Railway Client (GraphQL API)
                     ├── Proxy (forwards to workers)
                     └── Dashboard UI
                          │
                   [Railway API]
                          │
                          ▼
                  Worker Containers (one per instance)
                     ├── Claude Agent SDK (query/resume)
                     ├── Conversation History (in-memory)
                     └── MCP ──▶ Remote MCP Servers
```

**Key design decisions:**
- Callers always go through the control plane (proxy model) — workers are not directly addressable by callers
- Single Docker image for both roles, selected by `AAS_ROLE` env var (`control-plane` or `worker`)
- No worker auth for now (trusted Railway internal network)

## Tech Stack

| Layer | Technology | Package | Purpose |
|-------|-----------|---------|---------|
| **HTTP Server** | Hono | `hono` + `@hono/node-server` | Lightweight, fast HTTP framework (both roles) |
| **AI Foundation** | Claude Agent SDK | `@anthropic-ai/claude-agent-sdk` | Agent orchestration, LLM calls, tool execution, sessions (worker only) |
| **Telemetry** | Sentry | `@sentry/node` | Distributed tracing, logs, metrics (both roles) |
| **Validation** | Zod | `zod` | Input validation at API boundaries |
| **Language** | TypeScript | `typescript` | Everything |
| **Runtime** | Node.js 22+ | — | Long-lived container process |
| **Deployment** | Railway | `@railway/cli` | Container hosting with CLI deploy + GraphQL API for service management |

## API Surface

### Control Plane Routes

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/v1/instances` | Provision instance (async — creates Railway service) |
| GET | `/v1/instances` | List (query: `?prefix=dev/A`) |
| GET | `/v1/instances/*` | Get by name |
| PATCH | `/v1/instances/*` | Update config (redeploys worker) |
| DELETE | `/v1/instances/*` | Delete exact or nuke prefix (destroys Railway services) |
| POST | `/v1/instances/*/message` | Proxy → worker `POST /message` → SSE stream |
| GET | `/v1/instances/*/history` | Proxy → worker `GET /history` |
| GET | `/v1/instances/*/status` | Proxy → worker `GET /status` |
| GET | `/v1/health` | Health + instance count |
| GET | `/v1/logs` | SSE stream of rolling logs |
| GET | `/ui` | Management dashboard |

### Worker Routes

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/message` | Send message → SSE stream response |
| GET | `/history` | Conversation history (in-memory) |
| GET | `/status` | Runtime status (session, invocations, uptime, cost) |
| GET | `/health` | Health check (Railway readiness) |
| POST | `/abort` | Abort current invocation |
| POST | `/reset` | Reset session + clear history |

## Directory Structure

```
src/
├── entry.ts              # Dual-role dispatcher: reads AAS_ROLE, boots control-plane or worker
├── server.ts             # Control-plane Hono app + route wiring
├── shared/               # Types and utilities shared between roles
│   └── types.ts          # InstanceRecord, McpServerConfig, shared Zod schemas
├── routes/               # Control-plane API route handlers
│   ├── instances.ts      # Instance CRUD
│   ├── proxy.ts          # Proxy routes (message, history, status)
│   └── health.ts         # Health check
├── registry/
│   └── store.ts          # In-memory InstanceRecord store, hierarchy support
├── railway/              # Railway API integration (control-plane only)
│   ├── client.ts         # GraphQL API client (service CRUD, variables, domains)
│   ├── provisioner.ts    # Async provisioning orchestrator
│   └── health-poller.ts  # Background health polling for worker containers
├── worker/               # Worker container code
│   ├── server.ts         # Worker Hono app + route wiring
│   ├── routes.ts         # Worker route handlers (message, history, status, health, abort, reset)
│   ├── sdk-runner.ts     # SDK query() wrapper + session tracking
│   ├── history.ts        # In-memory conversation history accumulator
│   └── queue.ts          # Worker-side FIFO invocation queue
├── sdk/
│   ├── events.ts         # SDK message → SSE event mapping
│   └── env.ts            # OTEL env for subprocess
├── telemetry/
│   ├── init.ts           # Sentry.init() (both roles, different service names)
│   ├── helpers.ts        # withSpan, logInfo, chunkedLog, etc.
│   └── middleware.ts     # HTTP tracing (incoming trace propagation)
├── ui/
│   └── dashboard.html    # Single-file management UI
└── types/
    └── index.ts
```

## Capability Index

| # | Capability | Spec File | Summary |
|---|-----------|-----------|---------|
| 1 | Instances | [instances.md](instances.md) | Provisioning, configuration, lifecycle management (async via Railway) |
| 2 | Hierarchy | [hierarchy.md](hierarchy.md) | Naming scheme, prefix operations, nuke (including Railway service deletion) |
| 3 | Messaging | [invocation.md](invocation.md) | Control-plane proxy to worker, SSE streaming, sessions |
| 4 | Telemetry | [telemetry.md](telemetry.md) | Sentry, OTEL, logs, metrics, distributed tracing (control plane + workers) |
| 5 | Management UI | [management-ui.md](management-ui.md) | Dashboard, rolling logs, instance actions |
| 6 | Worker API | [worker-api.md](worker-api.md) | Worker container endpoints, history, queue, SDK integration |
| 7 | Railway Integration | [railway-integration.md](railway-integration.md) | Railway GraphQL client, provisioning, health polling |

## Environment Variables

### Control Plane

```
ANTHROPIC_API_KEY=sk-ant-...        # Required — passed to workers as env var
SENTRY_DSN=https://...@sentry.io/.. # Required
PORT=8080                           # Optional, default 8080
AAS_ROLE=control-plane              # Required — selects control-plane role
RAILWAY_API_TOKEN=...               # Required — Railway API access
RAILWAY_PROJECT_ID=...              # Required — target Railway project
RAILWAY_ENVIRONMENT_ID=...          # Required — target Railway environment
RAILWAY_WORKER_IMAGE=...            # Required — Docker image reference for workers
```

### Worker

```
ANTHROPIC_API_KEY=sk-ant-...        # Required — injected by control plane
SENTRY_DSN=https://...@sentry.io/.. # Required — injected by control plane
PORT=8080                           # Injected by Railway
AAS_ROLE=worker                     # Required — selects worker role
AAS_INSTANCE_NAME=dev/A/michael     # Required — injected by control plane
AAS_SYSTEM_PROMPT=...               # Required — injected by control plane
AAS_MCP_SERVERS=...                 # Optional — JSON-encoded McpServerConfig[]
AAS_MODEL=claude-haiku-4-5-20251001 # Optional — default claude-haiku-4-5-20251001
AAS_MAX_TURNS=50                    # Optional — default 50
AAS_MAX_BUDGET_USD=1.0              # Optional — default 1.0
```

## What We Do NOT Build

| Feature | Why Skip |
|---------|----------|
| Authentication | Internal service, trusted network |
| Persistent sessions | In-memory only, reprovisioned on restart |
| Database | All state in-memory (both control plane and workers) |
| Frontend framework | Single HTML file, no build step |
| Multi-model routing | Caller specifies model at provisioning |
| Worker-to-worker communication | Workers are isolated, all coordination via control plane |
| Worker auth | Trusted Railway internal network |
