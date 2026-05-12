# Security Policy

## Reporting a Vulnerability

Please do **not** file a public GitHub issue for security reports.

Open a private security advisory at:
  https://github.com/laiadlotape/illo/security/advisories/new

A maintainer will acknowledge the report and follow up within a few days.

## Threat Model

- **Daemon binds 127.0.0.1 only.** It is not accessible from other hosts on the
  network. All local processes on the same machine are equally trusted.
- **Mobile push is opt-in.** Push credentials (ntfy topic, Pushover token) are
  provided by the user and stored in the plugin config. The project never
  collects or forwards credentials anywhere else.
- **VCR recordings persist event payloads to disk** under
  `~/.claude/illo-sidebar/vcr/`. Recordings may include prompt text and tool
  inputs. Do not share recording files that contain sensitive prompts.

## Supply chain posture

- Runtime is Node stdlib only — daemon, hooks, SDKs, and TUI carry zero runtime dependencies.
- The only `npm install` permitted is `cd tests && npm ci` for Playwright (dev only).
- GitHub Actions are pinned to commit SHAs. Dependabot reviews bumps weekly (group PRs).
- `npm audit` runs in CI against `tests/` on every PR.
- illo is distributed via the Claude Code plugin marketplace, not published to npm — the project itself is not a supply-chain poisoning target.

## In Scope

- `daemon/server.js` — the HTTP + WebSocket server
- `hooks/` and `bin/` — hook scripts and TUI client
- `sdks/` — Python and TypeScript reference clients
- `ui/` — browser fallback UI

## Not in Scope

- Claude Code itself
- Third-party push providers (ntfy.sh, Pushover)
- The user's terminal emulator or operating system
