---
description: Quick wave status — queue depth, in-flight worker, last tick output.
---

Show the current state of the wave orchestration loop.

Use the bash tool to print the survey + the in-flight item (if any):

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/wave-survey.sh"
echo
echo "in-flight detail:"
gh search issues "is:open label:claimed-by-tui-dev,claimed-by-daemon-dev,claimed-by-doc-writer,claimed-by-test-fixer,claimed-by-hooks-dev,claimed-by-reviewer" --json number,title,labels --jq '.[] | "  #\(.number) \(.title) [\(.labels | map(.name) | join(", "))]"' 2>/dev/null || echo "  (none)"
echo
echo "wave:focus:"
gh search issues "is:open label:wave:focus" --json number,title --jq '.[] | "  #\(.number) \(.title)"' 2>/dev/null || echo "  (none)"
```

Then summarise to the user in plain English: how many items are queued by
priority, whether a worker is active and on what, whether anything is pinned
with `wave:focus`, and whether anything has `status:human-needed` waiting on
them.

If `bin/wave-survey.sh` says everything is zero AND nothing is in-flight,
suggest `/wave-stop` if wave is still engaged (the auto-self-disable should
have caught it, but a stale CronCreate is possible).
