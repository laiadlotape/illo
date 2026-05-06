# illo-sidebar — agent harness rules

This project is a Claude Code plugin. Treat the rules below as binding for any
Claude session opened in this directory.

## Model routing (mandatory)

All real implementation work goes through the `Agent` tool with an explicit
`model:` field. The orchestrator session stays on Opus 4.7; subagents do the
typing.

| Task class | `model:` |
|---|---|
| Routine impl, file writes, tests, docs, verification, status checks | `sonnet` |
| Multi-file refactor, architecture redesign, deep cross-file analysis | `opus` (Opus 4.6) |
| Forks (Agent without `subagent_type`) | same routing — never omit `model:` |

If a Sonnet subagent's output is unsatisfactory, escalate by re-spawning the
same task on `opus`. Don't pre-escalate.

## Dogfood every change

Before reporting a plugin change as "done", run the end-to-end demo:

```bash
node daemon/server.js &      # start the daemon
sleep 0.5
PORT=$(cat ~/.claude/illo-sidebar/daemon.port)
curl -sS -X POST -H 'Content-Type: application/json' \
  -d '{"kind":"ask_user","session_id":"demo","tool_input":{"questions":[{"question":"Approve deploy?","options":[{"label":"Yes"},{"label":"No"}]}]}}' \
  http://127.0.0.1:$PORT/event
curl -sS http://127.0.0.1:$PORT/state | jq '.items'
```

The same demo lives in `tests/dogfood.sh` and is invoked from CI.

## Layout

- `.claude-plugin/plugin.json` — manifest
- `hooks/hooks.json` + `bin/*.sh` — event capture
- `daemon/server.js` — Node, no deps; HTTP+WS on localhost
- `bin/illo-tui.js` — **default sidebar**: terminal TUI client, spawned in a tmux split
- `ui/` — vanilla HTML/CSS/JS sidebar (optional `/sb-web` fallback for headless/remote use)
- `commands/` — `/sb` (TUI in tmux split), `/sb-web` (browser fallback), `/sb-resume`, `/sb-status`
- `skills/sidebar-coordinator/SKILL.md` — guidance for Claude on resume flow
- `tests/` — Playwright UX tests + dogfood script

## Sidebar surface rule

The sidebar is a CLI thing. Default to the TUI; only open the browser when the user explicitly asks (`/sb-web`) or there is no terminal multiplexer available *and* the user opted into autoOpenWeb.

## Hard constraints

- Daemon must be zero-dep (stdlib only). No `npm install` for runtime.
- Hooks must never block Claude on daemon errors — every script exits 0.
- Daemon binds 127.0.0.1 only.
- No telemetry, no remote calls.
