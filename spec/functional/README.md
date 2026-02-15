# Claude Agent SDK as a Service (AAS) — Functional Specification

AI agent instance management service. The control plane runs as a long-lived container on Railway, managing named Claude Agent SDK instances. Workers are drawn from a pre-warmed pool for instant provisioning. Distributed tracing with OTel via Sentry is fundamental — every operation carries trace context end-to-end from caller through control plane to worker to SDK subprocess.

## Architecture

```
Vercel App ──HTTP──▶ Control Plane (Railway, Hono + Node.js)
                         ├── Instance Registry (in-memory Map)
                         ├── Pool Manager (idle/active worker tracking)
                         ├── Pool Replenisher (background, maintains target idle count)
                         ├── Railway GraphQL Client
                         └── Health Poller
                              │
                              ├──POST /configure──▶ Pool Worker (Railway)
                              │                       ├── State: idle → active
                              │                       ├── SDK query() + OTEL subprocess tracing
                              │                       ├── Session management
                              │                       ├── Verbose logging (prompts, tools, reasoning)
                              │                       └── FIFO message queue
                              │                            └──MCP──▶ Remote MCP Servers
                              │
                              ├──POST /reset──▶ Pool Worker → idle (recycle to pool)
                              │
                              └──HTTP proxy──▶ Worker /message, /history, /status
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
| **Deployment** | Railway + Railpack | `@railway/cli` | Container hosting with zero-config builds |

## API Surface

### Control Plane

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/v1/instances` | Provision instance (pool hit → instant, pool miss → async 202) |
| GET | `/v1/instances` | List (query: `?prefix=dev/A`) |
| GET | `/v1/instances/*` | Get by name |
| PATCH | `/v1/instances/*` | Update config (in-place reconfigure for pool workers) |
| DELETE | `/v1/instances/*` | Delete exact or nuke prefix (pool workers recycled) |
| POST | `/v1/instances/*/message` | Proxy message to worker → SSE stream |
| GET | `/v1/instances/*/history` | Proxy: get conversation history from worker |
| GET | `/v1/instances/*/status` | Proxy: get runtime status from worker |
| GET | `/v1/health` | Health + instance count + pool status |
| GET | `/v1/logs` | SSE stream of rolling logs |
| GET | `/ui` | Management dashboard |

### Worker

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/configure` | Apply instance config (pool mode) |
| POST | `/message` | Execute SDK invocation → SSE stream |
| GET | `/history` | Return conversation history |
| GET | `/status` | Return runtime status (works in any state) |
| POST | `/abort` | Cancel active invocation |
| POST | `/reset` | Clear state, return to idle (pool mode) |
| GET | `/health` | Health check (includes worker state: idle/active) |

## Capability Index

| # | Capability | Spec File | Summary |
|---|-----------|-----------|---------|
| 1 | Instances | [instances.md](instances.md) | Pool-aware provisioning, configuration, lifecycle management |
| 2 | Hierarchy | [hierarchy.md](hierarchy.md) | Naming scheme, prefix operations, nuke |
| 3 | Messaging | [invocation.md](invocation.md) | Proxy-based messaging, SSE streaming, sessions |
| 4 | Telemetry | [telemetry.md](telemetry.md) | Sentry, OTEL subprocess tracing, verbose logging, distributed tracing, metrics |
| 5 | Management UI | [management-ui.md](management-ui.md) | Dashboard, rolling logs, instance actions |
| 6 | Railway Integration | [railway-integration.md](railway-integration.md) | Pool provisioning, health polling, service management |
| 7 | Worker API | [worker-api.md](worker-api.md) | Worker endpoints, configure, reset, queue, history, status |

## Environment Variables

### Control Plane

```
AAS_ROLE=control-plane          # Required
ANTHROPIC_API_KEY=sk-ant-...    # Required
SENTRY_DSN=https://...          # Required
RAILWAY_API_TOKEN=...           # Required (for Railway API calls)
AAS_POOL_TARGET_IDLE=2          # Optional, default 2
AAS_POOL_MAX_TOTAL=10           # Optional, default 10
PORT=8080                       # Optional, default 8080
```

### Worker (Pool Mode — Minimal)

```
AAS_ROLE=worker                 # Required
ANTHROPIC_API_KEY=sk-ant-...    # Required
SENTRY_DSN=https://...          # Required
PORT=8080                       # Optional
```

Instance config delivered via `POST /configure` at runtime.

`RAILWAY_PROJECT_ID` and `RAILWAY_ENVIRONMENT_ID` are auto-injected by Railway at runtime.

## What We Do NOT Build

| Feature | Why Skip |
|---------|----------|
| Authentication | Internal service, trusted network |
| Persistent sessions | In-memory only, reprovisioned on restart |
| Database | All state in-memory |
| Frontend framework | Single HTML file, no build step |
| Multi-model routing | Caller specifies model at provisioning |
