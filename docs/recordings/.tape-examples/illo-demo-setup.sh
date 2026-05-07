#!/usr/bin/env bash
set -euo pipefail

PROJECT=/home/lotape6/Projects/illo
TSOCK=illo-demo

# Isolated tmux server that ignores user tmux.conf (no base-index 1, etc.)
TMUX="tmux -L $TSOCK -f /dev/null"

$TMUX kill-server 2>/dev/null || true

# ── Daemon ────────────────────────────────────────────────────────────────────
DEMO=$(mktemp -d)
ILLO_SIDEBAR_HOME="$DEMO" node "$PROJECT/daemon/server.js" &>/dev/null &

for i in $(seq 1 20); do
  sleep 0.3
  [[ -f "$DEMO/daemon.port" ]] && break
done
PORT=$(cat "$DEMO/daemon.port")

# ── Pre-populate event log (simulates an ongoing Claude session) ──────────────
curl -sS -XPOST -H 'Content-Type: application/json' \
  -d '{"kind":"notification","agent_id":"claude:1","urgency":"urgent","message":"Tests: 47 passed, 0 failed — ready to release"}' \
  "http://127.0.0.1:$PORT/event" >/dev/null

# ── Schedule ask_user to fire ~2s after Ctrl-S in the demo ───────────────────
# Show phase starts ~3s after setup ends; Ctrl-S is ~13s into Show → total ~16s
(sleep 19 && \
  curl -sS -XPOST -H 'Content-Type: application/json' \
    -d '{"kind":"ask_user","agent_id":"claude:1","session_id":"demo","urgency":"urgent","tool_input":{"questions":[{"question":"Proceed with rolling deploy to production? (20% canary, abort if error rate > 0.5%)","options":[{"label":"Yes — deploy now"},{"label":"No — hold for review"}]}]}}' \
    "http://127.0.0.1:$PORT/event" >/dev/null) &

# ── Tmux session: window 0 = target bash, window 1 = illo full-screen ─────────
# No split-window needed — avoids "size missing" in detached sessions
$TMUX new-session -d -s demo -x 218 -y 52     # window 0: bash (send target)

# Print the fake Claude session into window 0 so it looks alive
$TMUX send-keys -t demo:0 "
printf '\033[1;34m Claude Code\033[0m  illo › fix/47-tui-polish\n'
printf '\033[90m──────────────────────────────────────────────\033[0m\n\n'
printf ' User: Review illo v0.4.1 changes.\n\n'
printf ' \033[1;35mClaude:\033[0m  Checking clear, *unsaved, prompt rename…\n\n'
printf '   \033[32m✓\033[0m  bin/illo-tui.js — all three fixes landed\n'
printf '   \033[32m✓\033[0m  tests/tui.test.sh — all assertions pass\n\n'
printf '   Ready for v0.4.1. Shall I cut the release?\n\n'
printf ' \033[90m❯ \033[0m'" Enter
sleep 0.5

$TMUX new-window -t demo                       # window 1: illo TUI (full screen)

# Configure pane-override to window 0's pane so Ctrl-S actually sends there
TARGET_PANE=$($TMUX list-panes -t demo:0 -F '#{pane_id}' | head -1)
curl -sS -XPOST -H 'Content-Type: application/json' \
  -d "{\"paneId\":\"$TARGET_PANE\"}" \
  "http://127.0.0.1:$PORT/config/pane-override" >/dev/null

$TMUX send-keys -t demo:1 \
  "ILLO_SIDEBAR_HOME=$DEMO ILLO_SIDEBAR_PORT=$PORT node $PROJECT/bin/illo-tui.js" Enter
sleep 4

exec $TMUX attach -t demo:1
