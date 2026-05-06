---
description: Open the sidebar TUI in a tmux split (alias for /sb).
---

Open the CLI-native sidebar TUI. This is an alias for `/sb` — both do the same thing.

Use the bash tool:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/open-sidebar.sh"
```

After running, tell the user:
- Inside tmux: "Sidebar TUI is opening in a new pane on the right. Press `Prefix → o` to switch to it. Use `j/k` to navigate, `Enter` to resume, `q` to quit."
- Outside tmux: Relay the printed instructions about tmux, manual launch, or `/sb-web`.
