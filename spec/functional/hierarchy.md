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

## Prefix Operations

| Operation | Behavior | Example |
|-----------|----------|---------|
| List by prefix | Returns all instances where name starts with `{prefix}/` OR exact match | `GET ?prefix=dev/A` → `dev/A/michael`, `dev/A/dwight`, etc. |
| Nuke by prefix | Deletes all matching prefix + exact, cancels active invocations, clears sessions | `DELETE /v1/instances/dev/A` → deletes all `dev/A/*` |
| Get exact | Returns single instance by exact name match | `GET /v1/instances/dev/A/michael` |

## Nuke Semantics

- DELETE on a path acts as "nuke" if the path matches a prefix (has children)
- All instances where name starts with `{path}/` are deleted, plus exact match on `{path}` itself
- Active invocations on nuked instances are cancelled immediately
- Sessions are cleared (no cleanup needed — in-memory only)
- Returns `{ deleted: N }` with count of deleted instances
- Idempotent: nuking a non-existent prefix returns `{ deleted: 0 }`

**Instant Readiness**: After nuke, the same names can be re-provisioned immediately. No cooldown, no cleanup delay.

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
