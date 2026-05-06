#!/usr/bin/env bash
# Notification hook: fires for permission prompts and idle waits.
# We forward to the daemon as a pending-input item.
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$DIR/_lib.sh"
# shellcheck source=_snapshot.sh
source "$DIR/_snapshot.sh"

INPUT="$(read_stdin)"
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")
MESSAGE=$(printf '%s' "$INPUT" | jq -r '.message // .notification // ""' 2>/dev/null || echo "")
SUBKIND=$(printf '%s' "$INPUT" | jq -r '.notification_type // .type // "notification"' 2>/dev/null || echo "notification")
TRANSCRIPT_PATH=$(printf '%s' "$INPUT" | jq -r '.transcript_path // ""' 2>/dev/null || echo "")
CWD_RAW=$(printf '%s' "$INPUT" | jq -r '.cwd // ""' 2>/dev/null || echo "")
SNAPSHOT_TEXT=""
if [[ -n "$TRANSCRIPT_PATH" ]]; then
  SNAPSHOT_TEXT="$(transcript_snapshot "$TRANSCRIPT_PATH" 40 || true)"
fi

AGENT_ID="claude-code:${SESSION_ID:-unknown}"

# Resolve git context from cwd; all failures are silent.
resolve_git_context "$CWD_RAW"

push_event "$(jq -nc \
  --arg sid "$SESSION_ID" \
  --arg m "$MESSAGE" \
  --arg sk "$SUBKIND" \
  --arg aid "$AGENT_ID" \
  --arg snap "$SNAPSHOT_TEXT" \
  --arg cwd "$GIT_CWD" \
  --arg proj "$GIT_PROJECT_NAME" \
  --arg branch "$GIT_BRANCH" \
  --arg worktree "$GIT_WORKTREE" \
  '{kind:"notification",
    subkind:$sk,
    session_id:$sid,
    agent_id:$aid,
    agent_kind:"claude-code",
    message:$m,
    transcript_snapshot:(if $snap == "" then null else $snap end),
    cwd:(if $cwd == "" then null else $cwd end),
    project_name:(if $proj == "" then null else $proj end),
    git_branch:(if $branch == "" then null else $branch end),
    git_worktree:(if $worktree == "" then null else $worktree end),
    ts:(now|tostring)}')"
exit 0
