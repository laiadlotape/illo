#!/usr/bin/env bash
# illo-vcr.sh — VCR record/replay CLI for illo-sidebar.
#
# Calls the daemon's /vcr/* endpoints via curl.
#
# Usage:
#   illo-vcr.sh record start
#   illo-vcr.sh record stop <name>
#   illo-vcr.sh list
#   illo-vcr.sh replay <name> [--speed N]
#
# Port discovery: reads ~/.claude/illo-sidebar/daemon.port
# Override with ILLO_SIDEBAR_HOME or --port <port>.

set -euo pipefail

ILLO_HOME="${ILLO_SIDEBAR_HOME:-${HOME}/.claude/illo-sidebar}"
PORT=""
SPEED=1

# ---------- helpers ----------
usage() {
  cat >&2 <<'EOF'
Usage:
  illo-vcr.sh record start
  illo-vcr.sh record stop <name>
  illo-vcr.sh list
  illo-vcr.sh replay <name> [--speed N]
  illo-vcr.sh --port <port> ...

Calls the daemon VCR endpoints.
EOF
  exit 1
}

post_json() {
  local path="$1"
  local body="${2-}"
  [[ -z "$body" ]] && body='{}'
  curl -sS -m 30 -X POST \
    -H 'Content-Type: application/json' \
    --data "$body" \
    "http://127.0.0.1:${PORT}${path}"
}

get_json() {
  local path="$1"
  curl -sS -m 10 "http://127.0.0.1:${PORT}${path}"
}

resolve_port() {
  if [[ -n "$PORT" ]]; then return; fi
  local port_file="$ILLO_HOME/daemon.port"
  if [[ -f "$port_file" ]]; then
    PORT="$(cat "$port_file")"
  else
    echo "ERROR: daemon port file not found: $port_file" >&2
    echo "  Start the daemon first, or pass --port explicitly." >&2
    exit 1
  fi
}

# ---------- argument parsing ----------
[[ $# -eq 0 ]] && usage

# Peek for --port anywhere in args
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --speed) SPEED="$2"; shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
set -- "${args[@]:-}"

resolve_port

CMD="${1:-}"
shift || true

case "$CMD" in
  record)
    SUB="${1:-}"
    shift || true
    case "$SUB" in
      start)
        resp="$(post_json /vcr/record/start '{}')"
        echo "$resp"
        ;;
      stop)
        NAME="${1:-unnamed}"
        resp="$(post_json /vcr/record/stop "$(printf '{"name":"%s"}' "$NAME")")"
        echo "$resp"
        ;;
      *)
        echo "Usage: illo-vcr.sh record start|stop [name]" >&2
        exit 1
        ;;
    esac
    ;;
  list)
    resp="$(get_json /vcr/list)"
    # Pretty print if python3 available, else raw.
    if command -v python3 &>/dev/null; then
      echo "$resp" | python3 -c "
import json, sys
d = json.load(sys.stdin)
recs = d.get('recordings', [])
if not recs:
    print('(no recordings)')
else:
    print(f'{'NAME':<30} {'SIZE':>8}  MTIME')
    for r in sorted(recs, key=lambda x: x.get('mtime', 0)):
        import datetime
        mt = datetime.datetime.fromtimestamp(r['mtime']/1000).strftime('%Y-%m-%d %H:%M')
        print(f\"{r['name']:<30} {r['size']:>8}  {mt}\")
"
    else
      echo "$resp"
    fi
    ;;
  replay)
    NAME="${1:-}"
    [[ -z "$NAME" ]] && { echo "Usage: illo-vcr.sh replay <name> [--speed N]" >&2; exit 1; }
    body="$(printf '{"name":"%s","speed":%s}' "$NAME" "$SPEED")"
    resp="$(post_json /vcr/replay "$body")"
    echo "$resp"
    ;;
  -h|--help)
    usage
    ;;
  *)
    echo "Unknown command: $CMD" >&2
    usage
    ;;
esac
