# Management UI

A single-file HTML dashboard served at `/ui` for inspecting instance state, viewing rolling logs, and performing management actions. No build step, no framework — just HTML + CSS + vanilla JS inlined in one file.

## Serving

`GET /ui` — Hono serves the HTML file directly. The file lives at `src/ui/dashboard.html` and is served as a static asset via `c.html()`.

## Layout

```
+-----------------------------------------------------------+
|  AAS Dashboard                              [Nuke All]     |
+----------------+------------------------------------------+
|                |                                           |
|  Instance      |  Main Area                                |
|  Tree          |  (Log Stream or Instance Detail)          |
|                |                                           |
|  dev/          |  +-- Log Stream -------------------------+|
|    A/          |  | dev/A/michael | message.start | ...   ||
|      michael   |  | dev/A/michael | assistant.1 | ...     ||
|      dwight    |  | dev/A/dwight | provision | ...        ||
|    B/          |  | dev/B/michael | message.done | ...    ||
|      michael   |  |                                       ||
|                |  |              [Auto-scroll ^]          ||
|                |  +---------------------------------------+|
|                |                                           |
|                |  +-- Send Message -----------------------+|
|                |  | Instance: [dev/A/michael    v]        ||
|                |  | Message:  [__________________ ]       ||
|                |  |                        [Send]         ||
|                |  +---------------------------------------+|
|                |                                           |
+----------------+------------------------------------------+
|  Connected *  | Instances: 16 | Ready: 8 | Deploying: 2   |
+-----------------------------------------------------------+
```

## Instance Tree (Left Sidebar)

Collapsible tree grouped by hierarchy prefix (slash-separated segments).

### Structure

- Each instance name is split by `/` to form a tree path
- Interior nodes (prefixes) are collapsible — click to expand/collapse
- Leaf nodes represent individual instances

### Instance Display

Each leaf node shows:
- **Name**: the leaf segment of the instance name (e.g., `michael` for `dev/A/michael`)
- **Status badge**: colored indicator reflecting current state

### Status Badges

| Badge | Status | Meaning |
|-------|--------|---------|
| Gray (pulsing) | `provisioning` | Railway service being created |
| Blue (pulsing) | `deploying` | Container deploying, waiting for health check |
| Green | `ready` | Worker is healthy and accepting messages |
| Orange | `unreachable` | Worker failed health checks (may recover) |
| Red | `error` | Provisioning failed or fatal error |
| Gray (fading) | `destroying` | Railway service being deleted |

### Interactions

- **Click leaf node** — show instance detail in main area (replaces log stream)
- **Click prefix node** — filter log stream to that prefix (client-side filter applied)
- **Tree auto-updates** — SSE log events include instance names; new instances appear automatically, status badges update in real-time

## Rolling Log Stream (Main Area, Default View)

Real-time rendering of server log lines, powered by the SSE log endpoint.

### Data Source

`GET /v1/logs` — SSE endpoint streaming structured log events.

### Log Line Format

```
{instanceName} | {event}.{turn} | {content}
```

### Color Coding

| Event | Color |
|-------|-------|
| `provision` | Blue |
| `deploy` | Cyan |
| `message.start` | Green |
| `error` | Red |
| `tool_use` | Yellow |
| `assistant` | White |

### Behavior

- **Auto-scroll**: Automatically scrolls to bottom as new lines arrive
- **Pause on scroll**: When the user scrolls up, auto-scroll pauses. A "Resume auto-scroll" indicator appears at the bottom. Clicking it or scrolling to the bottom re-enables auto-scroll.
- **Client-side filter**: Text input above the log stream. Typing a prefix filters visible log lines to those matching the prefix. Filter applies to both existing and incoming lines.
- **DOM limit**: Maximum 1000 log lines rendered in the DOM. Older lines are removed from the top as new ones arrive, preventing memory issues in long-running sessions.
- **Styling**: Monospace font, dark background (terminal aesthetic)

## Instance Detail (Main Area, On Click)

Displayed when clicking an instance leaf node in the tree. Replaces the log stream view (back button returns to log stream).

### Displayed Fields

| Field | Description |
|-------|-------------|
| Name | Full instance name (e.g., `dev/A/michael`) |
| Status | Current status with colored badge |
| Model | Claude model ID |
| maxTurns | Turn limit for invocations |
| maxBudgetUsd | Budget cap per invocation |
| Worker URL | Internal Railway URL (if available) |
| Railway Service ID | Railway service identifier |
| Provision Error | Error message (shown only if status is `error`) |
| System prompt | First 500 characters, with "Show more" to expand |
| MCP servers | List of configured MCP server names |
| Created at | Timestamp of instance provisioning |

### Worker Runtime Info (fetched from proxy)

When status is `ready`, the detail view fetches `/v1/instances/{name}/status` to display:

| Field | Description |
|-------|-------------|
| Session ID | Current SDK session ID |
| Uptime | Worker container uptime |
| Message count | Total messages processed |
| Total cost | Cumulative cost across all messages |
| Queue depth | Number of pending items in the worker queue |

### View History Button

When status is `ready`, a "View History" button fetches `/v1/instances/{name}/history` and displays the conversation history inline — each message shown with role, content, and timestamp.

## Actions

### 1. Nuke by Prefix

- **Trigger**: Button in sidebar header or instance detail view
- **Flow**:
  1. Opens confirm dialog: "Delete all instances under `{prefix}`? This will destroy their Railway services."
  2. On confirm, calls `DELETE /v1/instances/{prefix}`
  3. Shows result toast: "Deleted N instances"
  4. Tree auto-updates (instances transition to `destroying`, then disappear)

### 2. Send Message

- **Trigger**: "Send Message" panel at bottom of main area (always visible)
- **Flow**:
  1. Select instance from dropdown (only shows `ready` instances, or click instance in tree to pre-fill)
  2. Type message in text input
  3. Click "Send" (or press Enter)
  4. Calls `POST /v1/instances/{name}/message` with the message
  5. Response streams inline below the input as SSE events arrive
  6. Shows: assistant text, tool calls, final summary

### 3. Nuke All

- **Trigger**: Button in top-right header
- **Flow**:
  1. Double-confirm dialog: "Delete ALL instances? This will destroy all Railway worker services."
  2. On confirm, calls `DELETE /v1/instances` (or nuke with empty prefix)
  3. Shows result toast: "Deleted N instances"
  4. Tree clears completely

## Status Bar (Bottom)

Persistent bar across the bottom of the dashboard.

| Element | Description |
|---------|-------------|
| Connection indicator | Green dot + "Connected" when SSE stream is active; red dot + "Disconnected" when not |
| Instance count | Total number of provisioned instances |
| Ready count | Instances with `ready` status |
| Deploying count | Instances with `provisioning` or `deploying` status |

All counts auto-update via SSE events.

## SSE Log Endpoint (`GET /v1/logs`)

Server-side endpoint that streams all log lines as SSE events.

### Event Format

- **Event type**: `log`
- **Data**: JSON object

```json
{
  "timestamp": "2026-02-14T10:30:00.000Z",
  "instanceName": "dev/A/michael",
  "event": "message.start",
  "turn": 1,
  "content": "Processing user message..."
}
```

### Query Parameters

| Param | Type | Description |
|-------|------|-------------|
| `prefix` | string (optional) | Server-side filter — only stream logs for instances matching this prefix |

### Keepalive

Sends SSE comment (`: keepalive`) every 30 seconds to prevent connection timeout.

## Responsive Behavior

- Sidebar is collapsible on narrow screens (hamburger menu toggle)
- When sidebar is hidden, log stream takes full width
- Send message section remains visible at the bottom regardless of viewport size

## Related

- **Telemetry**: [telemetry.md](telemetry.md) — log format and structured logging conventions
- **Instances**: [instances.md](instances.md) — instance data model, CRUD operations
- **Messaging**: [invocation.md](invocation.md) — message endpoint, SSE event streaming
- **Worker API**: [worker-api.md](worker-api.md) — worker history and status endpoints
