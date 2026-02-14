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

- **Build**: Railpack detects `package.json`, runs `npm ci` + the `build` script (`tsc`), and uses the `start` script (`node dist/index.js`) as the entry point.
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
├── index.ts              # Entry: init Sentry, start server
├── server.ts             # Hono app + route wiring
├── routes/               # API route handlers (health, instances)
├── registry/             # Instance store + types (AgentInstance, Zod schemas)
└── telemetry/            # Sentry init, helpers, middleware
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
- Use `jsonResponse()` helper that attaches trace headers (`streamResponse()` will be added in S-2.1).
- Error responses follow the shape: `{ error: string, code?: string }`.

### Error Handling

- Let errors propagate naturally. Don't wrap everything in try/catch.
- Validate at API boundaries with Zod. Trust internal code.
- Agent invocation errors are isolated — never crash the server for a single instance failure.
- Use fail-open semantics where appropriate (e.g., telemetry failures should not block invocations).

### Environment Variables

All secrets live in `.env.local` (gitignored). If the file is missing, copy from `../the-office-a/.env.local`.

```
ANTHROPIC_API_KEY=sk-ant-...    # Required
SENTRY_DSN=https://...          # Required
PORT=8080                       # Optional, default 8080
```

## Key Specs

- Functional spec: `spec/functional/` (one file per feature area — see `spec/functional/README.md` for index)
- Implementation plan: `spec/plan/` (see `spec/plan/README.md` for milestones)

## Telemetry

Telemetry is VITAL. **Be liberal — when in doubt, add a span, log, or metric.** The cost of too much telemetry is trivial; the cost of too little is hours of blind debugging.

### What to Instrument

- **Traces**: Every instance operation (provision, invoke, nuke), every API request, and every significant async operation must be wrapped in a Sentry span. Nest child spans for sub-operations.
- **Logs**: Structured logs for instance lifecycle events, invocation decisions, SDK events, and errors. Include relevant IDs (instanceName, sessionId, invocationId) as attributes so logs are filterable.
- **Metrics**: Counters for invocations, queue depth, errors. Distributions for invocation latencies and token usage.

### Helpers (`src/telemetry/helpers.ts`)

- `withSpan(name, op, fn)` — wrap any function in a traced span
- `logInfo/logWarn/logError(message, attributes)` — structured logs
- `countMetric(name, value, attributes)` — counter metrics
- `distributionMetric(name, value, unit, attributes)` — distribution metrics
- `chunkedLog(prefix, text, maxLen?)` — split long text into `[chunk N/M]` log entries

### Traced Responses

All API routes MUST use `jsonResponse()` helper instead of raw Hono responses (`streamResponse()` will be added in S-2.1 for SSE endpoints). These helpers automatically attach the active Sentry trace ID as an `x-sentry-trace-id` response header, linking every HTTP response to its full trace in Sentry.

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
