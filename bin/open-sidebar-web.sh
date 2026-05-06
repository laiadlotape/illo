#!/usr/bin/env bash
# Open the sidebar UI in a browser window pinned to the right of the screen.
# This is the explicit browser fallback for illo-sidebar (use /sb-web to invoke).
# Tries chromium-family --app mode for a chromeless window, falls back to xdg-open.
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$DIR/_lib.sh"

ensure_daemon || true
PORT=$(daemon_port)
URL="http://127.0.0.1:${PORT}/"

# Pick a sensible "right sidebar" geometry. ~420px wide, full height.
# Users can re-pin via WM if needed; this is just a starting position.
WIDTH=420
HEIGHT=1000
# Heuristic: position near right edge of a typical 1920x1080 display.
# (We can't query screen size portably from a hook script.)
POS_X=$((1920 - WIDTH - 8))
POS_Y=8

OVERRIDE="${ILLO_SIDEBAR_BROWSER:-}"
CANDIDATES=()
if [[ -n "$OVERRIDE" ]]; then
  CANDIDATES+=("$OVERRIDE")
fi
CANDIDATES+=(google-chrome chromium chromium-browser brave-browser microsoft-edge firefox)

for cmd in "${CANDIDATES[@]}"; do
  if command -v "$cmd" >/dev/null 2>&1; then
    case "$cmd" in
      firefox)
        # Firefox doesn't support --app, so just open a normal window.
        nohup "$cmd" --new-window "$URL" >/dev/null 2>&1 &
        disown || true
        exit 0
        ;;
      *)
        nohup "$cmd" \
          --app="$URL" \
          --window-size="${WIDTH},${HEIGHT}" \
          --window-position="${POS_X},${POS_Y}" \
          --user-data-dir="$STATE_DIR/browser-profile" \
          >/dev/null 2>&1 &
        disown || true
        exit 0
        ;;
    esac
  fi
done

# Last-resort fallback.
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" >/dev/null 2>&1 &
  disown || true
fi
exit 0
