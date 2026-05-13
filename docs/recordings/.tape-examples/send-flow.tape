Output docs/recordings/send-flow.gif
Set Theme "Catppuccin Mocha"
Set FontSize 14
Set Width 1440
Set Height 840
Set TypingSpeed 65ms
Set Shell "bash"

# ── Everything before Show is hidden — no shell noise in the gif ──────────────
Hide

Type "bash docs/recordings/.tape-examples/illo-demo-setup.sh"
Enter

# Setup script starts daemon, builds tmux session, execs into illo.
# Give it time to complete (daemon ~1.5s, tmux+illo ~2.5s, buffer ~1s).
Sleep 11000ms

# ── Recording starts here — illo compose pane is focused ─────────────────────
Show

# Switch to compose pane
Ctrl+Down
Sleep 700ms

# ── Type a short 1-line prompt ────────────────────────────────────────────────
Type "Ready to merge — LGTM"
Sleep 1000ms

# ── Pause — re-reading before sending ────────────────────────────────────────
Sleep 800ms

# ── Send — focus jumps to Claude pane, "sent →" toast appears ────────────────
Ctrl+S
Sleep 1200ms

# ── Return to events log to see the sent record ──────────────────────────────
Ctrl+Up
Sleep 1500ms

# The "sent" item should now be visible at the top of the log.
Sleep 1000ms

# ── Quit ─────────────────────────────────────────────────────────────────────
Ctrl+Q
Sleep 500ms
