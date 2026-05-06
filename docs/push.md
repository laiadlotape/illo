# Mobile Push Notifications — Setup Guide

> **OPT-IN ONLY.** Mobile push is disabled by default. The daemon makes **no outbound
> network calls** unless you explicitly configure a push provider and set
> `push.enabled = true`. Zero data leaves your machine until you enable this.

When enabled, the daemon will send a push notification to your phone for any
item that has been pending for longer than `afk_threshold_seconds` (default: 120)
without you focusing it in the sidebar. This is useful when you step away from
your desk.

---

## Supported providers

| Provider | What you need | Privacy |
|---|---|---|
| **ntfy.sh** | A topic name (no account needed for public server) | [ntfy.sh privacy policy](https://ntfy.sh/docs/privacy/) — topic names are public by default; use a random suffix |
| **Pushover** | Pushover app ($5 one-time), API token + user key | Self-contained, credentials stay on your machine |

---

## Quick setup — ntfy.sh (recommended)

1. Install the [ntfy app](https://ntfy.sh) on your phone (iOS / Android / web).
2. Pick a **random** topic name (e.g. `illo-sidebar-alice-7f3a9`). Avoid
   guessable names since ntfy topics are public by default.
3. Subscribe to the topic in the app.
4. Configure the daemon:

```bash
# Enable ntfy push (replace topic with your chosen name)
curl -sS -X POST http://127.0.0.1:7821/config/push \
  -H 'Content-Type: application/json' \
  -d '{
    "enabled": true,
    "provider": "ntfy",
    "ntfy_topic": "illo-sidebar-alice-7f3a9",
    "ntfy_server": "https://ntfy.sh",
    "afk_threshold_seconds": 120
  }'
```

That's it. After 120 seconds of an unacknowledged item, you'll get a phone
notification with a link to reply directly from the phone.

### Self-hosted ntfy

Pass your own server URL:

```bash
"ntfy_server": "https://push.example.com"
```

---

## Quick setup — Pushover

1. Create an account at [pushover.net](https://pushover.net) and install the app.
2. Create an application token at <https://pushover.net/apps/build>.
3. Note your **User Key** from the Pushover dashboard.
4. Configure:

```bash
curl -sS -X POST http://127.0.0.1:7821/config/push \
  -H 'Content-Type: application/json' \
  -d '{
    "enabled": true,
    "provider": "pushover",
    "pushover_token": "YOUR_APP_TOKEN",
    "pushover_user": "YOUR_USER_KEY",
    "afk_threshold_seconds": 120
  }'
```

**Alternatively**, set the token via environment variable before starting the
daemon to avoid sending it over HTTP even on localhost:

```bash
export ILLO_SIDEBAR_PUSH_PUSHOVER_TOKEN="your_app_token"
node daemon/server.js
```

Then POST only `pushover_user` and the provider/enabled fields.

---

## Turning push off

```bash
curl -sS -X POST http://127.0.0.1:7821/config/push \
  -H 'Content-Type: application/json' \
  -d '{"enabled": false}'
```

Or set `"provider": "off"`.

---

## How it works

- A **5-second background tick** scans unresolved, unfocused, non-snoozed items.
- If an item's age exceeds `afk_threshold_seconds`, a push is sent **once**.
- The item gets a `pushedAt` timestamp (persisted) so it is not re-pushed on
  the next tick or after a daemon restart.
- Each push includes a **single-use reply link** (`/reply-from-push?id=…&token=…`)
  that renders a mobile-friendly reply page — tap it from the notification to
  type a reply directly. The token is invalidated after use.
- Outbound HTTP errors are logged to `console.warn` but **never crash the daemon**.
  There are no retries in v0.2.

---

## Security notes

- The daemon binds **127.0.0.1 only**. The reply page is accessible only if the
  push notification link is opened while on the same machine (e.g. via SSH
  tunnel). This is by design.
- ntfy topics are public by default — use a long, random topic name.
- Pushover tokens are not returned by any GET endpoint. The `/protocol` and
  `/config/push` responses only return `pushover_set: true/false`.
- Credentials in the push config are persisted to `$STATE_DIR/state.json` on
  disk (same as all other config). Protect that file with filesystem permissions
  if you're concerned (`chmod 600 ~/.claude/illo-sidebar/state.json`).
