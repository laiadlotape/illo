# illo-sidebar — v0.3 — deliberate-prompting workbench for Claude Code (and any HITL agent)

![CI](https://github.com/laiadlotape/illo/actions/workflows/ci.yml/badge.svg) ![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg) ![Node](https://img.shields.io/badge/node-%E2%89%A5%2020.x-339933) ![Plugin](https://img.shields.io/badge/plugin-v0.3.0-f7b955)

A Claude Code plugin (and standalone local daemon) whose default surface is a
**prompt notepad** that lives in a tmux split next to the Claude pane. Compose
your prompt deliberately, review it twice, then hand it off to Claude via
`tmux send-keys` — without auto-pressing Enter. The notepad also tails the
agent's pending-input events (questions, notifications, sends) so you can see
what Claude is waiting on without context-switching.

> Why a notepad? "Never prompt directly in chat. Write in an editor, read it
> twice, dehumanize it. You are configuring a system, not chatting with a
> colleague." — *FindingMemo*

A browser fallback (`/sb-web`) is still available for headless / remote use.

---

## What's new in v0.3

- **Prompt-notepad TUI** (default surface): events log on top (~1/3),
  full-feature compose buffer below (~2/3) with an in-house editor (cursor
  motion, undo/redo, word/line kills, auto-indent on Enter).
- **`Ctrl-S` sends to the claude pane** via `tmux send-keys -l` (literal
  text, no auto-Enter — the human reads once more in the destination pane
  and submits). `Ctrl-D` is "send + Enter" for when you've already
  re-read.
- **`Ctrl-E` opens `$EDITOR`** for long compositions; the buffer round-trips
  through a tmp file.
- **Auto-detection of the claude pane** in the current tmux window. Override
  with `/sb-attach <pane_id>`, clear with `/sb-detach`.
- **`POST /sent` + `sent` kind** in the protocol: every send is recorded in
  the event log so you can scroll back.
- **`paneOverride` daemon config**: persisted, broadcast over WS, exposed in
  `/state` and `/protocol`.

## What's still here from v0.2

- **CLI-native TUI sidebar** (default) — opens in a tmux split via `/sb`.
  Browser UI moved to optional `/sb-web` fallback.
- **Generic protocol** — `POST /event` accepts events from Claude Code,
  LangGraph, CrewAI, OpenAI Codex, Aider, Cursor, OpenAI Agents SDK, or any
  custom script. The full v0.1 envelope is still accepted unchanged.
- **Urgency tiers** — `urgency: low | normal | urgent`. Re-warn cadence scales
  with urgency (0.5× for urgent, 4× for low). Urgent items flash inline in the
  TUI and also trigger browser desktop notifications (when using `/sb-web`).
- **Snooze** — per-item snooze with presets (5 m / 15 m / 1 h / 4 h). Snoozed
  items appear in a dedicated filter view and re-surface automatically.
- **Quick reply** — type a reply directly in the sidebar; `Cmd/Ctrl+Enter` sends
  it. The daemon writes `pending_resume.json` with `user_reply_text` so the
  agent's hook can inject it into the next turn.
- **Transcript snapshots** — attach the last N lines of the agent's transcript to
  any event. A collapsible `<details>` expander in the sidebar shows the context.
- **Stats page** — `/stats.html` shows total items, by-kind breakdown, by-agent
  breakdown, median and p95 time-to-resolve, dismissal rate, and top recurring
  titles. History stored in `node:sqlite` (Node 22+) or JSONL fallback.
- **Mobile push** — opt-in ntfy.sh and Pushover integration. After
  `afk_threshold_seconds` without focus, the daemon pushes a notification with a
  single-use reply link. See `docs/push.md`.
- **Demo mode** — `bin/illo-demo.sh` runs scripted scenarios against the live
  daemon at any speed multiplier. Three scenarios ship: `typical`, `multi-agent`,
  `chaotic`.
- **VCR** — `bin/illo-vcr.sh` records and replays event streams for debugging
  and reproducible demos.
- **Python + TypeScript SDKs** — thin stdlib-only reference clients in `sdks/`.
  No `pip install` needed; drop the file onto `PYTHONPATH`.

---

## How it works

illo is built around the principle from [FindingMemo](https://github.com/lotape6/FindingMemo/blob/master/lessons/00-introduction/deck.md):

> **Never prompt directly in chat.** Write in an editor, read it twice, dehumanize it. You are configuring a system, not chatting with a colleague.

Two tmux panes side by side: the Claude session on the left, illo on the right. illo is your **prompt notepad** plus a live event log of what Claude has been doing. You compose your prompt deliberately in illo's editor, press a hotkey to inject it into the Claude pane (via `tmux send-keys`) and focus that pane — illo does **not** auto-press Enter, so you read the prompt once more in its destination before committing.

```
┌─────────────────────────────┬────────────────────────────────────────┐
│                             │ illo · pane: claude(%4)         ●      │  status bar
│  Claude session             ├────────────────────────────────────────┤
│  (claude CLI in tmux pane)  │ events  · [v] verbose  · [x] clear     │  event log
│                             │   12:30 · ask_user · "Drop users_old?" │  (questions /
│  > _ (cursor here after     │   12:31 · sent     · "Drop it. Backup" │   notifications /
│      illo sends)            │   12:33 · stop     · waiting…          │   sent prompts)
│                             ├────────────────────────────────────────┤
│                             │ ┌─ compose ──── lines: 4 · words: 23 ─┐│  multi-line editor
│                             │ │ Claude, after looking at the script,│ │  arrows / Home / End
│                             │ │   1. Verify backup at /backups/…    │ │  Backspace / Ctrl-W
│                             │ │   2. Run rollback if mismatch█      │ │  Ctrl-Z undo (2s groups)
│                             │ └─────────────────────────────────────┘ │  Ctrl-E → $EDITOR
│                             │ Ctrl-S send · Ctrl-D send+Enter · …    │  hotkey hint
└─────────────────────────────┴────────────────────────────────────────┘
```

### The send loop (deliberate prompting)

```
You compose in illo's editor (free editing, undo, $EDITOR escape)
                │
                │   Ctrl-S
                v
  bin/tmux-send.sh  →  tmux send-keys -l <text>      (literal mode, no Enter)
                                  +
                       tmux select-pane              (focus jumps to Claude pane)
                │
                │   you read the prompt one more time in its destination
                │   you press Enter yourself
                v
  Claude receives the prompt and starts working
                │
                │   AskUserQuestion / Notification / tool calls fire hooks
                v
  hooks → POST /event → daemon → broadcast → illo event log refreshes
                │
                │   you watch the timeline build up; pick the next prompt
                v
  back to compose (Ctrl-R re-loads the last sent prompt for refinement)
```

### Event capture (the v0.2 plumbing, unchanged)

Every event Claude (or any other agent framework) generates flows through the daemon and lands in the event log:

```
Any agent framework
  Claude Code / LangGraph / CrewAI / Codex / Aider / Cursor / custom script
           │
           │  POST /event   (envelope: kind, agent_kind, urgency,
           │                 transcript_snapshot, project / git_branch / cwd, …)
           v
  daemon/server.js   (Node 20+, stdlib only, 127.0.0.1:7821)
           │
           │  normalise → persist (state.json + sqlite or JSONL history)
           │  broadcast via WebSocket
           v
  illo TUI event log   ←   browser fallback /sb-web (optional)
```

### Resume / quick-reply (still available, secondary to the editor)

If a captured `ask_user` or `notification` arrived while you were doing something else, you can answer it from inside illo without composing a fresh prompt: select the event in the log, press `r` to inject a one-line reply via `/items/:id/reply`. The daemon writes `pending_resume_<sessionId>.json`; the next `UserPromptSubmit` hook in that Claude session injects the original question's context — you don't have to retype it.

This path is optimised for short corrective replies. The default workflow is **compose deliberately in the editor, send via Ctrl-S, watch the response land in the event log.**

---

## Install

**Requirements:** Node 20+, `curl`, `jq`.

1. Clone or download this repository anywhere on your machine.

2. Install the plugin into Claude Code:

   ```bash
   /plugin install /path/to/illo
   ```

3. Register the hooks in `~/.claude/settings.json`:

   ```json
   {
     "plugins": ["illo-sidebar"],
     "hooks": {
       "hooksJsonPath": "/path/to/illo/hooks/hooks.json"
     }
   }
   ```

   If you already have a `hooksJsonPath` entry, merge the hook entries from
   `hooks/hooks.json` into your existing file manually.

4. Verify Node is on your `PATH`:

   ```bash
   node --version   # 20.x or newer
   ```

   The daemon starts on demand on the first hook that fires; no separate install
   step is needed.

---

## Quick start

1. Open a Claude Code session **inside a tmux window** (the prompt notepad
   needs a tmux pane to send to). Make sure your `claude` session is the
   foreground command of one of the panes.

2. Run the slash command to open the sidebar:

   ```
   /sb
   ```

   **Inside tmux:** a 40%-wide vertical split opens on the right running the
   prompt-notepad TUI. The status bar shows the auto-detected pane id
   (e.g. `pane: %4`). Switch to it with `Prefix → o`.

   **Compose** your prompt in the lower box. `Ctrl-S` sends it (literal
   text) into the claude pane and focuses the pane so you can re-read and
   submit. `Ctrl-D` does the same plus auto-Enter. `Ctrl-E` opens
   `$EDITOR` for longer drafts. `Ctrl-Q` quits. Full keybinding table at
   `docs/tui.md`.

   The **events log** at the top tails Claude's pending-input items
   (questions, notifications, your past sends). Press `Ctrl-Up` to focus
   it, `j`/`k` to scroll, `v` to flip between low-noise and verbose,
   `Enter` to open a detail modal, `Ctrl-Down` to return to compose.

   **Outside tmux:** the command prints clear guidance — start tmux and
   re-run `/sb`, launch the TUI manually with
   `node "$CLAUDE_PLUGIN_ROOT/bin/illo-tui.js"`, or use `/sb-web` for the
   browser fallback.

3. If auto-detection picks the wrong claude pane (or none), pin one with
   `/sb-attach %N`. `/sb-detach` returns to auto-detection.

4. Ask Claude to do a multi-step task that triggers `AskUserQuestion`. The
   event log shows the question; compose your reply in the notepad and
   `Ctrl-S` it into the claude pane.

**Push a fake event for testing (no Claude required):**

```bash
PORT=$(cat ~/.claude/illo-sidebar/daemon.port)
curl -sX POST -H 'Content-Type: application/json' \
  -d '{"kind":"ask_user","session_id":"demo","tool_input":{"questions":[{"question":"Approve deploy?","options":[{"label":"Yes"},{"label":"No"}]}]},"urgency":"urgent","transcript_snapshot":"last 3 lines of context here"}' \
  http://127.0.0.1:$PORT/event
```

---

## Slash commands

| Command | What it does |
|---|---|
| `/sb` | Opens the prompt-notepad TUI in a tmux split (or guides you to open it). Default sidebar surface. |
| `/sb-tui` | Alias for `/sb`. |
| `/sb-attach <pane_id>` | Override the auto-detected claude pane. Use when detection picks the wrong pane (or you have multiple claude sessions). Example: `/sb-attach %4`. |
| `/sb-detach` | Clear the pane override and return to auto-detection. |
| `/sb-web` | Opens the browser UI fallback (~420 px wide window). Use when you can't use tmux or prefer the GUI. The browser surface still uses the v0.2 list view; prompt-notepad parity is tracked separately. |
| `/sb-resume [item_id]` | With no argument, lists all unresolved items. With an id, marks it as the resume target. |
| `/sb-status` | Prints daemon port, healthz response, total item count, and unresolved count. |

Example `/sb-status` output:

```
daemon port: 7821  {"ok":true,"version":"0.3.0"}
config: { warnIntervalSeconds: 300, warnStyle: 'pulse', paneOverride: null }
total items: 6  pending: 2
```

---

## Settings

All `userConfig` fields live in `.claude-plugin/plugin.json` and can be
overridden by environment variables. The settings panel (gear icon in the
header) lets you edit `warnIntervalSeconds` and `warnStyle` live.

| Field | Default | Meaning |
|---|---|---|
| `warnIntervalSeconds` | `300` | Seconds between re-warn animations on an unacknowledged item. 0 disables re-warn. |
| `daemonPort` | `7821` | Localhost port the daemon binds to. Auto-increments if taken (up to +20). Actual port written to `daemon.port`. |
| `autoOpenSidebar` | `true` | Open the sidebar automatically on `SessionStart`. With the TUI default, this is a no-op outside tmux unless `ILLO_SIDEBAR_AUTO_TERMINAL` is set; for the browser fallback, see `/sb-web`. |
| `browserCommand` | `""` | Browser launcher used by `/sb-web` only. Empty = autodetect: chrome, chromium, brave, edge, firefox. |
| `warnStyle` | `"pulse"` | CSS animation for re-warn: `pulse`, `blink`, `glow`, `none`. |
| `pushProvider` | `"off"` | Mobile push provider: `ntfy`, `pushover`, or `off`. Disabled by default. |
| `pushNtfyTopic` | `""` | ntfy.sh topic name (only used when `pushProvider=ntfy`). |
| `pushNtfyServer` | `"https://ntfy.sh"` | ntfy server base URL (self-host capable). |
| `pushAfkThresholdSeconds` | `120` | Push items pending this long without focus. |

Environment variable overrides (take precedence over the file):

| Variable | Equivalent field |
|---|---|
| `ILLO_SIDEBAR_PORT` | `daemonPort` |
| `ILLO_SIDEBAR_WARN_INTERVAL_S` | `warnIntervalSeconds` |
| `ILLO_SIDEBAR_WARN_STYLE` | `warnStyle` |
| `ILLO_SIDEBAR_BROWSER` | `browserCommand` |
| `ILLO_SIDEBAR_HOME` | State directory (default: `~/.claude/illo-sidebar`) |
| `ILLO_SIDEBAR_AUTO_TERMINAL` | If set (e.g. `gnome-terminal`, `kitty`, `alacritty`, `wezterm`, `xterm`), `/sb` outside tmux spawns the TUI in that terminal. Default: empty (no auto-spawn). |
| `ILLO_SIDEBAR_PUSH_PUSHOVER_TOKEN` | Pushover app token (avoids sending over HTTP) |

---

## Sidebar UI

### Sidebar TUI (default)

Opens in a tmux split via `/sb`. Renders with pure ANSI escape codes — zero
npm deps.

- **Selection model** — the `▶` marker tracks the focused item; navigate with
  `j`/`k`.
- **Urgency badge** — `[urgent]` / `[normal]` / `[low]` displayed per item.
  Urgent items are red-tinted; low items are dimmed.
- **Agent identity line** — `agent_kind · session_id.slice(0,8)`.
- **Snooze badge** — `[snoozed Nm]` shown on snoozed items; opacity reduced.
- **Transcript context** — press `c` to expand the snapshot; scroll with
  `,` / `.`.
- **Reply mode** — press `r`; the bottom bar becomes an inline text input
  prefixed `reply: `. Press `Enter` to submit, `Esc` to cancel.
- **Snooze picker** — press `s`; choose `[1] 5m  [2] 15m  [3] 1h  [4] 4h`.
- **Filter overlay** — press `/`; then `(a)gent`, `(u)rgency`, `(k)ind`, or
  `(c)lear`.
- **Box mode** — press `b` to collapse to a one-line summary (`illo · N
  pending [urgent×N …] ●`).
- **Reconnect loop** — prints `[reconnecting…]` in the header and retries
  every second if the daemon disconnects.
- **Quit** — press `q` or `Ctrl-C`; restores the terminal cleanly (alt-screen
  off + cursor restore).

Urgency also affects re-warn cadence:

- `low` → 4× the base interval
- `normal` → 1× base interval
- `urgent` → 0.5× base interval (re-warns twice as often)

Snooze via HTTP (works for both TUI and browser fallback):

```bash
curl -sX POST -H 'Content-Type: application/json' \
  -d '{"seconds": 900}' \
  http://127.0.0.1:$PORT/items/$ITEM_ID/snooze
```

For the full keybinding reference see `docs/tui.md`.

### Browser fallback (`/sb-web`)

If you prefer a GUI, can't use tmux, or want the `/stats.html` dashboard, run
`/sb-web`. The browser window is ~420 px wide and uses the same daemon
WebSocket feed.

#### Modes

- **Full** (`data-mode="full"`): header bar + scrollable item list. Default.
- **Compact box** (`data-mode="box"`): header and list hidden; a small pill
  shows the count of unresolved items. Pulses continuously when items are
  pending.

Toggle with the **"box"/"list" button** or press **`b`** (window-local).

#### Item card anatomy

Each card shows:

- Kind label (`ask user`, `notification`, `custom`, `idle`)
- Urgency badge (`low`, `normal`, `urgent`)
- Agent identity line (`agentKind · sessionId[:8]`) — hidden for generic items
- Title and snippet
- Elapsed time (live-updated every second)
- Transcript snapshot expander (collapsible `<details>`) if `transcript_snapshot` was sent
- Snooze badge (shows remaining time when snoozed)
- Action row: `resume here`, `acknowledge`, `snooze ▾`, `×` dismiss
- Quick reply textarea (hidden when `quick_reply_enabled: false`)

#### Quick reply

Items with `quick_reply_enabled: true` (the default) show a textarea at the
bottom of the card. Type a reply and press `Cmd/Ctrl+Enter` (or click "send").
The daemon:

1. Writes `pending_resume.json` with `user_reply_text`.
2. Marks the item `replied: true, resolved: true, focused: true`.
3. Broadcasts `item:update`.

The UI hides the textarea and shows a `[replied] <text>` pill. The
`UserPromptSubmit` hook picks up the reply on the next prompt.

Disable quick reply for an item by sending `"quick_reply_enabled": false` in
the event envelope.

#### Filter chips

The filter row offers:

- `all` / `pending` / `snoozed` — base visibility mode
- `by urgency ▾` — dropdown to filter by `low`, `normal`, `urgent`, or `any`
- `by kind ▾` — dropdown to filter by `ask_user`, `notification`, `custom`,
  `idle`, or `any`
- `by agent ▾` — dropdown populated dynamically from item `agentKind` values

#### Transcript snapshot expander

When an item has a `transcriptSnapshot`, a `<details class="transcript-expander">`
element is visible below the snippet. Click the summary to expand; the raw text
appears in a `<pre>`. This lets you see what the agent was doing at the moment
it paused.

#### Browser notifications

Items with `urgency: urgent` trigger `new Notification(title, {...})` when the
sidebar receives the `item:add` WebSocket message. The browser must have
granted notification permission. The "notif: on/off" button in the header
toggles the feature (persisted in `localStorage`). In headless CI environments
(no browser permission), notifications are silently skipped.

#### Stats page

Click the `stats` link in the header (or navigate to `/stats.html`).

Shows:

- Summary cards: total items, median resolve time, p95 resolve time, dismissal
  rate, window (default 7 days).
- `by kind` bar chart.
- `by agent kind` bar chart.
- Top recurring titles (items with the same title appearing more than once).

Data comes from the history sink (`node:sqlite` on Node 22+ or JSONL fallback).
Pass `?days=N` to `/stats` to change the window.

---

## The resume flow in detail

When the user clicks "resume here" or submits a quick reply:

1. `POST /items/:id/resume` or `POST /items/:id/reply` — daemon writes
   `~/.claude/illo-sidebar/pending_resume.json`:

   ```json
   {
     "id": "itm_<sha1>",
     "title": "<first question>",
     "snippet": "<options>",
     "original_payload": "{\"questions\":[...]}",
     "user_reply_text": "yes please",
     "ts": "2026-05-06T12:00:00.000Z"
   }
   ```

2. The user types any text in the Claude CLI and submits. The
   `UserPromptSubmit` hook fires `bin/on-user-prompt.sh`.

3. `on-user-prompt.sh` reads and deletes the resume file, then emits
   `hookSpecificOutput.additionalContext` so Claude Code prepends the original
   context to the turn.

4. The `sidebar-coordinator` skill instructs Claude not to re-ask the question.

If `pending_resume.json` does not exist, the hook exits 0 and emits nothing.

---

## Mobile push

See `docs/push.md` for full setup instructions. Summary:

- Off by default. Enable via `POST /config/push`.
- Supported providers: **ntfy.sh** (no account required for public server) and
  **Pushover** ($5 one-time purchase).
- After `afk_threshold_seconds` (default 120) with an unacknowledged item, the
  daemon sends a push notification with a single-use reply link.
- The reply link opens a mobile-friendly page; submitting it calls
  `POST /reply-from-push-submit`, which writes `pending_resume.json` and marks
  the item replied.

Quick ntfy setup:

```bash
curl -sX POST http://127.0.0.1:7821/config/push \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true,"provider":"ntfy","ntfy_topic":"illo-sidebar-yourname-7f3a","afk_threshold_seconds":120}'
```

---

## Demo and VCR

### Demo mode

```bash
bin/illo-demo.sh --list                         # list available scenarios
bin/illo-demo.sh --scenario typical --speed 5   # run at 5× speed
bin/illo-demo.sh --scenario chaotic --speed 20  # run at 20× speed
```

Scenario files live in `bin/demo-scenarios/*.jsonl`. Each line is either an
event (`{"after_ms": N, "event": {...}}`) or an action on a created item
(`{"after_ms": N, "action": "focus|snooze|reply", "by_index": 0}`).

### VCR record/replay

```bash
PORT=$(cat ~/.claude/illo-sidebar/daemon.port)

# Start recording
bin/illo-vcr.sh record start

# ... run your agent, fire real events ...

# Stop and name the recording
bin/illo-vcr.sh record stop my-session

# List recordings
bin/illo-vcr.sh list

# Replay at 10× speed
bin/illo-vcr.sh replay my-session --speed 10
```

The VCR writes to `$STATE_DIR/vcr/<name>.jsonl`. On replay all events are
injected with `agent_id` set to the `into_session` name (default: `vcr-replay`)
so replayed items are distinguishable in `/state`.

---

## SDKs

See `sdks/README.md` for full API reference. Both SDKs are single-file, no
third-party dependencies.

### Python — `sdks/python/illo_sidebar.py`

```python
import sys
sys.path.insert(0, '/path/to/illo/sdks/python')
from illo_sidebar import IlloSidebar

client = IlloSidebar(
    port=7821,
    agent_id="my-langgraph-agent",
    agent_kind="langgraph",
    session_id="thread-44",
)

client.ask(
    "Approve deploy to production?",
    options=["yes", "no"],
    urgency="urgent",
    transcript=last_40_lines,
)
client.notify("Build complete.", urgency="low")
client.custom(title="Approval needed", payload={"node": "cleanup"})
client.heartbeat()
```

Errors are swallowed by default (`raise_on_error=False`). Pass
`raise_on_error=True` to get exceptions for debugging.

### TypeScript — `sdks/typescript/illo-sidebar.ts`

```ts
import { IlloSidebar } from "./illo-sidebar";

const c = new IlloSidebar({
  port: 7821,
  agentId: "my-codex-agent",
  agentKind: "codex",
  sessionId: "run-99",
});

await c.ask({
  question: "Approve `rm -rf node_modules && npm i`?",
  options: ["yes", "no"],
  urgency: "urgent",
});
await c.notify({ message: "Done." });
await c.heartbeat();
```

---

## Protocol

See `docs/protocol.md` for the full contract. Summary:

The v0.2 envelope is a strict superset of v0.1. Every field except `kind` is
optional; the daemon fills sensible defaults. New fields in v0.2: `agent_id`,
`agent_kind`, `urgency` (`low | normal | urgent`), `transcript_snapshot`,
`quick_reply_enabled`, `subkind`, `payload`, `title` (override), `snippet`
(override). Items receive corresponding normalized fields (`agentId`,
`agentKind`, `urgency`, `transcriptSnapshot`, `quickReplyEnabled`,
`snoozedUntil`, `replied`) with defaults, so v0.1 consumers ignore them.

`GET /protocol` returns the live version, supported `kind`s, `agent_kind`s,
`urgency` values, and endpoint list — useful for SDK version negotiation.

---

## Files in this plugin

```
illo/
├── .claude-plugin/
│   ├── plugin.json          # manifest, userConfig schema (v0.3)
│   └── marketplace.json     # local marketplace entry (v0.3)
├── bin/
│   ├── illo-tui.js          # v0.3 prompt-notepad TUI (default surface)
│   ├── open-sidebar.sh      # TUI router: tmux split + claude-pane discovery
│   ├── open-sidebar-web.sh  # browser fallback launcher (used by /sb-web)
│   ├── _tmux.sh             # tmux helpers (sourced): pane discovery + send-keys
│   ├── tmux-send.sh         # CLI wrapper around _tmux.sh (used by the TUI)
│   ├── _lib.sh              # shared helpers: daemon_port, ensure_daemon, push_event
│   ├── _snapshot.sh         # transcript snapshot helpers
│   ├── on-ask-user.sh       # PreToolUse AskUserQuestion → POST /event ask_user
│   ├── on-ask-user-answered.sh  # PostToolUse AskUserQuestion → ask_user_answered
│   ├── on-notification.sh   # Notification hook → POST /event notification
│   ├── on-pre-tool.sh       # PreToolUse catch-all (forward compat)
│   ├── on-session-start.sh  # SessionStart → session_start
│   ├── on-session-end.sh    # SessionEnd → session_end
│   ├── on-stop.sh           # Stop hook → stop
│   ├── on-user-prompt.sh    # UserPromptSubmit → resume injection
│   ├── notify-tray.sh       # desktop tray notification helper
│   ├── start-daemon.sh      # explicit daemon start helper
│   ├── illo-demo.sh         # scripted demo runner
│   ├── illo-vcr.sh          # VCR record/replay CLI
│   └── demo-scenarios/
│       ├── typical.jsonl    # 5-step typical session
│       ├── multi-agent.jsonl # multi-agent interleaved scenario
│       └── chaotic.jsonl    # rapid multi-agent chaos scenario
├── commands/
│   ├── sb.md                # /sb (TUI default)
│   ├── sb-tui.md            # alias for /sb
│   ├── sb-attach.md         # /sb-attach <pane_id> — override claude-pane discovery
│   ├── sb-detach.md         # /sb-detach — clear the override
│   ├── sb-web.md            # /sb-web browser fallback
│   ├── sb-resume.md         # /sb-resume slash command
│   └── sb-status.md         # /sb-status slash command
├── daemon/
│   └── server.js            # Node 20+ stdlib HTTP+WS server, zero npm deps
├── docs/
│   ├── protocol.md          # v0.2 protocol contract (read-only reference)
│   ├── push.md              # mobile push setup guide (ntfy + Pushover)
│   └── tui.md               # TUI quick-start + keybindings
├── hooks/
│   └── hooks.json           # hook wiring for Claude Code settings.json
├── sdks/
│   ├── README.md            # SDK usage and API reference
│   ├── python/
│   │   └── illo_sidebar.py  # stdlib-only Python client (~120 lines)
│   └── typescript/
│       └── illo-sidebar.ts  # fetch-based TypeScript client (~110 lines)
├── skills/
│   └── sidebar-coordinator/
│       └── SKILL.md         # guidance for Claude on resume flow
├── tests/
│   ├── server.test.mjs      # node:test unit tests (in-process)
│   ├── dogfood.sh           # HTTP integration smoke test (incl. /sent + paneOverride)
│   ├── sdk_python.test.sh   # Python SDK integration test
│   ├── integration.test.sh  # demo + VCR integration smoke test
│   ├── tui.test.sh          # TUI smoke test (--no-tty headless mode)
│   ├── tmux-helper.test.sh  # bin/_tmux.sh + bin/tmux-send.sh shape tests
│   ├── ux.spec.js           # Playwright E2E tests (v0.1 + v0.2 UI)
│   ├── _helper.mjs          # test env setup helper
│   ├── playwright.config.js # Playwright configuration
│   └── package.json         # test scripts + @playwright/test dep
└── ui/                      # browser fallback (used by /sb-web only)
    ├── index.html           # sidebar markup, item template (v0.2 elements)
    ├── app.js               # WebSocket client, render loop, actions (v0.2)
    ├── stats.html           # stats page
    ├── stats.js             # stats page data fetching and chart rendering
    └── style.css            # dark theme, warn animations, box mode, v0.2 UI
```

---

## Limitations

- **TUI requires tmux for in-place split.** Outside tmux, `/sb` prints
  instructions; set `ILLO_SIDEBAR_AUTO_TERMINAL` to auto-spawn in a known
  terminal emulator, or use `/sb-web`.

- **No global OS keyboard shortcut.** The `b` key binding works only when the
  sidebar window has focus (TUI pane or browser window).

- **Cannot focus the terminal from the browser.** After clicking "resume here"
  in `/sb-web`, the user must manually switch to the Claude CLI window.

- **Daemon is per-user, not per-session.** All Claude Code sessions on the
  machine share one daemon instance and one item list. Items are tagged with
  `sessionId` but the UI shows everything.

- **AskUserQuestion hook detection depends on Claude Code version.** The
  `hooks.json` registers a `PreToolUse` hook with `matcher: "AskUserQuestion"`
  and a catch-all `matcher: ".*"`. If a future Claude Code version renames
  AskUserQuestion, the catch-all in `on-pre-tool.sh` provides a fallback.

- **Daemon port conflict.** If ports 7821–7841 are all taken, the daemon exits.
  Check `~/.claude/illo-sidebar/daemon.log`.

- **Firefox does not support `--app` mode.** Chromium-family browsers are
  strongly preferred for `/sb-web`.

- **`/sb-web` browser window position is heuristic.** `open-sidebar-web.sh`
  hard-codes position `(1920 - 420 - 8, 8)` for a 1080p display. Reposition
  via your window manager.

- **Mobile push is opt-in and uses external services.** ntfy.sh topics are
  public by default; use a long, random topic name. Pushover requires a paid
  app ($5 one-time). No data leaves your machine until you explicitly enable
  push via `POST /config/push`.

- **sqlite history requires Node 22+.** On Node 20/21, the history sink falls
  back to a JSONL file (`$STATE_DIR/history.jsonl`). The `/stats` endpoint
  works in both modes, but JSONL is slower on large histories.

- **No built-in auth on the local-bound daemon.** The daemon binds
  `127.0.0.1` only, so remote access is not possible without an explicit tunnel.
  Any local process can call the API without authentication. Do not expose the
  daemon port externally.

---

## Development

See `CLAUDE.md` for model-routing rules and hard constraints:

- Daemon must be zero-dep (Node stdlib only).
- Hooks must never block Claude on daemon errors — every script exits 0.
- Daemon binds 127.0.0.1 only.
- No telemetry, no remote calls.
- Every change must pass the dogfood demo before being reported as done.

### Test scripts

```bash
cd tests

npm run test:unit          # node:test in-process unit tests
npm run test:dogfood       # full HTTP API smoke test (bash + curl + jq)
npm run test:sdk-python    # Python SDK round-trip test (requires python3)
npm run test:integration   # demo + VCR integration smoke (requires python3, bc)
npm run test:tui           # TUI smoke test (--no-tty headless mode)
npm run test:ux            # Playwright E2E (requires: npx playwright install chromium)
npm run test:all           # all six in sequence
```

`bin/illo-vcr.sh` had a quoting bug on replay (the endpoint produced
malformed JSON); this is now fixed and replays produce valid JSON that the
daemon accepts correctly.

### Dogfood mandate

Before reporting a plugin change as "done", run the end-to-end demo (from
`CLAUDE.md`):

```bash
node daemon/server.js &
sleep 0.5
PORT=$(cat ~/.claude/illo-sidebar/daemon.port)
curl -sS -X POST -H 'Content-Type: application/json' \
  -d '{"kind":"ask_user","session_id":"demo","tool_input":{"questions":[{"question":"Approve deploy?","options":[{"label":"Yes"},{"label":"No"}]}]}}' \
  http://127.0.0.1:$PORT/event
curl -sS http://127.0.0.1:$PORT/state | jq '.items'
```

Or use the faster dogfood script:

```bash
tests/dogfood.sh
```
