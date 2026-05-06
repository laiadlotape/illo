---
description: Cancel the wave-tick CronCreate and halt the orchestration loop. Idempotent — safe even when wave is not engaged.
---

Halt the wave orchestration loop.

This invokes the `wave-stop` skill which:

1. Finds the `wave-tick` CronCreate entry and deletes it.
2. Surfaces a TUI notification.
3. Prints `wave: stopped` (or `wave: not engaged` if there was nothing to stop).

Use the Skill tool:

```
Skill(skill="wave-stop")
```

This does NOT touch in-flight `claimed-by-*` labels. If a worker is still
running, let it finish naturally; stopping the tick only prevents NEW
dispatches. To manually unstick a wedged claim, see `docs/wave.md`.
