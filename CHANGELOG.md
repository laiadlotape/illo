# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
