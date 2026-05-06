#!/usr/bin/env bash
# UserPromptSubmit hook: if the user clicked an item in the sidebar
# (which writes pending_resume.json), inject the original question's
# context as additionalContext so Claude can pick up exactly where it left off.
#
# v0.2: pending_resume.json may also include a `user_reply_text` field, set by
# POST /items/:id/reply (the sidebar's quick-reply input). When present, we
# pass that text along in additionalContext so Claude treats the user's typed
# reply as their answer to the original question — even if the prompt the user
# subsequently types in the CLI is empty/short/incidental.
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$DIR/_lib.sh"

INPUT="$(read_stdin)"
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")

# Always forward the user prompt event (helps the sidebar clear stale items).
USER_TEXT=$(printf '%s' "$INPUT" | jq -r '.prompt // .user_prompt // ""' 2>/dev/null || echo "")
push_event "$(jq -nc --arg sid "$SESSION_ID" --arg t "$USER_TEXT" \
  '{kind:"user_prompt",session_id:$sid,text:$t,ts:(now|tostring)}')"

# Determine which resume file to use: per-session file first, then global fallback.
ACTIVE_RESUME_FILE=""
if [[ -n "$SESSION_ID" ]]; then
  RESUME_FILE_SID="$STATE_DIR/pending_resume_${SESSION_ID}.json"
  if [[ -s "$RESUME_FILE_SID" ]]; then
    ACTIVE_RESUME_FILE="$RESUME_FILE_SID"
  fi
fi
if [[ -z "$ACTIVE_RESUME_FILE" && -s "$RESUME_FILE" ]]; then
  ACTIVE_RESUME_FILE="$RESUME_FILE"
fi

if [[ -z "$ACTIVE_RESUME_FILE" ]]; then
  exit 0
fi

# Build additionalContext from the resume file, then consume it.
RESUME_JSON="$(cat "$ACTIVE_RESUME_FILE" 2>/dev/null || echo '{}')"
rm -f "$ACTIVE_RESUME_FILE"

ITEM_ID=$(printf '%s' "$RESUME_JSON" | jq -r '.id // ""' 2>/dev/null || echo "")
TITLE=$(printf '%s'  "$RESUME_JSON" | jq -r '.title // "pending input"' 2>/dev/null || echo "pending input")
SNIPPET=$(printf '%s' "$RESUME_JSON" | jq -r '.snippet // ""' 2>/dev/null || echo "")
ORIG=$(printf '%s' "$RESUME_JSON" | jq -r '.original_payload // ""' 2>/dev/null || echo "")
REPLY_TEXT=$(printf '%s' "$RESUME_JSON" | jq -r '.user_reply_text // ""' 2>/dev/null || echo "")
TRANSCRIPT=$(printf '%s' "$RESUME_JSON" | jq -r '.transcript_snapshot // ""' 2>/dev/null || echo "")
PROJECT_NAME=$(printf '%s' "$RESUME_JSON" | jq -r '.project_name // ""' 2>/dev/null || echo "")
GIT_BRANCH=$(printf '%s' "$RESUME_JSON" | jq -r '.git_branch // ""' 2>/dev/null || echo "")
AGENT_KIND=$(printf '%s' "$RESUME_JSON" | jq -r '.agent_kind // ""' 2>/dev/null || echo "")

# Cap the transcript snapshot to the last 80 lines and indent each line 4 spaces.
TRANSCRIPT_INDENTED=""
if [[ -n "$TRANSCRIPT" ]]; then
  TRANSCRIPT_INDENTED=$(printf '%s' "$TRANSCRIPT" | tail -n 80 | awk '{print "    " $0}')
fi

if [[ -n "$REPLY_TEXT" ]]; then
  CTX="[illo-sidebar] User pre-typed reply via sidebar: $(printf '%s' "$REPLY_TEXT" | jq -Rs '.' | jq -r '.'). Use that as their answer; the empty/short prompt that follows is incidental."
  CTX="${CTX}"$'\n'"  item_id: ${ITEM_ID}"
  CTX="${CTX}"$'\n'"  title: ${TITLE}"
  [[ -n "$AGENT_KIND" ]]   && CTX="${CTX}"$'\n'"  agent_kind: ${AGENT_KIND}"
  [[ -n "$PROJECT_NAME" ]] && CTX="${CTX}"$'\n'"  project: ${PROJECT_NAME}"
  [[ -n "$GIT_BRANCH" ]]   && CTX="${CTX}"$'\n'"  branch: ${GIT_BRANCH}"
  CTX="${CTX}"$'\n'"  original_question_or_event: ${ORIG}"
  CTX="${CTX}"$'\n'"  excerpt: ${SNIPPET}"
  if [[ -n "$TRANSCRIPT_INDENTED" ]]; then
    CTX="${CTX}"$'\n'"  recent_transcript: |"
    CTX="${CTX}"$'\n'"${TRANSCRIPT_INDENTED}"
  fi
  ADDITIONAL=$(printf '%s' "$CTX" | jq -Rs '.')
else
  CTX="[illo-sidebar] User is resuming a previously surfaced pending input."
  CTX="${CTX}"$'\n'"  item_id: ${ITEM_ID}"
  CTX="${CTX}"$'\n'"  title: ${TITLE}"
  [[ -n "$AGENT_KIND" ]]   && CTX="${CTX}"$'\n'"  agent_kind: ${AGENT_KIND}"
  [[ -n "$PROJECT_NAME" ]] && CTX="${CTX}"$'\n'"  project: ${PROJECT_NAME}"
  [[ -n "$GIT_BRANCH" ]]   && CTX="${CTX}"$'\n'"  branch: ${GIT_BRANCH}"
  CTX="${CTX}"$'\n'"  original_question_or_event: ${ORIG}"
  CTX="${CTX}"$'\n'"  excerpt: ${SNIPPET}"
  if [[ -n "$TRANSCRIPT_INDENTED" ]]; then
    CTX="${CTX}"$'\n'"  recent_transcript: |"
    CTX="${CTX}"$'\n'"${TRANSCRIPT_INDENTED}"
  fi
  CTX="${CTX}"$'\n'"The text the user typed below is their reply to that. Treat it accordingly and do not re-ask the original question."
  ADDITIONAL=$(printf '%s' "$CTX" | jq -Rs '.')
fi

# PreToolUse-style hookSpecificOutput; UserPromptSubmit accepts additionalContext.
jq -nc --arg ctx "$(printf '%s' "$ADDITIONAL" | jq -r '.')" \
  '{hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:$ctx}}'
exit 0
