// illo-sidebar daemon: tiny stdlib-only HTTP + WebSocket server.
//
// Responsibilities:
//   - Receive events from any agent framework via POST /event (generic protocol)
//   - Persist a normalized list of pending-input items
//   - Serve the static sidebar UI from ../ui
//   - Push live updates to connected sidebar clients via WebSocket
//   - Accept "focus" (clear-warn), "resume", "reply" and "snooze" callbacks
//   - Append item-lifecycle events to a history log (node:sqlite if available,
//     else JSONL) and serve aggregate stats
//   - Optional mobile push via ntfy.sh or Pushover (opt-in, off by default)
//   - VCR record/replay for debugging and demos
//
// Hard constraints:
//   - Zero npm dependencies. Node stdlib only.
//   - Bind 127.0.0.1 only.
//   - No telemetry, no remote calls unless user explicitly enables push.
//
// Protocol version: 0.2.0. The legacy v0.1 envelope is still accepted; every
// v0.1 event still produces an identical item shape so existing hook scripts
// keep working unchanged. See ../docs/protocol.md.

import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const PROTOCOL_VERSION = '0.2.0';
const SUPPORTED_KINDS = [
  'ask_user',
  'notification',
  'stop',
  'session_start',
  'session_end',
  'ask_user_answered',
  'user_prompt',
  'custom',
];
const SUPPORTED_AGENT_KINDS = [
  'claude-code',
  'langgraph',
  'crewai',
  'codex',
  'aider',
  'cursor',
  'openai-agents',
  'generic',
];
const SUPPORTED_URGENCIES = ['low', 'normal', 'urgent'];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UI_DIR = path.resolve(__dirname, '..', 'ui');
const STATE_DIR =
  process.env.ILLO_SIDEBAR_HOME ||
  path.join(os.homedir(), '.claude', 'illo-sidebar');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const PORT_FILE = path.join(STATE_DIR, 'daemon.port');
const PID_FILE = path.join(STATE_DIR, 'daemon.pid');
const RESUME_FILE = path.join(STATE_DIR, 'pending_resume.json');
const HISTORY_JSONL = path.join(STATE_DIR, 'history.jsonl');
const HISTORY_SQLITE = path.join(STATE_DIR, 'history.sqlite');
const VCR_DIR = path.join(STATE_DIR, 'vcr');

const DEFAULT_PORT = Number(process.env.ILLO_SIDEBAR_PORT || 7821);
// Re-warn cadence — also re-broadcast on a config change.
const DEFAULT_WARN_INTERVAL_S = Number(
  process.env.ILLO_SIDEBAR_WARN_INTERVAL_S || 300
);

await fsp.mkdir(STATE_DIR, { recursive: true });
await fsp.mkdir(VCR_DIR, { recursive: true });

// ---------- history sink ----------
// Try node:sqlite (Node 22+) first; fall back to JSONL.
let historyDb = null;
let historyKind = 'jsonl';
try {
  // Dynamic import so missing module just throws and we fall back.
  const sqliteMod = await import('node:sqlite').catch(() => null);
  if (sqliteMod?.DatabaseSync) {
    historyDb = new sqliteMod.DatabaseSync(HISTORY_SQLITE);
    historyDb.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        item_id TEXT NOT NULL,
        action TEXT NOT NULL,
        kind TEXT,
        agent_kind TEXT,
        urgency TEXT,
        title TEXT,
        meta TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
    `);
    historyKind = 'sqlite';
  }
} catch {
  historyDb = null;
  historyKind = 'jsonl';
}

function historyAppend(rec) {
  // rec: { ts, item_id, action, kind, agent_kind, urgency, title, meta }
  try {
    if (historyKind === 'sqlite' && historyDb) {
      const stmt = historyDb.prepare(
        'INSERT INTO events (ts, item_id, action, kind, agent_kind, urgency, title, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      );
      stmt.run(
        rec.ts,
        rec.item_id,
        rec.action,
        rec.kind || null,
        rec.agent_kind || null,
        rec.urgency || null,
        rec.title || null,
        rec.meta ? JSON.stringify(rec.meta) : null
      );
    } else {
      fs.appendFileSync(HISTORY_JSONL, JSON.stringify(rec) + '\n');
    }
  } catch {
    /* never let history I/O break a hook path */
  }
}

function historyReadSince(sinceMs) {
  // Returns array of records with at least { ts, item_id, action, kind, agent_kind, urgency, title }
  try {
    if (historyKind === 'sqlite' && historyDb) {
      const rows = historyDb
        .prepare(
          'SELECT ts, item_id, action, kind, agent_kind, urgency, title, meta FROM events WHERE ts >= ? ORDER BY ts ASC'
        )
        .all(sinceMs);
      return rows;
    }
    if (!fs.existsSync(HISTORY_JSONL)) return [];
    const raw = fs.readFileSync(HISTORY_JSONL, 'utf8');
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const r = JSON.parse(line);
        if (typeof r.ts === 'number' && r.ts >= sinceMs) out.push(r);
      } catch {
        /* skip malformed line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

// ---------- in-memory state ----------
const state = {
  config: {
    warnIntervalSeconds: DEFAULT_WARN_INTERVAL_S,
    warnStyle: process.env.ILLO_SIDEBAR_WARN_STYLE || 'pulse',
    // Mobile push config — OFF by default. User must explicitly enable.
    // See docs/push.md for setup instructions.
    push: {
      enabled: false,
      provider: 'off',          // "ntfy" | "pushover" | "off"
      ntfy_topic: '',
      ntfy_server: 'https://ntfy.sh',
      pushover_token: process.env.ILLO_SIDEBAR_PUSH_PUSHOVER_TOKEN || '',
      pushover_user: '',
      afk_threshold_seconds: 120,
    },
  },
  // items keyed by id, oldest-first iteration
  items: new Map(),
  sessions: new Map(),
};

function persist() {
  const out = {
    config: state.config,
    items: Array.from(state.items.values()),
  };
  fsp.writeFile(STATE_FILE, JSON.stringify(out, null, 2)).catch(() => {});
}

function restore() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.config) {
      // Deep-merge push config to preserve defaults for new keys
      if (parsed.config.push) {
        Object.assign(state.config.push, parsed.config.push);
      }
      const { push: _push, ...rest } = parsed.config;
      Object.assign(state.config, rest);
    }
    if (Array.isArray(parsed?.items)) {
      for (const it of parsed.items) state.items.set(it.id, it);
    }
  } catch {
    /* fresh state */
  }
}
restore();

// ---------- event ingestion ----------
//
// An "item" is a normalized pending-input entry. The shape includes both v0.1
// fields (kind, sessionId, title, snippet, payload, focused, resolved) and v0.2
// fields (agentId, agentKind, urgency, snoozedUntil, transcriptSnapshot,
// quickReplyEnabled, replied). v0.1 events still produce identical items so
// no consumer breaks.
// pushedAt is added for mobile push tracking — null means not yet pushed.
function makeItem({
  kind,
  sessionId,
  title,
  snippet,
  payload,
  subkind,
  agentId,
  agentKind,
  urgency,
  transcriptSnapshot,
  quickReplyEnabled,
}) {
  const now = Date.now();
  const id =
    'itm_' +
    createHash('sha1')
      .update(`${now}:${Math.random()}:${kind}:${title}`)
      .digest('hex')
      .slice(0, 12);
  return {
    id,
    kind, // 'ask_user' | 'notification' | 'idle' | 'custom'
    subkind: subkind || null,
    sessionId: sessionId || null,
    agentId: agentId || null,
    agentKind: agentKind || 'claude-code',
    urgency: SUPPORTED_URGENCIES.includes(urgency) ? urgency : 'normal',
    title: title || '(untitled)',
    snippet: snippet || '',
    payload: payload || null,
    transcriptSnapshot:
      typeof transcriptSnapshot === 'string' && transcriptSnapshot
        ? transcriptSnapshot
        : null,
    quickReplyEnabled: quickReplyEnabled !== false,
    snoozedUntil: null,
    createdAt: now,
    lastWarnedAt: now,
    focused: false,
    resolved: false,
    replied: false,
    resolvedAt: null,
    pushedAt: null,  // mobile push tracking — null = not yet pushed
  };
}

function addItem(item) {
  state.items.set(item.id, item);
  persist();
  historyAppend({
    ts: Date.now(),
    item_id: item.id,
    action: 'created',
    kind: item.kind,
    agent_kind: item.agentKind,
    urgency: item.urgency,
    title: item.title,
  });
  broadcast({ type: 'item:add', item });
  return item;
}

function updateItem(id, patch, action) {
  const cur = state.items.get(id);
  if (!cur) return null;
  Object.assign(cur, patch);
  persist();
  if (action) {
    historyAppend({
      ts: Date.now(),
      item_id: cur.id,
      action,
      kind: cur.kind,
      agent_kind: cur.agentKind,
      urgency: cur.urgency,
      title: cur.title,
    });
  }
  broadcast({ type: 'item:update', item: cur });
  return cur;
}

// Read common envelope fields (v0.2 generic protocol).
function envelope(evt) {
  return {
    sessionId: evt.session_id || null,
    agentId: evt.agent_id || null,
    agentKind: evt.agent_kind || 'claude-code',
    urgency: evt.urgency || 'normal',
    transcriptSnapshot: evt.transcript_snapshot || null,
    quickReplyEnabled: evt.quick_reply_enabled !== false,
    titleOverride: typeof evt.title === 'string' ? evt.title : null,
    snippetOverride: typeof evt.snippet === 'string' ? evt.snippet : null,
    payload: evt.payload || null,
  };
}

function ingest(evt) {
  const env = envelope(evt);
  let createdItem = null;
  switch (evt.kind) {
    case 'ask_user': {
      const ti = evt.tool_input || {};
      const qs = Array.isArray(ti.questions) ? ti.questions : [];
      const first = qs[0] || {};
      const derivedTitle =
        first.question?.slice(0, 80) ||
        ti.question?.slice(0, 80) ||
        'Claude is asking a question';
      const derivedSnippet =
        (qs.length > 1 ? `+${qs.length - 1} more question(s). ` : '') +
        (Array.isArray(first.options)
          ? 'Options: ' + first.options.map((o) => o.label).join(' / ')
          : '');
      createdItem = addItem(
        makeItem({
          kind: 'ask_user',
          sessionId: env.sessionId,
          title: env.titleOverride || derivedTitle,
          snippet: env.snippetOverride || derivedSnippet,
          payload: ti,
          agentId: env.agentId,
          agentKind: env.agentKind,
          urgency: env.urgency,
          transcriptSnapshot: env.transcriptSnapshot,
          quickReplyEnabled: env.quickReplyEnabled,
        })
      );
      break;
    }
    case 'notification': {
      const derivedTitle = evt.message || 'Claude needs your attention';
      createdItem = addItem(
        makeItem({
          kind: 'notification',
          subkind: evt.subkind,
          sessionId: env.sessionId,
          title: (env.titleOverride || derivedTitle).slice(0, 100),
          snippet: env.snippetOverride || '',
          payload: env.payload || { message: evt.message },
          agentId: env.agentId,
          agentKind: env.agentKind,
          urgency: env.urgency,
          transcriptSnapshot: env.transcriptSnapshot,
          quickReplyEnabled: env.quickReplyEnabled,
        })
      );
      break;
    }
    case 'custom': {
      // Generic agent event — most fields come from the envelope.
      createdItem = addItem(
        makeItem({
          kind: 'custom',
          subkind: evt.subkind || null,
          sessionId: env.sessionId,
          title: env.titleOverride || 'Agent needs attention',
          snippet: env.snippetOverride || '',
          payload: env.payload,
          agentId: env.agentId,
          agentKind: env.agentKind,
          urgency: env.urgency,
          transcriptSnapshot: env.transcriptSnapshot,
          quickReplyEnabled: env.quickReplyEnabled,
        })
      );
      break;
    }
    case 'ask_user_answered': {
      // Resolve the most-recent unresolved ask_user item for this session.
      const candidates = Array.from(state.items.values())
        .filter(
          (it) =>
            it.kind === 'ask_user' &&
            !it.resolved &&
            (!evt.session_id || it.sessionId === evt.session_id)
        )
        .sort((a, b) => b.createdAt - a.createdAt);
      if (candidates[0]) {
        updateItem(
          candidates[0].id,
          { resolved: true, resolvedAt: Date.now(), focused: true },
          'resolved'
        );
      }
      return null;
    }
    case 'user_prompt': {
      // User typed something — that implicitly resolves any "idle" warns.
      // Real ask_user resolution comes via PostToolUse, not this path.
      for (const it of state.items.values()) {
        if (it.kind === 'idle' && !it.resolved) {
          updateItem(
            it.id,
            { resolved: true, resolvedAt: Date.now() },
            'resolved'
          );
        }
      }
      return null;
    }
    case 'session_start':
    case 'session_end':
    case 'stop': {
      // Stash session info but don't synthesize items by default.
      if (evt.session_id) {
        state.sessions.set(evt.session_id, {
          ...(state.sessions.get(evt.session_id) || {}),
          lastEvent: evt.kind,
          lastEventAt: Date.now(),
          cwd: evt.cwd,
          agentId: env.agentId,
          agentKind: env.agentKind,
        });
      }
      broadcast({ type: 'session', kind: evt.kind, sessionId: evt.session_id });
      return null;
    }
    case 'heartbeat': {
      // No-op; agents send these to indicate liveness. Not a top-level kind in
      // SUPPORTED_KINDS but accepted for SDK convenience.
      if (evt.session_id) {
        state.sessions.set(evt.session_id, {
          ...(state.sessions.get(evt.session_id) || {}),
          lastHeartbeatAt: Date.now(),
          agentId: env.agentId,
          agentKind: env.agentKind,
        });
      }
      return null;
    }
    default:
      return null;
  }

  // If VCR is recording, write this event to the recording stream.
  if (createdItem && vcrState.recording && vcrState.writeStream) {
    try {
      const afterMs = Date.now() - vcrState.startedAt;
      const line = JSON.stringify({ after_ms: afterMs, event: evt }) + '\n';
      vcrState.writeStream.write(line);
    } catch (e) {
      console.warn('[vcr] write error:', e.message);
    }
  }

  return createdItem;
}

// ---------- re-warn timer ----------
// Once per second, look for unresolved items not focused whose last-warn was
// longer than `effectiveInterval(item)` ago, bump them, and notify clients.
// Effective interval is urgency-aware: low = 4×, normal = 1×, urgent = 0.5×.
function urgencyMultiplier(urgency) {
  if (urgency === 'low') return 4;
  if (urgency === 'urgent') return 0.5;
  return 1;
}

setInterval(() => {
  const now = Date.now();
  const baseMs = state.config.warnIntervalSeconds * 1000;
  if (baseMs <= 0) return;
  for (const it of state.items.values()) {
    if (it.resolved || it.focused) continue;
    if (it.snoozedUntil && now < it.snoozedUntil) continue;
    const effMs = baseMs * urgencyMultiplier(it.urgency);
    if (now - it.lastWarnedAt >= effMs) {
      it.lastWarnedAt = now;
      broadcast({
        type: 'item:warn',
        id: it.id,
        style: state.config.warnStyle,
        urgency: it.urgency,
      });
    }
  }
}, 1000).unref?.();

// ---------- mobile push tick ----------
// Fires every 5 seconds. Scans for unresolved, unfocused, non-snoozed items
// that have been pending longer than afk_threshold_seconds without a push.
// Push is strictly opt-in and off by default.
//
// Per-item `pushedAt` is persisted on the item so it survives daemon restarts.
// Outbound errors are logged to console.warn but never crash the process.
//
// In-memory map of item_id → single-use reply token (for /reply-from-push).
const pushReplyTokens = new Map(); // id -> token

function generateToken() {
  return createHash('sha1')
    .update(String(Date.now()) + String(Math.random()))
    .digest('hex')
    .slice(0, 16);
}

// Map Pushover priority scale (-2..2) from urgency
function pushoverPriority(urgency) {
  if (urgency === 'urgent') return 1;
  if (urgency === 'low') return -1;
  return 0;
}

// Map ntfy priority (1..5) from urgency
function ntfyPriority(urgency) {
  if (urgency === 'urgent') return 5;
  if (urgency === 'low') return 1;
  return 3;
}

function httpsPost(urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sendNtfyPush(item, token, port) {
  const cfg = state.config.push;
  const server = cfg.ntfy_server || 'https://ntfy.sh';
  const topic = cfg.ntfy_topic || '';
  if (!topic) return;

  const replyLink = `http://127.0.0.1:${port}/reply-from-push?id=${encodeURIComponent(item.id)}&token=${token}`;
  const url = `${server.replace(/\/$/, '')}/${encodeURIComponent(topic)}`;

  const headers = {
    'Content-Type': 'text/plain',
    'Title': item.title.slice(0, 250),
    'Priority': String(ntfyPriority(item.urgency)),
    'Tags': 'illo-sidebar',
    'X-Click': replyLink,
  };

  await httpsPost(url, headers, item.title);
}

async function sendPushoverPush(item, token, port) {
  const cfg = state.config.push;
  if (!cfg.pushover_token || !cfg.pushover_user) return;

  const replyLink = `http://127.0.0.1:${port}/reply-from-push?id=${encodeURIComponent(item.id)}&token=${token}`;
  const body = JSON.stringify({
    token: cfg.pushover_token,
    user: cfg.pushover_user,
    message: item.snippet || item.title,
    title: item.title.slice(0, 250),
    priority: pushoverPriority(item.urgency),
    url: replyLink,
    url_title: 'Reply',
  });

  await httpsPost('https://api.pushover.net/1/messages.json', {
    'Content-Type': 'application/json',
  }, body);
}

// Kick off the push tick — will resolve once the server is listening.
let daemonPort = DEFAULT_PORT; // updated after listen()

setInterval(async () => {
  const cfg = state.config.push;
  if (!cfg.enabled || cfg.provider === 'off') return;

  const now = Date.now();
  const threshold = (cfg.afk_threshold_seconds || 120) * 1000;

  for (const it of state.items.values()) {
    if (it.resolved || it.focused) continue;
    if (it.pushedAt != null) continue; // already pushed this item
    if (it.snoozedUntil && now < it.snoozedUntil) continue;
    if (now - it.createdAt < threshold) continue; // not old enough

    // Generate a single-use reply token and store it.
    const token = generateToken();
    pushReplyTokens.set(it.id, token);

    try {
      if (cfg.provider === 'ntfy') {
        await sendNtfyPush(it, token, daemonPort);
      } else if (cfg.provider === 'pushover') {
        await sendPushoverPush(it, token, daemonPort);
      }
      // Mark pushed — persisted on the item.
      updateItem(it.id, { pushedAt: now });
    } catch (e) {
      console.warn('[push] outbound error for item', it.id, ':', e.message);
      // Remove token on failure so we can retry next tick.
      pushReplyTokens.delete(it.id);
    }
  }
}, 5000).unref?.();

// ---------- VCR state ----------
const vcrState = {
  recording: false,
  startedAt: 0,
  currentPath: null,
  writeStream: null,
};

async function vcrRecordStart() {
  if (vcrState.recording && vcrState.writeStream) {
    vcrState.writeStream.end();
  }
  const tmpPath = path.join(STATE_DIR, 'vcr-current.jsonl');
  vcrState.writeStream = fs.createWriteStream(tmpPath, { flags: 'w' });
  vcrState.recording = true;
  vcrState.startedAt = Date.now();
  vcrState.currentPath = tmpPath;
  return tmpPath;
}

async function vcrRecordStop(name) {
  if (!vcrState.recording || !vcrState.writeStream) {
    throw new Error('not_recording');
  }
  await new Promise((r) => vcrState.writeStream.end(r));
  vcrState.recording = false;

  const safeName = String(name || 'unnamed').replace(/[^a-zA-Z0-9_-]/g, '_');
  const dest = path.join(VCR_DIR, `${safeName}.jsonl`);
  await fsp.rename(vcrState.currentPath, dest);
  vcrState.currentPath = null;
  vcrState.writeStream = null;
  return dest;
}

async function vcrList() {
  try {
    const entries = await fsp.readdir(VCR_DIR);
    const results = [];
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      try {
        const stat = await fsp.stat(path.join(VCR_DIR, f));
        results.push({
          name: f.replace(/\.jsonl$/, ''),
          size: stat.size,
          mtime: stat.mtimeMs,
        });
      } catch { /* skip */ }
    }
    return results;
  } catch {
    return [];
  }
}

async function vcrReplay(name, speed, intoSession) {
  const safeName = String(name || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  const filePath = path.join(VCR_DIR, `${safeName}.jsonl`);
  const raw = await fsp.readFile(filePath, 'utf8');
  const lines = raw.split('\n').filter(Boolean);

  const sessionId = intoSession || 'vcr-replay';
  const spd = Number(speed) > 0 ? Number(speed) : 1;

  // Run replay asynchronously — don't block the HTTP response.
  (async () => {
    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        const delay = Math.round((rec.after_ms || 0) / spd);
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        const evt = { ...(rec.event || {}), agent_id: sessionId };
        ingest(evt);
      } catch (e) {
        console.warn('[vcr] replay parse error:', e.message);
      }
    }
  })().catch((e) => console.warn('[vcr] replay error:', e.message));
}

// ---------- HTTP server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // CORS — daemon binds to localhost only, but a UI loaded from file://
  // would need this. We allow same-origin and explicit dev.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (url.pathname === '/healthz')
      return json(res, 200, { ok: true, version: PROTOCOL_VERSION });
    if (url.pathname === '/protocol' && req.method === 'GET') {
      const pushCfg = state.config.push;
      return json(res, 200, {
        version: PROTOCOL_VERSION,
        kinds: SUPPORTED_KINDS,
        agent_kinds: SUPPORTED_AGENT_KINDS,
        urgencies: SUPPORTED_URGENCIES,
        // push capability summary — does NOT leak tokens/credentials
        push: {
          enabled: pushCfg.enabled,
          provider: pushCfg.provider,
          ntfy_topic_set: Boolean(pushCfg.ntfy_topic),
          pushover_set: Boolean(pushCfg.pushover_token && pushCfg.pushover_user),
        },
        endpoints: [
          { method: 'GET', path: '/healthz' },
          { method: 'GET', path: '/protocol' },
          { method: 'GET', path: '/state' },
          { method: 'GET', path: '/stats' },
          { method: 'POST', path: '/event' },
          { method: 'POST', path: '/config' },
          { method: 'POST', path: '/config/push' },
          { method: 'POST', path: '/items/:id/focus' },
          { method: 'POST', path: '/items/:id/resume' },
          { method: 'POST', path: '/items/:id/reply' },
          { method: 'POST', path: '/items/:id/snooze' },
          { method: 'DELETE', path: '/items/:id' },
          { method: 'POST', path: '/clear' },
          { method: 'GET', path: '/reply-from-push' },
          { method: 'POST', path: '/vcr/record/start' },
          { method: 'POST', path: '/vcr/record/stop' },
          { method: 'GET', path: '/vcr/list' },
          { method: 'POST', path: '/vcr/replay' },
          { method: 'WS', path: '/ws' },
        ],
        history_backend: historyKind,
      });
    }
    if (url.pathname === '/state' && req.method === 'GET') {
      return json(res, 200, snapshot());
    }
    if (url.pathname === '/stats' && req.method === 'GET') {
      const days = Number(url.searchParams.get('days') || 7);
      return json(res, 200, computeStats(days));
    }
    if (url.pathname === '/event' && req.method === 'POST') {
      const body = await readJson(req);
      const item = ingest(body);
      return json(res, 200, { ok: true, item });
    }
    if (url.pathname === '/config' && req.method === 'POST') {
      const body = await readJson(req);
      if (typeof body.warnIntervalSeconds === 'number') {
        state.config.warnIntervalSeconds = body.warnIntervalSeconds;
      }
      if (typeof body.warnStyle === 'string') {
        state.config.warnStyle = body.warnStyle;
      }
      persist();
      broadcast({ type: 'config', config: state.config });
      return json(res, 200, state.config);
    }
    // POST /config/push — update mobile push settings.
    // WARNING: This endpoint accepts sensitive credentials (Pushover token/user).
    // Prefer setting ILLO_SIDEBAR_PUSH_PUSHOVER_TOKEN env var for token.
    // Push is opt-in and OFF by default. See docs/push.md.
    if (url.pathname === '/config/push' && req.method === 'POST') {
      const body = await readJson(req);
      const push = state.config.push;

      if (typeof body.enabled === 'boolean') push.enabled = body.enabled;

      // Validate provider — treat unknown as 'off'.
      if (typeof body.provider === 'string') {
        push.provider = ['ntfy', 'pushover', 'off'].includes(body.provider)
          ? body.provider
          : 'off';
      }
      if (typeof body.ntfy_topic === 'string') push.ntfy_topic = body.ntfy_topic;
      if (typeof body.ntfy_server === 'string') push.ntfy_server = body.ntfy_server;
      if (typeof body.pushover_token === 'string') push.pushover_token = body.pushover_token;
      if (typeof body.pushover_user === 'string') push.pushover_user = body.pushover_user;
      if (typeof body.afk_threshold_seconds === 'number') push.afk_threshold_seconds = body.afk_threshold_seconds;

      persist();
      // Return a safe summary — never echo back credentials.
      return json(res, 200, {
        ok: true,
        push: {
          enabled: push.enabled,
          provider: push.provider,
          ntfy_topic_set: Boolean(push.ntfy_topic),
          ntfy_server: push.ntfy_server,
          pushover_set: Boolean(push.pushover_token && push.pushover_user),
          afk_threshold_seconds: push.afk_threshold_seconds,
        },
      });
    }
    // GET /reply-from-push?id=<id>&token=<token>
    // Renders a mobile-friendly reply page. Token is single-use.
    if (url.pathname === '/reply-from-push' && req.method === 'GET') {
      const id = url.searchParams.get('id') || '';
      const token = url.searchParams.get('token') || '';
      const item = state.items.get(id);

      if (!item || pushReplyTokens.get(id) !== token || !token) {
        res.writeHead(410, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(replyPageHtml('', 'Link expired or invalid. Please reply directly in the sidebar.', true));
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(replyPageHtml(id, item.title, false, token, item.snippet));
    }
    // POST /reply-from-push-submit — handles the HTML form submission from the reply page.
    if (url.pathname === '/reply-from-push-submit' && req.method === 'POST') {
      const body = await readFormBody(req);
      const id = body.id || '';
      const token = body.token || '';
      const text = body.text || '';
      const item = state.items.get(id);

      if (!item || pushReplyTokens.get(id) !== token || !token) {
        res.writeHead(410, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(replyPageHtml('', 'Link expired or invalid.', true));
      }

      // Token consumed — remove it.
      pushReplyTokens.delete(id);

      if (item.quickReplyEnabled === false) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(replyPageHtml('', 'Quick reply is disabled for this item.', true));
      }

      const resumePayload = {
        id: item.id,
        title: item.title,
        snippet: item.snippet,
        original_payload: JSON.stringify(item.payload || {}),
        user_reply_text: text,
        ts: new Date().toISOString(),
      };
      await fsp.writeFile(RESUME_FILE, JSON.stringify(resumePayload, null, 2));
      updateItem(id, { focused: true, replied: true, resolved: true, resolvedAt: Date.now() }, 'replied');

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(replyPageHtml('', 'Reply sent! Claude will continue.', true));
    }

    if (url.pathname.startsWith('/items/')) {
      const parts = url.pathname.split('/');
      const id = parts[2];
      const action = parts[3];
      if (req.method === 'POST' && action === 'focus') {
        const it = updateItem(id, { focused: true }, 'focused');
        if (!it) return json(res, 404, { error: 'not_found' });
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && action === 'resume') {
        const it = state.items.get(id);
        if (!it) return json(res, 404, { error: 'not_found' });
        const resumePayload = {
          id: it.id,
          title: it.title,
          snippet: it.snippet,
          original_payload: JSON.stringify(it.payload || {}),
          ts: new Date().toISOString(),
        };
        await fsp.writeFile(RESUME_FILE, JSON.stringify(resumePayload, null, 2));
        updateItem(id, { focused: true }, 'focused');
        return json(res, 200, { ok: true, resumeFile: RESUME_FILE });
      }
      if (req.method === 'POST' && action === 'reply') {
        const it = state.items.get(id);
        if (!it) return json(res, 404, { error: 'not_found' });
        if (it.quickReplyEnabled === false) {
          return json(res, 400, { error: 'quick_reply_disabled' });
        }
        const body = await readJson(req);
        const text = typeof body?.text === 'string' ? body.text : '';
        const resumePayload = {
          id: it.id,
          title: it.title,
          snippet: it.snippet,
          original_payload: JSON.stringify(it.payload || {}),
          user_reply_text: text,
          ts: new Date().toISOString(),
        };
        await fsp.writeFile(RESUME_FILE, JSON.stringify(resumePayload, null, 2));
        updateItem(
          id,
          {
            focused: true,
            replied: true,
            resolved: true,
            resolvedAt: Date.now(),
          },
          'replied'
        );
        // If this item had a push reply token, invalidate it (already replied).
        pushReplyTokens.delete(id);
        return json(res, 200, { ok: true, resumeFile: RESUME_FILE });
      }
      if (req.method === 'POST' && action === 'snooze') {
        const it = state.items.get(id);
        if (!it) return json(res, 404, { error: 'not_found' });
        const body = await readJson(req);
        const seconds = Number(body?.seconds);
        if (!Number.isFinite(seconds) || seconds <= 0) {
          return json(res, 400, { error: 'invalid_seconds' });
        }
        const until = Date.now() + seconds * 1000;
        updateItem(id, { snoozedUntil: until }, 'snoozed');
        return json(res, 200, { ok: true, snoozedUntil: until });
      }
      if (req.method === 'DELETE' && !action) {
        const it = state.items.get(id);
        if (it) {
          historyAppend({
            ts: Date.now(),
            item_id: it.id,
            action: 'dismissed',
            kind: it.kind,
            agent_kind: it.agentKind,
            urgency: it.urgency,
            title: it.title,
          });
        }
        state.items.delete(id);
        persist();
        broadcast({ type: 'item:remove', id });
        return json(res, 200, { ok: true });
      }
    }
    if (url.pathname === '/clear' && req.method === 'POST') {
      const removed = [];
      for (const [id, it] of state.items) {
        if (it.resolved) {
          state.items.delete(id);
          removed.push(id);
        }
      }
      persist();
      broadcast({ type: 'cleared', ids: removed });
      return json(res, 200, { ok: true, removed });
    }

    // ---- VCR endpoints ----
    if (url.pathname === '/vcr/record/start' && req.method === 'POST') {
      const filePath = await vcrRecordStart();
      return json(res, 200, { recording: true, path: filePath });
    }
    if (url.pathname === '/vcr/record/stop' && req.method === 'POST') {
      const body = await readJson(req);
      try {
        const savedPath = await vcrRecordStop(body.name || 'unnamed');
        return json(res, 200, { saved: savedPath });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }
    if (url.pathname === '/vcr/list' && req.method === 'GET') {
      const recordings = await vcrList();
      return json(res, 200, { recordings });
    }
    if (url.pathname === '/vcr/replay' && req.method === 'POST') {
      const body = await readJson(req);
      if (!body.name) return json(res, 400, { error: 'name required' });
      try {
        await vcrReplay(body.name, body.speed || 1, body.into_session || 'vcr-replay');
        return json(res, 200, { ok: true, replaying: body.name });
      } catch (e) {
        return json(res, 404, { error: e.message });
      }
    }

    // ---- WebSocket upgrade is handled in 'upgrade' event below ----

    // ---- static UI ----
    if (req.method === 'GET') {
      let p = url.pathname === '/' ? '/index.html' : url.pathname;
      const filePath = path.join(UI_DIR, p);
      if (!filePath.startsWith(UI_DIR)) {
        res.writeHead(403);
        return res.end('forbidden');
      }
      try {
        const buf = await fsp.readFile(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const ct =
          {
            '.html': 'text/html; charset=utf-8',
            '.js': 'application/javascript; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.svg': 'image/svg+xml',
            '.png': 'image/png',
            '.json': 'application/json',
          }[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'no-cache' });
        return res.end(buf);
      } catch {
        res.writeHead(404);
        return res.end('not found');
      }
    }

    res.writeHead(404);
    res.end('not found');
  } catch (err) {
    res.writeHead(500);
    res.end('error: ' + err.message);
  }
});

// ---------- reply-from-push HTML page ----------
function replyPageHtml(id, title, done, token, snippet) {
  const safeTitle = (title || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const safeSnippet = (snippet || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  if (done) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>illo-sidebar</title>
<style>
  body{font-family:system-ui,sans-serif;margin:0;padding:2rem;background:#0f0f10;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center}
  .card{background:#1e293b;border-radius:12px;padding:2rem;max-width:420px;width:100%;text-align:center}
  h1{font-size:1.25rem;margin:0 0 1rem}
  .msg{color:#94a3b8;font-size:0.9rem}
</style>
</head>
<body>
<div class="card">
  <h1>illo-sidebar</h1>
  <p class="msg">${safeTitle}</p>
</div>
</body>
</html>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reply — illo-sidebar</title>
<style>
  *{box-sizing:border-box}
  body{font-family:system-ui,sans-serif;margin:0;padding:1rem;background:#0f0f10;color:#e2e8f0;min-height:100vh}
  .card{background:#1e293b;border-radius:12px;padding:1.5rem;max-width:480px;margin:auto}
  h1{font-size:1.1rem;margin:0 0 0.5rem;color:#f1f5f9}
  .title{font-size:1rem;font-weight:600;color:#f8fafc;margin-bottom:0.5rem}
  .snippet{font-size:0.85rem;color:#94a3b8;margin-bottom:1.25rem}
  textarea{width:100%;min-height:120px;background:#0f172a;border:1px solid #334155;color:#e2e8f0;border-radius:8px;padding:0.75rem;font-size:1rem;resize:vertical;outline:none}
  textarea:focus{border-color:#3b82f6}
  button{margin-top:0.75rem;width:100%;padding:0.9rem;background:#3b82f6;color:#fff;border:none;border-radius:8px;font-size:1rem;font-weight:600;cursor:pointer}
  button:active{background:#2563eb}
  .label{font-size:0.75rem;color:#64748b;margin-bottom:0.25rem}
</style>
</head>
<body>
<div class="card">
  <h1>illo-sidebar — Reply</h1>
  <div class="title">${safeTitle}</div>
  ${safeSnippet ? `<div class="snippet">${safeSnippet}</div>` : ''}
  <form method="POST" action="/reply-from-push-submit">
    <input type="hidden" name="id" value="${id}">
    <input type="hidden" name="token" value="${token || ''}">
    <div class="label">Your reply</div>
    <textarea name="text" autofocus placeholder="Type your reply…"></textarea>
    <button type="submit">Send Reply</button>
  </form>
</div>
</body>
</html>`;
}

// ---------- WebSocket (RFC 6455, hand-rolled, no deps) ----------
const wsClients = new Set();

server.on('upgrade', (req, socket, head) => {
  if (req.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  const accept = createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  wsClients.add(socket);
  // Initial snapshot.
  wsSend(socket, JSON.stringify({ type: 'snapshot', ...snapshot() }));

  socket.on('data', (buf) => {
    try {
      const msg = wsDecode(buf);
      if (!msg) return;
      // We don't need client->server messages over WS for v0.1; HTTP suffices.
    } catch {
      /* ignore */
    }
  });
  socket.on('close', () => wsClients.delete(socket));
  socket.on('error', () => wsClients.delete(socket));
});

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const s of wsClients) {
    try {
      wsSend(s, data);
    } catch {
      wsClients.delete(s);
    }
  }
}

function wsSend(socket, str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

function wsDecode(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  if (opcode === 0x8) return null; // close
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  let mask = null;
  if (masked) {
    mask = buf.slice(offset, offset + 4);
    offset += 4;
  }
  const data = buf.slice(offset, offset + len);
  if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
  return data.toString('utf8');
}

// ---------- helpers ----------
function snapshot() {
  return {
    config: state.config,
    items: Array.from(state.items.values()).sort(
      (a, b) => a.createdAt - b.createdAt
    ),
  };
}

// ---------- stats aggregation ----------
function computeStats(windowDays) {
  const now = Date.now();
  const since = now - windowDays * 24 * 3600 * 1000;
  const recs = historyReadSince(since);

  const byKind = {};
  const byAgentKind = {};
  const titleCounts = {};
  // resolution timing: for each item_id we look for "created" then a terminal
  // action (resolved | replied | dismissed) and record delta.
  const created = new Map();
  const resolveDeltas = [];
  let dismissals = 0;
  let totalCreated = 0;

  for (const r of recs) {
    if (r.action === 'created') {
      totalCreated += 1;
      created.set(r.item_id, r.ts);
      if (r.kind) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
      if (r.agent_kind)
        byAgentKind[r.agent_kind] = (byAgentKind[r.agent_kind] || 0) + 1;
      if (r.title) titleCounts[r.title] = (titleCounts[r.title] || 0) + 1;
    } else if (
      r.action === 'resolved' ||
      r.action === 'replied' ||
      r.action === 'dismissed'
    ) {
      const start = created.get(r.item_id);
      if (typeof start === 'number') {
        resolveDeltas.push(r.ts - start);
        created.delete(r.item_id);
      }
      if (r.action === 'dismissed') dismissals += 1;
    }
  }

  const sorted = resolveDeltas.slice().sort((a, b) => a - b);
  const median =
    sorted.length === 0
      ? null
      : Math.round(sorted[Math.floor(sorted.length / 2)] / 1000);
  const p95 =
    sorted.length === 0
      ? null
      : Math.round(
          sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] /
            1000
        );

  const top = Object.entries(titleCounts)
    .filter(([, c]) => c > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([title, count]) => ({ title, count }));

  return {
    window_days: windowDays,
    total_items: totalCreated,
    by_kind: byKind,
    by_agent_kind: byAgentKind,
    median_time_to_resolve_seconds: median,
    p95_time_to_resolve_seconds: p95,
    dismissal_rate:
      totalCreated > 0 ? Number((dismissals / totalCreated).toFixed(4)) : 0,
    top_recurring_titles: top,
    history_backend: historyKind,
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const s = Buffer.concat(chunks).toString('utf8') || '{}';
        resolve(JSON.parse(s));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// Parse simple application/x-www-form-urlencoded body (used by reply HTML form).
function readFormBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const s = Buffer.concat(chunks).toString('utf8');
        const result = {};
        for (const pair of s.split('&')) {
          const [k, v] = pair.split('=');
          if (k) result[decodeURIComponent(k.replace(/\+/g, ' '))] =
            decodeURIComponent((v || '').replace(/\+/g, ' '));
        }
        resolve(result);
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// ---------- bind with port-fallback ----------
function listen(port, attempt = 0) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 20) {
      listen(port + 1, attempt + 1);
    } else {
      console.error('listen failed:', err);
      process.exit(1);
    }
  });
  server.listen(port, '127.0.0.1', () => {
    daemonPort = server.address().port;
    fs.writeFileSync(PORT_FILE, String(daemonPort));
    fs.writeFileSync(PID_FILE, String(process.pid));
    console.log(`illo-sidebar daemon listening on http://127.0.0.1:${daemonPort}`);
  });
}

listen(DEFAULT_PORT);

const cleanup = () => {
  try {
    if (fs.readFileSync(PID_FILE, 'utf8') === String(process.pid)) {
      fs.unlinkSync(PID_FILE);
    }
  } catch {}
  process.exit(0);
};
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// Exported only for unit tests.
export const __test = {
  state,
  ingest,
  snapshot,
  addItem,
  updateItem,
  computeStats,
  historyAppend,
  historyReadSince,
  PROTOCOL_VERSION,
  vcrState,
  pushReplyTokens,
};
