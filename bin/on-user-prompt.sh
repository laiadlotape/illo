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

if [[ ! -s "$RESUME_FILE" ]]; then
  exit 0
fi

# Build additionalContext from the resume file, then consume it.
RESUME_JSON="$(cat "$RESUME_FILE" 2>/dev/null || echo '{}')"
rm -f "$RESUME_FILE"

ITEM_ID=$(printf '%s' "$RESUME_JSON" | jq -r '.id // ""' 2>/dev/null || echo "")
TITLE=$(printf '%s'  "$RESUME_JSON" | jq -r '.title // "pending input"' 2>/dev/null || echo "pending input")
SNIPPET=$(printf '%s' "$RESUME_JSON" | jq -r '.snippet // ""' 2>/dev/null || echo "")
ORIG=$(printf '%s' "$RESUME_JSON" | jq -r '.original_payload // ""' 2>/dev/null || echo "")
REPLY_TEXT=$(printf '%s' "$RESUME_JSON" | jq -r '.user_reply_text // ""' 2>/dev/null || echo "")

if [[ -n "$REPLY_TEXT" ]]; then
  ADDITIONAL=$(jq -nc \
    --arg id "$ITEM_ID" \
    --arg ttl "$TITLE" \
    --arg s "$SNIPPET" \
    --arg orig "$ORIG" \
    --arg reply "$REPLY_TEXT" \
    '"[illo-sidebar] User pre-typed reply via sidebar: " + ($reply|tojson) + ". Use that as their answer; the empty/short prompt that follows is incidental.\n  item_id: " + $id + "\n  title: " + $ttl + "\n  original_question_or_event: " + $orig + "\n  excerpt: " + $s')
else
  ADDITIONAL=$(jq -nc \
    --arg id "$ITEM_ID" \
    --arg ttl "$TITLE" \
    --arg s "$SNIPPET" \
    --arg orig "$ORIG" \
    '"[illo-sidebar] User is resuming a previously surfaced pending input.\n  item_id: " + $id + "\n  title: " + $ttl + "\n  original_question_or_event: " + $orig + "\n  excerpt: " + $s + "\nThe text the user typed below is their reply to that. Treat it accordingly and do not re-ask the original question."')
fi

# PreToolUse-style hookSpecificOutput; UserPromptSubmit accepts additionalContext.
jq -nc --arg ctx "$(printf '%s' "$ADDITIONAL" | jq -r '.')" \
  '{hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:$ctx}}'
exit 0
