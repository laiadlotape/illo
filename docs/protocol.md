# illo-sidebar protocol — v0.3.0

The illo-sidebar daemon is a **generic agent inbox**. Any agent framework
(Claude Code, LangGraph, CrewAI, OpenAI Codex, Aider, Cursor, OpenAI Agents
SDK, or a custom script) can push events to it via `POST /event`. The daemon
normalizes those events into items and surfaces them in a persistent local
sidebar UI.

This document is the contract. SDKs in `sdks/python/` and `sdks/typescript/`
target this contract.

- Daemon binds **127.0.0.1 only**. No telemetry, no remote calls.
- Zero npm dependencies (Node stdlib only).
- Hooks must never block the calling agent on errors.

---

## Versioning

| Protocol | Daemon | Hooks compatibility |
|---|---|---|
| `0.1.0` | original v0.1 envelope | preserved — every v0.1 event still produces an identical item |
| `0.2.0` | generic-inbox envelope | strict superset of v0.1 |
| `0.3.0` | this document | adds `sent` kind, `POST /sent`, `POST /config/pane-override`, `paneOverride` config — all backward-compatible |

`GET /protocol` returns the live version and supported enums so SDKs can
negotiate.

---

## Event envelope (POST /event)

Every event is a JSON object with the following fields. All fields except
`kind` are optional; sensible defaults are filled in by the daemon.

```jsonc
{
  "kind":            "ask_user|notification|stop|session_start|session_end|ask_user_answered|user_prompt|custom|sent|heartbeat",
  "agent_id":        "string  (e.g. 'claude-code:abc123', 'langgraph:graph-7', 'codex:run-99')",
  "agent_kind":      "claude-code|langgraph|crewai|codex|aider|cursor|openai-agents|generic",
  "session_id":      "string  (optional; used to group items and to resolve ask_user_answered)",
  "title":           "string  (optional override; if absent we derive from kind+payload)",
  "snippet":         "string  (optional override)",
  "urgency":         "low|normal|urgent  (default: normal)",
  "transcript_snapshot": "string  (optional; freeform — typically last N lines of the agent's transcript)",
  "quick_reply_enabled": true,
  "subkind":         "string  (optional; e.g. 'permission_prompt', 'approval', 'confirm-shell')",
  "tool_input":      { /* existing — used by ask_user title/snippet derivation */ },
  "message":         "string  (existing — used by notification title)",
  "payload":         { /* arbitrary additional metadata */ },
  "ts":              "ISO8601  (optional; server fills if absent)",
  "cwd":             "string  (optional; absolute working directory of the agent process)",
  "project_name":    "string  (optional; basename of cwd; used for display in the sidebar)",
  "git_branch":      "string|null  (optional; current git branch in cwd, or null if not in a repo)",
  "git_worktree":    "string|null  (optional; absolute path of the git worktree root, from git rev-parse --show-toplevel)"
}
```

### Kind semantics

| `kind` | Behavior |
|---|---|
| `ask_user` | Creates an item. Title derived from `tool_input.questions[0].question` (truncated to 80 chars) unless `title` is provided. Snippet lists the options. |
| `notification` | Creates an item. Title is `message` (truncated to 100 chars) unless `title` is provided. If the title is a generic string (see "Smart title derivation for notifications" below), the daemon will attempt to derive a more useful title from `transcript_snapshot`. |
| `custom` | Creates an item. Title and snippet come from the envelope (`title`, `snippet`); `payload` is preserved verbatim. Use this for any framework-specific event the daemon doesn't natively understand. |
| `sent` | Creates an informational item recording a prompt the human handed off to the agent pane (typically via the v0.3 illo TUI's `Ctrl-S`). Marked `urgency: low`, `resolved: true`, `focused: true` immediately — never re-warns. Title is the first line of `text` (truncated to 80 chars); snippet is remaining lines joined with ` / `; `payload.text` carries the full text and `payload.paneId` records the destination pane. Convenience endpoint `POST /sent` wraps the same path. |
| `ask_user_answered` | Resolves the most recent unresolved `ask_user` item for the matching `session_id`. Creates no new item. |
| `user_prompt` | Resolves any unresolved `idle` items in this session. Creates no new item. |
| `session_start` / `session_end` / `stop` | Updates session state; creates no item. Broadcast as `{type:"session"}` to UI. |
| `heartbeat` | No-op liveness ping. Creates no item. |

---

## Item shape

The normalized item shape exposed via `GET /state`, `GET /ws` snapshot, and
the `item:add` / `item:update` WS messages:

```jsonc
{
  "id":              "itm_<sha1-12>",
  "kind":            "ask_user|notification|custom|idle|sent",
  "subkind":         "string|null",
  "sessionId":       "string|null",
  "agentId":         "string|null",
  "agentKind":       "string  (default: 'claude-code')",
  "urgency":         "low|normal|urgent",
  "title":           "string",
  "snippet":         "string",
  "payload":         "object|null",
  "transcriptSnapshot": "string|null",
  "quickReplyEnabled":  true,
  "snoozedUntil":    "number|null  (ms epoch)",
  "createdAt":       1730000000000,
  "lastWarnedAt":    1730000000000,
  "focused":         false,
  "resolved":        false,
  "replied":         false,
  "resolvedAt":      "number|null",
  "cwd":             "string|null  (absolute working directory of the originating agent process)",
  "projectName":     "string|null  (basename of cwd)",
  "gitBranch":       "string|null  (current git branch, or null if not in a repo)",
  "gitWorktree":     "string|null  (git worktree root path)"
}
```

### Smart title derivation for notifications

When a `notification` item's title matches one of these patterns (case-insensitive substring match):

- `"claude is waiting"`
- `"waiting for your input"`
- `"needs your attention"`

…and a non-empty `transcript_snapshot` is present, the daemon derives a more meaningful title:

1. Find the **last line** in the snapshot that starts with `assistant:` (case-insensitive). Strip the prefix and take the first 80 characters.
2. If no `assistant:` line exists, take the **last non-empty line** of the snapshot, trimmed, first 80 characters.
3. If the snapshot is empty or yields nothing, keep the original title unchanged.

The original (generic) title is always preserved in `payload.original_title` so consumers can access it.

---

## Endpoint reference

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | Liveness check, returns `{"ok":true,"version":"0.3.0"}` |
| `GET` | `/protocol` | Protocol metadata: version, supported `kind`s, `agent_kind`s, `urgency` values, endpoint list, history backend, `paneOverride` |
| `GET` | `/state` | Full snapshot: `{config, items[]}`. `config.paneOverride` carries the v0.3 TUI pane target. |
| `GET` | `/stats?days=7` | Aggregate stats over the last N days (default 7) — see below |
| `POST` | `/event` | Ingest an event (see envelope above) |
| `POST` | `/sent` | v0.3 convenience: body `{text, paneId?, session_id?, agent_kind?}` → creates a `kind:'sent'` item. Identical to posting `{kind:'sent', ...}` to `/event`. |
| `POST` | `/config` | Update `warnIntervalSeconds` / `warnStyle` live |
| `POST` | `/config/pane-override` | Body `{paneId: string|null}`. Sets/clears the pane id the v0.3 TUI sends to. Persisted to `state.json`; broadcast as `config` over WS. Empty string → clears. |
| `POST` | `/items/:id/focus` | Mark item focused (suppresses re-warn) |
| `POST` | `/items/:id/resume` | Write per-session `pending_resume_<sessionId>.json` (or global `pending_resume.json` if item has no `sessionId`), mark focused. Response includes `resumeFile` path. |
| `POST` | `/items/:id/reply` | Body `{"text": "..."}`. Writes per-session `pending_resume_<sessionId>.json` (or global fallback) with `user_reply_text`, marks item `replied: true, resolved: true, focused: true`. Fails 400 if `quickReplyEnabled === false`. Response includes `resumeFile` and `sessionId`. |
| `GET` | `/resume-targets` | List all currently-queued resume files. Returns `[{sessionId, itemId, title, queuedAt, filePath}, ...]`. Scans `$STATE_DIR` for `pending_resume*.json` files on each call. |
| `POST` | `/items/:id/snooze` | Body `{"seconds": 900}`. Sets `snoozedUntil = now + seconds*1000`; broadcast `item:update`. |
| `DELETE` | `/items/:id` | Remove item immediately (logged as `dismissed` in history) |
| `POST` | `/clear` | Remove all resolved items |
| `GET` | `/` (and assets) | Serve `ui/` static files |
| `WS` | `/ws` | WebSocket; server pushes `snapshot`, `item:add`, `item:update`, `item:remove`, `item:warn`, `config`, `cleared`, `session` |

### Per-session resume routing

When an item carries a `sessionId`, the `/resume` and `/reply` endpoints write
to a **per-session** file:

```
$STATE_DIR/pending_resume_<sessionId>.json
```

When the item has no `sessionId` (e.g. events from a non-Claude-Code agent SDK),
the legacy **global** file is used as a fallback for back-compat:

```
$STATE_DIR/pending_resume.json
```

The `UserPromptSubmit` hook (`bin/on-user-prompt.sh`) checks the per-session file
first (using the hook's own `session_id`), then falls back to the global file.
This ensures that with multiple Claude sessions running, only the correct session
consumes the queued reply.

#### Resume file shape

Both `/resume` and `/reply` write a JSON file with the following fields:

```jsonc
{
  "id":                "itm_...",
  "sessionId":         "string|null",
  "title":             "string",
  "snippet":           "string",
  "original_payload":  "stringified JSON of the item's payload",
  "user_reply_text":   "string  (only present on /reply)",
  "ts":                "ISO8601",
  "queuedAt":          1730000000000,
  "transcript_snapshot": "string|null  — last N lines of the agent transcript at the time the item was created",
  "project_name":      "string|null  — populated when the item carries projectName",
  "git_branch":        "string|null  — populated when the item carries gitBranch",
  "agent_kind":        "string|null  — e.g. 'claude-code', 'langgraph'"
}
```

The `UserPromptSubmit` hook uses these fields to build the `additionalContext`
block. The `transcript_snapshot` is capped to the last 80 lines and indented
4 spaces under a `recent_transcript: |` key. Optional fields (`agent_kind`,
`project_name`, `git_branch`) are omitted from the context block when empty.

`GET /resume-targets` lists all currently-queued resume files so the TUI can
surface delivery hints to the user.

### `paneOverride` config (v0.3)

`state.config.paneOverride` is a string (a tmux pane id like `"%4"`) or
`null`. The v0.3 illo TUI consults this on startup and on every `config`
broadcast:

- If non-null, the TUI uses it directly as the send target — no auto-discovery.
- If null, the TUI runs `bin/tmux-send.sh discover` (which delegates to
  `tmux list-panes` for the current window) and uses the first pane whose
  current command is `claude` or whose process tree contains `claude`.

Set via `POST /config/pane-override` (typically from the `/illo-attach`
slash command). Cleared by passing `{"paneId": null}`.

### Re-warn cadence

Re-warns fire once per second when an item meets all of:

- `!resolved && !focused`
- `!snoozedUntil || Date.now() >= snoozedUntil`
- `now - lastWarnedAt >= warnIntervalSeconds * 1000 * urgencyMultiplier(urgency)`

Where `urgencyMultiplier`:

- `low` → 4×
- `normal` → 1×
- `urgent` → 0.5×

### `/stats` response

```json
{
  "window_days": 7,
  "total_items": 123,
  "by_kind": { "ask_user": 80, "notification": 40, "custom": 3 },
  "by_agent_kind": { "claude-code": 100, "langgraph": 23 },
  "median_time_to_resolve_seconds": 47,
  "p95_time_to_resolve_seconds": 612,
  "dismissal_rate": 0.12,
  "top_recurring_titles": [ { "title": "...", "count": 9 } ],
  "history_backend": "jsonl"
}
```

History is stored in `node:sqlite` if available (Node 22+), otherwise in
`$STATE_DIR/history.jsonl` (one record per line). Fields written per
lifecycle event: `created`, `focused`, `snoozed`, `resolved`, `replied`,
`dismissed`.

---

## Backwards compatibility

- All v0.1 fields (`kind`, `session_id`, `tool_input`, `message`, `subkind`,
  `tool_response`, `prompt`) are still accepted.
- The v0.1 hook scripts still produce items with identical `id` semantics,
  identical `kind`, and identical title/snippet derivation.
- Items receive new fields (`agentId`, `agentKind`, `urgency`, `snoozedUntil`,
  `transcriptSnapshot`, `quickReplyEnabled`, `replied`) with defaults so any
  v0.1 consumer can ignore them.

---

## Examples

### `ask_user` (Claude Code hook)

```json
POST /event
{
  "kind": "ask_user",
  "agent_id": "claude-code:abc123",
  "agent_kind": "claude-code",
  "session_id": "abc123",
  "transcript_snapshot": "...last 40 lines of transcript JSONL...",
  "tool_input": {
    "questions": [
      { "question": "Approve deploy?", "options": [{ "label": "Yes" }, { "label": "No" }] }
    ]
  }
}
```

### `notification`

```json
POST /event
{
  "kind": "notification",
  "agent_id": "claude-code:abc123",
  "agent_kind": "claude-code",
  "session_id": "abc123",
  "subkind": "permission_prompt",
  "message": "May I write file X?",
  "urgency": "urgent"
}
```

### `custom` — LangGraph human-in-the-loop approval

```json
POST /event
{
  "kind": "custom",
  "agent_id": "langgraph:deploy-graph-7",
  "agent_kind": "langgraph",
  "session_id": "thread-44",
  "title": "LangGraph: approve tool call delete_user(id=2)",
  "snippet": "Node 'cleanup' wants to call delete_user. Approve to continue.",
  "urgency": "urgent",
  "payload": { "node": "cleanup", "tool": "delete_user", "args": { "id": 2 } }
}
```

### `custom` — Codex confirm-shell-cmd

```json
POST /event
{
  "kind": "custom",
  "agent_id": "codex:run-99",
  "agent_kind": "codex",
  "session_id": "run-99",
  "subkind": "confirm-shell",
  "title": "Codex wants to run: rm -rf node_modules && npm i",
  "urgency": "urgent",
  "quick_reply_enabled": true,
  "payload": { "command": "rm -rf node_modules && npm i", "cwd": "/repo" }
}
```

---

## SDKs

Two thin reference SDKs ship in `sdks/`. Both target this protocol exactly,
have **no dependencies** (Python: stdlib `urllib`; TypeScript: `fetch`), and
are intentionally short (~80 lines).

### Python — `sdks/python/illo_sidebar.py`

```python
from illo_sidebar import IlloSidebar

client = IlloSidebar(port=7821, agent_id="my-agent", agent_kind="langgraph")
client.ask("Approve deploy?", options=["yes", "no"], urgency="urgent",
           transcript=last_lines)
client.notify("Long-running task done", urgency="low")
client.heartbeat()
```

### TypeScript — `sdks/typescript/illo-sidebar.ts`

```ts
import { IlloSidebar } from "./illo-sidebar";

const c = new IlloSidebar({ port: 7821, agentId: "my-agent", agentKind: "codex" });
await c.ask({ question: "Approve deploy?", options: ["yes", "no"], urgency: "urgent" });
await c.notify({ message: "Done." });
await c.heartbeat();
```

Both clients hit the same `POST /event` route. Errors are silent by default
(matching the daemon-side hook contract that I/O failures must never block
the agent).
