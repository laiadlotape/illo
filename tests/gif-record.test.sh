#!/usr/bin/env bash
# Smoke test for bin/gif-record.sh
# Verifies that --help exits 0 and prints install one-liners.
# Does NOT require vhs or asciinema to be installed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GIF_RECORD="${SCRIPT_DIR}/../bin/gif-record.sh"

# ---------- sanity ----------
[[ -f "$GIF_RECORD" ]] || { echo "FAIL: $GIF_RECORD not found" >&2; exit 1; }
[[ -x "$GIF_RECORD" ]] || { echo "FAIL: $GIF_RECORD is not executable" >&2; exit 1; }

# ---------- --help must exit 0 ----------
HELP_OUT="$("$GIF_RECORD" --help 2>&1)" || {
  echo "FAIL: gif-record.sh --help exited non-zero" >&2
  exit 1
}

# ---------- --help must contain install one-liners ----------
echo "$HELP_OUT" | grep -q "brew install vhs" || {
  echo "FAIL: --help output missing 'brew install vhs'" >&2
  echo "$HELP_OUT" >&2
  exit 1
}

echo "$HELP_OUT" | grep -q "pip install asciinema" || {
  echo "FAIL: --help output missing 'pip install asciinema'" >&2
  echo "$HELP_OUT" >&2
  exit 1
}

echo "$HELP_OUT" | grep -q "charmbracelet/vhs" || {
  echo "FAIL: --help output missing vhs release URL" >&2
  echo "$HELP_OUT" >&2
  exit 1
}

# ---------- bash -n syntax check ----------
bash -n "$GIF_RECORD" || {
  echo "FAIL: bash -n reported syntax errors in gif-record.sh" >&2
  exit 1
}

echo "GIF-RECORD HELP OK"
