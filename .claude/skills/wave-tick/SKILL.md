---
name: wave-tick
description: "One iteration of the wave orchestration loop. Polls GitHub for one ready issue or PR, claims it, spawns a Sonnet sub-agent (or reviewer for PRs). Hard 1-worker cap. Fired by CronCreate every 5 minutes."
user_invocable: true
argument: "[--dry-run]"
category: orchestration
---

# Wave-tick

Single dispatch tick. Each tick dispatches **at most one** worker, keeping
spend and host load bounded.

## Resource brakes (HARD — DO NOT bypass)

Before doing anything, run `bin/wave-resource-check.sh`. Possible outcomes:

- `OK`           → continue.
- `BRAKE: load`  → yield this tick. Print `tick: load brake (loadavg=X)`.
- `BRAKE: disk`  → yield this tick. Print `tick: disk brake (free=N MiB)`.
- `BRAKE: swap+load` (exit 2) → ABORT entirely. Print
  `tick: ABORT swap+load combined; halting until next manual /wave`.
  Then call `/wave-stop` so we don't keep firing into a sick host.

## What it does (in order)

1. **Cleanliness check.** `git status --porcelain` in the plugin root must be
   empty. If not, yield: `tick: working tree dirty; yielding`.

2. **Auth check.** `gh auth status` must show `laiadlotape` active. If not,
   yield: `tick: gh auth not laiadlotape; yielding`.

3. **Resource brake.** See above.

4. **Concurrency gate.** Count open issues + PRs with any `claimed-by-*`
   label (use `bin/wave-survey.sh --json` and look at `in_flight`). If
   `in_flight >= 1`, yield with
   `tick: at 1-cap (in-flight: #<n> <agent>); yielding`.
   To find the in-flight item: `gh issue list --label claimed-by-tui-dev`
   etc., or `gh search issues "is:open in:body" --label "claimed-by-*"`.

5. **No-orphan sweep.** Run `bin/wave-orphan-check.sh`. This may add
   `status:human-needed` to stale items; that is fine — the picker filters
   them out.

6. **Pick next item.** Run `bin/wave-find-next.sh`. Output is one of:
   - `EMPTY` → check in-flight again. If still zero, **self-disable**: call
     `/wave-stop` internally and print `wave complete: queue empty + no in-flight; tick cancelled`.
   - `issue:<n>` → continue with issue dispatch.
   - `pr:<n>`    → continue with PR review dispatch.

7. **Acquire lock.** Pick the matching `claimed-by-<role>` label:
   - For an issue: read its `agent:*` label, derive `<role>` (e.g.
     `agent:tui-dev` → `tui-dev`).
   - For a PR: use `reviewer`.

   Then PATCH:
   ```
   gh issue edit <n> --add-label claimed-by-<role>
   ```
   (or `gh pr edit <n> ...` for a PR.)

   Re-read the item. If another `claimed-by-*` exists, lost the race —
   print `tick: lost race on #<n>; will retry next tick` and exit.

8. **Transition state.**
   - Issue: `gh issue edit <n> --add-label status:in-progress --remove-label status:ready`.
   - PR: `gh pr edit <n> --add-label status:in-progress` (keep status:needs-review until merged).

9. **Spawn worker.** Use the `Agent` tool with these fields:

   For an **issue**:
   ```
   Agent(
     subagent_type: "general-purpose",
     model: "sonnet",                     # or "opus" if complexity:high label present
     isolation: "worktree",
     description: "Issue #<n>: <truncated title>",
     prompt: <issue worker template, see below>
   )
   ```

   For a **PR awaiting review**:
   ```
   Agent(
     subagent_type: "general-purpose",
     model: "sonnet",
     description: "Review PR #<n>",
     prompt: <reviewer template, see below>
   )
   ```

   Per `CLAUDE.md`: ALWAYS pass `model:` explicitly. Never omit it.

10. **Print dispatch summary.**

    ```
    tick: dispatched #<n> → <role> (priority=<p>, model=sonnet|opus, agent_id=<id>)
    followup: PR will land at <branch>; reviewer will run on next tick
    ```

## Issue worker prompt template

The prompt MUST contain, in this order:

1. **Goal.** `Resolve GitHub issue #<n> in laiadlotape/illo.`
2. **Issue title.** Verbatim from `gh issue view <n> --json title`.
3. **Issue body.** Verbatim from `gh issue view <n> --json body`.
4. **Branch.** `<role>/<n>-<slug>` where `<slug>` is the first 4 words of the
   title, lowercased and kebab-cased.
5. **Allowed paths.** From `.claude/agents/<role>.md`, the "Allowed paths"
   section. Worker must NOT touch files outside that list.
6. **CLAUDE.md rules.** Verbatim copy of `/home/lotape6/Projects/illo/CLAUDE.md`.
7. **Acceptance criteria.** Extracted from the issue body (lines starting
   with `- [ ]` under an "Acceptance criteria" heading, if present).
8. **PR open instruction.**
   - Open a PR with title `<type>: <issue-title>` (type from agent role).
   - PR body MUST include `Closes #<n>`.
   - PR body MUST include the standard acceptance-criteria checkboxes.
   - Apply `status:needs-review` and remove `status:in-progress` from the PR
     once opened.
9. **CHANGELOG.** Add a line under `## [Unreleased]` (Added/Changed/Fixed
   as appropriate). If genuinely doc-only or chore-only, include
   `[skip changelog]` in the PR body instead.
10. **Auto-merge gate.** Add `safe:auto-merge` ONLY if BOTH:
    - The change is genuinely small/trivial (e.g. typo fix, isolated test
      addition, version bump).
    - Tests cover the change exhaustively.
    Otherwise omit the label and let the reviewer apply `status:human-needed`.
11. **Cleanup on completion.** After PR is opened, the worker MUST remove
    `claimed-by-<role>` from the original issue (NOT the PR) so the issue's
    in-flight slot frees up. The PR is now the in-flight item via
    `status:needs-review`.

## Reviewer prompt template

The prompt MUST contain:

1. **Goal.** `Review PR #<n> in laiadlotape/illo.`
2. **PR title + body.** From `gh pr view <n> --json title,body`.
3. **PR diff.** From `gh pr diff <n>`. (May be large — summarise files first.)
4. **Standard checks.**
   - Tests added or updated for any code change.
   - Docs updated where the doc-drift workflow (#19) would flag drift.
   - CHANGELOG entry under `[Unreleased]` (or `[skip changelog]` in body).
   - No unrelated files touched (compare against the issue's allowed paths).
   - CI status: `gh pr checks <n>` — must be all green.
5. **Decision tree.**

   - All green AND PR has `safe:auto-merge` label →
     `gh pr merge <n> --squash --delete-branch`. Then:
     `gh pr comment <n> --body "auto-merged: CI green + reviewer approval + safe:auto-merge"`.
     Remove `claimed-by-reviewer`.

   - All green AND no `safe:auto-merge` →
     `gh pr review <n> --approve --body "<summary>"`.
     `gh pr edit <n> --add-label status:human-needed`.
     Push a TUI notification (curl to daemon, kind=`notification`,
     urgency=`urgent`, title=`PR #<n> ready to merge (human gate)`).
     Remove `claimed-by-reviewer`.

   - Concerns found, minor →
     `gh pr review <n> --request-changes --body "<specifics>"`.
     Leave `status:in-progress` so the original worker can iterate.
     Remove `claimed-by-reviewer`.

   - Concerns found, major →
     `gh pr review <n> --request-changes --body "<specifics>"`.
     `gh pr edit <n> --add-label status:human-needed`.
     Push a TUI notification (urgency=`urgent`, title=`PR #<n> needs human review`).
     Remove `claimed-by-reviewer`.

6. **NEVER** force-push, NEVER `--admin`, NEVER bypass branch protection.
   If a merge fails because checks are red, label `status:human-needed` and
   stop.

## --dry-run flag

If first arg is `--dry-run`, print what WOULD be dispatched but do not
PATCH any labels and do not spawn the worker.

## Output (success)

```
tick: dispatched issue #<n> → <role> (priority=<p>, model=sonnet)
  branch: <role>/<n>-<slug>
  followup: PR will land; reviewer runs on next tick
```

## Output (no-op)

```
tick: nothing to dispatch (queue empty)
```

then maybe:

```
wave complete: queue empty + no in-flight; tick cancelled
```

## Output (race lost)

```
tick: lost race on #<n> to <other-role>; will retry next tick
```

## Failure modes

- gh auth wrong user → yield with explicit message.
- gh API rate-limit → yield with `tick: gh API rate-limited; retry next tick`.
- Agent tool refuses spawn → roll back: remove `claimed-by-<role>`, restore
  `status:ready` (issues only), print `tick: dispatch failed for #<n>; rolled back`.
- Branch protection rejects merge → reviewer applies `status:human-needed`.

## Related

- `.claude/skills/wave/SKILL.md` — bootstrap.
- `.claude/skills/wave-stop/SKILL.md` — manual halt.
- `bin/wave-find-next.sh` — picker.
- `bin/wave-resource-check.sh` — brakes.
- `docs/wave.md` — full operational guide.
- `.claude/agents/<role>.md` — per-role briefs.
