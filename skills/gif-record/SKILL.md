---
name: gif-record
description: Record the current tmux window to a gif with keystroke overlay. Uses vhs (preferred) or asciinema+agg (fallback). Both optional.
---

# gif-record

Record the current tmux window to a gif (or webm/mp4) so the user can show
how each version of the TUI looks. Keystrokes are gently overlaid so viewers
can follow what is being pressed.

## When to use

- User wants to capture a TUI demo for docs, a PR, or a README screencast.
- User says "record the sidebar", "make a gif of the TUI", "capture a demo",
  or similar.
- User wants a repeatable, scriptable demo of illo's prompt-notepad flow.

## Quick start

```
/gif-record
/gif-record --name v0.3-demo
/gif-record --name my-demo --tape path/to/my-demo.tape
/gif-record --tool asciinema
```

Output lands in `docs/recordings/<name>.gif` (gitignored — large binary blobs).

## vhs vs asciinema

| Feature                     | vhs                          | asciinema + agg          |
|-----------------------------|------------------------------|--------------------------|
| Keystroke overlay           | Yes — via `Show` directive   | No (terminal only)       |
| Script format               | Declarative `.tape` file     | Interactive / `--command`|
| Output                      | gif / webm / mp4             | gif (via agg)            |
| Install size                | ~10 MB Go binary + ffmpeg    | Python + Rust (agg)      |
| Preferred for TUI demos     | Yes                          | Fallback only            |

vhs starts its own pty and types commands for you — so it records exactly the
`.tape` script, not the live tmux state. Use it to author a repeatable demo.

asciinema records the live terminal session interactively but does not capture
keystrokes. It is useful for quick one-off recordings without scripting.

## Authoring a custom .tape script for repeatable demos

A `.tape` script is a plain-text file consumed by `vhs`. Run
`/gif-record --name demo` once to get a generated template at
`docs/recordings/demo.tape`, then edit it. Key directives:

```tape
Output docs/recordings/demo.gif
Set Theme "Catppuccin Mocha"
Set FontSize 14
Set Width 1200
Set Height 700
Set TypingSpeed 50ms
Set Shell "bash"

# Show causes vhs to show keystrokes as they are typed
Show

# Start the TUI
Type "node bin/illo-tui.js"
Enter
Sleep 2s

# Demonstrate compose
Type "Claude, confirm the migration plan."
Sleep 500ms

# Send with Ctrl-S (no auto-Enter in the TUI — safe to demonstrate)
Ctrl+S
Sleep 1s
```

Pass the finished script via `--tape`:

```bash
gif-record.sh --name demo --tape docs/recordings/demo.tape
```

Full vhs guide: https://github.com/charmbracelet/vhs

## Where the output lands

```
docs/recordings/
  <name>.gif      gitignored — large binary; share out-of-band or via a CDN
  <name>.tape     tracked if you choose to commit it (small, text)
  <name>.cast     gitignored — asciinema cast file

docs/recordings/.tape-examples/
  <anything>.tape   tracked reference scripts; commit these
```

`.gitignore` already excludes `*.gif`, `*.webm`, `*.mp4`, and `*.cast` under
`docs/recordings/`. The `.tape-examples/` subdirectory is tracked.

## Constraints

- `--help` works without any recorder installed (the smoke-test gate).
- No npm or pip deps in the script itself; recorders are user-installed.
- `set -euo pipefail` — any unexpected failure exits non-zero.
