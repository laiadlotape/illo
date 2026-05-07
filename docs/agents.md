# Agent roles

The wave orchestration loop dispatches work to one of six agent roles. Each
role owns a narrow scope of files and is invoked by `/wave-tick` when the
matching issue carries the corresponding `agent:*` label.

This page is a quick reference. Full briefs live in `.claude/agents/<role>.md`.

## Role index

| Role         | Label                | Scope (in one line)                                  | Brief                              |
|--------------|----------------------|------------------------------------------------------|------------------------------------|
| tui-dev      | `agent:tui-dev`      | `bin/illo-tui.js` + TUI tests + TUI doc              | `.claude/agents/tui-dev.md`        |
| daemon-dev   | `agent:daemon-dev`   | `daemon/server.js` + protocol doc + daemon tests     | `.claude/agents/daemon-dev.md`     |
| doc-writer   | `agent:doc-writer`   | `README.md` + `docs/` + `CHANGELOG.md`               | `.claude/agents/doc-writer.md`     |
| test-fixer   | `agent:test-fixer`   | `tests/`                                             | `.claude/agents/test-fixer.md`     |
| hooks-dev    | `agent:hooks-dev`    | `bin/on-*.sh` + `bin/_lib.sh` + tmux helpers + hooks | `.claude/agents/hooks-dev.md`      |
| reviewer     | `agent:reviewer`     | PR review only; `gh pr *` commands; no code edits    | `.claude/agents/reviewer.md`       |

`agent:reviewer` is synthesised by `/wave-tick` per PR; users normally do not
set it on issues.

## How to assign work

Add the matching `agent:*` label to a triaged issue. Then the next
`/wave-tick` will dispatch it (subject to FIFO order, focus, and the
1-worker concurrency cap).

```bash
gh issue edit <n> --add-label "agent:tui-dev,status:ready"
```

If you don't know which role fits, the `triage.yml` workflow (#20) makes a
recommendation when the issue is opened. You can override by re-labelling.

## Allowed-paths enforcement

The reviewer agent compares the PR's touched files against the worker
role's "Allowed paths" section. Files outside the allowed set are an
automatic concern — the reviewer requests changes and the worker either
revises the PR or escalates to `status:human-needed`.

This prevents scope creep: a `tui-dev` PR cannot silently modify the
daemon protocol; a `doc-writer` PR cannot silently change behaviour.

## Model routing

Per `CLAUDE.md`:

- Routine work → Sonnet (default).
- `complexity:high` label → Opus 4.6.
- The orchestrator session (running `/wave-tick`) stays on Opus 4.7.

Every `Agent` call from `/wave-tick` passes `model:` explicitly.

## Adding a new role

1. Create `.claude/agents/<role>.md` following the existing template
   (Scope / Allowed paths / Standard process / Done criteria / Hard
   constraints).
2. Add a row to `bin/wave-init-labels.sh` for `agent:<role>` and
   `claimed-by-<role>`.
3. Re-run `bin/wave-init-labels.sh` to create the labels.
4. Add the row to the table above (this file).
5. Update `docs/wave.md` "Agent labels" table.

## Related

- `docs/wave.md` — full wave guide.
- `.claude/agents/` — per-role briefs.
- `CLAUDE.md` — model-routing rules.
