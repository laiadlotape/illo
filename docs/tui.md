# illo TUI — prompt notepad

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
│ prompt · lines: 4 · words: 23 · *unsaved · wrap:on          │  prompt status
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ Claude, after looking at the migration script,          │ │  prompt pane
│ │   1. Verify backup at /backups/users-2026-05-06         │ │  (~2/3)
│ │   2. Run rollback if any row count differs█             │ │
│ └─────────────────────────────────────────────────────────┘ │
│ Ctrl-S send · Ctrl-D send+Enter · Ctrl-E $EDITOR · Ctrl-Z …│  hint row 1 (primary)
│ Ctrl-W word-back · Ctrl-U line-back · Ctrl-K kill-EOL · … │  hint row 2 (secondary)
└─────────────────────────────────────────────────────────────┘
```

The events log takes ~1/3 of the available rows; the prompt pane takes ~2/3. On
narrow terminals (< 24 rows), the events log shrinks to 4 rows so the prompt
pane keeps the room. The two-row hint footer is always visible at the bottom.

## Quick start

Inside tmux, from Claude Code:

```
/illo
```

A 40%-wide vertical split opens on the right running `bin/illo-tui.js`.
Switch to the sidebar pane with `Prefix → o` (or your tmux keybinding).

To launch manually:

```bash
node /path/to/illo/bin/illo-tui.js
```

## Keybindings

Press `?` at any time to open the full keybindings help overlay. `Esc` or `?`
closes it.

### Prompt pane (focus: compose)

| Key | Action |
|---|---|
| Printable / UTF-8 | Insert at cursor |
| `Tab` | Insert two spaces |
| `Enter` | Newline (auto-indent to match leading whitespace) |
| `Backspace` | Delete char left (joins lines at col 0) |
| `Delete` | Delete char right (joins next line at end) |
| `←` `→` `↑` `↓` | Move cursor (with line-wrap on horizontal motion) |
| `Ctrl-←` / `Ctrl-→` | Jump cursor left / right by one word (`[A-Za-z0-9_]` boundary); wraps to prev/next line at line boundaries. Word boundaries use identifier semantics (`[A-Za-z0-9_]`) for all word-delete and word-jump operations. |
| `Ctrl-↑` / `Ctrl-↓` | Focus toggle: move focus to events log / back to compose (works from any pane) |
| `Ctrl-Shift-↑` / `Ctrl-Shift-↓` | Paragraph motion in prompt pane: jump to previous / next blank line (`\x1b[1;6A` / `\x1b[1;6B`) |
| `Home` / `End` | Beginning / end of line |
| `PgUp` / `PgDn` | Scroll one screen |
| `Ctrl-A` | Beginning of line (alias for `Home`) |
| `Ctrl-W` / `Ctrl-Backspace` / `Alt-Backspace` | Delete word backward |
| `Ctrl-Delete` / `Alt-D` | Delete word forward |
| `Shift-↑` | Move current line up |
| `Shift-↓` | Move current line down |
| `Alt-Shift-↑` | Duplicate current line upward (cursor stays on upper copy) |
| `Alt-Shift-↓` | Duplicate current line downward (cursor moves to the copy) |
| `Ctrl-Home` | Jump to buffer start (row 0, col 0) |
| `Ctrl-End` | Jump to buffer end (last row, end of line) |
| `Ctrl-U` | Delete from cursor backward to beginning of line |
| `Ctrl-K` | Kill to end of line (or join next line at EOL) |
| `Ctrl-Z` | Undo |
| `Ctrl-Y` | Redo |
| `Ctrl-L` | Force-redraw |
| `Ctrl-S` | **Send to claude pane** (no auto-Enter — review and submit yourself) |
| `Ctrl-D` | Send + press Enter (skip the human review step) |
| `Ctrl-E` | Open `$EDITOR` (or `nano`) on the buffer |
| `Ctrl-X` | Clear prompt buffer |
| `Ctrl-\` / `Alt-w` | Toggle line wrap on/off (preference persisted to `tui-prefs.json`) |
| `?` | Open full keybindings help overlay |
| `Ctrl-Q` | Quit (also `Ctrl-C`) |

### Events log (focus: events)

| Key | Action |
|---|---|
| `j` / `↓` | Scroll one event toward older |
| `k` / `↑` | Scroll one event toward newer (wraps the tail) |
| `PgUp` / `PgDn` | Scroll five events |
| `v` | Toggle filter: low-noise (default) ↔ verbose |
| `x` | Clear resolved events from the log view |
| `r` | Toggle session recording (asciinema → gif via `agg`). Recordings go to `~/.claude/illo-sidebar/recordings/`. `● REC` indicator appears in the status bar while active. |
| `Tab` | Toggle expand/collapse of selected event (shows full body inline; `▸`/`▾` indicator on each row) |
| `Enter` | Open event-detail popup (kind, urgency, snippet, transcript snapshot — wrapping, scrollable) |
| `Esc` / `q` | Close event-detail popup |
| `↑` / `↓` | Scroll popup content one line (while popup is open) |
| `PgUp` / `PgDn` | Scroll popup content one screen (while popup is open) |
| `Ctrl-Up` | Move focus to events log (always — works from compose too) |
| `Ctrl-Down` | Move focus back to prompt pane (always) |
| `,` | Open settings panel |
| `?` | Open full keybindings help overlay |
| `Ctrl-Q` | Quit |

### Focus toggle and paragraph motion

`Ctrl-Up` and `Ctrl-Down` are universal focus-toggle keys: they always switch
between the prompt pane and the events log regardless of which pane is
currently focused. Use `Ctrl-Shift-Up` / `Ctrl-Shift-Down` (xterm sequences
`\x1b[1;6A` / `\x1b[1;6B`) for paragraph motion (jump to previous / next blank
line) within the prompt pane.

## Hint footer

The bottom two rows of the screen are always occupied by a hint footer:

- **Row N-1 (primary)**: The key chords are in bright white (`color(255)`),
  descriptions in `color(245)`. No `dim()` attribute — readable on both dark
  and light backgrounds. Content: `Ctrl-S send · Ctrl-D send+Enter · Ctrl-E
  $EDITOR · Ctrl-Z undo · ? help`.
- **Row N (secondary)**: Contextual for the current focus pane. In prompt
  focus: movement, kill, wrap, and quit keys. In events focus: scroll,
  filter, and detail keys. `color(245)` throughout.

The secondary row is truncated gracefully if the terminal is narrow — trailing
groups are dropped first.

## Line wrap

Wrap mode controls whether long lines in the compose buffer are soft-wrapped
at the box width or scroll horizontally.

- **Default**: wrap on (`appState.compose.wrap = true`).
- **Toggle**: `Ctrl-\` (xterm sequence `0x1c`). Backup binding: `Alt-w` (for
  terminals that intercept `Ctrl-\` as SIGQUIT — e.g. some tmux configurations
  strip it). Both bindings toggle the same state.
- **Persistence**: the preference is written to
  `~/.claude/illo-sidebar/tui-prefs.json` (`{ "composeWrap": true|false }`)
  directly from the TUI. No daemon round-trip is needed because wrap is a
  purely local display preference.
- **Status bar**: `wrap:on` / `wrap:off` is shown in the prompt status line.

When wrap is on:
- Each logical line is split into visual rows using word-aware wrapping
  (`wrapLogicalLine`). The break point is the last whitespace character within
  `innerCols` columns (`cols - 4`), provided that backing up to that whitespace
  does not leave a trailing gap wider than `(1 - WORD_HARD_BREAK_RATIO) *
  innerCols` (default ratio `0.8`, so ≤ 20% trailing space is acceptable).
  Very long tokens (URLs, identifiers) that exceed the ratio threshold are
  hard-broken at the column limit instead.
- The `WORD_HARD_BREAK_RATIO = 0.8` constant is defined near the top of
  `bin/illo-tui.js` and controls how aggressively the wrapper prefers
  whitespace breaks over hard breaks.
- The cursor block (`█`) appears on the correct visual row; the render maps
  each logical column to its visual (segment, offset) pair based on actual
  word-aware break positions.
- PgUp/PgDn move by logical rows (same as before) — visual screenfuls are
  not implemented for PgUp/PgDn to keep the implementation simple.
- Vertical viewport scrolling adjusts so the cursor's visual row is always
  on screen.

When wrap is off (original behaviour): the horizontal `colOffset` is used
exactly as before — the line scrolls right as the cursor moves past the prompt
pane edge.

### Undo behavior

Edits are grouped into "typing groups": a sequence of printable inserts
within a 2-second window collapses into a single undo entry. A non-character
action (Enter, Backspace beyond the current group, kill, paste from
`$EDITOR`, etc.) opens a fresh group on the next edit. The undo stack is
capped at 100 entries; older entries are dropped silently. Redo is cleared
whenever a new edit happens after an undo.

### Pasting

The TUI enables **bracketed paste mode** (`\x1b[?2004h`) on startup and
disables it on exit (`\x1b[?2004l`). Terminals that support bracketed paste
(all modern ones do) wrap paste content in `\x1b[200~` … `\x1b[201~` markers,
which lets the TUI distinguish paste from keystroke-by-keystroke input.

Paste behaviour:

- **ANSI escape stripping**: CSI sequences (`\x1b[…`) and OSC sequences
  (`\x1b]…\x07` / `\x1b]…\x1b\\`) are removed before insertion.
- **Newlines preserved**: `\n` splits the paste into multiple logical lines.
  `\t` is preserved as-is.
- **No auto-indent per line**: auto-indent only fires on user-pressed Enter,
  not on paste. The current line's indent is not propagated across paste lines.
- **Single undo group**: the entire paste is pushed as one undo snapshot. A
  single `Ctrl-Z` removes the full paste.
- **1 MB cap**: pastes exceeding `PASTE_MAX_BYTES = 1024 * 1024` bytes are
  silently truncated at the UTF-8 boundary before insertion.
- **Defensive**: terminals that do not support bracketed paste fall through to
  the regular keystroke path — no regression.

## Pane discovery

On startup, the TUI runs `bin/tmux-send.sh discover` which calls
`tmux list-panes` for the **current window** and returns the first pane
whose `pane_current_command` is `claude` OR whose pid's process tree
contains `claude` (excluding the illo TUI's own pane).

If the daemon's `paneOverride` config is set (via `/illo-attach`), that
wins — discovery is skipped.

If discovery returns nothing, the status bar shows
`pane: <none — /illo-attach to set>` and `Ctrl-S` toasts
`no claude pane in this window — set with /illo-attach <pane_id>`.

To pin a specific pane (or override a misdetection):

```
/illo-attach %4
```

To return to auto-detection:

```
/illo-detach
```

## Send semantics

`Ctrl-S` does the following:

1. Joins the compose buffer with `\n` into a single string `text`.
2. If empty, toasts `(nothing to send)` and returns.
3. If no `paneId` is known, retries discovery once. If still none, toasts
   the `/illo-attach` hint.
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

## Event row suffix

Each event row shows a dimmed suffix with session age, project name, and git branch (configurable in the settings panel or `docs/config.md`). For example: `· 2m · my-project · feat/pr4a`. Fields are enabled individually via `display.showSessionAge`, `display.showProject`, `display.showBranch`, and `display.showCwd`.

## Event log filters

Default filter is `low-noise`. Only attention-worthy items surface:

| Kind | Passes low-noise? |
|---|---|
| `ask_user` | Always |
| `sent` | Always |
| `notification` with `urgency: 'urgent'` | Yes |
| `notification` with `subkind: 'permission_prompt'` | Yes (security gates always surface) |
| `notification` with any other urgency (`low`, `normal`) | No — filtered out |
| `stop`, `session_start`, `session_end`, `user_prompt`, `ask_user_answered`, `custom`, `idle` | No |

Press `v` (in events focus) to flip to `verbose` (every kind, including
`stop`, `session_*`, `custom`, and all notification urgencies).

The `x` key clears resolved events from the log view and POSTs to `/clear` so
the daemon removes them server-side. A toast shows how many were removed.

## Session recording

Press `r` (in events focus) to start or stop a live recording of the full tmux
window — capturing both the Claude pane and the illo sidebar in one view.

- **`r`** — toggle recording on/off. The status bar shows `● REC` (bold red) while active.
- Recordings are saved to `~/.claude/illo-sidebar/recordings/session-YYYYMMDD-HHMMSS.cast`.
- On stop, `agg` converts the cast to a `.gif` automatically (if installed).
- To convert an existing cast manually: `bash bin/record.sh gif <cast-file>`.

The recording uses **asciinema** attached read-only to the current tmux session
via an isolated socket — it does not interfere with your session.

**Requirements:** `asciinema` and `agg`. Install:

```bash
pip install asciinema
cargo install --git https://github.com/asciinema/agg
```

You can also start/stop from outside the TUI:

```bash
bash bin/record.sh start   # start
bash bin/record.sh stop    # stop + auto-gif
bash bin/record.sh status  # check if recording
```

## Settings panel

Press `,` from any focus to open the interactive settings panel. All changes
are held in a draft until you explicitly save or cancel.

### Sections

| Section | Contents |
|---|---|
| **Display** | Toggles for `showSessionAge`, `showProject`, `showBranch`, `showCwd`, `expandSentByDefault` |
| **Filters** | Cycle `defaultMode` between `low-noise` and `verbose` |
| **Compose** | Toggle `wrap` (word-wrap in compose buffer) |
| **Keybindings** | Read-only placeholder — keybinding overrides coming in a future release |
| **About** | illo version, config file path, homepage URL |

### Keys inside the settings panel

| Key | Action |
|---|---|
| `j` / `↓` | Move cursor down (wraps to next section) |
| `k` / `↑` | Move cursor up (wraps to previous section) |
| `Tab` | Jump to the next section |
| `Space` / `→` / `←` | Toggle boolean / cycle value for highlighted row |
| `s` | Save draft to `~/.claude/illo/config.json` and close |
| `r` | Revert draft to the last saved values |
| `d` | Reset draft to compiled defaults (press `s` to confirm) |
| `Esc` / `,` | Cancel and close without saving |

Settings are written to `~/.claude/illo/config.json` — the same file you can
hand-edit between sessions. Changes take effect immediately in the running TUI
when saved via `s` (no restart needed for display toggles and filter defaults).

## Troubleshooting

**"no claude pane in this window"**

You're either outside tmux or the current window doesn't have a pane
running `claude`. Open one (`tmux split-window claude`) or use `/illo-attach
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

If you can't use tmux, run `/illo-web` for the browser UI. Note that the
browser surface still uses the v0.2 layout — it's tracked separately and
will get the prompt-notepad treatment in a follow-up.
