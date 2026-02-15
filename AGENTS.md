# Claude Agent SDK as a Service (AAS)

> **Critical Instruction for Agents**: This document is the source of truth for code structure. You MUST NOT deviate from these patterns without updating this document first. "Consistency is better than cleverness."

## Project Overview

Long-lived container service managing named Claude Agent SDK instances. Runs as a standalone Hono server deployed to Railway — no Next.js, no database, all state in-memory.

## Commands

- `npm run dev` — Start dev server with hot reload (tsx watch)
- `npm run build` — TypeScript compile
- `npm run start` — Run compiled server
- `npm run lint` — ESLint
- `npm run typecheck` — TypeScript strict check
- `npm run test` — Vitest unit tests
- `npm run test:watch` — Vitest watch mode
- `npm run deploy` — Deploy to Railway (`railway up -d`)

**Troubleshooting:** If any `npm run` command fails, the very first thing to try is `npm install`.

## Deployment

Deployed to [Railway](https://railway.app) as a long-lived container. Railway uses Railpack (its zero-config builder) to auto-detect the Node.js/TypeScript app from `package.json` and build an optimized container image. No Dockerfile needed.

- **Build**: Railpack detects `package.json`, runs `npm ci` + the `build` script (`tsc`), and uses the `start` script (`node dist/entry.js`) as the entry point.
- **Dual-role**: A single codebase serves both control plane and worker. `AAS_ROLE` env var selects the role at boot.
- **CLI**: `npx @railway/cli@latest` (or install globally). Key commands:
  - `railway link` — Link local project to Railway service (one-time setup)
  - `railway up -d` — Deploy (detached, returns immediately)
  - `railway logs` — Tail production logs
  - `railway variables` — Manage env vars on Railway
- **Environment variables**: Set `ANTHROPIC_API_KEY`, `SENTRY_DSN` via `railway variables` or the Railway dashboard. Railway injects `PORT` automatically.
- **PR previews**: Railway auto-deploys a preview environment per GitHub PR. Railpack builds from the PR branch automatically.

## Architecture

- **HTTP Server**: Hono + @hono/node-server
- **State**: In-memory Map (no database)
- **Agent SDK**: @anthropic-ai/claude-agent-sdk for agent orchestration
- **Telemetry**: @sentry/node for tracing, logs, metrics
- **Validation**: Zod at API boundaries

## Directory Structure

```text
src/
├── entry.ts              # Dual-role entry: reads AAS_ROLE, boots control-plane or worker
├── server.ts             # Control plane Hono app + route wiring
├── routes/               # API route handlers (health, instances, proxy)
├── registry/             # Instance store (InstanceStore class)
├── railway/              # Railway GraphQL client, provisioner, health poller
├── pool/                 # Pool manager, replenisher, pool worker types
├── worker/               # Worker server, SDK runner, queue, history, routes
├── shared/               # Shared types (InstanceRecord, McpServerConfig, Zod schemas)
└── telemetry/            # Sentry init, helpers, middleware, OTEL env var derivation
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

```
AAS_ROLE=control-plane          # Required: 'control-plane' or 'worker'
ANTHROPIC_API_KEY=sk-ant-...    # Required
SENTRY_DSN=https://...          # Required
RAILWAY_API_TOKEN=...           # Required (for Railway API calls, control-plane only)
AAS_POOL_TARGET_IDLE=2          # Optional, default 2 (control-plane only)
AAS_POOL_MAX_TOTAL=10           # Optional, default 10 (control-plane only)
PORT=8080                       # Optional, default 8080
```

`RAILWAY_PROJECT_ID` and `RAILWAY_ENVIRONMENT_ID` are auto-injected by Railway at runtime.

## Key Specs

- Functional spec: `spec/functional/` (one file per feature area — see `spec/functional/README.md` for index)
- Implementation plan: `spec/plan/` (see `spec/plan/README.md` for milestones)

## Telemetry

Telemetry is VITAL. **Be liberal — when in doubt, add a span, log, or metric.** The cost of too much telemetry is trivial; the cost of too little is hours of blind debugging.

**Distributed tracing with OTel via Sentry is fundamental.** Every HTTP call from control plane to worker carries `sentry-trace` and `baggage` headers. Workers accept incoming trace info and use it as the parent for all operations. The SDK subprocess receives OTEL env vars so its internal spans appear as children of the invocation span. There must be a single unbroken trace from caller → control plane → worker → SDK subprocess.

### What to Instrument

- **Traces**: Every instance operation (provision, invoke, nuke), every API request, pool operations, and every significant async operation must be wrapped in a Sentry span. Nest child spans for sub-operations.
- **Logs**: Structured logs for instance lifecycle events, invocation decisions, SDK events, and errors. Include relevant IDs (instanceName, sessionId, invocationId) as attributes so logs are filterable. **Be verbose**: log system prompts, tool call inputs, tool results, reasoning text — full content, chunked if needed. Logs must be sufficient to reconstruct the entire agent conversation from Sentry alone.
- **Metrics**: Counters for invocations, queue depth, pool state, errors. Distributions for invocation latencies and token usage.

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
