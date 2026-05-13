Output docs/recordings/event-nav.gif
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

# Setup script pre-populates 3 events and starts illo.
# Give it time to complete (daemon ~1.5s, tmux+illo ~2.5s, buffer ~1s).
Sleep 11000ms

# ── Recording starts here — illo compose pane is focused ─────────────────────
Show

# Let viewer see the initial layout
Sleep 1500ms

# ── Focus the events log ─────────────────────────────────────────────────────
Ctrl+Up
Sleep 900ms

# ── Scroll through events with j/k ───────────────────────────────────────────
Type "j"
Sleep 500ms
Type "j"
Sleep 500ms
Type "k"
Sleep 700ms

# ── Open the ask_user event detail popup ─────────────────────────────────────
Enter
Sleep 1200ms

# ── Scroll through the popup content ─────────────────────────────────────────
Down
Sleep 600ms
Down
Sleep 800ms

# ── Close popup ──────────────────────────────────────────────────────────────
Escape
Sleep 800ms

# ── Toggle to verbose — shows all event kinds ─────────────────────────────────
Type "v"
Sleep 1400ms

# ── Return to low-noise ───────────────────────────────────────────────────────
Type "v"
Sleep 900ms

# ── Quit ─────────────────────────────────────────────────────────────────────
Ctrl+Q
Sleep 500ms
