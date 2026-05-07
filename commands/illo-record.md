---
description: Toggle live session recording (asciinema + agg). Captures all tmux panes in one cast. Recordings land in ~/.claude/illo-sidebar/recordings/.
---

Record the current tmux session (Claude pane + illo pane together) using asciinema attached read-only, then auto-convert to a gif via `agg` on stop.

Use the bash tool:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/record.sh" ${ARGUMENTS:-start}
```

Subcommands:

- `start` (default) — begin recording; prints the cast file path
- `stop` — stop recording and auto-convert to gif if `agg` is installed
- `toggle` — start if not recording, stop if recording
- `status` — print whether recording is active and the cast path
- `gif <cast-file>` — manually convert an existing cast to a gif

After running, tell the user:

- On **start**: recording is live; the cast file path is printed; the `[REC]` indicator will appear in the illo TUI status bar (press `r` in events focus to toggle from the TUI).
- On **stop**: the cast file path and, if `agg` is installed, the gif path. Gifs land in `~/.claude/illo-sidebar/recordings/`.
- If `agg` is not installed: relay the printed hint and suggest `cargo install agg` or the prebuilt binary from https://github.com/asciinema/agg/releases.
- If run outside tmux: relay the "not in a tmux session" error clearly.

The `r` key in the illo TUI events pane toggles recording directly without needing this command.
