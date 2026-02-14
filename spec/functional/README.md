# Claude Agent SDK as a Service (AAS) — Functional Specification

AI agent instance management service. The control plane runs as a long-lived container on Railway, managing named Claude Agent SDK instances. Each instance maps to a dedicated worker container on Railway. The control plane handles provisioning, health monitoring, and proxying messages to workers.

## Architecture

```
Vercel App ──HTTP──▶ Control Plane (Railway, Hono + Node.js)
                         ├── Instance Registry (in-memory Map)
                         ├── Railway GraphQL Client
                         └── Health Poller
                              │
                              ├──Railway API──▶ Worker Container (Railway)
                              │                    ├── SDK query()
                              │                    ├── Session management
                              │                    └── FIFO message queue
                              │                         └──MCP──▶ Remote MCP Servers
                              │
                              └──HTTP proxy──▶ Worker /message, /history, /status
```

## Tech Stack

| Layer | Technology | Package | Purpose |
|-------|-----------|---------|---------|
| **HTTP Server** | Hono | `hono` + `@hono/node-server` | Lightweight, fast HTTP framework |
| **AI Foundation** | Claude Agent SDK | `@anthropic-ai/claude-agent-sdk` | Agent orchestration, LLM calls, tool execution, sessions |
| **Telemetry** | Sentry | `@sentry/node` | Distributed tracing, logs, metrics |
| **Validation** | Zod | `zod` | Input validation at API boundaries |
| **Language** | TypeScript | `typescript` | Everything |
| **Runtime** | Node.js 22+ | — | Long-lived container process |
| **Deployment** | Railway + Railpack | `@railway/cli` | Container hosting with zero-config builds |

## API Surface

### Control Plane

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/v1/instances` | Provision instance (async, returns 202) |
| GET | `/v1/instances` | List (query: `?prefix=dev/A`) |
| GET | `/v1/instances/*` | Get by name |
| PATCH | `/v1/instances/*` | Update config (triggers redeploy) |
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
| POST | `/message` | Execute SDK invocation → SSE stream |
| GET | `/history` | Return conversation history |
| GET | `/status` | Return runtime status |
| POST | `/abort` | Cancel active invocation |
| POST | `/reset` | Clear session, history, and queue |
| GET | `/health` | Health check (used by control plane poller) |

## Capability Index

| # | Capability | Spec File | Summary |
|---|-----------|-----------|---------|
| 1 | Instances | [instances.md](instances.md) | Provisioning, configuration, lifecycle management |
| 2 | Hierarchy | [hierarchy.md](hierarchy.md) | Naming scheme, prefix operations, nuke |
| 3 | Messaging | [invocation.md](invocation.md) | Proxy-based messaging, SSE streaming, sessions |
| 4 | Telemetry | [telemetry.md](telemetry.md) | Sentry, OTEL, logs, metrics, distributed tracing |
| 5 | Management UI | [management-ui.md](management-ui.md) | Dashboard, rolling logs, instance actions |
| 6 | Railway Integration | [railway-integration.md](railway-integration.md) | Provisioning flow, health polling, service management |
| 7 | Worker API | [worker-api.md](worker-api.md) | Worker endpoints, queue, history, status |

## Environment Variables

```
ANTHROPIC_API_KEY=sk-ant-...    # Required
SENTRY_DSN=https://...          # Required
RAILWAY_API_TOKEN=...           # Required (for Railway API calls)
PORT=8080                       # Optional, default 8080
```

`RAILWAY_PROJECT_ID` and `RAILWAY_ENVIRONMENT_ID` are auto-injected by Railway at runtime.

## What We Do NOT Build

| Feature | Why Skip |
|---------|----------|
| Authentication | Internal service, trusted network |
| Persistent sessions | In-memory only, reprovisioned on restart |
| Database | All state in-memory |
| Frontend framework | Single HTML file, no build step |
| Multi-model routing | Caller specifies model at provisioning |
