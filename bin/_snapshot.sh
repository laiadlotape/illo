#!/usr/bin/env bash
# Helper: extract the last N lines of a transcript file as a single string.
# Used by the Claude Code hooks to attach a transcript_snapshot to events.
#
# Usage:
#   snapshot_lines=$(transcript_snapshot "<transcript_path>" 40)
#
# If the path is empty, missing, unreadable, or N is invalid, prints nothing
# and exits 0 — callers should treat empty output as "no snapshot available"
# and pass null/empty to the daemon.

set -u

# Print the last N lines (default 40) of the given transcript file as raw text.
# Hooks should pipe this through `jq -Rs .` (or use --arg) when embedding in
# a JSON payload to handle escaping safely.
transcript_snapshot() {
  local path="${1:-}"
  local n="${2:-40}"
  if [[ -z "$path" || ! -r "$path" ]]; then
    return 0
  fi
  case "$n" in
    ''|*[!0-9]*) n=40 ;;
  esac
  # Claude Code transcript files are JSONL — surface last N raw lines.
  tail -n "$n" "$path" 2>/dev/null || true
}
