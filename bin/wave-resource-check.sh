#!/usr/bin/env bash
# wave-resource-check.sh — hard resource brakes for wave-tick. Never bypass.
#
# Brakes:
#   load   1-min loadavg > 75% of nproc                 -> BRAKE: load
#   disk   /home free < 5 GiB                           -> BRAKE: disk
#   swap   swap used > 1024 MiB AND load brake fired    -> ABORT (no retry)
#
# Output (stdout):
#   OK
#   BRAKE: load (loadavg=X.XX threshold=Y.YY)
#   BRAKE: disk (free=NNNN MiB)
#   BRAKE: swap+load (swap=NNNN MiB loadavg=X.XX)   <- abort signal
#
# Exit codes:
#   0 = OK
#   1 = BRAKE (yield this tick, retry next)
#   2 = ABORT (swap+load combined; do not retry until human checks)
#
# Env overrides (for tests):
#   WAVE_LOADAVG_FILE     default /proc/loadavg
#   WAVE_DISK_PATH        default /home
#   WAVE_NPROC            override `nproc`
#   WAVE_FREE_CMD         override `free -m` invocation
#   WAVE_DF_CMD           override `df --output=avail -m <path>` invocation
#   WAVE_LOAD_THRESHOLD   override the 0.75*nproc threshold

set -euo pipefail

LOADAVG_FILE="${WAVE_LOADAVG_FILE:-/proc/loadavg}"
DISK_PATH="${WAVE_DISK_PATH:-/home}"
NPROC="${WAVE_NPROC:-$(nproc 2>/dev/null || printf '4')}"

# 1-min load average
if [ ! -r "$LOADAVG_FILE" ]; then
  printf 'BRAKE: loadavg-unreadable (%s)\n' "$LOADAVG_FILE"
  exit 1
fi
LOAD=$(awk '{print $1}' "$LOADAVG_FILE")

# threshold: 75% of nproc, with python for float math (POSIX-portable)
if [ -n "${WAVE_LOAD_THRESHOLD:-}" ]; then
  THRESH="$WAVE_LOAD_THRESHOLD"
else
  THRESH=$(python3 -c "print(round(0.75 * $NPROC, 2))")
fi

LOAD_BRAKE=0
if python3 -c "import sys; sys.exit(0 if float('$LOAD') > float('$THRESH') else 1)"; then
  LOAD_BRAKE=1
fi

# Disk free in MiB
if [ -n "${WAVE_DF_CMD:-}" ]; then
  FREE_MIB=$(eval "$WAVE_DF_CMD")
else
  FREE_MIB=$(df --output=avail -m "$DISK_PATH" 2>/dev/null | tail -1 | tr -d ' ' || printf '0')
fi
[ -z "$FREE_MIB" ] && FREE_MIB=0

DISK_BRAKE=0
if [ "$FREE_MIB" -lt 5120 ]; then
  DISK_BRAKE=1
fi

# Swap used (MiB)
if [ -n "${WAVE_FREE_CMD:-}" ]; then
  SWAP_MIB=$(eval "$WAVE_FREE_CMD" | awk '/^Swap:/ {print $3}')
else
  SWAP_MIB=$(free -m 2>/dev/null | awk '/^Swap:/ {print $3}' || printf '0')
fi
[ -z "$SWAP_MIB" ] && SWAP_MIB=0

# ABORT case: heavy swap + load brake combined
if [ "$LOAD_BRAKE" -eq 1 ] && [ "$SWAP_MIB" -gt 1024 ]; then
  printf 'BRAKE: swap+load (swap=%s MiB loadavg=%s)\n' "$SWAP_MIB" "$LOAD"
  exit 2
fi

if [ "$LOAD_BRAKE" -eq 1 ]; then
  printf 'BRAKE: load (loadavg=%s threshold=%s)\n' "$LOAD" "$THRESH"
  exit 1
fi

if [ "$DISK_BRAKE" -eq 1 ]; then
  printf 'BRAKE: disk (free=%s MiB)\n' "$FREE_MIB"
  exit 1
fi

printf 'OK\n'
exit 0
