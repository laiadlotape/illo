---
description: Record the current tmux window to a gif with keystroke overlay. Uses vhs (preferred) or asciinema+agg (fallback).
---

Record the current tmux window to a gif so the user can show how each version of the TUI looks. Keystrokes are overlaid when using vhs.

Use the bash tool:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/gif-record.sh" $ARGUMENTS
```

OPTIONS

```
--name <name>       Output base name (default: gif-record-YYYYMMDD-HHMMSS)
--tape <file>       Custom .tape script for vhs (skips template generation)
--cmd <command>     Command to embed in the generated tape / pass to asciinema
--width <px>        Terminal width in pixels (default: 1200; vhs only)
--height <px>       Terminal height in pixels (default: 700; vhs only)
--out <dir>         Output directory (default: docs/recordings)
--tool vhs|asciinema|auto
                    Recording backend (default: auto — prefer vhs)
--help              Print usage and install one-liners; exits 0 (no recorder needed)
```

After running, tell the user:
- Where the gif landed (`docs/recordings/<name>.gif`).
- If no recorder was found, relay the install one-liners printed by the script.
- If a template tape was generated, mention that the user can edit `docs/recordings/<name>.tape` and re-run with `--tape` for a repeatable scripted demo.
- If the asciinema fallback was used, note that keystroke overlay is not available — vhs is preferred for that.

See `docs/gif-record.md` for full install instructions and a worked .tape example.
