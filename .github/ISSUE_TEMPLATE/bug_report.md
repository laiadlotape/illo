---
name: Bug report
about: Report a defect in illo-sidebar
title: ''
labels: bug
---

## Steps to reproduce

1.
2.
3.

## Expected behavior

<!-- What should have happened? -->

## Actual behavior

<!-- What actually happened? -->

## Environment

- **illo version** (from `.claude-plugin/plugin.json`):
- **Node version** (`node --version`):
- **OS**:
- **tmux version** (`tmux -V`, if applicable):
- **Claude Code version**:

## Daemon log excerpt

```
# tail -50 ~/.claude/illo-sidebar/daemon.log
```

## Sidebar state at time of bug

```json
# curl -sS http://127.0.0.1:$PORT/state | jq .
```
