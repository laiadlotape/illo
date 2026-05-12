Output docs/recordings/illo-record.gif
Set Theme "Catppuccin Mocha"
Set FontSize 14
Set Width 1440
Set Height 840
Set TypingSpeed 65ms
Set Shell "bash"

# ── Hidden setup: daemon, events, tmux session with illo ──────────────────────
Hide

Type "bash docs/recordings/.tape-examples/illo-demo-setup.sh"
Enter
Sleep 11000ms

Show

# illo is live — settle on the events pane view
Sleep 1500ms

# Focus events pane first (Ctrl-Up)
Ctrl+Up
Sleep 800ms

# ── Start recording: press r ──────────────────────────────────────────────────
Type "r"
Sleep 1500ms

# ● REC is now visible in the status bar
# Switch to compose and type a prompt
Ctrl+Down
Sleep 600ms

Type "Claude, summarise the last three decisions we made."
Sleep 800ms
Enter
Type "  Include rationale for each one."
Sleep 1200ms

# Back to events to show the REC indicator is still live
Ctrl+Up
Sleep 1200ms

# ── Stop recording: press r again ─────────────────────────────────────────────
Type "r"
Sleep 2000ms

# ● REC gone — recording finalized, gif being generated
# Quit
Ctrl+Q
Sleep 400ms
