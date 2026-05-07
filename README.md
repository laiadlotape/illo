# illo

**A prompt notepad that lives next to Claude.** Write deliberately, review once more, then send — without auto-pressing Enter.

[![CI](https://github.com/laiadlotape/illo/actions/workflows/ci.yml/badge.svg)](https://github.com/laiadlotape/illo/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-%E2%89%A5%2020.x-339933)](https://nodejs.org/) [![Plugin](https://img.shields.io/badge/plugin-v0.4.3-f7b955)](https://github.com/laiadlotape/illo/releases)

---

## The premise

> "Never prompt directly in chat. Write in an editor, read it twice, dehumanize it. You are configuring a system, not chatting with a colleague."
> — *[FindingMemo](https://github.com/lotape6/FindingMemo/blob/master/lessons/00-introduction/deck.md)*

You are sending instructions to a system that executes them. The chat box is a terrible place to compose them. illo gives you a real editor — in a tmux split, next to the Claude pane — where you can draft, revise, and inspect before committing. When you're done, one keystroke injects the text into Claude's input. **illo does not press Enter for you.** That's yours.

---

## What it looks like

![illo TUI — events log, compose, send, event-detail popup](https://github.com/laiadlotape/illo/releases/download/v0.4.1/illo-tui-latest.gif)

```
┌──────────────────────────────────┬─────────────────────────────────────────┐
│                                  │ illo · v0.4.3 · pane: %4          ●     │
│   Claude session                 ├─────────────────────────────────────────┤
│   (claude CLI)                   │ events (last 3) · [v] low-noise          │
│                                  │   12:30 · ask_user · "Drop users_old?"  │
│   > _ ← your prompt lands here, │   12:31 · sent     · "Drop it, backup…" │
│       you review and hit Enter   │   12:33 · stop     · waiting…           │
│                                  ├─────────────────────────────────────────┤
│                                  │ ┌─ prompt ──── lines: 3 · words: 18 ──┐ │
│                                  │ │ Claude, before running the migration│ │
│                                  │ │   1. Verify /backups exists         │ │
│                                  │ │   2. Abort if row count differs█    │ │
│                                  │ └─────────────────────────────────────┘ │
│                                  │ Ctrl-S send · Ctrl-D send+Enter · ? help│
└──────────────────────────────────┴─────────────────────────────────────────┘
```

The screen is split into three zones: an **event log** (top ~1/3, low-noise filter by default), a **prompt buffer** (bottom ~2/3, full editor), and a **hint footer** that reminds you of the most useful keys. The status bar tracks which Claude pane you're targeting and whether a session recording is active.

---

## How it works

### The send loop

```
┌─ prompt buffer ────────────────────────────────┐
│ You compose. Undo. Revise. Open $EDITOR.       │
│ Take your time.                                │
└──────────────────────────┬─────────────────────┘
                           │  Ctrl-S
                           ▼
              bin/tmux-send.sh
              tmux send-keys -l <text>   ← literal, no interpretation
              tmux select-pane           ← focus jumps to Claude pane
                           │
                           │  You read the prompt in its destination.
                           │  You press Enter yourself.
                           ▼
              Claude receives the prompt and works.
                           │
                           │  Hooks fire on AskUserQuestion / Notification / Stop
                           ▼
              POST /event → daemon → WebSocket broadcast
                           │
                           ▼
              illo event log updates — pick the next prompt
```

### Event capture

Every event from any agent framework flows through the daemon and lands in the log:

```
Claude Code / LangGraph / CrewAI / Codex / Aider / Cursor / custom script
       │
       │  POST /event  (kind, urgency, agent_id, transcript_snapshot, …)
       ▼
daemon/server.js   Node 20+, zero npm deps, 127.0.0.1:7821
       │
       │  normalise → persist → broadcast via WebSocket
       ▼
illo TUI event log    ←    /illo-web browser fallback (optional)
```

The daemon is shared across all Claude sessions on your machine. Items carry a `sessionId`; the low-noise filter keeps the log sane.

### Answering a question

When Claude posts an `ask_user` event, illo surfaces it with a `Q:` prefix:

1. Press `Enter` on the event to open the detail popup — full question text, options, transcript snapshot.
2. `Ctrl-Down` to switch to the prompt buffer.
3. Write your reply.
4. `Ctrl-S` → the reply lands in the Claude pane → you press `Enter`.

The `UserPromptSubmit` hook injects the original question's context into the turn so Claude doesn't re-ask it.

---

## Install

**Requirements:** Node 20+, tmux, `curl`, `jq`.

```bash
# 1. Clone anywhere
git clone https://github.com/laiadlotape/illo /path/to/illo

# 2. Install the plugin
/plugin install /path/to/illo

# 3. Register hooks in ~/.claude/settings.json
{
  "hooks": { "hooksJsonPath": "/path/to/illo/hooks/hooks.json" }
}

# 4. Verify Node
node --version   # 20.x or newer
```

The daemon starts automatically on the first hook that fires. No separate daemon install step.

---

## Quick start

```
# Inside a tmux window with claude running in one pane:
/illo
```

A 40%-wide vertical split opens on the right. Switch to it with `Prefix → o`.

| Key | What happens |
|---|---|
| Type anything | Compose your prompt in the buffer |
| `Ctrl-S` | Inject into the Claude pane (no Enter) |
| `Ctrl-D` | Inject + press Enter (use only after re-reading) |
| `Ctrl-E` | Open `$EDITOR` for longer drafts |
| `Ctrl-Up` | Focus the events log |
| `j` / `k` | Scroll events; `Enter` to open detail |
| `v` | Toggle low-noise ↔ verbose filter |
| `r` | Toggle session recording (`● REC` in status bar) |
| `?` | Full keybinding help overlay |
| `Ctrl-Q` | Quit |

Full reference: [`docs/tui.md`](docs/tui.md).

**Test without Claude:**

```bash
PORT=$(cat ~/.claude/illo-sidebar/daemon.port)
curl -sX POST -H 'Content-Type: application/json' \
  -d '{"kind":"ask_user","session_id":"demo","urgency":"urgent",
       "tool_input":{"questions":[{"question":"Approve deploy?",
       "options":[{"label":"Yes"},{"label":"No"}]}]}}' \
  http://127.0.0.1:$PORT/event
```

---

## Session recording

illo can record the entire tmux window — Claude pane and sidebar together — as an asciinema cast, then auto-convert it to a gif.

<!-- gif: recording demo — r key, ● REC indicator, stop + gif output -->

**How to record:**

| Method | Command |
|---|---|
| TUI shortcut | `r` in events focus — toggles on/off |
| Slash command | `/illo-record` to start, `/illo-record stop` to stop |
| Shell | `bash bin/record.sh start` / `bash bin/record.sh stop` |

Output lands in `~/.claude/illo-sidebar/recordings/` as `.cast` and `.gif`.

**Requirements:** `asciinema` + `agg`. If `agg` isn't installed, the cast is saved and you can convert later:

```bash
pip install asciinema
cargo install --git https://github.com/asciinema/agg   # or grab a prebuilt binary
bash bin/record.sh gif <cast-file>                      # manual conversion
```

---

## Slash commands

| Command | Purpose |
|---|---|
| `/illo` | Open the TUI in a tmux split |
| `/illo-attach %N` | Pin a specific tmux pane as the send target |
| `/illo-detach` | Return to auto-detection |
| `/illo-record [stop\|status]` | Start/stop session recording |
| `/illo-status` | Daemon health + pending item count |
| `/illo-resume [item_id]` | List or mark unresolved resume items |
| `/illo-web` | Open the browser UI fallback |

---

## Settings

| Field | Default | Purpose |
|---|---|---|
| `warnIntervalSeconds` | `300` | Re-warn cadence on unacknowledged items. `0` disables. |
| `daemonPort` | `7821` | Port the daemon binds to. Auto-increments up to +20 if taken. |
| `autoOpenSidebar` | `true` | Auto-open on `SessionStart` (no-op outside tmux unless `ILLO_SIDEBAR_AUTO_TERMINAL` is set). |
| `pushProvider` | `"off"` | Mobile push: `ntfy`, `pushover`, or `off`. |
| `pushAfkThresholdSeconds` | `120` | Push after this many idle seconds. |

All fields live in `.claude-plugin/plugin.json`. Environment variables take precedence:

| Variable | Effect |
|---|---|
| `ILLO_SIDEBAR_PORT` | Override daemon port |
| `ILLO_SIDEBAR_HOME` | Override state directory (default: `~/.claude/illo-sidebar`) |
| `ILLO_SIDEBAR_AUTO_TERMINAL` | Auto-spawn TUI outside tmux (`kitty`, `alacritty`, etc.) |

---

## Integrations

### Generic event protocol

Any agent framework can send events — not just Claude Code:

```bash
curl -sX POST http://127.0.0.1:7821/event \
  -H 'Content-Type: application/json' \
  -d '{
    "kind": "ask_user",
    "agent_id": "my-langgraph-agent",
    "agent_kind": "langgraph",
    "urgency": "urgent",
    "tool_input": { "questions": [{ "question": "Proceed?", "options": [{"label":"Yes"},{"label":"No"}] }] },
    "transcript_snapshot": "last N lines of your agent log here"
  }'
```

Supported `kind`s: `ask_user`, `notification`, `stop`, `session_start`, `session_end`, `user_prompt`, `custom`. Full contract: [`docs/protocol.md`](docs/protocol.md).

### Python SDK

```python
from illo_sidebar import IlloSidebar
c = IlloSidebar(port=7821, agent_id="my-agent", agent_kind="langgraph")
c.ask("Approve deploy?", options=["yes", "no"], urgency="urgent")
c.notify("Build complete.", urgency="low")
```

Drop `sdks/python/illo_sidebar.py` onto your `PYTHONPATH`. No `pip install`.

### TypeScript SDK

```ts
import { IlloSidebar } from "./illo-sidebar";
const c = new IlloSidebar({ port: 7821, agentId: "my-agent" });
await c.ask({ question: "Approve?", options: ["yes", "no"], urgency: "urgent" });
```

Drop `sdks/typescript/illo-sidebar.ts` into your project. No build step.

### Mobile push

When you step away from the keyboard, illo can push unacknowledged items to your phone via ntfy.sh (free) or Pushover ($5 one-time). See [`docs/push.md`](docs/push.md).

```bash
curl -sX POST http://127.0.0.1:7821/config/push \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true,"provider":"ntfy","ntfy_topic":"my-illo-topic"}'
```

### Wave orchestration

`wave` is an opt-in autonomous GitHub loop — it polls `status:ready` issues, dispatches Sonnet sub-agents, enforces a 1-worker cap, auto-merges PRs that pass CI + review + `safe:auto-merge`. Run `/wave` once to bootstrap; `/wave-stop` to halt. See [`docs/wave.md`](docs/wave.md).

---

## Limitations

- **Requires tmux.** Outside tmux, `/illo` prints clear guidance. Set `ILLO_SIDEBAR_AUTO_TERMINAL` to spawn in a terminal emulator automatically, or use `/illo-web`.

- **One daemon per machine.** All Claude Code sessions share one daemon and one event log. Items are tagged with `sessionId` and `agentId`, so filtering works, but they coexist.

- **Browser fallback (`/illo-web`) uses the v0.2 UI.** It's functional but doesn't have the prompt-notepad layout. Chromium-family browsers only — Firefox doesn't support `--app` mode.

- **Port exhaustion.** If ports 7821–7841 are all taken, the daemon exits. Check `~/.claude/illo-sidebar/daemon.log`.

- **No global keyboard shortcut.** The `r` / `v` / `x` keys work only when the illo pane is focused.

---

## Contributing

Issues, PRs, and protocol extensions welcome. The codebase is organized around narrow roles:

| Path | Owned by |
|---|---|
| `bin/illo-tui.js` | TUI — prompt notepad, keybindings, render |
| `daemon/server.js` | Daemon — HTTP + WebSocket, zero deps |
| `bin/on-*.sh`, `bin/_*.sh` | Hooks — event capture, tmux send |
| `docs/` | Documentation |
| `tests/` | Tests — unit, dogfood, TUI smoke, Playwright E2E |

Run the test suite:

```bash
bash tests/dogfood.sh            # HTTP integration smoke
bash tests/tui.test.sh           # TUI headless smoke
node --test tests/server.test.mjs  # daemon unit tests
```

---

*Built on the shoulders of tmux, asciinema, and the wisdom that a slow prompt is better than a fast mistake.*
