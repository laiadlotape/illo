# illo TUI sidebar

The illo sidebar lives in your terminal — a full-screen TUI that renders
pending agent items in the alternate screen buffer of whatever pane you give it.

## Quick start

Inside a tmux session, just run `/sb` (or `/sb-tui`) from Claude Code:

```
/sb
```

A 40%-wide vertical split opens on the right running `bin/illo-tui.js`. Claude
stays focused in your original pane. Switch to the sidebar pane with
`Prefix → o` (or whatever your tmux keybinding is).

To open it manually:

```bash
node /path/to/illo/bin/illo-tui.js
```

## Keybindings

| Key               | Action                                         |
|-------------------|------------------------------------------------|
| `j` / `↓`        | Select next item                               |
| `k` / `↑`        | Select previous item                           |
| `Enter`           | Resume selected item (queues context)          |
| `r`               | Reply — opens inline prompt at bottom          |
| `s`               | Snooze — picker: `[1]` 5m `[2]` 15m `[3]` 1h `[4]` 4h |
| `a`               | Acknowledge (suppress re-warn)                 |
| `x` / `Delete`   | Dismiss selected item                          |
| `c`               | Toggle transcript context expansion            |
| `,` / `.`         | Scroll expanded context up / down              |
| `/`               | Filter — then `(a)gent (u)rgency (k)ind (c)lear` |
| `b`               | Toggle box mode (compact single-line summary)  |
| `q` / `Ctrl-C`   | Quit TUI (restores terminal)                   |

### Reply mode

Press `r` on a selected item. The bottom bar becomes an inline text input
prefixed `reply: `. Type your reply, press `Enter` to submit, or `Esc` to cancel.

### Snooze mode

Press `s`. A picker appears at the bottom:

```
snooze: [1] 5m  [2] 15m  [3] 1h  [4] 4h  [Esc] cancel
```

Press the number or `Esc`.

### Box mode

Press `b` to collapse the TUI to a single summary line:

```
illo · 3 pending [urgent×1 normal×1 low×1] ●
```

Press any key to return to the full list.

## Outside tmux

If you run `/sb` outside a tmux session, you'll see guidance:

```
Sidebar TUI works best inside tmux. Either:

  1. Run: tmux new-session
     Then re-run: /sb

  2. Manually open another terminal pane and run:
     node /path/to/illo/bin/illo-tui.js

  3. Run /sb-web for the browser fallback
```

To auto-spawn a terminal emulator, set:

```bash
export ILLO_SIDEBAR_AUTO_TERMINAL=kitty   # or: alacritty, gnome-terminal, wezterm, xterm
```

Only explicit env var values are honored — no auto-detection.

## Browser fallback

Run `/sb-web` to open the sidebar as a browser window (chromium --app mode or
xdg-open). This is the same UI as before v0.3 and remains fully functional.

## Troubleshooting

**Daemon not up**

The TUI prints `[reconnecting…]` in the header and retries every second.
Start the daemon manually:

```bash
node /path/to/illo/daemon/server.js &
```

**Port discovery**

Port is read from (in order):
1. `$ILLO_SIDEBAR_PORT` env var
2. `$ILLO_SIDEBAR_HOME/daemon.port` (default: `~/.claude/illo-sidebar/daemon.port`)
3. Fallback: `7821`

Override for a specific port:

```bash
ILLO_SIDEBAR_PORT=7831 node bin/illo-tui.js
```

**Alternate terminal emulators**

The TUI requires a terminal that supports:
- ANSI escape codes (256-color)
- Alternate screen buffer (`\x1b[?1049h`)
- Raw mode input

All modern terminals (kitty, alacritty, wezterm, gnome-terminal, xterm, iTerm2)
qualify. The Linux tty console and some embedded terminals may not.
