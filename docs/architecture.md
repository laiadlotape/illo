# Architecture

illo is a Claude Code plugin built around a local daemon (`daemon/server.js`) that acts as an event bus between Claude's hooks and the illo TUI. The TUI (`bin/illo-tui.js`) is a Node.js terminal app that opens in a tmux split; hooks (`bin/on-*.sh`) POST events to the daemon over HTTP; the daemon broadcasts them to all connected clients over WebSocket. The code is organized so each component has one narrow responsibility.

---

## The send loop

When you press `Ctrl-S` in the compose buffer, here is what happens:

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

`tmux send-keys -l` sends text literally — no shell expansion, no Enter injected. Focus shifts to the Claude pane immediately so you can read what landed in the input before committing.

---

## event capture

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

The daemon is shared across all Claude sessions on your machine. Items carry a `sessionId`; the low-noise filter keeps the log sane when multiple sessions are active.

---

## Answering a question

When Claude posts an `ask_user` event, illo surfaces it with a `Q:` prefix:

1. Press `Enter` on the event to open the detail popup — full question text, options, transcript snapshot.
2. `Ctrl-Down` to switch to the prompt buffer.
3. Write your reply.
4. `Ctrl-S` → the reply lands in the Claude pane → you press `Enter`.

The `UserPromptSubmit` hook injects the original question's context into the turn so Claude doesn't re-ask it.

---

## File layout

| Path | Role |
|---|---|
| `bin/illo-tui.js` | TUI — prompt notepad, keybindings, render loop |
| `bin/tmux-send.sh` | Injects text into a target tmux pane via `send-keys -l` |
| `bin/on-*.sh`, `bin/_*.sh` | Hook scripts — capture Claude events, POST to daemon |
| `bin/record.sh` | Session recording helper (asciinema + agg) |
| `daemon/server.js` | HTTP + WebSocket daemon, zero npm deps, Node 20+ stdlib only |
| `hooks/hooks.json` | Hook registration manifest loaded by Claude Code |
| `ui/` | Browser fallback UI (vanilla HTML/CSS/JS, v0.2) |
| `sdks/python/` | Python SDK — `illo_sidebar.py`, no pip install |
| `sdks/typescript/` | TypeScript SDK — `illo-sidebar.ts`, no build step |
| `tests/dogfood.sh` | HTTP integration smoke test (also run in CI) |
| `tests/tui.test.sh` | TUI headless smoke test |
| `tests/server.test.mjs` | Daemon unit tests (`node --test`) |
| `tests/` | Playwright E2E tests for the browser UI |
| `docs/` | Documentation (protocol, TUI reference, push, wave) |
| `.claude-plugin/plugin.json` | Plugin manifest — settings fields, default values |
| `commands/` | Slash command implementations (`/illo`, `/illo-resume`, etc.) |
