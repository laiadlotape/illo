#!/usr/bin/env bash
# illo-demo.sh — scripted demo runner for illo-sidebar.
#
# Runs a scenario (.jsonl file from bin/demo-scenarios/) against the live daemon.
# The daemon must already be running; this script discovers its port from
# ~/.claude/illo-sidebar/daemon.port (or the --port flag).
#
# Usage:
#   illo-demo.sh                        # run 'typical' scenario at 1× speed
#   illo-demo.sh --port 7821            # explicit port
#   illo-demo.sh --speed 2              # 2× speed (halves all delays)
#   illo-demo.sh --scenario chaotic     # pick a scenario
#   illo-demo.sh --list                 # list available scenarios
#
# Scenario file format (one JSON object per line):
#   {"after_ms": 0, "event": { ...full v0.2 event envelope... }}
#   {"after_ms": 1500, "action": "focus",  "by_index": 0}
#   {"after_ms": 800,  "action": "snooze", "by_index": 1, "seconds": 600}
#   {"after_ms": 500,  "action": "reply",  "by_index": 0, "text": "yes"}
#
# by_index refers to the creation order of items created during the scenario.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCENARIOS_DIR="$SCRIPT_DIR/demo-scenarios"
ILLO_HOME="${ILLO_SIDEBAR_HOME:-${HOME}/.claude/illo-sidebar}"

# ---------- defaults ----------
PORT=""
SPEED=1
SCENARIO="typical"
LIST_ONLY=0

# ---------- argument parsing ----------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)    PORT="$2";     shift 2 ;;
    --speed)   SPEED="$2";   shift 2 ;;
    --scenario) SCENARIO="$2"; shift 2 ;;
    --list)    LIST_ONLY=1;  shift ;;
    -h|--help)
      sed -n '/^# illo-demo.sh/,/^[^#]/p' "$0" | head -n 20 | grep '^#' | sed 's/^# \?//'
      exit 0 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

# ---------- list mode ----------
if [[ "$LIST_ONLY" -eq 1 ]]; then
  echo "Available scenarios:"
  for f in "$SCENARIOS_DIR"/*.jsonl; do
    [[ -e "$f" ]] || continue
    name="$(basename "$f" .jsonl)"
    count="$(wc -l < "$f" 2>/dev/null || echo '?')"
    echo "  $name  ($count steps)"
  done
  exit 0
fi

# ---------- port discovery ----------
if [[ -z "$PORT" ]]; then
  PORT_FILE="$ILLO_HOME/daemon.port"
  if [[ -f "$PORT_FILE" ]]; then
    PORT="$(cat "$PORT_FILE")"
  else
    echo "ERROR: daemon port file not found at $PORT_FILE" >&2
    echo "  Start the daemon first, or pass --port explicitly." >&2
    exit 1
  fi
fi

BASE_URL="http://127.0.0.1:${PORT}"

# Verify daemon is alive.
if ! curl -sS -m 2 "${BASE_URL}/healthz" > /dev/null 2>&1; then
  echo "ERROR: daemon not reachable at $BASE_URL" >&2
  exit 1
fi

# ---------- scenario file ----------
SCENARIO_FILE="$SCENARIOS_DIR/${SCENARIO}.jsonl"
if [[ ! -f "$SCENARIO_FILE" ]]; then
  echo "ERROR: scenario file not found: $SCENARIO_FILE" >&2
  echo "  Use --list to see available scenarios." >&2
  exit 1
fi

echo "=== illo-demo: scenario=$SCENARIO speed=${SPEED}x port=$PORT ==="

# ---------- runner ----------
# Track created item IDs in order.
declare -a ITEM_IDS=()
STEP=0

post_json() {
  local path="$1" body="$2"
  curl -sS -m 10 -X POST \
    -H 'Content-Type: application/json' \
    --data "$body" \
    "${BASE_URL}${path}"
}

# Sleep for after_ms / speed (minimum 0).
sleep_ms() {
  local ms="$1"
  # Use bc for floating-point division.
  local secs
  secs="$(echo "scale=3; $ms / ($SPEED * 1000)" | bc 2>/dev/null || echo 0)"
  # Strip negative or zero.
  if [[ "$(echo "$secs > 0.001" | bc 2>/dev/null || echo 0)" -eq 1 ]]; then
    sleep "$secs"
  fi
}

while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" ]] && continue
  [[ "$line" == \#* ]] && continue

  STEP=$((STEP + 1))

  # Parse after_ms
  after_ms="$(echo "$line" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('after_ms',0))" 2>/dev/null || echo 0)"
  step_type="$(echo "$line" | python3 -c "import json,sys; d=json.load(sys.stdin); print('event' if 'event' in d else d.get('action','unknown'))" 2>/dev/null || echo unknown)"

  sleep_ms "$after_ms"

  if [[ "$step_type" == "event" ]]; then
    event_body="$(echo "$line" | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(d['event']))" 2>/dev/null)"
    resp="$(post_json /event "$event_body")"
    item_id="$(echo "$resp" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('item',{}).get('id','') or '')" 2>/dev/null || echo '')"
    kind="$(echo "$event_body" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('kind','?'))" 2>/dev/null || echo '?')"
    # Title: prefer explicit title, then message, then first question, then snippet.
    title="$(echo "$event_body" | python3 -c "
import json,sys
d=json.load(sys.stdin)
t = d.get('title') or d.get('message') or ''
if not t:
    qs = (d.get('tool_input') or {}).get('questions', [])
    t = qs[0].get('question', '') if qs else ''
if not t:
    t = d.get('snippet', '')
print(str(t)[:60])
" 2>/dev/null || echo '')"

    if [[ -n "$item_id" ]]; then
      ITEM_IDS+=("$item_id")
      echo "  step $STEP [+${after_ms}ms] event $kind → id=${item_id} \"${title}\""
    else
      echo "  step $STEP [+${after_ms}ms] event $kind (no item created)"
    fi
  else
    # Action on an existing item by index.
    by_index="$(echo "$line" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('by_index',0))" 2>/dev/null || echo 0)"
    if [[ "$by_index" -lt "${#ITEM_IDS[@]}" ]]; then
      target_id="${ITEM_IDS[$by_index]}"

      case "$step_type" in
        focus)
          post_json "/items/${target_id}/focus" '{}' > /dev/null
          echo "  step $STEP [+${after_ms}ms] focus item[$by_index]=$target_id"
          ;;
        snooze)
          secs="$(echo "$line" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('seconds',60))" 2>/dev/null || echo 60)"
          post_json "/items/${target_id}/snooze" "{\"seconds\":${secs}}" > /dev/null
          echo "  step $STEP [+${after_ms}ms] snooze item[$by_index]=$target_id for ${secs}s"
          ;;
        reply)
          text="$(echo "$line" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('text','ok'))" 2>/dev/null || echo ok)"
          text_json="$(python3 -c "import json; print(json.dumps('$text'))" 2>/dev/null || echo '"ok"')"
          post_json "/items/${target_id}/reply" "{\"text\":${text_json}}" > /dev/null
          echo "  step $STEP [+${after_ms}ms] reply item[$by_index]=$target_id \"${text}\""
          ;;
        *)
          echo "  step $STEP [+${after_ms}ms] unknown action: $step_type" >&2
          ;;
      esac
    else
      echo "  step $STEP [+${after_ms}ms] WARN: by_index=$by_index out of range (${#ITEM_IDS[@]} items created so far)" >&2
    fi
  fi
done < "$SCENARIO_FILE"

echo "=== illo-demo: scenario complete (${STEP} steps, ${#ITEM_IDS[@]} items created) ==="
