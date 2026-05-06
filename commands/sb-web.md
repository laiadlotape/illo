---
description: Open the sidebar in a browser window (fallback).
---

Open the illo sidebar as a browser window. This is the explicit browser fallback — prefer `/sb` for the CLI-native TUI inside tmux.

Use the bash tool:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/open-sidebar-web.sh"
```

After running, tell the user: "Browser sidebar is opening. It shows the same pending items as the TUI. Use `/sb` next time to get the terminal-native sidebar inside tmux."
