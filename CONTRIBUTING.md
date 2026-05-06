# Contributing to illo-sidebar

Thank you for your interest in contributing.

## Project guarantees

These are non-negotiable. Any PR that violates them will be rejected.

- **Daemon stays zero-runtime-deps.** `daemon/server.js` uses Node stdlib only.
  Never add `require`/`import` for an npm package at runtime.
- **Daemon binds 127.0.0.1 only.** Do not change the bind address or add any
  mechanism to expose the daemon to remote hosts.
- **No telemetry, no remote calls.** The daemon must never phone home or contact
  any external service on the user's behalf (mobile push is opt-in and only
  fires when the user explicitly enables it via `POST /config/push`).
- **Mobile push is opt-in only.** Push credentials are provided by the user;
  they are never collected or forwarded anywhere else.
- **Hooks must never block Claude.** Every hook script must `exit 0`, even on
  daemon errors.

## Repo layout

See the "Files in this plugin" tree in `README.md` for the full directory
layout. Key directories:

- `daemon/` — the HTTP + WebSocket server (Node stdlib only)
- `bin/` — hook scripts, TUI client, demo/VCR tooling
- `ui/` — browser fallback (vanilla HTML/CSS/JS)
- `sdks/` — Python and TypeScript reference clients
- `tests/` — all test code (unit, dogfood, integration, TUI smoke, Playwright)
- `docs/` — protocol contract and setup guides
- `commands/` and `hooks/` — Claude Code plugin wiring

## Local dev loop

1. Clone the repo:

   ```bash
   git clone https://github.com/laiadlotape/illo.git
   cd illo
   ```

2. Run the dogfood demo to verify a clean baseline:

   ```bash
   tests/dogfood.sh
   ```

3. For interactive development, start the daemon and open the TUI:

   ```bash
   node daemon/server.js &
   node bin/illo-tui.js
   ```

4. Push a test event:

   ```bash
   PORT=$(cat ~/.claude/illo-sidebar/daemon.port)
   curl -sX POST -H 'Content-Type: application/json' \
     -d '{"kind":"ask_user","session_id":"dev","tool_input":{"questions":[{"question":"Proceed?","options":[{"label":"Yes"},{"label":"No"}]}]}}' \
     http://127.0.0.1:$PORT/event
   ```

No `npm install` is needed for the daemon or any hook. The only package that
needs installing is the test suite:

```bash
cd tests && npm ci
```

## Test requirements

- **Node 20+** — required to run the daemon and test suite.
- **Node 22+** — enables the `node:sqlite` history sink. On Node 20/21 the
  JSONL fallback is used instead. The CI matrix covers both versions.
- **python3** — required for `test:sdk-python` and parts of `test:integration`.
- **bc** — required for timing arithmetic in `test:integration`.
- **Playwright / Chromium** — required for `test:ux`:
  ```bash
  npx playwright install chromium
  ```

## Test matrix

All test scripts live in `tests/` and are run from that directory.

| npm script | What it covers |
|---|---|
| `npm run test:unit` | In-process unit tests for `daemon/server.js` via `node:test` |
| `npm run test:dogfood` | Full HTTP API smoke test (bash + curl + jq against a live daemon) |
| `npm run test:sdk-python` | Python SDK round-trip: asks, notifies, heartbeats against a live daemon |
| `npm run test:integration` | Demo scenarios and VCR record/replay end-to-end smoke test |
| `npm run test:tui` | TUI headless smoke test (--no-tty mode) |
| `npm run test:ux` | Playwright E2E: v0.1 and v0.2 UI interactions, quick reply, snooze, filter chips |
| `npm run test:all` | All six in sequence (the full CI gate) |

Before reporting any change as "done", run `npm run test:all` locally.

## Code style

- Vanilla ES modules throughout. No build step, no transpiler, no bundler.
- Match the style of the file you are editing. Do not introduce a linter or
  formatter unless the maintainers have agreed to it.
- English-only user-visible labels. No emojis in user-visible strings.
- Prefer editing an existing file over rewriting it entirely — reviewers read
  diffs, not whole files.
- Keep functions small and named. Avoid deeply nested callbacks; prefer early
  returns.
- Do not add runtime npm dependencies to `daemon/server.js` or any hook script.

## Commit style

This project uses [Conventional Commits](https://www.conventionalcommits.org/).

Format: `<type>(<scope>): <subject>`

Allowed types: `feat`, `fix`, `docs`, `chore`, `test`, `refactor`.

Examples:

```
feat(daemon): add snooze endpoint with configurable presets
fix(vcr): correct shell quoting in replay path
docs(protocol): document quick_reply_enabled field
chore(ci): pin ubuntu-latest to 22.04
```

Rules:
- Keep subjects to 70 characters or fewer.
- Use the imperative mood ("add", not "added" or "adds").
- Reference an issue number in the body if one exists.

## Submitting a PR

1. Fork the repo, create a feature branch from `main`.
2. Make your changes and ensure `npm run test:all` passes.
3. If your change adds or modifies a public protocol field, update
   `docs/protocol.md` accordingly — this is a hard requirement.
4. Open a PR using the pull request template. Fill in every section.
5. A maintainer will review within a few days.

See `.github/PULL_REQUEST_TEMPLATE.md` for the full checklist.
