# gif-record — TUI screencast skill

Record the illo prompt-notepad TUI (or any tmux window) to a gif so you can
show how each version looks in docs, READMEs, and PRs. The `/gif-record` skill
wraps two optional recording tools: **vhs** (preferred, with native keystroke
overlay) and **asciinema + agg** (fallback, no keystroke display). Neither tool
is required to load the skill — only when you actually invoke a recording.

Output goes to `docs/recordings/<name>.gif` (gitignored because binary blobs
are large). Tape scripts and cast files follow the same naming convention.

---

## Install vhs (preferred)

vhs is a single Go binary that renders declarative `.tape` scripts into gif,
webm, or mp4. It starts its own pty, types your commands, and records the
result — giving you fully repeatable, scriptable demos with native keystroke
overlay via the `Show` directive.

**macOS**

```bash
brew install vhs
brew install ffmpeg   # required by vhs for video encoding
```

**Linux — go install**

```bash
go install github.com/charmbracelet/vhs@latest
# ffmpeg also needed:
sudo apt-get install ffmpeg   # Debian/Ubuntu
# or: sudo dnf install ffmpeg  (Fedora)
```

**Linux — prebuilt binary**

Download from the [releases page](https://github.com/charmbracelet/vhs/releases):

```bash
VERSION=0.7.2   # check for latest
curl -Lo vhs.tar.gz "https://github.com/charmbracelet/vhs/releases/download/v${VERSION}/vhs_${VERSION}_Linux_x86_64.tar.gz"
tar xzf vhs.tar.gz vhs
sudo mv vhs /usr/local/bin/
sudo chmod +x /usr/local/bin/vhs
```

**Linux — apt (where packaged)**

```bash
sudo apt-get install vhs   # available in some distros; check your package list
```

---

## Install asciinema + agg (fallback)

asciinema records a live interactive terminal session. agg converts the
resulting `.cast` file to a gif. Neither tool shows keystrokes natively.

```bash
pip install asciinema
cargo install --git https://github.com/asciinema/agg
```

Or via distro packages where available:

```bash
sudo apt-get install asciinema   # Debian/Ubuntu
# agg still needs: cargo install --git https://github.com/asciinema/agg
```

---

## Quick start

```bash
# Let the skill pick the best available tool automatically:
/gif-record

# Named recording:
/gif-record --name v0.3-demo

# Use a custom tape script (recommended for repeatable demos):
/gif-record --name my-demo --tape docs/recordings/.tape-examples/sidebar-demo.tape

# Force asciinema fallback:
/gif-record --tool asciinema --name quick-capture
```

---

## Author a .tape script for repeatable demos

A `.tape` script tells vhs exactly what to type, when to pause, and what the
output should look like. Run `/gif-record --name foo` once to generate a
template at `docs/recordings/foo.tape`, then edit it.

**Worked example — illo sidebar demo**

```tape
Output docs/recordings/sidebar-demo.gif
Set Theme "Catppuccin Mocha"
Set FontSize 14
Set Width 1200
Set Height 700
Set TypingSpeed 60ms
Set Shell "bash"

# Show causes vhs to render keystrokes visually as they are typed
Show

# Open a tmux session with the sidebar already running
Type "tmux new-session -d -s demo && tmux send-keys -t demo 'node bin/illo-tui.js' Enter"
Enter
Sleep 500ms

Type "tmux attach -t demo"
Enter
Sleep 2s

# Type a prompt in the compose buffer
Type "Claude, please confirm the migration plan before running."
Sleep 500ms

# Ctrl-S sends to the claude pane without pressing Enter
Ctrl+S
Sleep 1s

# Done — the gif captures the compose → send flow
```

Store finished scripts under `docs/recordings/.tape-examples/` and commit them
(they are small text files). The generated gifs in `docs/recordings/` are
gitignored.

Full vhs guide: https://github.com/charmbracelet/vhs

---

## Where output lands

```
docs/recordings/
  <name>.gif        gitignored — share out-of-band or host on a CDN
  <name>.webm       gitignored
  <name>.mp4        gitignored
  <name>.cast       gitignored (asciinema cast)
  <name>.tape       not gitignored — commit if you want the script tracked

  .tape-examples/   tracked — store reference .tape scripts here
    sidebar-demo.tape
    v0.3-compose-send.tape
```

The `.gitignore` rule:

```gitignore
docs/recordings/*.gif
docs/recordings/*.webm
docs/recordings/*.mp4
docs/recordings/*.cast
```

`docs/recordings/.tape-examples/` is intentionally NOT listed and therefore
tracked by git.

---

## Troubleshooting

**vhs: `ffmpeg not found`**

vhs requires ffmpeg for video encoding even when the output is a gif.

```bash
brew install ffmpeg          # macOS
sudo apt-get install ffmpeg  # Debian/Ubuntu
sudo dnf install ffmpeg      # Fedora
```

**vhs: `font not found` or garbled output**

Install a nerd font and set `Set FontFamily "JetBrainsMono Nerd Font"` (or any
monospace nerd font) in your tape. The default font may not be available
in your vhs build.

**asciinema does not capture keystrokes**

This is by design — asciinema records terminal output, not input. For keystroke
overlay, use vhs with the `Show` directive.

**agg not found after `cargo install`**

Make sure `~/.cargo/bin` is on your `PATH`:

```bash
export PATH="$HOME/.cargo/bin:$PATH"
```

Add that line to your shell profile (`.bashrc`, `.zshrc`, etc.) to make it
permanent.

**Permission denied on gif-record.sh**

```bash
chmod +x bin/gif-record.sh
```
