Output docs/recordings/illo-hero.gif
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

# Setup script starts daemon, injects history events, schedules ask_user,
# builds the two-pane tmux session, and execs into illo.
Sleep 11000ms

# ── Recording starts here — 10s montage ──────────────────────────────────────
Show

# Brief establishing pause — viewer sees the layout
Sleep 1200ms

# ── Switch to compose, type a short note ─────────────────────────────────────
Ctrl+Down
Sleep 500ms

Type "LGTM — ship it"
Sleep 800ms

# ── Send ──────────────────────────────────────────────────────────────────────
Ctrl+S
Sleep 1000ms

# ── Jump to events log ────────────────────────────────────────────────────────
Ctrl+Up
Sleep 800ms

# ── Open the ask_user popup ──────────────────────────────────────────────────
Enter
Sleep 1200ms

# ── Scroll popup ─────────────────────────────────────────────────────────────
Down
Sleep 500ms

# ── Close popup ──────────────────────────────────────────────────────────────
Escape
Sleep 700ms

# ── Quit ─────────────────────────────────────────────────────────────────────
Ctrl+Q
Sleep 500ms
