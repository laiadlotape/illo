# illo TUI — v0.3 prompt notepad

The illo sidebar is a **prompt notepad** that lives in a tmux split next to
the Claude pane. You compose, edit, review, then hand the prompt off to the
Claude pane via `tmux send-keys`. **The TUI never auto-presses Enter** —
the human reads once more in the destination pane and submits.

> Why? "Never prompt directly in chat. Write in an editor, read it twice,
> dehumanize it. You are configuring a system, not chatting with a colleague."
> — *FindingMemo*

## Layout

```
┌─────────────────────────────────────────────────────────────┐
│ illo · v0.3 · pane: claude(%4) · focus: compose         ●   │  status (1 row)
├─────────────────────────────────────────────────────────────┤
│ events (last N) · [v] low-noise · [x] clear · Ctrl-Up …     │  events header
│   12:30 · ask_user  · "Should I drop users_old?"            │  event log (~1/3)
│   12:31 · sent      · "Drop it. Backup verified at /backups…│
│   12:33 · stop      · waiting…                              │
├─────────────────────────────────────────────────────────────┤
│ compose · lines: 4 · words: 23 · *unsaved                   │  compose status
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ Claude, after looking at the migration script,          │ │  compose pane
│ │   1. Verify backup at /backups/users-2026-05-06         │ │  (~2/3)
│ │   2. Run rollback if any row count differs█             │ │
│ └─────────────────────────────────────────────────────────┘ │
│ Ctrl-S send · Ctrl-D send+Enter · Ctrl-E $EDITOR · Ctrl-X   │  hint (1 row)
└─────────────────────────────────────────────────────────────┘
```

The events log takes ~1/3 of the available rows; compose takes ~2/3. On
narrow terminals (< 24 rows), the events log shrinks to 4 rows so compose
keeps the room.

## Quick start

Inside tmux, from Claude Code:

```
/sb
```

A 40%-wide vertical split opens on the right running `bin/illo-tui.js`.
Switch to the sidebar pane with `Prefix → o` (or your tmux keybinding).

To launch manually:

```bash
node /path/to/illo/bin/illo-tui.js
```

## Keybindings

### Compose pane (focus: compose)

| Key | Action |
|---|---|
| Printable / UTF-8 | Insert at cursor |
| `Tab` | Insert two spaces |
| `Enter` | Newline (auto-indent to match leading whitespace) |
| `Backspace` | Delete char left (joins lines at col 0) |
| `Delete` | Delete char right (joins next line at end) |
| `←` `→` `↑` `↓` | Move cursor (with line-wrap on horizontal motion) |
| `Home` / `End` | Beginning / end of line |
| `PgUp` / `PgDn` | Scroll one screen |
| `Ctrl-A` | Beginning of line (alias for `Home`) |
| `Ctrl-W` | Delete word backward |
| `Ctrl-U` | Delete from cursor backward to beginning of line |
| `Ctrl-K` | Kill to end of line (or join next line at EOL) |
| `Ctrl-Z` | Undo |
| `Ctrl-Y` | Redo |
| `Ctrl-L` | Force-redraw |
| `Ctrl-S` | **Send to claude pane** (no auto-Enter — review and submit yourself) |
| `Ctrl-D` | Send + press Enter (skip the human review step) |
| `Ctrl-E` | Open `$EDITOR` (or `nano`) on the buffer |
| `Ctrl-X` | Clear compose buffer |
| `Ctrl-Up` | Move focus to events log |
| `Ctrl-Q` | Quit (also `Ctrl-C`) |

### Events log (focus: events)

| Key | Action |
|---|---|
| `j` / `↓` | Scroll one event toward older |
| `k` / `↑` | Scroll one event toward newer (wraps the tail) |
| `PgUp` / `PgDn` | Scroll five events |
| `v` | Toggle filter: low-noise (default) ↔ verbose |
| `x` | Clear resolved events from the log view |
| `Enter` | Open detail modal (kind, urgency, snippet, transcript snapshot first 6 lines) |
| `Esc` | Close modal |
| `Ctrl-Down` | Move focus back to compose |
| `Ctrl-Q` | Quit |

### Undo behavior

Edits are grouped into "typing groups": a sequence of printable inserts
within a 2-second window collapses into a single undo entry. A non-character
action (Enter, Backspace beyond the current group, kill, paste from
`$EDITOR`, etc.) opens a fresh group on the next edit. The undo stack is
capped at 100 entries; older entries are dropped silently. Redo is cleared
whenever a new edit happens after an undo.

## Pane discovery

On startup, the TUI runs `bin/tmux-send.sh discover` which calls
`tmux list-panes` for the **current window** and returns the first pane
whose `pane_current_command` is `claude` OR whose pid's process tree
contains `claude` (excluding the illo TUI's own pane).

If the daemon's `paneOverride` config is set (via `/sb-attach`), that
wins — discovery is skipped.

If discovery returns nothing, the status bar shows
`pane: <none — /sb-attach to set>` and `Ctrl-S` toasts
`no claude pane in this window — set with /sb-attach <pane_id>`.

To pin a specific pane (or override a misdetection):

```
/sb-attach %4
```

To return to auto-detection:

```
/sb-detach
```

## Send semantics

`Ctrl-S` does the following:

1. Joins the compose buffer with `\n` into a single string `text`.
2. If empty, toasts `(nothing to send)` and returns.
3. If no `paneId` is known, retries discovery once. If still none, toasts
   the `/sb-attach` hint.
4. Pipes the text to `bin/tmux-send.sh send <pane>`. The helper invokes
   `tmux send-keys -t <pane> -l -- "$text"` — `-l` disables key
   interpretation so backslashes, quotes, dollars, and newlines pass
   through literally; `--` ends option parsing for hostile leading dashes.
5. Calls `bin/tmux-send.sh focus <pane>` so the human's eyes land on the
   destination.
6. POSTs `/sent { text, paneId }` to the daemon so the send appears in the
   event log.
7. Clears the compose buffer.
8. Toasts `sent → claude pane focused; review and press Enter`.

`Ctrl-D` is the same flow plus a final `tmux send-keys -t <pane> Enter` —
use it only when the prompt has been re-read in the buffer and you want
to skip the destination-pane review.

## $EDITOR escape (Ctrl-E)

Long compositions deserve a real editor. `Ctrl-E`:

1. Reads `$EDITOR` (default `nano`).
2. Writes the current buffer to `$TMPDIR/illo-compose-<pid>-<ts>.md`.
3. Disables raw mode and exits the alt screen so `$EDITOR` owns the
   terminal.
4. Spawns `<editor> <tmpfile>` with `stdio: 'inherit'`.
5. On editor exit code 0, reads the file back, replaces the compose
   buffer, pushes an undo snapshot, and rewrites the cursor at end-of-buffer.
6. Re-enters the alt screen and re-renders.
7. Deletes the tmp file.

Editor exits non-zero leave the buffer untouched and toast a warning.

## Event log filters

Default filter `low-noise` shows only `kind ∈ {ask_user, notification, sent}`.
Press `v` (in events focus) to flip to `verbose` (every kind, including
`stop`, `session_*`, `custom`).

The `x` key clears resolved events from the log view (does not delete from
the daemon — those still appear via `GET /state`).

## Troubleshooting

**"no claude pane in this window"**

You're either outside tmux or the current window doesn't have a pane
running `claude`. Open one (`tmux split-window claude`) or use `/sb-attach
<pane_id>` to point at a `claude` running in another window.

**Daemon not up**

The status dot turns red and `[reconnecting…]` appears in the status bar.
The TUI retries every second with backoff. Start the daemon manually:

```bash
node /path/to/illo/daemon/server.js &
```

**Port discovery**

Port is read from (in order):
1. `$ILLO_SIDEBAR_PORT` env var
2. `$ILLO_SIDEBAR_HOME/daemon.port` (default: `~/.claude/illo-sidebar/daemon.port`)
3. Fallback: `7821`

**Alternate terminals**

The TUI requires a terminal that supports:

- ANSI 256-color escapes
- Alternate screen buffer (`\x1b[?1049h`)
- Raw mode input

All modern terminals (kitty, alacritty, wezterm, gnome-terminal, xterm,
iTerm2) qualify.

## Browser fallback

If you can't use tmux, run `/sb-web` for the browser UI. Note that the
browser surface still uses the v0.2 layout — it's tracked separately and
will get the prompt-notepad treatment in a follow-up.
