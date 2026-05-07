---
description: Pin one issue or PR to the front of the wave queue. /wave-focus <#> sets the wave:focus label. /wave-focus clear removes it everywhere.
argument-hint: <issue-or-pr-#> | clear
---

Pin or clear the wave focused-work pointer.

Usage:

- `/wave-focus 42` — pin issue or PR #42 to the front of the queue. The next
  `/wave-tick` will dispatch it before any FIFO candidates.
- `/wave-focus clear` — remove `wave:focus` from every open item.

Only ONE item can be focused at a time. Setting focus on a new item clears it
from everything else.

This invokes the `wave-focus` skill:

```
Skill(skill="wave-focus", args="$ARGUMENTS")
```

If the chosen item is already in-flight (`claimed-by-*` label present), the
skill refuses with a message asking the user to manually unstick first.
