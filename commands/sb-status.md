---
description: Show daemon health and a summary of pending sidebar items.
---

```bash
PORT=$(cat "$HOME/.claude/illo-sidebar/daemon.port" 2>/dev/null || echo 7821)
echo "daemon port: $PORT"
curl -sS "http://127.0.0.1:${PORT}/healthz" || echo "(daemon not reachable)"
echo
curl -sS "http://127.0.0.1:${PORT}/state" | jq '{config, count: (.items|length), pending: ([.items[]|select(.resolved|not)]|length)}'
```

Summarize the result for the user in 2–3 lines.
