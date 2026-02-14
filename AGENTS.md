# Claude Agent SDK as a Service (AAS)

> **Critical Instruction for Agents**: This document is the source of truth for code structure. You MUST NOT deviate from these patterns without updating this document first. "Consistency is better than cleverness."

## Project Overview

Control plane + worker architecture for managing named Claude Agent SDK instances. Each instance gets its own long-lived Docker container on Railway. The control plane provisions workers via Railway's GraphQL API and proxies all caller traffic. Single Docker image for both roles, selected by `AAS_ROLE` env var.

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

- **Control Plane**: Hono + @hono/node-server. Manages instance registry, provisions workers via Railway API, proxies requests to workers.
- **Workers**: Hono + @hono/node-server. Runs Claude Agent SDK, maintains conversation history, exposes API for messaging/history/status.
- **Telemetry**: @sentry/node on both roles with different service names.
- **Validation**: Zod at API boundaries (both roles).
- **No auth**: Internal service, trusted Railway network.

## Commands

- `npm run dev` — Start dev server with hot reload (tsx watch)
- `npm run build` — TypeScript compile
- `npm run start` — Run compiled server
- `npm run lint` — ESLint
- `npm run typecheck` — TypeScript strict check
- `npm run test` — Vitest unit tests
- `npm run test:watch` — Vitest watch mode

**Local development with roles**: Set `AAS_ROLE=control-plane` or `AAS_ROLE=worker` in `.env.local` to test each role locally.

**Troubleshooting:** If any `npm run` command fails, the very first thing to try is `npm install`.

## Deployment

Deployed to [Railway](https://railway.app). The control plane runs as a single Railway service. Worker containers are created dynamically by the control plane via Railway's GraphQL API.

- **CLI**: `npx @railway/cli@latest` (or install globally). Key commands:
  - `railway link` — Link local project to Railway service (one-time setup)
  - `railway up -d` — Deploy (detached, returns immediately)
  - `railway logs` — Tail production logs
  - `railway variables` — Manage env vars on Railway
- **Docker image strategy**: Single Dockerfile, single image for both roles. `src/entry.ts` reads `AAS_ROLE` and boots the appropriate server. The control plane uses `RAILWAY_WORKER_IMAGE` to reference the same image when creating worker services.
- **Dockerfile**: Multi-stage build (`npm ci` → `tsc` → `node dist/entry.js`). Railway uses this automatically.

## Directory Structure

```text
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

## Code Conventions

### TypeScript

- Strict mode. No `any` — use `unknown` if unsure, but prefer defined types.
- Named exports only (no default exports).
- File naming: `kebab-case.ts` for all modules.
- Prefer early return over nested if/else.
- Flat over nested — max one level of indentation unless it hurts readability.
- Use enums/unions over booleans for state (e.g., `status: 'ready' | 'running' | 'error'` not `isRunning: boolean`).
- **Keep Codebase Pristine**: This is an unlaunched greenfield project with NO backwards compatibility concerns. Aggressively delete unused code, dead imports, and stale abstractions. Never leave compatibility shims, re-exports, or commented-out code behind.

### API Routes

- All routes use Zod for input validation.
- All routes return JSON (except SSE endpoints and `/ui`).
- All routes emit Sentry telemetry via middleware.
- Use `jsonResponse()` / `streamResponse()` helpers that attach trace headers.
- Error responses follow the shape: `{ error: string, code?: string }`.

### Error Handling

- Let errors propagate naturally. Don't wrap everything in try/catch.
- Validate at API boundaries with Zod. Trust internal code.
- Agent invocation errors are isolated — never crash the server for a single instance failure.
- Use fail-open semantics where appropriate (e.g., telemetry failures should not block operations).

### Environment Variables

All secrets live in `.env.local` (gitignored). If the file is missing, copy from `../the-office-a/.env.local`.

#### Control Plane

```
ANTHROPIC_API_KEY=sk-ant-...        # Required — passed to workers as env var
SENTRY_DSN=https://...              # Required
PORT=8080                           # Optional, default 8080
AAS_ROLE=control-plane              # Required — selects control-plane role
RAILWAY_API_TOKEN=...               # Required — Railway API access
RAILWAY_PROJECT_ID=...              # Required — target Railway project
RAILWAY_ENVIRONMENT_ID=...          # Required — target Railway environment
RAILWAY_WORKER_IMAGE=...            # Required — Docker image reference for workers
```

#### Worker

```
ANTHROPIC_API_KEY=sk-ant-...        # Required — injected by control plane
SENTRY_DSN=https://...              # Required — injected by control plane
PORT=8080                           # Injected by Railway
AAS_ROLE=worker                     # Required — selects worker role
AAS_INSTANCE_NAME=dev/A/michael     # Required — injected by control plane
AAS_SYSTEM_PROMPT=...               # Required — injected by control plane
AAS_MCP_SERVERS=...                 # Optional — JSON-encoded McpServerConfig[]
AAS_MODEL=claude-haiku-4-5-20251001 # Optional — default claude-haiku-4-5-20251001
AAS_MAX_TURNS=50                    # Optional — default 50
AAS_MAX_BUDGET_USD=1.0              # Optional — default 1.0
```

## Key Specs

- Functional spec: `spec/functional/` (one file per feature area — see `spec/functional/README.md` for index)
- Implementation plan: `spec/plan/` (see `spec/plan/README.md` for milestones)

## Telemetry

Telemetry is VITAL. **Be liberal — when in doubt, add a span, log, or metric.** The cost of too much telemetry is trivial; the cost of too little is hours of blind debugging.

### What to Instrument

- **Traces**: Every instance operation (provision, proxy, nuke), every Railway API call, every worker invocation, and every significant async operation must be wrapped in a Sentry span. Nest child spans for sub-operations.
- **Logs**: Structured logs for instance lifecycle events, provisioning decisions, proxy operations, SDK events, and errors. Include relevant IDs (instanceName, sessionId, invocationId, railwayServiceId) as attributes so logs are filterable.
- **Metrics**: Counters for provisions, proxy requests, health polls, errors. Distributions for latencies, costs, and token usage.

### Helpers (`src/telemetry/helpers.ts`)

- `withSpan(name, op, fn)` — wrap any function in a traced span
- `logInfo/logWarn/logError(message, attributes)` — structured logs
- `countMetric(name, value, attributes)` — counter metrics
- `distributionMetric(name, value, unit, attributes)` — distribution metrics

### Traced Responses

All API routes MUST use `jsonResponse()` / `streamResponse()` helpers instead of raw Hono responses. These helpers automatically attach the active Sentry trace ID as an `x-sentry-trace-id` response header, linking every HTTP response to its full trace in Sentry.

## Testing

### Exit Criteria

This is a **requirement**:
- **Any changes**: `npm run test` must pass.
- **New features**: Unit tests covering the happy path and key edge cases.

### Testing Strategy

- **Unit Tests**: Vitest, co-located with source files (`*.test.ts` next to the module).
- **One `describe()` per file** — each test file contains exactly one top-level `describe()` block.
- **Factories**: Use `src/tests/factories/` for generating test data. Do not manually construct complex objects in tests.

### Show That Your Tests Are Working

Tests that have never failed even once are USELESS. You absolutely MUST confirm that the test is actually testing what you intend, either by following TDD and writing your test code before your product code, or by writing your changes, writing your test, temporarily removing your code changes, confirming that the test fails as expected, and then restoring the product code changes.

## Agent Workflow Standards

### Stop and Read Policy

- **Before Coding**: Read the relevant spec and any related source files before starting implementation.
- **Before Modifying**: Always read the existing file content before editing. Blind edits are forbidden.

### Error Recovery Protocol

- **Linter Errors**: If a fix triggers a linter error, DO NOT suppress it with `// eslint-disable` unless absolutely necessary. Fix the root cause.
- **Test Failures**: Analyze the failure output. If the test is wrong, update the test. If the code is wrong, update the code. Do not delete the test.

### Self-Verification

- **Run the Build**: After significant changes, run `npm run build` and `npm run lint`.
- **Run the Tests**: After any code change, run `npm run test` to verify nothing is broken.
