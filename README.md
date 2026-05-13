# illo

**A prompt notepad that lives next to Claude.** Write deliberately, review once more, then send — without auto-pressing Enter.

[![CI](https://github.com/laiadlotape/illo/actions/workflows/ci.yml/badge.svg)](https://github.com/laiadlotape/illo/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-%E2%89%A5%2020.x-339933)](https://nodejs.org/) [![Plugin](https://img.shields.io/badge/plugin-v0.5.0-f7b955)](https://github.com/laiadlotape/illo/releases)

---

![illo TUI demo](docs/recordings/illo-tui-latest.gif)

---

## Why this exists

Claude interrupts you. You're deep in a task, and it asks a question — but you're mid-thought somewhere else. By the time you context-switch back, you've lost the thread of what you were doing. That friction compounds across a long session.

The chat input box makes it worse. You type fast, you hit Enter too soon, you send something half-formed. There's no draft space, no undo before the prompt leaves, no moment to re-read what you're about to hand off to a system that will act on it literally.

illo puts a real editor in a tmux split, right next to Claude. The left pane is `claude`. The right pane is yours: an event log on top (questions, notifications, what Claude just finished), and a compose buffer below where you write at your own pace. When you're ready, one keystroke injects your text into the Claude pane. **illo does not press Enter for you.** That last step is yours.

> "Never prompt directly in chat. Write in an editor, read it twice, dehumanize it. You are configuring a system, not chatting with a colleague."
> — *[FindingMemo](https://github.com/lotape6/FindingMemo/blob/master/lessons/00-introduction/deck.md)*

---

## 5-minute tour

### Composing a thought

Open illo with `/illo`. A 40%-wide vertical split appears on the right. The bottom two-thirds is your compose buffer — a full text editor.

![Composing a thought — draft, edit, send](docs/recordings/compose-keys.gif)

Type naturally. Use `Ctrl-Left` / `Ctrl-Right` to jump words, `Ctrl-W` to delete a word backward, `Ctrl-Z` to undo. For longer drafts, `Ctrl-E` opens the buffer in your `$EDITOR` and pastes it back when you save and quit.

```
┌─────────────────────────────────────────┐
│ ┌─ prompt ──── lines: 3 · words: 18 ──┐ │
│ │ Claude, before running the migration│ │
│ │   1. Verify /backups exists         │ │
│ │   2. Abort if row count differs█    │ │
│ └─────────────────────────────────────┘ │
│ Ctrl-S send · Ctrl-D send+Enter · ? help│
└─────────────────────────────────────────┘
```

### Catching what Claude says

The top third of the illo pane is the event log. It shows items from Claude's hooks in real time: questions (`ask_user`), status updates (`notification`), and what you just sent (`sent`).

![Catching what Claude says — event log, popup, filter toggle](docs/recordings/event-nav.gif)

Press `Ctrl-Up` to focus the event log. Use `j` / `k` to scroll through items. Press `Enter` on any item to open a detail popup with the full text, options (for questions), and a transcript snapshot. Press `v` to toggle between the default low-noise filter and the full verbose log — useful when you want to see `stop` events or session boundaries.

### Sending it across

When you're ready, press `Ctrl-S`. illo injects your text into the Claude pane via `tmux send-keys -l` (literal — no shell interpretation) and shifts focus there. A "sent →" toast appears in the status bar. You land in the Claude pane, read the prompt as it sits in the input, and press Enter yourself.

![Sending it across — Ctrl-S, sent toast, event confirmation](docs/recordings/send-flow.gif)

`Ctrl-D` does the same thing but also presses Enter for you. Use it only when you've already read the prompt once and are confident.

---

## Make it yours

Full keybinding reference is in [`docs/tui.md`](docs/tui.md).

Coming in v0.6: a settings panel (`,`) and `~/.claude/illo/config.json` will let you change themes, key overrides, filter presets, and default `$EDITOR` behaviour without touching the plugin source. This is not built yet — the config system is in the roadmap.

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

A 40%-wide vertical split opens on the right. Switch back to illo with `Prefix → o`.

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

## Slash commands

| Command | Purpose |
|---|---|
| `/illo` | Open the TUI in a tmux split |
| `/illo-attach %N` | Pin a specific tmux pane as the send target |
| `/illo-detach` | Return to auto-detection |
| `/illo-record [stop\|status]` | Start/stop session recording |
| `/illo-status` | Daemon health + pending item count |
| `/illo-resume [item_id]` | List or mark unresolved resume items |
| `/illo-update` | Update the plugin and restart the daemon |
| `/illo-web` | Open the browser UI fallback |

Run `/illo-update` to pull the latest version and gracefully restart the daemon in one step. If your installed version drifts from `main`, the SessionStart hook posts an "update available" notice to the sidebar automatically.

---

## Session recording

illo can record the entire tmux window — Claude pane and sidebar together — as an asciinema cast, then auto-convert it to a gif.

<!-- gif: illo-record — r key toggles ● REC, cast auto-converts to gif -->

| Method | Command |
|---|---|
| TUI shortcut | `r` in events focus — toggles on/off |
| Slash command | `/illo-record` to start, `/illo-record stop` to stop |
| Shell | `bash bin/record.sh start` / `bash bin/record.sh stop` |

Output lands in `~/.claude/illo-sidebar/recordings/` as `.cast` and `.gif`. Requires `asciinema` + `agg`:

```bash
pip install asciinema
cargo install --git https://github.com/asciinema/agg   # or grab a prebuilt binary
bash bin/record.sh gif <cast-file>                      # manual conversion
```

---

## Integrations

Any agent framework can post events to the daemon — not just Claude Code. See [`docs/protocol.md`](docs/protocol.md) for the full event contract.

```bash
curl -sX POST http://127.0.0.1:7821/event \
  -H 'Content-Type: application/json' \
  -d '{"kind":"ask_user","agent_id":"my-agent","urgency":"urgent",
       "tool_input":{"questions":[{"question":"Proceed?","options":[{"label":"Yes"},{"label":"No"}]}]}}'
```

**Python SDK** — drop `sdks/python/illo_sidebar.py` onto your `PYTHONPATH`:

```python
from illo_sidebar import IlloSidebar
c = IlloSidebar(port=7821, agent_id="my-agent", agent_kind="langgraph")
c.ask("Approve deploy?", options=["yes", "no"], urgency="urgent")
```

**TypeScript SDK** — drop `sdks/typescript/illo-sidebar.ts` into your project:

```ts
import { IlloSidebar } from "./illo-sidebar";
const c = new IlloSidebar({ port: 7821, agentId: "my-agent" });
await c.ask({ question: "Approve?", options: ["yes", "no"], urgency: "urgent" });
```

**Mobile push** — when you step away, illo can push unacknowledged items to your phone via ntfy.sh (free) or Pushover ($5 one-time). See [`docs/push.md`](docs/push.md).

**Wave orchestration** — an opt-in autonomous GitHub loop that polls `status:ready` issues, dispatches sub-agents, and auto-merges PRs that pass CI + review. Run `/wave` once to bootstrap. See [`docs/wave.md`](docs/wave.md).

---

## Settings

| Field | Default | Purpose |
|---|---|---|
| `warnIntervalSeconds` | `300` | Re-warn cadence on unacknowledged items. `0` disables. |
| `daemonPort` | `7821` | Port the daemon binds to. Auto-increments up to +20 if taken. |
| `autoOpenSidebar` | `true` | Auto-open on `SessionStart` (no-op outside tmux unless `ILLO_SIDEBAR_AUTO_TERMINAL` is set). |
| `pushProvider` | `"off"` | Mobile push: `ntfy`, `pushover`, or `off`. |
| `pushAfkThresholdSeconds` | `120` | Push after this many idle seconds. |

All fields live in `.claude-plugin/plugin.json`. Environment variables take precedence: `ILLO_SIDEBAR_PORT`, `ILLO_SIDEBAR_HOME`, `ILLO_SIDEBAR_AUTO_TERMINAL`.

---

## Limitations

- **Requires tmux.** Outside tmux, `/illo` prints clear guidance. Set `ILLO_SIDEBAR_AUTO_TERMINAL` to spawn in a terminal emulator automatically, or use `/illo-web`.
- **One daemon per machine.** All Claude Code sessions share one daemon and one event log. Items are tagged with `sessionId` and `agentId`, so filtering works, but they coexist.
- **Browser fallback (`/illo-web`) uses the v0.2 UI.** It's functional but doesn't have the prompt-notepad layout. Chromium-family browsers only.
- **Port exhaustion.** If ports 7821–7841 are all taken, the daemon exits. Check `~/.claude/illo-sidebar/daemon.log`.
- **No global keyboard shortcut.** The `r` / `v` / `x` keys work only when the illo pane is focused.

---

## Contributing

Issues, PRs, and protocol extensions welcome.

| Path | Role |
|---|---|
| `bin/illo-tui.js` | TUI — prompt notepad, keybindings, render |
| `daemon/server.js` | Daemon — HTTP + WebSocket, zero deps |
| `bin/on-*.sh`, `bin/_*.sh` | Hooks — event capture, tmux send |
| `ui/` | Browser fallback UI |
| `sdks/` | Python + TypeScript SDKs |
| `docs/` | Documentation |
| `tests/` | Unit, dogfood, TUI smoke, Playwright E2E |

```bash
bash tests/dogfood.sh              # HTTP integration smoke
bash tests/tui.test.sh             # TUI headless smoke
node --test tests/server.test.mjs  # daemon unit tests
```

---

## Going further

| Doc | What's in it |
|---|---|
| [`docs/tui.md`](docs/tui.md) | Full keybinding reference, editor modes, status bar fields |
| [`docs/protocol.md`](docs/protocol.md) | Event schema, all `kind` values, REST + WebSocket API |
| [`docs/push.md`](docs/push.md) | ntfy and Pushover setup, AFK threshold tuning |
| [`docs/wave.md`](docs/wave.md) | Wave orchestration — labels, worker cap, auto-merge rules |
| [`docs/architecture.md`](docs/architecture.md) | How the send loop works, event capture flow, file layout |

---

*Built on the shoulders of tmux, asciinema, and the wisdom that a slow prompt is better than a fast mistake.*
