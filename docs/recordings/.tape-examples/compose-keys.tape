Output docs/recordings/compose-keys.gif
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

# ── Type a 3-line note ────────────────────────────────────────────────────────
Type "Before the migration runs, please:"
Enter
Type "  1. Snapshot the production database"
Enter
Type "  2. Verify row counts match staging"
Sleep 800ms

# ── Word navigation: jump left two words ─────────────────────────────────────
Ctrl+Left
Sleep 400ms
Ctrl+Left
Sleep 600ms

# ── Delete a word backward ────────────────────────────────────────────────────
Ctrl+W
Sleep 500ms

# Re-type the deleted word
Type "confirm"
Sleep 600ms

# ── Undo the re-type ──────────────────────────────────────────────────────────
Ctrl+Z
Sleep 500ms
Ctrl+Z
Sleep 500ms

# ── Re-type cleanly ──────────────────────────────────────────────────────────
Type "validate"
Sleep 900ms

# ── Brief pause — reviewing before sending ────────────────────────────────────
Sleep 1200ms

# ── Send to Claude pane ───────────────────────────────────────────────────────
Ctrl+S
Sleep 1500ms

# ── Quit ─────────────────────────────────────────────────────────────────────
Ctrl+Q
Sleep 500ms
