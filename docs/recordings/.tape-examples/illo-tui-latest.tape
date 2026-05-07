Output docs/recordings/illo-tui-latest.gif
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

# Setup script starts daemon, injects history events, schedules the ask_user,
# builds the two-pane tmux session on an isolated socket, and execs into it.
# Give it time to complete (daemon ~1.5s, tmux+illo ~2.5s, buffer ~1s).
Sleep 11000ms

# ── Recording starts here — tmux session is live, illo pane is focused ────────
Show

# Let viewer see the layout: Claude Code on left, illo events+compose on right
Sleep 2000ms

# Focus the compose pane (Ctrl-Down works from any pane)
Ctrl+Down
Sleep 700ms

# ── Compose: type the prompt ──────────────────────────────────────────────────
Type "Approve v0.4.1 deploy? Here's the checklist:"
Sleep 600ms
Enter

# "Paste" the formatted checklist — fast typing mimics paste
Set TypingSpeed 13ms
Type "  - Backup: 142,331 rows confirmed (matches staging)"
Enter
Type "  - Schema: 0 breaking changes vs prod"
Enter
Type "  - Rolling deploy: 20% canary, auto-abort if err > 0.5%"
Enter
Type "  - Rollback: tested in staging, 90s to revert"
Set TypingSpeed 65ms

# Brief pause — reviewing before sending
Sleep 1400ms

# ── Send to Claude pane ───────────────────────────────────────────────────────
Ctrl+S
Sleep 500ms

# Compose clears; "sent → claude pane focused" toast shows.
# Claude is processing… ask_user fires ~2s later.
Sleep 2500ms

# ── ask_user event arrives — switch to events log ─────────────────────────────
Ctrl+Up
Sleep 1200ms

# Open event-detail popup
Enter
Sleep 1800ms

# Scroll through the question
Down
Sleep 600ms
Down
Sleep 800ms

# Close popup
Escape
Sleep 800ms

# ── Reply from compose pane ───────────────────────────────────────────────────
Ctrl+Down
Sleep 600ms

Type "Yes — proceed with deploy now"
Sleep 1000ms

Ctrl+S
Sleep 500ms

# ── Browse events log — see the sent record ───────────────────────────────────
Ctrl+Up
Sleep 1600ms

# Toggle to verbose — shows all events (stop, session_start, etc.)
Type "v"
Sleep 1400ms

# Back to low-noise
Type "v"
Sleep 900ms

# ── Help overlay ──────────────────────────────────────────────────────────────
Ctrl+Down
Sleep 300ms
Type "?"
Sleep 2800ms

Escape
Sleep 700ms

# ── Quit ─────────────────────────────────────────────────────────────────────
Ctrl+Q
Sleep 500ms
