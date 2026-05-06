# illo-sidebar SDKs

Minimal reference clients for the illo-sidebar agent-inbox protocol (v0.2.0).
Both clients have **no third-party dependencies** and target the daemon's
`POST /event` endpoint exactly as documented in `docs/protocol.md`.

By default, both clients **swallow network errors** so a flaky daemon can
never break the calling agent. Pass `raise_on_error=True` (Python) or
`raiseOnError: true` (TypeScript) to opt into exceptions for debugging.

---

## Python — `python/illo_sidebar.py`

Stdlib-only (`urllib`, `json`). Drop the file anywhere on your `PYTHONPATH`.

```python
from illo_sidebar import IlloSidebar

client = IlloSidebar(
    port=7821,
    agent_id="my-agent",
    agent_kind="langgraph",
    session_id="thread-44",
)

client.ask(
    "Approve deploy?",
    options=["yes", "no"],
    urgency="urgent",
    transcript=last_lines,
)

client.notify("Long-running task done", urgency="low")
client.heartbeat()  # liveness ping; daemon updates session.lastHeartbeatAt

# arbitrary extra event
client.custom(title="LangGraph approval", payload={"node": "cleanup"})
```

The `port` argument is overridden by the `ILLO_SIDEBAR_PORT` environment
variable when set.

---

## TypeScript / JavaScript — `typescript/illo-sidebar.ts`

Uses global `fetch` (Node 18+, all modern browsers). Single file, ~110 lines.

```ts
import { IlloSidebar } from "./illo-sidebar";

const c = new IlloSidebar({
  port: 7821,
  agentId: "my-agent",
  agentKind: "codex",
  sessionId: "run-99",
});

await c.ask({
  question: "Approve `rm -rf node_modules`?",
  options: ["yes", "no"],
  urgency: "urgent",
});

await c.notify({ message: "Build complete." });
await c.heartbeat();

// arbitrary extra event
await c.custom({ title: "Codex confirm-shell", payload: { cmd: "rm -rf x" } });
```

Compile with `tsc` or use directly in a TS-enabled toolchain. For plain JS,
strip the type annotations — the runtime logic is otherwise identical.

---

## Protocol reference

See `../docs/protocol.md` for the full event envelope, item shape, endpoint
table, urgency multipliers, and worked examples for LangGraph, Codex, and
Claude Code.
