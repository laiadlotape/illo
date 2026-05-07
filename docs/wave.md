# Wave orchestration

`wave` is a self-managing, label-driven, single-worker GitHub orchestration
loop for the `laiadlotape/illo` repository. The user (or an Opus 4.7
orchestrator session) calls `/wave` once; the loop dispatches one Sonnet
worker every 5 minutes against ready issues and PRs, and self-disables when
the queue is empty.

## What wave does

- Bootstraps a state-machine in GitHub labels (issues + PRs).
- Polls the queue every 5 minutes via a CronCreate-driven `/wave-tick`.
- Picks the next item by **focus → FIFO** order.
- Spawns ONE Sonnet sub-agent per tick (or Opus 4.6 for `complexity:high`).
- For PRs, spawns a reviewer agent that auto-merges only when CI is green
  AND the PR carries `safe:auto-merge`. Otherwise the reviewer requests a
  human gate.
- Enforces a no-orphans rule: every issue ends up linked to a PR, every PR
  references an issue.
- Yields gracefully on resource pressure (load, disk, swap).

## Slash commands

- `/wave` — bootstrap the loop. Idempotent.
- `/wave-tick` — fired by cron every 5 minutes; can also be invoked
  manually.
- `/wave-stop` — cancel the cron.
- `/wave-focus <#>` — pin one issue or PR to the front of the queue.
- `/wave-focus clear` — unpin everything.
- `/wave-status` — quick survey + in-flight detail.

## The label state machine

Each issue and PR carries exactly **one** `status:*` label and (for issues)
exactly **one** `agent:*` label. Other labels are modifiers.

### Status labels

| Label | Meaning | Set by |
|---|---|---|
| `status:proposed`     | New issue, not yet triaged | `triage.yml` workflow on issue open |
| `status:triaged`      | Acceptance criteria + agent label added | triage workflow or human |
| `status:ready`        | Queueable; wave-tick can dispatch | human (or triage when criteria are clear) |
| `status:in-progress`  | Claimed by an agent | `/wave-tick` on dispatch |
| `status:needs-review` | PR open, awaiting reviewer | worker on PR open |
| `status:human-needed` | Escalated; wave-tick yields | reviewer, orphan-check, or human |
| `status:blocked`      | Waiting on external input | human |
| `status:done`         | Closed/merged | GitHub on close/merge |

### Agent labels (one per worker role)

| Label | Scope |
|---|---|
| `agent:tui-dev`     | `bin/illo-tui.js`, `docs/tui.md`, `tests/tui.test.sh` |
| `agent:daemon-dev`  | `daemon/server.js`, `docs/protocol.md`, `tests/server.test.mjs`, `tests/dogfood.sh` |
| `agent:doc-writer`  | `README.md`, `docs/`, `CHANGELOG.md` |
| `agent:test-fixer`  | `tests/` |
| `agent:hooks-dev`   | `bin/on-*.sh`, `bin/_lib.sh`, `bin/_snapshot.sh`, `bin/_tmux.sh`, `bin/tmux-send.sh`, `bin/open-sidebar*.sh` |
| `agent:reviewer`    | synthesised by `/wave-tick`; rarely user-set |

Full role briefs live in `.claude/agents/<role>.md`.

### Modifier labels

| Label | Effect |
|---|---|
| `priority:p0` / `:p1` / `:p2` | Priority signal; FIFO is the default sort, priority is a modifier |
| `complexity:high`             | Escalates the worker model from Sonnet to Opus 4.6 |
| `safe:auto-merge`             | Reviewer is allowed to merge if CI is green |
| `claimed-by-<role>`           | The in-flight lock; only ONE such label across the whole repo at a time |
| `wave:focus`                  | User-set focused-work pointer |

## Lifecycle of an issue

```
status:proposed
   ↓ (triage.yml or human)
status:triaged
   ↓ (acceptance criteria added + agent:* label added + human "ready" decision)
status:ready
   ↓ (wave-tick picks; adds claimed-by-<role> + status:in-progress; spawns worker)
status:in-progress
   ↓ (worker opens PR with Closes #N; PR gets status:needs-review; worker removes claimed-by-<role> from issue)
   (issue stays status:in-progress until PR merges)
status:done   ← issue closed by PR merge
```

## Lifecycle of a PR

```
PR opened by worker
   labels: status:needs-review (+ optionally safe:auto-merge)
   ↓ (next /wave-tick picks; adds claimed-by-reviewer; spawns reviewer agent)
reviewer reads diff + CI; emits ONE decision:
   ├── auto-merge (CI green + safe:auto-merge)  → merged, deleted, branch gone
   ├── approved + needs human (CI green, no safe:auto-merge) → status:human-needed + TUI notification
   ├── minor concerns                            → request-changes; status:in-progress; worker can iterate
   └── major concerns                            → request-changes + status:human-needed + TUI notification
```

## How auto-merge works (the hybrid path)

A PR auto-merges only when ALL of:

1. CI is green: `unit-and-dogfood (20.x)`, `unit-and-dogfood (22.x)`,
   `enforce` all passing.
2. The reviewer agent approves (its checks: linked issue, CHANGELOG, doc
   consistency, allowed paths, test coverage).
3. The PR carries the `safe:auto-merge` label.

If any of those fails, the reviewer applies `status:human-needed`, posts a
review summary, and pushes a TUI notification. The user takes over.

The `safe:auto-merge` label is opt-in by the worker — workers add it only
for trivial changes (typo, isolated test addition, version bump) per the
guidance in each role brief.

## How focus works

`wave:focus` is a user-set pointer. The picker checks for it FIRST. If a
focused item exists and is dispatchable (open, not claimed, not
human-needed), it is picked regardless of priority or createdAt.

Set with `/wave-focus 42`; clear with `/wave-focus clear`. Only one item
can carry `wave:focus` at a time — setting it on a new item clears it
from every other open item.

## How the no-orphans rule works

Run by `bin/wave-orphan-check.sh` at the top of every `/wave-tick`:

- **Issue → PR (24h grace).** An issue with `status:in-progress` for more
  than 24 hours that no open PR references via `Closes #N` / `Fixes #N` /
  `Resolves #N` gets `status:human-needed` applied. The user investigates
  (worker probably crashed; manually unstick).
- **PR → issue (immediate).** A PR whose body has no `Closes #N` reference
  to any open issue gets `status:human-needed` applied immediately. The user
  asks the author for an issue link.

This prevents work from drifting away from the planning surface.

## Resource brakes

`bin/wave-resource-check.sh` runs at the top of every `/wave-tick`:

- **Load brake.** 1-min loadavg > 75% of `nproc` → yield this tick.
- **Disk brake.** `/home` free < 5 GiB → yield this tick.
- **Swap+load abort.** Swap used > 1024 MiB AND load brake fired → ABORT
  entirely. `/wave-tick` calls `/wave-stop` so we don't keep firing into a
  sick host.

Brakes are HARD. Override only by editing the script (don't bypass at the
tick level).

## Self-disable

`/wave-tick` self-disables (calls `/wave-stop` internally) when:

- The picker returns `EMPTY`.
- AND no in-flight worker exists (no `claimed-by-*` labels anywhere).

This means you can `/wave` once and forget — the loop will tear itself down
when the queue drains. Re-engage with another `/wave`.

## Stopping wave manually

`/wave-stop` cancels the CronCreate. It does NOT touch in-flight
`claimed-by-*` labels — a worker mid-run finishes naturally; only NEW
dispatches are prevented.

## Manual unstick: stuck `claimed-by-*` lock

If a worker crashed mid-flight and the `claimed-by-*` label is wedged on an
issue:

```bash
gh issue edit <n> --remove-label claimed-by-<role>
gh issue edit <n> --add-label status:ready    # if no PR was opened
# or
gh issue edit <n> --remove-label status:in-progress --add-label status:ready
```

Then re-engage with `/wave`. The next tick will reclaim the issue and try
again.

If a `claimed-by-reviewer` is wedged on a PR:

```bash
gh pr edit <n> --remove-label claimed-by-reviewer
```

The next tick will pick it up for review again.

## Tools

| Script | Purpose |
|---|---|
| `bin/wave-init-labels.sh`   | Idempotent label creator (uses `gh label create --force`) |
| `bin/wave-survey.sh`        | One-line summary of queue counts |
| `bin/wave-resource-check.sh` | Load / disk / swap brake check |
| `bin/wave-find-next.sh`     | Picker (focus → FIFO → no-orphan filter) |
| `bin/wave-orphan-check.sh`  | No-orphan enforcer; labels stale items `status:human-needed` |

All zero-dep bash, `set -euo pipefail`. None require `npm install`.

## Hard constraints (binding for every wave-tick)

- DO NOT bypass branch protection. `gh pr merge --admin` is forbidden.
- DO NOT force-push.
- DO NOT spawn nested sub-agents from a worker.
- Worker `Agent` calls always pass `model:` explicitly (per `CLAUDE.md`).
- Resource brakes are HARD — never bypass at the tick level.
- The cleanliness check (`git status --porcelain`) prevents wave-tick from
  running while the human is mid-edit.
- The auth check (`gh auth status`) prevents accidental pushes from the
  wrong account (the only allowed identity is `laiadlotape`).

## Architecture notes

- We use a SINGLE `laiadlotape` GitHub identity for both human and bot
  commits. We do NOT mint per-bot tokens (the memaso pattern). The reason:
  GitHub's account-creation cost is high, and `laiadlotape` already owns
  this repo. Bot-vs-human attribution comes from the commit message
  trailer (`Co-Authored-By: ...`).
- We use ONE concurrent worker max. The illo-sidebar test suite is light
  and doesn't justify two parallel workers.
- We use 5-minute ticks (vs memaso's 12 min) because illo PRs land fast
  and the queue churns quickly.
- We do NOT have a `bot-spec-curator` equivalent. The `triage.yml` workflow
  (#20) is the spec/triage authority for incoming issues; the wave loop
  takes them from there.

## Related

- `.claude/skills/wave/SKILL.md`, `wave-tick/SKILL.md`, `wave-stop/SKILL.md`,
  `wave-focus/SKILL.md` — the four skills.
- `.claude/agents/<role>.md` — per-role briefs.
- `commands/wave.md`, `wave-stop.md`, `wave-focus.md`, `wave-status.md` —
  slash command entry points.
- `.github/workflows/triage.yml` — the upstream triage workflow that feeds
  wave with `status:triaged` issues.
- `.github/workflows/changelog-enforcer.yml` — gate that the reviewer cross-
  references when checking PRs.
- `.github/workflows/doc-drift.yml` — gate that doc-writer / reviewer
  reference for documentation drift.
