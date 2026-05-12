# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-05-12

### Added

- `bin/illo-update.sh`: shell helper that runs `claude plugin update illo`, gracefully stops the running daemon (SIGTERM → SIGKILL after 5s), and prints instructions for restarting. Supports `--help` (#17).
- `/illo-update` slash command: shells out to `bin/illo-update.sh` and reports the result (#17).
- SessionStart drift check: on each session start, a background job compares the installed plugin version against the GitHub `main` branch. If versions differ, a `notification` event is posted to the sidebar with a prompt to run `/illo-update`. The check is wrapped in `timeout 2` and never blocks the hook (#17).

### Fixed

- `tests/ux.spec.js`: replace fragile `.locator('.item').first()` in the agent-identity test with a title-anchored locator immune to ordering races (#13).
- `changelog-enforcer.yml`: release-cut PRs (which migrate `[Unreleased]` lines into a new `## [<semver>]` section) no longer fail the gate. The workflow now also passes when a new version heading is introduced in the diff (#26).

## [0.4.3] - 2026-05-07

### Fixed

- `bin/record.sh`: use correct asciinema 2.x syntax (`-c COMMAND`) instead of the unsupported `-- command` form; recordings now produce a cast file and auto-convert to gif on stop.

## [0.4.2] - 2026-05-07

### Added

- Live session recorder: `bin/record.sh` (start/stop/toggle/status/gif), `/illo-record` slash command, and `r` key in TUI events focus to toggle asciinema recording with a `● REC` status-bar indicator; casts auto-convert to gif via `agg` on stop.

### Fixed

- `bin/record.sh stop`: detach the readonly tmux client from the source session before killing the recording server — `tmux attach -r` exits cleanly, giving asciinema time to flush and write the cast file (previously the cast was silently dropped).
- TUI `r` key: recording features are disabled when `asciinema` is not installed; pressing `r` without it shows a clear install hint instead of silently failing.

## [0.4.1] - 2026-05-07

### Fixed

- TUI low-noise filter now drops non-urgent `notification` items. Only `ask_user`, `sent`, urgent notifications, and permission-prompt notifications surface in low-noise. Press `v` to flip to verbose for everything (#45).
- TUI events: `x` (clear) now correctly removes resolved events both locally and server-side via `POST /clear`, with a count toast (#47).
- TUI compose: `*unsaved` indicator is no longer shown for empty buffers; only when the buffer has content AND has been edited since the last send/clear (#47).

### Changed

- TUI: compose pane is now labelled "prompt" everywhere user-facing (status line, box title, help overlay, hint footer, README + docs). Internal state names unchanged (#47).
- TUI events: payloads are pretty-printed instead of dumped as JSON. `ask_user` shows `Q: <question>` + numbered options; `notification` shows just the message; `sent` shows a truncated excerpt; `custom` shows `field: value` lines (#47).

## [0.4.0] - 2026-05-07

### Changed (BREAKING)

- **Plugin renamed**: `illo-sidebar` → `illo`. After update, the plugin namespace is `illo:<cmd>` (was `illo-sidebar:<cmd>`).
- **Slash commands renamed**: `/sb*` → `/illo*` everywhere. The main TUI launcher is now `/illo` (was `/sb`).

### Migration

- Run `claude plugin update illo-sidebar@illo`. The local marketplace is unchanged; the plugin entry name updates from `illo-sidebar` to `illo`. After the next update cycle, install with `claude plugin install illo@illo`.
- The daemon's state directory (`~/.claude/illo-sidebar/`) is NOT renamed — existing items, history, and config are preserved.

### Added

- `/gif-record` skill: record the current tmux window to a gif with gentle keystroke overlay. Uses vhs (preferred) or asciinema+agg (fallback). Both are optional dependencies; install one-liners in `docs/gif-record.md`. Recordings go to `docs/recordings/` (gitignored). New: `bin/gif-record.sh`, `skills/gif-record/SKILL.md`, `commands/gif-record.md`, `docs/gif-record.md`, `tests/gif-record.test.sh` (#34).
- TUI compose: bracketed paste support. Multi-line pastes arrive as a single undo group with newlines preserved and ANSI escapes stripped; auto-indent is suppressed for paste content. Cap: 1 MB per paste (#39).
- `wave` skill: bootstraps a self-managing CronCreate-driven orchestration
  loop. Tick every 5 min, hard 1-worker cap, resource brakes (load/disk/swap),
  label-state machine, hybrid auto-merge with `safe:auto-merge` gate.
  Self-disables when the queue is empty and no in-flight worker remains.
  Closes #28.
- Safe agentic GitHub upload pattern: single `laiadlotape` identity,
  label-driven state machine (`status:*`, `agent:*`, `priority:*`,
  `complexity:high`, `safe:auto-merge`, `claimed-by-*`, `wave:focus`),
  worker template + reviewer template, no-orphan enforcement (issue→PR
  within 24h, PR→issue immediate). Closes #29.
- `bin/wave-*.sh` helpers: `wave-init-labels`, `wave-survey`,
  `wave-resource-check`, `wave-find-next`, `wave-orphan-check`. All zero-dep
  bash with `set -euo pipefail`.
- `.claude/agents/<role>.md` briefs: `tui-dev`, `daemon-dev`, `doc-writer`,
  `test-fixer`, `hooks-dev`, `reviewer`. Each role has a Scope, Allowed
  paths, Standard process, Done criteria, Hard constraints section.
- `.claude/skills/wave*/SKILL.md`: `wave`, `wave-tick`, `wave-stop`,
  `wave-focus`.
- Slash commands: `/wave`, `/wave-stop`, `/wave-focus`, `/wave-status`.
- `docs/wave.md` — full operational guide (label state machine, lifecycle,
  auto-merge path, no-orphan rule, manual unstick).
- `docs/agents.md` — index of agent roles, scopes, allowed-paths
  enforcement, model routing, how to add a new role.
- `tests/wave-*.test.sh`: `wave-labels`, `wave-survey`, `wave-find-next`,
  `wave-resource-check`. All four are dependency-free bash + python3, run
  against fixtures or mocked `gh`.

### Changed

- TUI compose: line wrap is now word-aware. Long lines break at the last whitespace within `innerCols`; words longer than `WORD_HARD_BREAK_RATIO * innerCols` (default 0.8) are hard-broken so very long URLs/identifiers don't push everything off-screen (#37).

### Fixed

- TUI: Ctrl+Up/Down once again toggle focus between compose and events panes (regression from #27); paragraph motion moved to Ctrl+Shift+Up/Down (#36).
- TUI event-detail popup: long lines now wrap at the popup width with 2-col inner margins; popup uses ~80% × ~60% of the terminal with a Unicode border and subtle drop shadow; content is scrollable with Up/Down and PgUp/PgDn (#31).
- `tests/ux.spec.js`: two assertions stale after PR #14's per-session resume routing. The "resume here" test now checks `pending_resume_<sessionId>.json` (was `pending_resume.json`); the quick-reply test now expects the `queued · type in session` hint (was `[replied]`) (#38).


## [0.3.0] - 2026-05-06

### Added

- **Prompt-notepad TUI rework** (#18): the v0.3 illo TUI is a composition
  surface, not a pending-items list. The screen splits into an event log
  (top ~1/3, low-noise filter by default) and a compose buffer (~2/3) with a
  full in-house editor (cursor motion, undo/redo with 2-second typing groups,
  word/line kills, auto-indent on Enter).
- **Tmux send integration**: `Ctrl-S` hands the composition off to the
  Claude pane via `tmux send-keys -t <pane> -l --` (literal mode, never
  auto-presses Enter). `Ctrl-D` is the same flow plus a final `Enter`.
  Helpers live in `bin/_tmux.sh` and `bin/tmux-send.sh`; the TUI shells out
  to them so the same logic is testable in isolation.
- **Pane discovery**: on startup the TUI scans the current tmux window for
  a pane whose foreground command is `claude` (or whose process tree
  contains `claude`) and pre-populates the send target. Excludes its own
  pane and other illo-tui panes to avoid feedback loops.
- **`/sb-attach <pane_id>` and `/sb-detach`** slash commands: override or
  clear the auto-detected pane via `POST /config/pane-override`.
- **`POST /sent` endpoint** and **`sent` kind** in the protocol: the TUI
  records every send so the event log shows what was handed off (and to
  which pane). `sent` items are `urgency: low`, marked resolved + focused
  immediately so they never re-warn.
- **`paneOverride` daemon config**: persisted in `state.json`, broadcast
  via the `config` WS message, exposed in `/state` and `/protocol`. Set
  via `POST /config/pane-override`.
- **`$EDITOR` escape (Ctrl-E)**: writes the buffer to `$TMPDIR`, suspends
  raw mode and the alt-screen, runs `$EDITOR` (default `nano`), reads the
  file back, pushes an undo snapshot, restores the TUI.
- `.github/workflows/doc-drift.yml`: claude-code-action review on every PR for documentation drift (#19).
- `.github/workflows/triage.yml`: auto-label and clarify newly-opened issues using claude-code-action (#20).
- `.github/workflows/stale-prs.yml`: daily cron nag for PRs older than 7 days using claude-code-action (#21).
- `.github/workflows/changelog-enforcer.yml`: PR gate — code changes must add an entry under CHANGELOG `[Unreleased]` (or include `[skip changelog]` in the PR body) (#22).
- Enriched item context (project, git branch, cwd) on every Claude Code hook. Every item now carries `cwd`, `projectName`, `gitBranch`, and `gitWorktree` fields populated from the hook payload (#6).
- `cwd`, `project_name`, `git_branch`, `git_worktree` keyword args added to Python and TypeScript SDK `.ask()`, `.notify()`, and `.custom()` methods.
- `GET /resume-targets` endpoint: lists all currently-queued resume files so
  the TUI and other clients can surface delivery status.
- Persistent post-reply toast in the legacy item-list TUI rendering path
  (kept for back-compat) — superseded by the v0.3 prompt-notepad surface.

### Changed

- **Protocol bumped to 0.3.0**. Backward-compatible: every v0.1 and v0.2
  envelope still produces the same items.
- Plugin description updated: "CLI-native prompt notepad sidebar for
  Claude Code (and any HITL agent framework). Compose deliberately, send
  to the Claude pane via tmux without auto-pressing Enter."
- `bin/illo-tui.js` rewritten end-to-end. Hand-rolled WebSocket client,
  ANSI palette, port discovery, and `parseKey` are preserved; layout,
  state, rendering, and key handling are new.
- `/sb` (and `bin/open-sidebar.sh`) now print whether a claude pane was
  detected when opening the split, hinting at `/sb-attach` if not.
- Notification items derive a meaningful title from the transcript
  snapshot when the raw message is a generic string ("Claude is waiting
  for your input", "Waiting for your input", "Claude needs your
  attention"). Original title preserved in `payload.original_title` (#6).

### Fixed

- Resume context now includes `transcript_snapshot`, `project_name`,
  `git_branch`, and `agent_kind` in the `additionalContext` block
  injected by the `UserPromptSubmit` hook (#12).
- Sidebar replies route to a per-session resume file
  (`pending_resume_<sessionId>.json`) so the correct Claude session
  consumes the queued reply when multiple sessions are running. Items
  without a `sessionId` fall back to the legacy global
  `pending_resume.json` for back-compat (#9).


## [0.2.0] - 2026-05-06

### Added

- Generic agent-inbox protocol: `POST /event` now accepts events from any
  agent framework (Claude Code, LangGraph, CrewAI, OpenAI Codex, Aider, Cursor,
  OpenAI Agents SDK, or any custom script).
- Urgency tiers (`low | normal | urgent`). Re-warn cadence scales with urgency
  (0.5x for urgent, 4x for low). Urgent items flash inline in the TUI.
- Per-item snooze with presets (5 m / 15 m / 1 h / 4 h). Snoozed items appear
  in a dedicated filter view and re-surface automatically.
- Quick reply: type a reply directly in the sidebar; the daemon writes
  `pending_resume.json` with `user_reply_text`.
- Transcript snapshots: attach the last N lines of the agent's transcript to
  any event via `transcript_snapshot`.
- `/stats` page: total items, by-kind and by-agent breakdowns, median and p95
  time-to-resolve, dismissal rate, top recurring titles. History stored in
  `node:sqlite` (Node 22+) or JSONL fallback.
- Mobile push (opt-in): ntfy.sh and Pushover integration. After
  `afk_threshold_seconds` without focus, the daemon pushes a notification with
  a single-use reply link. See `docs/push.md`.
- Demo mode: `bin/illo-demo.sh` with three scenarios (`typical`, `multi-agent`,
  `chaotic`) and a configurable speed multiplier.
- VCR: `bin/illo-vcr.sh` records and replays event streams for debugging and
  reproducible demos.
- Python SDK (`sdks/python/illo_sidebar.py`): stdlib-only, no `pip install`.
- TypeScript SDK (`sdks/typescript/illo-sidebar.ts`): fetch-based, no build
  step.
- CLI-native TUI sidebar (`bin/illo-tui.js`) as the default surface. Opens in
  a tmux split via `/sb`. Pure ANSI, zero npm deps.
- New hook event fields: `transcript_snapshot`, `agent_id`, `agent_kind`.
- `GET /protocol` endpoint for SDK version negotiation.

### Changed

- Browser UI moved from the default surface to the `/sb-web` optional fallback.
- Re-warn cadence now respects urgency multipliers.

### Fixed

- `bin/illo-vcr.sh`: shell-quoting bug on replay produced malformed JSON;
  replays now produce valid JSON that the daemon accepts correctly.

## [0.1.0] - 2026-05-06

### Added

- Initial plugin: hooks capture `AskUserQuestion`, `Notification`, `Stop`,
  `SessionStart`, `SessionEnd`, and `UserPromptSubmit` events and forward them
  to the daemon via `POST /event`.
- Daemon (`daemon/server.js`): Node 20+, stdlib only, HTTP + WebSocket on
  `127.0.0.1:7821`.
- Browser sidebar (`ui/`): vanilla HTML/CSS/JS, dark theme, item cards, action
  buttons.
- Slash commands: `/sb`, `/sb-resume`, `/sb-status`.
- Gentle re-warn cadence: configurable `warnIntervalSeconds`; warn animation
  plays again if an item is still unacknowledged.
- Focus-clears-warn: focusing the sidebar window clears the warn state.
- Click-to-resume: "resume here" button writes `pending_resume.json`; the
  `UserPromptSubmit` hook injects context into the next Claude turn.

[Unreleased]: https://github.com/laiadlotape/illo/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/laiadlotape/illo/compare/v0.4.3...v0.5.0
[0.4.3]: https://github.com/laiadlotape/illo/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/laiadlotape/illo/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/laiadlotape/illo/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/laiadlotape/illo/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/laiadlotape/illo/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/laiadlotape/illo/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/laiadlotape/illo/releases/tag/v0.1.0
