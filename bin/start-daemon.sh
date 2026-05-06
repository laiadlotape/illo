#!/usr/bin/env bash
# Manual daemon launcher (also used by tests).
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$DIR/.." && pwd)"
exec node "$PLUGIN_ROOT/daemon/server.js" "$@"
