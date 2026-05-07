---
description: Resume a pending sidebar item by id (e.g. /illo-resume itm_abc123). With no arg, lists pending items.
---

Arguments: $ARGUMENTS

If $ARGUMENTS is empty, fetch the current pending list and present it concisely so the user can pick one:

```bash
PORT=$(cat "$HOME/.claude/illo-sidebar/daemon.port" 2>/dev/null || echo 7821)
curl -sS "http://127.0.0.1:${PORT}/state" | jq '.items[] | select(.resolved|not) | {id,title,kind,createdAt}'
```

If $ARGUMENTS is an item id, mark it as the resume target (this writes pending_resume.json which the next UserPromptSubmit hook will pick up):

```bash
PORT=$(cat "$HOME/.claude/illo-sidebar/daemon.port" 2>/dev/null || echo 7821)
curl -sS -X POST "http://127.0.0.1:${PORT}/items/$ARGUMENTS/resume"
```

Then tell the user: "Resume context queued for $ARGUMENTS. Type your reply now and I'll have the original question's context."
