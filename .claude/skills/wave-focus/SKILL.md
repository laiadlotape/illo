---
name: wave-focus
description: "Pin one issue or PR to the front of the wave queue. /wave-focus <#> sets the wave:focus label. /wave-focus clear removes it everywhere. Only one item is focused at a time."
user_invocable: true
argument: "<issue-or-pr-#> | clear"
category: orchestration
---

# Wave-focus

Manual pointer to override the FIFO queue. The next `/wave-tick` will
dispatch the focused item before any FIFO candidates.

## Usage

- `/wave-focus 42` — pin issue or PR #42 (auto-detect kind).
- `/wave-focus clear` — remove `wave:focus` from every item.

## What this skill does

### Set focus (`/wave-focus <#>`)

1. **Determine kind.** Try `gh issue view <#> --json number` first; if it
   404s or returns a PR object, try `gh pr view <#> --json number`. PRs and
   issues share the same number space, so the API tells us which it is.

2. **Validate state.** The item must be open AND not have `claimed-by-*`
   labels. If claimed, refuse with:
   `wave-focus: refuses — #<n> already in-flight (claimed-by-<role>); manually unstick first`.

3. **Clear stale focus.** Remove `wave:focus` from every other open item:

   ```
   for kind in issue pr; do
     for n in $(gh $kind list --state open --label wave:focus --json number --jq '.[].number'); do
       [ "$n" = "<target>" ] && continue
       gh $kind edit "$n" --remove-label wave:focus
     done
   done
   ```

4. **Apply the label.** `gh <kind> edit <n> --add-label wave:focus`.

5. **Surface a TUI notification.**

   ```
   PORT=$(cat ~/.claude/illo-sidebar/daemon.port)
   curl -sS -X POST -H 'Content-Type: application/json' \
     -d "{\"kind\":\"notification\",\"agent_kind\":\"wave\",\"title\":\"wave focus set\",\"message\":\"#<n> pinned; will dispatch next tick\",\"urgency\":\"normal\"}" \
     http://127.0.0.1:$PORT/event || true
   ```

6. **Print confirmation.**

   ```
   wave-focus: pinned <kind> #<n>; next tick will dispatch it
   ```

### Clear focus (`/wave-focus clear`)

1. Iterate every open issue and PR with `wave:focus` label and remove it:

   ```
   for kind in issue pr; do
     for n in $(gh $kind list --state open --label wave:focus --json number --jq '.[].number'); do
       gh $kind edit "$n" --remove-label wave:focus
     done
   done
   ```

2. Print:

   ```
   wave-focus: cleared (N items unpinned)
   ```

## Hard constraints

- Only ONE item can be focused at a time. Setting focus on a new item clears
  it from everything else.
- DO NOT bypass the in-flight check. If the chosen item is claimed, the user
  needs to manually unstick (see `docs/wave.md`).
- DO NOT change `status:*` labels. Focus is a pointer, not a state transition.

## Related

- `/wave-tick` — picker honours `wave:focus` first, then FIFO.
- `bin/wave-find-next.sh` — implements the picker order.
- `docs/wave.md` — focused-work mechanism.
