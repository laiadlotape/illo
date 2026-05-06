# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Resume context now includes `transcript_snapshot`, `project_name`, `git_branch`, and `agent_kind` in the `additionalContext` block injected by the `UserPromptSubmit` hook (#12).
- Sidebar replies now route to a per-session resume file
  (`pending_resume_<sessionId>.json`) so the correct Claude session consumes
  the queued reply when multiple sessions are running. Items without a
  `sessionId` fall back to the legacy global `pending_resume.json` for
  back-compat (#9).

### Added

- `.github/workflows/doc-drift.yml`: claude-code-action review on every PR for documentation drift (#19).
- `.github/workflows/triage.yml`: auto-label and clarify newly-opened issues using claude-code-action (#20).
- `.github/workflows/stale-prs.yml`: daily cron nag for PRs older than 7 days using claude-code-action (#21).
- `.github/workflows/changelog-enforcer.yml`: PR gate — code changes must add an entry under CHANGELOG `[Unreleased]` (or include `[skip changelog]` in the PR body) (#22).
- Enriched item context (project, git branch, cwd) on every Claude Code hook. Every item now carries `cwd`, `projectName`, `gitBranch`, and `gitWorktree` fields populated from the hook payload. The TUI agent-line renders as `<projectName> · <gitBranch> · <agentKind> · <session8>`, omitting any null fields (#6).
- `cwd`, `project_name`, `git_branch`, `git_worktree` keyword args added to Python and TypeScript SDK `.ask()`, `.notify()`, and `.custom()` methods.
- `GET /resume-targets` endpoint: lists all currently-queued resume files so
  the TUI and other clients can surface delivery status.
- Persistent post-reply toast in the TUI: after a sidebar reply or resume,
  shows `queued · type anything in session <session8> to deliver` (or the
  no-session variant) until the user presses any key.

### Changed

- Notification items now derive a meaningful title from the transcript snapshot when the raw message is a generic string such as "Claude is waiting for your input", "Waiting for your input", or "Claude needs your attention". The original generic title is preserved in `payload.original_title` (#6).


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

[Unreleased]: https://github.com/laiadlotape/illo/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/laiadlotape/illo/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/laiadlotape/illo/releases/tag/v0.1.0
