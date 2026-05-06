#!/usr/bin/env bash
# tmux-send.sh — small CLI around _tmux.sh for the illo TUI to call out to.
# All subcommands exit 0 on "soft failure" (no tmux, no pane) and print an
# empty string, so the TUI can decide UX without trapping non-zero exits.
#
# Usage:
#   tmux-send.sh discover                 -> print pane id (or empty)
#   tmux-send.sh send <pane> [<text>]     -> send literal text (text from arg or stdin)
#   tmux-send.sh enter <pane>             -> send Enter
#   tmux-send.sh focus <pane>             -> select pane

set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_tmux.sh
. "$DIR/_tmux.sh"

usage() {
  cat <<'EOF'
Usage:
  tmux-send.sh discover
  tmux-send.sh send <pane> [<text>]    (reads stdin if <text> omitted)
  tmux-send.sh enter <pane>
  tmux-send.sh focus <pane>
EOF
}

cmd="${1:-}"
shift || true

case "$cmd" in
  discover)
    tmux_find_claude_pane
    ;;
  send)
    pane="${1:-}"
    shift || true
    if [[ -z "$pane" ]]; then
      echo "tmux-send.sh: send requires <pane>" >&2
      exit 2
    fi
    if [[ $# -gt 0 ]]; then
      tmux_send_text "$pane" "$*"
    else
      tmux_send_text_stdin "$pane"
    fi
    ;;
  enter)
    pane="${1:-}"
    if [[ -z "$pane" ]]; then
      echo "tmux-send.sh: enter requires <pane>" >&2
      exit 2
    fi
    tmux_send_enter "$pane"
    ;;
  focus)
    pane="${1:-}"
    if [[ -z "$pane" ]]; then
      echo "tmux-send.sh: focus requires <pane>" >&2
      exit 2
    fi
    tmux_select_pane "$pane"
    ;;
  ""|-h|--help|help)
    usage
    ;;
  *)
    echo "tmux-send.sh: unknown command '$cmd'" >&2
    usage >&2
    exit 2
    ;;
esac
