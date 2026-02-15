# Claude Agent SDK as a Service (AAS)

> **Critical Instruction for Agents**: This document is the source of truth for code structure. You MUST NOT deviate from these patterns without updating this document first. "Consistency is better than cleverness."

## Project Overview

Long-lived container service managing named Claude Agent SDK instances. Runs as a standalone Hono server deployed to Railway — no Next.js, no database, all state in-memory. Workers are pre-built Docker images pulled from GHCR, starting dormant and activated via HTTP.

## Commands

- `npm run dev` — Start dev server with hot reload (tsx watch)
- `npm run build` — TypeScript compile
- `npm run start` — Run compiled server
- `npm run lint` — ESLint
- `npm run typecheck` — TypeScript strict check
- `npm run test` — Vitest unit tests
- `npm run test:watch` — Vitest watch mode
- `npm run deploy` — Deploy to Railway
- `npm run docker:build` — Build both Docker images
- `npm run docker:push` — Push images to GHCR
- `npm run docker:up` — Start local Docker environment (CP + workers)
- `npm run docker:down` — Stop local Docker environment

**Troubleshooting:** If any `npm run` command fails, the very first thing to try is `npm install`.

## Deployment

Deployed to [Railway](https://railway.app) as Docker containers pulled from GHCR. Two separate images: one for the control plane, one for workers.

- **Build**: Two Dockerfiles (`Dockerfile.cp`, `Dockerfile.worker`) produce separate images. Built locally or in CI, pushed to GHCR. Railway pulls images directly — no Railpack, no Railway builds.
- **Control plane**: Single service pulling `ghcr.io/.../aas-cp:latest`. `AAS_ROLE=control-plane` is baked into the Dockerfile.
- **Workers**: Pool of services, each pulling `ghcr.io/.../aas-worker:latest`. `AAS_ROLE=worker` is baked into the Dockerfile. Workers start dormant; the CP activates them via `POST /activate` with agent config.
- **Pool management**: CP maintains a pool of dormant workers. Background monitor ensures dormant count >= 10. Workers are destroyed on agent delete; pool replenishes automatically.
- **Local dev**: `docker compose up` starts 1 CP + 3 dormant workers locally.
- **CLI**: `npx @railway/cli@latest` (or install globally). Key commands:
  - `railway link` — Link local project to Railway service (one-time setup)
  - `railway up -d` — Deploy (detached, returns immediately)
  - `railway logs` — Tail production logs
  - `railway variables` — Manage env vars on Railway
- **Environment variables**: Set `ANTHROPIC_API_KEY`, `SENTRY_DSN`, `RAILWAY_API_TOKEN` via `railway variables` or the Railway dashboard. Railway injects `PORT` automatically.

## Architecture

- **HTTP Server**: Hono + @hono/node-server
- **State**: In-memory Map (no database)
- **Agent SDK**: @anthropic-ai/claude-agent-sdk for agent orchestration
- **Telemetry**: @sentry/node for tracing, logs, metrics
- **Validation**: Zod at API boundaries
- **Container**: Docker (two images: `Dockerfile.cp`, `Dockerfile.worker`)
- **Registry**: GHCR for pre-built images
- **Worker Pool**: CP manages pool of dormant workers on Railway, activated via HTTP

## Directory Structure

```text
src/
├── entry.ts              # Dual-role entry: reads AAS_ROLE, boots control-plane or worker
├── server.ts             # Control plane Hono app + route wiring
├── routes/               # API route handlers (health, instances, proxy)
├── railway/              # Railway client, pool manager, health poller
├── registry/             # Instance store (InstanceStore class)
├── worker/               # Worker server, routes, activation, SDK runner, queue, history
├── shared/               # Shared types (InstanceRecord, McpServerConfig, Zod schemas)
└── telemetry/            # Sentry init, helpers, middleware, OTEL env var derivation

Dockerfile.cp             # Control plane image
Dockerfile.worker         # Worker image (with system deps: git, curl)
.dockerignore             # Docker build exclusions
docker-compose.yml        # Local dev: 1 CP + 3 dormant workers
```

## Code Conventions

### TypeScript

- Strict mode. No `any` — use `unknown` if unsure, but prefer defined types.
- Named exports only (no default exports).
- File naming: `kebab-case.ts` for all modules.
- Prefer early return over nested if/else.
- Flat over nested — max one level of indentation unless it hurts readability.
- Use enums/unions over booleans for state (e.g., `status: 'provisioning' | 'ready' | 'error'` not `isRunning: boolean`).
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
- Use fail-open semantics where appropriate (e.g., telemetry failures should not block invocations).

### Environment Variables

All secrets live in `.env.local` (gitignored). If the file is missing, copy from `../the-office-a/.env.local`.

#### Control Plane

```
AAS_ROLE=control-plane          # Baked into Dockerfile.cp (set in .env.local for local dev)
ANTHROPIC_API_KEY=sk-ant-...    # Required
SENTRY_DSN=https://...          # Required
RAILWAY_API_TOKEN=...           # Required (for Railway API calls)
PORT=8080                       # Optional, default 8080
```

`RAILWAY_PROJECT_ID` and `RAILWAY_ENVIRONMENT_ID` are auto-injected by Railway at runtime.

#### Worker

```
AAS_ROLE=worker                 # Baked into Dockerfile.worker
ANTHROPIC_API_KEY=sk-ant-...    # Required (injected by pool manager via Railway env vars)
SENTRY_DSN=https://...          # Required (injected by pool manager via Railway env vars)
PORT=8080                       # Optional (injected by Railway)
```

Agent config (instanceName, systemPrompt, mcpServers, model, maxTurns, maxBudgetUsd) is delivered at activation time via `POST /activate`, not via env vars.

## Key Specs

- Functional spec: `spec/functional/` (one file per feature area — see `spec/functional/README.md` for index)
- Implementation plan: `spec/plan/` (see `spec/plan/README.md` for milestones)

## Telemetry

Telemetry is VITAL. **Be liberal — when in doubt, add a span, log, or metric.** The cost of too much telemetry is trivial; the cost of too little is hours of blind debugging.

**Distributed tracing with OTel via Sentry is fundamental.** Every HTTP call from control plane to worker carries `sentry-trace` and `baggage` headers. Workers accept incoming trace info and use it as the parent for all operations. The SDK subprocess receives OTEL env vars so its internal spans appear as children of the invocation span. There must be a single unbroken trace from caller → control plane → worker → SDK subprocess.

### What to Instrument

- **Traces**: Every instance operation (provision, activate, nuke), every API request, every pool operation, and every significant async operation must be wrapped in a Sentry span. Nest child spans for sub-operations.
- **Logs**: Structured logs for instance lifecycle events, invocation decisions, SDK events, pool operations, and errors. Include relevant IDs (instanceName, sessionId, invocationId, workerNumber) as attributes so logs are filterable. **Be verbose**: log system prompts, tool call inputs, tool results, reasoning text — full content, chunked if needed. Logs must be sufficient to reconstruct the entire agent conversation from Sentry alone.
- **Metrics**: Counters for invocations, queue depth, pool size, errors. Distributions for invocation latencies, token usage, and activation times.

### Helpers (`src/telemetry/helpers.ts`)

- `withSpan(name, op, fn)` — wrap any function in a traced span
- `logInfo/logWarn/logError(message, attributes)` — structured logs
- `countMetric(name, value, attributes)` — counter metrics
- `distributionMetric(name, value, unit, attributes)` — distribution metrics
- `chunkedLog(prefix, text, maxLen?)` — split long text into `[chunk N/M]` log entries

### OTEL Subprocess Tracing (`src/telemetry/otel-env.ts`)

- `getOtelEnvVars(sentryDsn, span, instanceName)` — derive OTEL env vars from Sentry DSN + active span for SDK subprocess trace propagation

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
- **Test helpers**: Use local factory functions (e.g., `makeRequest()`) co-located in test files. Do not manually construct complex objects inline in tests.

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
