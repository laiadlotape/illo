#!/usr/bin/env bash
# PreToolUse matcher=AskUserQuestion.
# Capture the question Claude is about to ask the user and push it to the sidebar
# as a pending-input item. We do NOT block — the question still appears in the CLI.
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$DIR/_lib.sh"
# shellcheck source=_snapshot.sh
source "$DIR/_snapshot.sh"

INPUT="$(read_stdin)"
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")
TOOL_INPUT=$(printf '%s' "$INPUT" | jq -c '.tool_input // {}' 2>/dev/null || echo '{}')
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
  --argjson ti "$TOOL_INPUT" \
  --arg aid "$AGENT_ID" \
  --arg snap "$SNAPSHOT_TEXT" \
  --arg cwd "$GIT_CWD" \
  --arg proj "$GIT_PROJECT_NAME" \
  --arg branch "$GIT_BRANCH" \
  --arg worktree "$GIT_WORKTREE" \
  '{kind:"ask_user",
    session_id:$sid,
    agent_id:$aid,
    agent_kind:"claude-code",
    tool_input:$ti,
    transcript_snapshot:(if $snap == "" then null else $snap end),
    cwd:(if $cwd == "" then null else $cwd end),
    project_name:(if $proj == "" then null else $proj end),
    git_branch:(if $branch == "" then null else $branch end),
    git_worktree:(if $worktree == "" then null else $worktree end),
    ts:(now|tostring)}')"
exit 0
