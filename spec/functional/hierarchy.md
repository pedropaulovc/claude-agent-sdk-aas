# Instance Hierarchy

Instances are organized using hierarchical slash-separated names (e.g., `dev/A/michael`). This enables prefix-based operations like listing all instances in a worktree or nuking an entire environment.

## Naming Rules

- Pattern: `[a-zA-Z0-9][a-zA-Z0-9._-]*(/[a-zA-Z0-9][a-zA-Z0-9._-]*)*`
- Each segment: starts with alphanumeric, followed by alphanumeric, dot, underscore, or hyphen
- No leading, trailing, or double slashes
- Minimum 1 segment, no maximum depth
- Case-sensitive

Valid examples:

```
michael
dev/A/michael
prod/office/michael.scott
e2e/B/agents/dwight
```

Invalid examples:

```
/leading
trailing/
double//slash
.starts-with-dot
has spaces
```

## Railway Service Naming

Workers are named with a monotonic counter, decoupled from instance names:

```
aas-w-{number}
```

Examples: `aas-w-1`, `aas-w-2`, `aas-w-42`

The mapping from instance name to worker number lives in the `InstanceRecord` (via `workerNumber`) and the pool registry. This avoids name sanitization issues and allows workers to be pre-created before any instance exists.

## Prefix Operations

| Operation | Behavior | Example |
|-----------|----------|---------|
| List by prefix | Returns all instances where name starts with `{prefix}/` OR exact match | `GET ?prefix=dev/A` → `dev/A/michael`, `dev/A/dwight`, etc. |
| Nuke by prefix | Deletes all matching prefix + exact, destroys Railway services | `DELETE /v1/instances/dev/A` → deletes all `dev/A/*` |
| Get exact | Returns single instance by exact name match | `GET /v1/instances/dev/A/michael` |

## Nuke Semantics

- DELETE on a path acts as "nuke" if the path matches a prefix (has children)
- All instances where name starts with `{path}/` are deleted, plus exact match on `{path}` itself
- **Worker release**: each matching instance's worker is released via `pool.releaseWorker()`, which destroys the Railway service. Deletions are fire-and-forget. The pool monitor creates replacement dormant workers in the background.
- Returns `{ deleted: N }` with count of deleted instances
- Idempotent: nuking a non-existent prefix returns `{ deleted: 0 }`

**Instant Readiness**: After nuke, the same names can be re-provisioned immediately from the dormant pool. No cooldown, no cleanup delay.

## Use Cases

The hierarchy maps naturally to the worktree development pattern:

```
dev/A/michael    ← Worktree A's Michael Scott instance
dev/A/dwight     ← Worktree A's Dwight Schrute instance
dev/B/michael    ← Worktree B's Michael Scott instance
e2e/A/michael    ← Worktree A's E2E test instance
```

Common operations:

- `GET ?prefix=dev/A` → list all of worktree A's agents
- `DELETE /v1/instances/dev/A` → nuke worktree A (e.g., on branch reset)
- `DELETE /v1/instances/e2e` → nuke all E2E test instances

## Related

- **Instances**: [instances.md](instances.md) — instance data model, CRUD, lifecycle
- **Railway Integration**: [railway-integration.md](railway-integration.md) — pool management, worker creation
