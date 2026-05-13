# illo TUI — config reference

**File:** `~/.claude/illo/config.json`
**Env override:** set `ILLO_CONFIG_HOME` to use a different directory.

The file is plain JSON. Edit it by hand, then restart the TUI to apply changes.
Unknown keys are preserved across reads and writes (forward-compatible for
hand-edits that precede a future release).

---

## Schema

```jsonc
{
  "$schema": "illo-config/v1",
  "version": 1,

  // Compose buffer
  "compose": {
    "wrap": true        // word-wrap in compose buffer (toggle: Alt+W)
  },

  // Event log
  "filters": {
    "defaultMode": "low-noise"  // "low-noise" | "verbose" — filter on startup
  },

  // Header / event-row suffixes
  "display": {
    "showSessionAge": true,         // · Nm age suffix on events
    "showProject": true,            // project name suffix
    "showBranch": true,             // git branch suffix
    "showCwd": false,               // cwd suffix (off by default — noisy)
    "expandSentByDefault": false    // auto-expand `sent` items inline
  },

  // Colour theme
  "theme": {
    "name": "default",   // only "default" in v0.6
    "accent": "cyan"     // "cyan" | "green" | "magenta" | "yellow" | "blue"
  },

  // Keybinding overrides (populated by the settings panel in v0.6)
  "keybindings": {
    "compose": {},   // overrides for compose-pane keys
    "events": {},    // overrides for events-pane keys
    "global": {}     // overrides for global keys
  }
}
```

---

## Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `version` | int | `1` | Schema version — always `1`. |
| `compose.wrap` | bool | `true` | Word-wrap in the compose buffer. Toggle live with `Alt+W`. |
| `filters.defaultMode` | string | `"low-noise"` | Event log filter on startup. `"verbose"` shows all events. |
| `display.showSessionAge` | bool | `true` | Show `· Nm` age suffix on event rows. |
| `display.showProject` | bool | `true` | Show project name suffix on event rows. |
| `display.showBranch` | bool | `true` | Show git branch suffix on event rows. |
| `display.showCwd` | bool | `false` | Show cwd suffix (off by default — verbose). |
| `display.expandSentByDefault` | bool | `false` | Auto-expand `sent` items inline without pressing Enter. |
| `theme.name` | string | `"default"` | Theme name. Only `"default"` is available in v0.6. |
| `theme.accent` | string | `"cyan"` | Accent colour: `"cyan"`, `"green"`, `"magenta"`, `"yellow"`, `"blue"`. |
| `keybindings.compose` | object | `{}` | Keybinding overrides for the compose pane. |
| `keybindings.events` | object | `{}` | Keybinding overrides for the events pane. |
| `keybindings.global` | object | `{}` | Keybinding overrides for global actions. |

See [`docs/tui.md`](tui.md) for the full keybinding reference.

---

## Migration

If `~/.claude/illo-sidebar/tui-prefs.json` exists and `config.json` does not,
the TUI migrates `composeWrap` automatically on first start and writes
`config.json`. The old `tui-prefs.json` is left in place (not deleted).

---

## Env vars

| Variable | Description |
|---|---|
| `ILLO_CONFIG_HOME` | Override the directory that contains `config.json`. Useful for testing. |
