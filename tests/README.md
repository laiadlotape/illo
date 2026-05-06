# illo-sidebar — test suite

## What's tested

| Suite | File | Coverage |
|---|---|---|
| Unit | `server.test.mjs` | `ingest()`, `addItem()`, `updateItem()`, `snapshot()`, `computeStats()`, VCR state, push config — all in-process |
| Integration (HTTP) | `dogfood.sh` | Full HTTP API: events, /state, /resume, /focus, DELETE, /clear, /stats, /config/push, /vcr/* |
| Python SDK | `sdk_python.test.sh` | `ask()`, `notify()`, `custom()`, `heartbeat()` against a live daemon; item shape round-trip (agentKind, urgency, transcriptSnapshot, quickReplyEnabled) |
| Integration smoke | `integration.test.sh` | Demo scenario run + VCR record/stop/list/replay cycle; asserts item counts and agent_id rewrite |
| UX (E2E) | `ux.spec.js` | v0.1: item render, warn flash, box mode, resume, hover-focus, clear. v0.2: urgency badge, agent-line, transcript expander, snooze, quick reply, filter chips, stats page, browser notification stub |

## Run

```bash
cd tests
npm install                # installs @playwright/test
npm run test:unit          # node:test, no browser needed
npm run test:dogfood       # bash + curl + jq, no browser needed
npm run test:sdk-python    # bash + python3 + curl + jq, no browser needed
npm run test:integration   # bash + curl + jq + python3, no browser needed
npm run test:ux            # Playwright Chromium (see CI notes below)
npm run test:all           # all five in sequence
```

### Prerequisites by suite

| Suite | Requires |
|---|---|
| `test:unit` | Node 20+ |
| `test:dogfood` | Node 20+, `curl`, `jq` |
| `test:sdk-python` | Node 20+, `python3` (stdlib only — no pip), `curl`, `jq` |
| `test:integration` | Node 20+, `bash`, `curl`, `jq`, `python3`, `bc` (used by illo-demo.sh for timing) |
| `test:ux` | Node 20+, Chromium (`npx playwright install chromium`) |

## What `test:sdk-python` does

Spawns the daemon on port `PORT` (default 7843) with a fresh `mktemp -d` as
`ILLO_SIDEBAR_HOME`. Runs an inline Python 3 script that imports
`sdks/python/illo_sidebar.py` directly (no install needed; file is added to
`sys.path`). Calls `.ask()`, `.notify()`, `.custom()`, and `.heartbeat()` with
`raise_on_error=True`. After each batch, GETs `/state` and asserts:

- Exactly 3 items exist (heartbeat creates no item).
- `agentKind` round-trips as `langgraph`.
- `urgency`, `transcriptSnapshot`, and `quickReplyEnabled` match what was sent.

## What `test:integration` does

Spawns the daemon on port `PORT` (default 7847) with a fresh `mktemp -d`.

1. Runs `bin/illo-demo.sh --scenario typical --speed 20` and asserts at least 3
   items were created.
2. Starts VCR recording via `bin/illo-vcr.sh record start`, fires 3 events,
   stops recording with name `ci-recording`, and calls `list`.
3. Replays `ci-recording` at 20× speed into session `vcr-replay`.
4. Asserts the replayed items appear in `/state` with `agentId == "vcr-replay"`
   (the rewritten agent_id the VCR replay sets).

Both scripts require only bash, curl, jq, and python3 — no browsers, no npm.

## How the daemon is launched in tests

**Unit tests (`server.test.mjs`)**: the daemon module is imported in-process.
`ILLO_SIDEBAR_PORT=0` is set before the import so the OS assigns a free port and
nothing conflicts with a real daemon. Because the HTTP server is not exported from
`daemon/server.js`, it cannot be closed from the test; instead the `after()` hook
calls `process.exit(0)`. The re-warn `setInterval` is already `.unref()`'d in the
daemon so it does not prevent exit. The helper that sets the env vars lives in
`_helper.mjs`.

**Dogfood (`dogfood.sh`)**: spawns `node daemon/server.js` as a background
process, captures its PID, and kills it on EXIT via a `trap`. Uses an ephemeral
`mktemp -d` as `ILLO_SIDEBAR_HOME` and a fixed port `PORT=${PORT:-7831}` (override
with `PORT=xxxx bash dogfood.sh`).

**UX tests (`ux.spec.js`)**: `beforeAll` spawns `node daemon/server.js` via
`child_process.spawn` on a random port in the 17800–17999 range, and `afterAll`
kills it and removes the temp state dir. The port is chosen randomly to reduce
CI collision risk.

## CI notes

- `test:unit` and `test:dogfood` need only **Node 20+** and `jq` (for dogfood).
- `test:sdk-python` needs `python3` (stdlib only — no third-party packages) and
  `jq`. The SDK file is loaded directly from `sdks/python/illo_sidebar.py`.
- `test:integration` needs `bash`, `curl`, `jq`, `python3`, and `bc` (used by
  `bin/illo-demo.sh` for floating-point sleep calculations).
- `test:ux` needs **Chromium** installed: `npx playwright install chromium`.
- On CI without browsers the UX tests will fail to start. Set
  `PLAYWRIGHT_BROWSERS_PATH` or run `npx playwright install chromium` in your
  CI setup step. The `beforeAll` will throw if the daemon doesn't start.
- All suites are fully isolated: ephemeral ports and `mktemp` dirs, no shared
  state with a real daemon.

## Ambiguities resolved

- **Daemon import strategy**: chose direct in-process import + `process.exit`
  teardown (documented above). The alternative — spawning a child process for
  unit tests — would match the deployment shape but add latency and make
  assertion failures harder to trace. Direct import is simpler for unit tests.
- **`/clear` behaviour**: `POST /clear` only removes _resolved_ items. Tests
  mark items resolved via `ask_user_answered` before calling `/clear`.
- **Re-warn test**: instead of mocking time, the test uses `POST /config` to set
  `warnIntervalSeconds=2` and waits for the daemon's 1s timer to fire.
