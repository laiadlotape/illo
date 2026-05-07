#!/usr/bin/env bash
# gif-record.sh — Record the current tmux window to a gif (or cast).
# Uses vhs (preferred) or asciinema+agg (fallback). Both are optional.
# Usage: gif-record.sh [--name <name>] [--cmd <command>] [--width 1200]
#                      [--height 700] [--out docs/recordings]
#                      [--tool vhs|asciinema|auto] [--tape <file>]
set -euo pipefail

# ---------- defaults ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

NAME=""
CMD=""
WIDTH=1200
HEIGHT=700
FONT_SIZE=14
OUT="${PLUGIN_ROOT}/docs/recordings"
TOOL="auto"
TAPE_FILE=""

# ---------- helpers ----------
usage() {
  cat <<'EOF'
gif-record.sh — Record the current tmux window to a gif with keystroke overlay.

USAGE
  gif-record.sh [options]

OPTIONS
  --name <name>        Output base name (default: gif-record-YYYYMMDD-HHMMSS)
  --tape <file>        Use a custom .tape script (vhs only); skip template generation
  --cmd <command>      Command to run inside the recording (vhs: written into tape)
  --width <px>         Terminal width in pixels (default: 1200; vhs only)
  --height <px>        Terminal height in pixels (default: 700; vhs only)
  --out <dir>          Output directory (default: <plugin-root>/docs/recordings)
  --tool vhs|asciinema|auto
                       Recording backend (default: auto — prefer vhs)
  --help               Print this message and exit

INSTALL
  vhs (preferred — native keystroke display via Show):
    macOS:   brew install vhs
    Linux:   go install github.com/charmbracelet/vhs@latest
             OR download binary from https://github.com/charmbracelet/vhs/releases
             OR (Ubuntu/Debian where packaged): apt-get install vhs
    Note:    vhs also needs ffmpeg — brew install ffmpeg / apt-get install ffmpeg

  asciinema + agg (fallback — no native keystroke display):
    pip install asciinema
    cargo install --git https://github.com/asciinema/agg
    OR: apt-get install asciinema  (agg still needs cargo)

OUTPUT
  Recordings land in docs/recordings/<name>.gif  (gitignored — large binary blobs)
  Tape scripts land in docs/recordings/<name>.tape (tracked if you choose to commit)
  Cast files land in docs/recordings/<name>.cast  (gitignored)

CUSTOM TAPE SCRIPTS
  Pass --tape <file> to use your own .tape script for repeatable demos.
  See: https://github.com/charmbracelet/vhs#vhs-guide
EOF
}

die() {
  echo "gif-record: error: $*" >&2
  exit 1
}

require_dir() {
  local d="$1"
  mkdir -p "$d" || die "cannot create output dir: $d"
}

check_vhs() {
  command -v vhs >/dev/null 2>&1
}

check_asciinema() {
  command -v asciinema >/dev/null 2>&1
}

check_agg() {
  command -v agg >/dev/null 2>&1
}

# ---------- arg parsing ----------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)    NAME="$2";      shift 2 ;;
    --tape)    TAPE_FILE="$2"; shift 2 ;;
    --cmd)     CMD="$2";       shift 2 ;;
    --width)   WIDTH="$2";     shift 2 ;;
    --height)  HEIGHT="$2";    shift 2 ;;
    --out)     OUT="$2";       shift 2 ;;
    --tool)    TOOL="$2";      shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

# --help is the smoke-test gate: it must work even with no recorder installed.
# (handled above)

# ---------- tool selection ----------
if [[ "$TOOL" == "auto" ]]; then
  if check_vhs; then
    TOOL="vhs"
  elif check_asciinema && check_agg; then
    TOOL="asciinema"
  else
    echo "gif-record: no recorder found." >&2
    echo "" >&2
    echo "Install one of:" >&2
    echo "" >&2
    echo "  vhs (preferred — native keystroke display):" >&2
    echo "    macOS:  brew install vhs && brew install ffmpeg" >&2
    echo "    Linux:  go install github.com/charmbracelet/vhs@latest" >&2
    echo "            OR download from https://github.com/charmbracelet/vhs/releases" >&2
    echo "" >&2
    echo "  asciinema + agg (fallback — no keystroke display):" >&2
    echo "    pip install asciinema" >&2
    echo "    cargo install --git https://github.com/asciinema/agg" >&2
    echo "" >&2
    echo "Then re-run gif-record.sh." >&2
    exit 1
  fi
fi

# Validate explicit tool choice
case "$TOOL" in
  vhs)
    check_vhs || die "vhs not found. Install: brew install vhs (macOS) or go install github.com/charmbracelet/vhs@latest (Linux)"
    ;;
  asciinema)
    check_asciinema || die "asciinema not found. Install: pip install asciinema"
    check_agg       || die "agg not found. Install: cargo install --git https://github.com/asciinema/agg"
    ;;
  *)
    die "unknown --tool value: $TOOL (must be vhs, asciinema, or auto)"
    ;;
esac

# ---------- default name ----------
if [[ -z "$NAME" ]]; then
  NAME="gif-record-$(date '+%Y%m%d-%H%M%S')"
fi

# ---------- ensure output dir exists ----------
require_dir "$OUT"

# ---------- record ----------
echo "gif-record: tool=$TOOL  name=$NAME  out=$OUT"

case "$TOOL" in
  vhs)
    TAPE="${OUT}/${NAME}.tape"
    GIF="${OUT}/${NAME}.gif"

    if [[ -n "$TAPE_FILE" ]]; then
      # Use the caller's tape file; copy to output dir so everything is together.
      if [[ ! -f "$TAPE_FILE" ]]; then
        die "tape file not found: $TAPE_FILE"
      fi
      TAPE="$TAPE_FILE"
      echo "gif-record: using custom tape: $TAPE"
    else
      # Generate a placeholder tape script.
      DISPLAY_CMD="${CMD:-echo 'this is a placeholder — pass your own .tape via --tape <file>'}"
      cat >"$TAPE" <<TAPE_EOF
Output ${GIF}
Set Theme "Catppuccin Mocha"
Set FontSize ${FONT_SIZE}
Set Width ${WIDTH}
Set Height ${HEIGHT}
Set TypingSpeed 50ms
Set Shell "bash"
Show
Type "${DISPLAY_CMD}"
Sleep 1s
Enter
Sleep 1s
TAPE_EOF
      echo "gif-record: generated tape at $TAPE"
      echo "gif-record: tip — edit the tape to script your exact keystrokes, then re-run"
      echo "gif-record: tip — or pass --tape <your-script.tape> to skip template generation"
    fi

    echo "gif-record: running vhs ..."
    vhs "$TAPE"
    echo "gif-record: done — $GIF"
    ;;

  asciinema)
    CAST="${OUT}/${NAME}.cast"
    GIF="${OUT}/${NAME}.gif"

    echo "gif-record: NOTE — asciinema does not capture keystrokes natively."
    echo "gif-record: For keystroke overlay, install vhs instead."
    echo ""

    if [[ -n "$CMD" ]]; then
      asciinema rec --command "$CMD" "$CAST"
    else
      echo "gif-record: starting interactive asciinema session (Ctrl-D or 'exit' to stop)"
      asciinema rec "$CAST"
    fi

    echo "gif-record: converting cast → gif with agg ..."
    agg "$CAST" "$GIF"
    echo "gif-record: done — $GIF"
    echo "gif-record: cast preserved at $CAST"
    ;;
esac
