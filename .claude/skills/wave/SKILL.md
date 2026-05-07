---
name: wave
description: "Bootstrap the wave orchestration loop. Idempotently creates state-machine labels, surveys the queue, and schedules a CronCreate to fire /wave-tick every 5 minutes. Self-disables when the queue empties and no in-flight worker remains."
user_invocable: true
category: orchestration
---

# Wave (bootstrap)

The `/wave` command turns the illo-sidebar repo into a self-managing,
label-driven, single-worker orchestration loop on top of GitHub Issues + PRs.

You — the assistant running this skill — are the orchestrator. You stay on
Opus 4.7. Every actual code change is dispatched to a Sonnet (or Opus 4.6 for
`complexity:high`) sub-agent by `/wave-tick`.

## What this skill does

1. **Bootstrap labels.** Run `bin/wave-init-labels.sh`. Idempotent — already
   existing labels get colour/description refreshed via `--force`. Required
   labels are listed in `docs/wave.md`.

2. **Survey the queue.** Run `bin/wave-survey.sh`. Get a single-line summary
   of issue counts by status/priority and PR count by review state.

3. **Idempotency check.** If a CronCreate for `/wave-tick` already exists
   (search by job name `wave-tick`), DO NOT schedule a second one. Print
   `wave: already engaged` and exit.

4. **Schedule the tick.** Use the `CronCreate` tool (or `loop` skill, fallback)
   to schedule `/wave-tick` every 5 minutes:

   ```
   CronCreate(
     name: "wave-tick",
     schedule: "*/5 * * * *",
     command: "/wave-tick",
     description: "illo-sidebar wave orchestration tick"
   )
   ```

   If `CronCreate` is unavailable in this harness, fall back to:
   `Skill(skill="loop", args="5m /wave-tick")`.

5. **Surface a TUI notification.** POST to the daemon so the user sees the
   wave engaged in their sidebar:

   ```
   PORT=$(cat ~/.claude/illo-sidebar/daemon.port)
   curl -sS -X POST -H 'Content-Type: application/json' \
     -d "{\"kind\":\"notification\",\"agent_kind\":\"wave\",\"title\":\"wave engaged\",\"message\":\"$(bin/wave-survey.sh)\",\"urgency\":\"low\"}" \
     http://127.0.0.1:$PORT/event || true
   ```

   Errors are swallowed — daemon may not be running.

6. **Print confirmation.** One line back to the user:

   ```
   wave engaged: <survey-output>; tick every 5m. Use /wave-stop to halt, /wave-focus <#> to pin.
   ```

## Hard constraints

- DO NOT push code, create PRs, or open issues from this skill. Bootstrapping
  the loop is metadata only.
- DO NOT bypass `bin/wave-init-labels.sh` — every state transition assumes
  the labels exist.
- DO NOT schedule a second tick if one is already running. Re-running `/wave`
  while engaged is a no-op.
- DO NOT touch branch protection. The user (or a separate orchestrator turn)
  configures that out-of-band.

## Failure modes

- `gh auth status` shows the wrong user → abort with
  `wave: ABORT — gh auth not laiadlotape; run gh auth login first`.
- `gh` missing → abort with `wave: ABORT — gh CLI not installed`.
- `bin/wave-init-labels.sh` fails → print its stderr and exit non-zero.
- `CronCreate` unavailable AND `loop` skill unavailable → print
  `wave: ABORT — no scheduling primitive; install the loop skill or use a harness with CronCreate`.

## Related

- `/wave-tick` — fires every 5 minutes, dispatches at most one worker.
- `/wave-stop` — cancels the CronCreate.
- `/wave-focus <#>` — pin one issue/PR to the front of the queue.
- `/wave-status` — quick at-a-glance state.
- `docs/wave.md` — full operational guide.
