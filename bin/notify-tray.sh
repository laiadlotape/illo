#!/usr/bin/env bash
# illo-sidebar — OS-level tray notification helper (v0.2)
#
# Usage:
#   bin/notify-tray.sh --title "Title" --body "Body text" --urgency low|normal|urgent
#
# On Linux: delegates to notify-send (libnotify).
# On macOS: uses osascript.
# Exits 0 silently when the required tools are not available.

set -euo pipefail

TITLE=""
BODY=""
URGENCY="normal"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --title)   TITLE="$2";   shift 2 ;;
    --body)    BODY="$2";    shift 2 ;;
    --urgency) URGENCY="$2"; shift 2 ;;
    *) shift ;;
  esac
done

OS="$(uname -s 2>/dev/null || true)"

case "$OS" in
  Linux)
    if command -v notify-send >/dev/null 2>&1; then
      # Map urgency to libnotify levels: low -> low, normal -> normal, urgent -> critical
      case "$URGENCY" in
        urgent) NS_URGENCY="critical" ;;
        low)    NS_URGENCY="low" ;;
        *)      NS_URGENCY="normal" ;;
      esac
      notify-send --urgency="$NS_URGENCY" -- "$TITLE" "$BODY" || true
    fi
    ;;
  Darwin)
    if command -v osascript >/dev/null 2>&1; then
      # Escape single quotes for AppleScript
      SAFE_BODY="${BODY//\'/\'}"
      SAFE_TITLE="${TITLE//\'/\'}"
      osascript -e "display notification \"$SAFE_BODY\" with title \"$SAFE_TITLE\"" || true
    fi
    ;;
  *)
    # Unknown OS — silent no-op
    ;;
esac

exit 0
