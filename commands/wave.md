---
description: Bootstrap the wave orchestration loop. Sets up labels, surveys the queue, and schedules /wave-tick every 5 minutes. Idempotent — safe to re-invoke.
---

Engage the wave orchestration loop for the laiadlotape/illo repository.

This invokes the `wave` skill which:

1. Runs `bin/wave-init-labels.sh` to idempotently create every state-machine
   label (`status:*`, `agent:*`, `priority:*`, `complexity:high`,
   `safe:auto-merge`, `claimed-by-*`, `wave:focus`).
2. Runs `bin/wave-survey.sh` to count what's in the queue.
3. Schedules a CronCreate that fires `/wave-tick` every 5 minutes (one
   concurrent worker max, hard-capped).
4. Surfaces a TUI notification.
5. Prints a one-line confirmation.

Use the Skill tool:

```
Skill(skill="wave")
```

After running, tell the user the wave is engaged and how to halt it
(`/wave-stop`), pin work (`/wave-focus <#>`), or check status
(`/wave-status`). Wave self-disables when the queue empties and no in-flight
worker remains.
