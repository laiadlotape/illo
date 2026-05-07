---
name: sidebar-coordinator
description: Coordinator for the illo-sidebar plugin. Use when the user references the sidebar, "the side panel", "pending inputs", or wants to resume a question Claude asked earlier. Also use when injecting a resumed question's context back into a turn.
---

# illo-sidebar coordinator

## What this plugin does

The illo-sidebar plugin runs a tiny local daemon and a browser-based right-side
panel that lists every moment Claude has been waiting on the user — questions
asked via `AskUserQuestion`, permission prompts, and idle stops. Each item
gently re-warns at a configurable cadence (default 300s) until the user has
either focused (hovered/clicked) or explicitly resumed it.

## When the user clicks "resume here" on a sidebar item

The daemon writes `~/.claude/illo-sidebar/pending_resume.json`. The plugin's
`UserPromptSubmit` hook reads that file on the user's *next* prompt and injects
an `additionalContext` block describing the original question. **Do not re-ask
the original question** — treat the user's typed text as their reply to it.

The injected block looks like:

```
[illo-sidebar] User is resuming a previously surfaced pending input.
  item_id: itm_xxx
  title: <original question>
  original_question_or_event: <serialized original AskUserQuestion payload>
  excerpt: <snippet>
The text the user typed below is their reply to that.
```

## When the user asks "what am I behind on?" or "what's pending?"

Call `/illo-status` (or fetch `http://127.0.0.1:<port>/state` directly) and
summarize the unresolved items. Don't dump the whole JSON.

## When the user wants to open the panel

Call `/illo`. If they want a smaller footprint, tell them to press `b` inside
the sidebar window for compact-box mode.

## Constraints

- **Never** mutate the daemon's state file directly; always go through the HTTP
  API so the UI receives WebSocket updates.
- The daemon binds to localhost only. Don't expose its port externally.
- If the user reports the sidebar doesn't show new items, check
  `~/.claude/illo-sidebar/daemon.log` first.
