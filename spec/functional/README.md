# Claude Agent SDK as a Service (AAS) — Functional Specification

AI agent instance management service. Runs as a long-lived container process managing named Claude Agent SDK instances — Anthropic's "Pattern 2: Long-Running Sessions". Deployed to Railway. No auth (internal service, trusted network). Stateful in-memory sessions (no crash recovery).

## Architecture

```
Vercel App ──HTTP──▶ AAS Container (Railway, Hono + Node.js)
                         ├── Instance Registry (in-memory Map)
                         ├── Per-instance Queue
                         └── SDK subprocess (query())
                              └──MCP──▶ Remote MCP Servers (on Vercel)
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

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/v1/instances` | Provision instance |
| GET | `/v1/instances` | List (query: `?prefix=dev/A`) |
| GET | `/v1/instances/*` | Get by name |
| PATCH | `/v1/instances/*` | Update config (resets session) |
| DELETE | `/v1/instances/*` | Delete exact or nuke prefix |
| POST | `/v1/instances/*/invoke` | Invoke agent → SSE stream |
| GET | `/v1/health` | Health + instance count |
| GET | `/v1/logs` | SSE stream of rolling logs |
| GET | `/ui` | Management dashboard |

## Directory Structure

```
src/
├── index.ts              # Entry: init Sentry, start server
├── server.ts             # Hono app + route wiring
├── routes/
│   ├── instances.ts      # Instance CRUD
│   ├── invoke.ts         # Agent invocation + SSE
│   └── health.ts         # Health check
├── registry/
│   ├── types.ts          # AgentInstance type
│   └── store.ts          # In-memory store, hierarchy support
├── queue/
│   └── instance-queue.ts # Per-instance FIFO
├── sdk/
│   ├── executor.ts       # SDK query() wrapper + session tracking
│   ├── events.ts         # SDK message → SSE event mapping
│   └── env.ts            # OTEL env for subprocess
├── telemetry/
│   ├── init.ts           # Sentry.init()
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
| 1 | Instances | [instances.md](instances.md) | Provisioning, configuration, lifecycle management |
| 2 | Hierarchy | [hierarchy.md](hierarchy.md) | Naming scheme, prefix operations, nuke |
| 3 | Invocation | [invocation.md](invocation.md) | SSE streaming, queueing, sessions |
| 4 | Telemetry | [telemetry.md](telemetry.md) | Sentry, OTEL, logs, metrics, distributed tracing |
| 5 | Management UI | [management-ui.md](management-ui.md) | Dashboard, rolling logs, instance actions |

## Environment Variables

```
ANTHROPIC_API_KEY=sk-ant-...
SENTRY_DSN=https://...@sentry.io/...
PORT=8080
```

## What We Do NOT Build

| Feature | Why Skip |
|---------|----------|
| Authentication | Internal service, trusted network |
| Persistent sessions | In-memory only, reprovisioned on restart |
| Database | All state in-memory |
| Frontend framework | Single HTML file, no build step |
| Multi-model routing | Caller specifies model at provisioning |
