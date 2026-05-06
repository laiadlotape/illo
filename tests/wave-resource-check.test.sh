#!/usr/bin/env bash
# wave-resource-check.test.sh — fake /proc/loadavg, df, free; assert each
# brake fires correctly and the OK path passes through.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RC_SH="$PROJECT_ROOT/bin/wave-resource-check.sh"

pass() { printf '\033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '\033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

# 1. syntax-clean
if bash -n "$RC_SH"; then
  pass "bin/wave-resource-check.sh passes bash -n"
else
  fail "bin/wave-resource-check.sh failed bash -n"
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# Helper: run with synthetic env, capture output + exit code
run_rc() {
  local out exit_code
  out=$("$@" 2>&1)
  exit_code=$?
  printf '%s\n%d\n' "$out" "$exit_code"
}

# Build a fake /proc/loadavg (just need a 1-min field)
make_loadavg() {
  local val="$1"
  local f="$WORK/loadavg.$val"
  printf '%s 0.50 0.50 1/200 12345\n' "$val" >"$f"
  printf '%s' "$f"
}

# ── case A: OK (low load, ample disk, no swap)
LA=$(make_loadavg "1.00")
OUT=$(WAVE_LOADAVG_FILE="$LA" \
      WAVE_NPROC=12 \
      WAVE_DF_CMD='echo 100000' \
      WAVE_FREE_CMD='printf "Swap: 1024 0 1024\n"' \
      bash "$RC_SH" 2>&1)
EC=$?
if [[ "$EC" == "0" && "$OUT" == "OK" ]]; then
  pass "case OK: clean output, exit 0"
else
  fail "case OK: expected 'OK' exit 0, got: '$OUT' exit $EC"
fi

# ── case B: load brake (loadavg above 75% of nproc)
LA=$(make_loadavg "10.50")
OUT=$(WAVE_LOADAVG_FILE="$LA" \
      WAVE_NPROC=12 \
      WAVE_DF_CMD='echo 100000' \
      WAVE_FREE_CMD='printf "Swap: 1024 0 1024\n"' \
      bash "$RC_SH" 2>&1)
EC=$?
if [[ "$EC" == "1" ]] && grep -q "BRAKE: load" <<<"$OUT"; then
  pass "case load brake: exit 1, message '$OUT'"
else
  fail "case load brake: expected exit 1 + 'BRAKE: load', got exit $EC '$OUT'"
fi

# ── case C: disk brake (under 5 GiB free)
LA=$(make_loadavg "1.00")
OUT=$(WAVE_LOADAVG_FILE="$LA" \
      WAVE_NPROC=12 \
      WAVE_DF_CMD='echo 1024' \
      WAVE_FREE_CMD='printf "Swap: 1024 0 1024\n"' \
      bash "$RC_SH" 2>&1)
EC=$?
if [[ "$EC" == "1" ]] && grep -q "BRAKE: disk" <<<"$OUT"; then
  pass "case disk brake: exit 1, message '$OUT'"
else
  fail "case disk brake: expected exit 1 + 'BRAKE: disk', got exit $EC '$OUT'"
fi

# ── case D: swap+load combined → ABORT (exit 2)
LA=$(make_loadavg "10.50")
OUT=$(WAVE_LOADAVG_FILE="$LA" \
      WAVE_NPROC=12 \
      WAVE_DF_CMD='echo 100000' \
      WAVE_FREE_CMD='printf "Swap: 4096 2048 2048\n"' \
      bash "$RC_SH" 2>&1)
EC=$?
if [[ "$EC" == "2" ]] && grep -q "BRAKE: swap+load" <<<"$OUT"; then
  pass "case swap+load abort: exit 2, message '$OUT'"
else
  fail "case swap+load abort: expected exit 2 + 'BRAKE: swap+load', got exit $EC '$OUT'"
fi

# ── case E: swap alone (heavy swap, low load) → still OK (no abort, no brake)
LA=$(make_loadavg "1.00")
OUT=$(WAVE_LOADAVG_FILE="$LA" \
      WAVE_NPROC=12 \
      WAVE_DF_CMD='echo 100000' \
      WAVE_FREE_CMD='printf "Swap: 4096 2048 2048\n"' \
      bash "$RC_SH" 2>&1)
EC=$?
if [[ "$EC" == "0" && "$OUT" == "OK" ]]; then
  pass "case swap-only (load OK): no brake fires, exit 0"
else
  fail "case swap-only: expected 'OK' exit 0, got '$OUT' exit $EC"
fi

# ── case F: explicit threshold override
LA=$(make_loadavg "5.00")
OUT=$(WAVE_LOADAVG_FILE="$LA" \
      WAVE_NPROC=12 \
      WAVE_LOAD_THRESHOLD=4.0 \
      WAVE_DF_CMD='echo 100000' \
      WAVE_FREE_CMD='printf "Swap: 1024 0 1024\n"' \
      bash "$RC_SH" 2>&1)
EC=$?
if [[ "$EC" == "1" ]] && grep -q "BRAKE: load" <<<"$OUT"; then
  pass "case threshold override: respects WAVE_LOAD_THRESHOLD"
else
  fail "case threshold override: expected brake at threshold 4.0 with load 5.0, got '$OUT' exit $EC"
fi

printf '\033[32mall wave-resource-check tests passed\033[0m\n'
