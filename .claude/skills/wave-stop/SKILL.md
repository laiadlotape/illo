---
name: wave-stop
description: "Cancel the wave-tick CronCreate job. Halts the orchestration loop. Idempotent — safe to invoke even when wave is not engaged."
user_invocable: true
category: orchestration
---

# Wave-stop

Manual halt for the wave orchestration loop.

## What this skill does

1. **Find the cron job.** Search for the `wave-tick` CronCreate entry. The
   exact API depends on the harness; common patterns:

   - `CronList` then `CronDelete <id>` matching `name == "wave-tick"`.
   - If using the `loop` skill fallback: `Skill(skill="loop", args="--stop wave-tick")`.

2. **Cancel it.** If found, delete it. If not found, print
   `wave: not engaged` and exit cleanly (idempotent).

3. **Surface a TUI notification.**

   ```
   PORT=$(cat ~/.claude/illo-sidebar/daemon.port)
   curl -sS -X POST -H 'Content-Type: application/json' \
     -d '{"kind":"notification","agent_kind":"wave","title":"wave stopped","message":"orchestration loop halted","urgency":"low"}' \
     http://127.0.0.1:$PORT/event || true
   ```

4. **Print confirmation.**

   ```
   wave: stopped
   ```

## Hard constraints

- DO NOT remove `claimed-by-*` labels. A worker may still be running; let it
  finish naturally. Stopping the tick only prevents NEW dispatches.
- DO NOT close in-flight PRs or issues.
- This skill is idempotent — running it twice is a no-op the second time.

## When to use

- Before doing manual repository work that you don't want wave to interfere
  with (though wave-tick already yields on dirty working tree).
- After a host-level incident (OOM, swap thrash) where you want to manually
  recover before re-engaging.
- At end of session if you don't want the loop to continue overnight.
- Internally by `/wave-tick` when the queue is empty + no in-flight worker
  remains (self-disable path).

## Manual recovery: stuck `claimed-by-*` lock

If a worker crashed mid-flight and the `claimed-by-*` label is wedged:

```
gh issue edit <n> --remove-label claimed-by-<role>
gh issue edit <n> --add-label status:ready    # if worker never opened a PR
```

Then re-engage with `/wave`.

## Related

- `/wave` — bootstrap.
- `/wave-tick` — the cron-driven dispatch.
- `docs/wave.md` — manual unstick procedure.
