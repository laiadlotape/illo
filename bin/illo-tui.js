#!/usr/bin/env node
// illo-tui — CLI-native TUI sidebar for illo-sidebar daemon.
// Zero npm deps. Pure Node.js stdlib + ANSI escape codes.
// Connects to the daemon via WebSocket (RFC 6455, hand-rolled), renders a
// full-screen list of pending items in the alternate screen buffer.
//
// Usage:
//   node bin/illo-tui.js           # normal TUI mode
//   node bin/illo-tui.js --no-tty  # headless smoke-test mode (print snapshot + exit on EOF)

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';

// ─── args ────────────────────────────────────────────────────────────────────
const NO_TTY = process.argv.includes('--no-tty');

// ─── port discovery ──────────────────────────────────────────────────────────
function discoverPort() {
  if (process.env.ILLO_SIDEBAR_PORT) return Number(process.env.ILLO_SIDEBAR_PORT);
  const home = process.env.ILLO_SIDEBAR_HOME ||
    `${os.homedir()}/.claude/illo-sidebar`;
  const portFile = `${home}/daemon.port`;
  try {
    return Number(fs.readFileSync(portFile, 'utf8').trim());
  } catch {
    return 7821;
  }
}

// ─── ANSI helpers ────────────────────────────────────────────────────────────
const ESC = '\x1b';
const CSI = `${ESC}[`;

function moveTo(row, col) { return `${CSI}${row};${col}H`; }
function clearScreen() { return `${CSI}2J`; }
function altScreenOn()  { return `${CSI}?1049h`; }
function altScreenOff() { return `${CSI}?1049l`; }
function hideCursor()   { return `${CSI}?25l`; }
function showCursor()   { return `${CSI}?25h`; }
function resetAttrs()   { return `${CSI}0m`; }
function bold()         { return `${CSI}1m`; }
function dim()          { return `${CSI}2m`; }
function reverse()      { return `${CSI}7m`; }
function color(n)       { return `${CSI}38;5;${n}m`; }
function bgColor(n)     { return `${CSI}48;5;${n}m`; }
function eraseLine()    { return `${CSI}2K`; }

// Palette
const C = {
  amber:   214,  // normal urgency accent
  red:     203,  // urgent
  gray:    245,  // low urgency
  green:   114,  // connected / ok
  dim_c:   240,  // muted text
  white:   255,  // foreground
  blue:    111,  // reply prompt
  yellow:  227,  // snooze overlay
};

function urgencyColor(urgency) {
  if (urgency === 'urgent') return C.red;
  if (urgency === 'low')    return C.gray;
  return C.amber;
}

function truncate(str, width) {
  if (!str) return '';
  const s = String(str);
  if (s.length <= width) return s;
  return s.slice(0, width - 1) + '…';
}

function pad(str, width) {
  const s = String(str);
  return s.length >= width ? s.slice(0, width) : s + ' '.repeat(width - s.length);
}

function urgencyBadge(urgency) {
  // Padded to width 8: "[urgent ]", "[normal ]", "[low    ]"
  const label = urgency === 'urgent' ? 'urgent ' :
                urgency === 'low'    ? 'low    ' : 'normal ';
  return `[${label}]`;
}

// ─── terminal size ────────────────────────────────────────────────────────────
function termSize() {
  try {
    return { rows: process.stdout.rows || 24, cols: process.stdout.columns || 80 };
  } catch {
    return { rows: 24, cols: 80 };
  }
}

// ─── WebSocket client (RFC 6455, hand-rolled, MASKED client frames) ──────────
function wsHandshakeKey() {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Buffer.from(bytes).toString('base64');
}

function wsClientEncode(str) {
  // Client→server frames MUST be masked per RFC 6455.
  const payload = Buffer.from(str, 'utf8');
  const mask = Buffer.alloc(4);
  for (let i = 0; i < 4; i++) mask[i] = Math.floor(Math.random() * 256);
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text
    header[1] = 0x80 | len; // MASK bit set
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

// Server→client frames are NOT masked; re-use the server's decode logic.
function wsServerDecode(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  if (opcode === 0x8) return { type: 'close' };
  if (opcode === 0x9) return { type: 'ping' };
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) { len = buf.readUInt16BE(2); offset = 4; }
  else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); offset = 10; }
  let maskBytes = null;
  if (masked) { maskBytes = buf.slice(offset, offset + 4); offset += 4; }
  if (buf.length < offset + len) return null; // incomplete frame
  const data = Buffer.from(buf.slice(offset, offset + len));
  if (maskBytes) for (let i = 0; i < data.length; i++) data[i] ^= maskBytes[i % 4];
  const consumed = offset + len;
  return { text: data.toString('utf8'), consumed };
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(new Error('timeout')); });
  });
}

function httpPost(port, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const options = {
      hostname: '127.0.0.1', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
    };
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { resolve({}); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function httpDelete(port, path) {
  return new Promise((resolve, reject) => {
    const options = { hostname: '127.0.0.1', port, path, method: 'DELETE' };
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve());
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

// ─── Application state ────────────────────────────────────────────────────────
const appState = {
  items: [],          // all items from daemon
  config: {},
  connected: false,
  selectedIdx: 0,     // index into filteredItems()
  filter: {
    mode: 'pending',  // 'pending' | 'all' | 'snoozed'
    agent: '',
    urgency: '',
    kind: '',
  },
  expandedContext: new Set(), // item ids with context expanded
  contextScroll: new Map(),   // item id → scroll offset in transcript
  boxMode: false,
  // overlay state
  overlay: null,  // null | { type: 'reply', text: '' } | { type: 'snooze' } | { type: 'filter' }
  replyText: '',
  // toast
  toast: null,    // { text, expiresAt }
  // warn flash
  warnFlash: new Map(), // id → { until, phase }
  // reconnect
  reconnecting: false,
  reconnectAttempts: 0,
};

function filteredItems() {
  const now = Date.now();
  const { mode, agent, urgency, kind } = appState.filter;
  return appState.items.filter((it) => {
    if (mode === 'pending') {
      if (it.resolved) return false;
      if (it.snoozedUntil && it.snoozedUntil > now) return false;
    } else if (mode === 'snoozed') {
      if (!(it.snoozedUntil && it.snoozedUntil > now)) return false;
    }
    // focused items not shown in pending
    if (mode === 'pending' && it.focused && it.resolved) return false;
    if (agent && it.agentKind !== agent) return false;
    if (urgency && it.urgency !== urgency) return false;
    if (kind && it.kind !== kind) return false;
    return true;
  });
}

function selectedItem() {
  const items = filteredItems();
  const idx = Math.min(appState.selectedIdx, items.length - 1);
  return idx >= 0 ? items[idx] : null;
}

// ─── Rendering ────────────────────────────────────────────────────────────────
let lastRenderTime = 0;
let renderScheduled = false;
const RENDER_INTERVAL_MS = Math.floor(1000 / 30); // 30fps cap

function scheduleRender() {
  if (NO_TTY) { renderNoTty(); return; }
  if (renderScheduled) return;
  renderScheduled = true;
  const now = Date.now();
  const wait = Math.max(0, RENDER_INTERVAL_MS - (now - lastRenderTime));
  setTimeout(() => {
    renderScheduled = false;
    lastRenderTime = Date.now();
    render();
  }, wait);
}

function fmtAge(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  return Math.floor(s / 3600) + 'h';
}

function fmtSnoozeRemaining(until) {
  const s = Math.max(0, Math.floor((until - Date.now()) / 1000));
  if (s <= 0) return null;
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  return Math.floor(s / 3600) + 'h';
}

function render() {
  if (!process.stdout.isTTY && !NO_TTY) return;
  const { rows, cols } = termSize();
  const items = filteredItems();
  const selIdx = Math.min(appState.selectedIdx, Math.max(0, items.length - 1));
  const out = [];

  // Box mode: single-line summary
  if (appState.boxMode) {
    const pending = appState.items.filter((it) => !it.resolved);
    const urgent = pending.filter((it) => it.urgency === 'urgent').length;
    const normal = pending.filter((it) => it.urgency === 'normal').length;
    const low    = pending.filter((it) => it.urgency === 'low').length;
    const dot = appState.connected ?
      `${color(C.green)}●${resetAttrs()}` : `${color(C.red)}●${resetAttrs()}`;
    const summary = `illo · ${pending.length} pending [urgent×${urgent} normal×${normal} low×${low}] ${dot}`;
    out.push(moveTo(1, 1) + eraseLine() + summary);
    out.push(moveTo(2, 1) + eraseLine() + dim() + color(C.dim_c) + 'Press any key to return to full mode' + resetAttrs());
    process.stdout.write(out.join(''));
    return;
  }

  // Full mode
  // Status bar (row 1)
  const pendingCount = appState.items.filter((it) => !it.resolved).length;
  const connDot = appState.connected ?
    `${color(C.green)}●${resetAttrs()}` : `${color(C.red)}●${resetAttrs()}`;
  const filterDesc = [
    appState.filter.agent   ? `agent:${appState.filter.agent}` : 'agent:any',
    appState.filter.urgency ? `urgency:${appState.filter.urgency}` : '',
  ].filter(Boolean).join('  ');
  const reconnMsg = appState.reconnecting ? `${color(C.red)} [reconnecting…]${resetAttrs()}` : '';
  const statusText = `illo · pending [${pendingCount}]  ${filterDesc}${reconnMsg}`;
  const statusLine = truncate(statusText.replace(/\x1b\[[^m]*m/g, ''), cols - 4);

  out.push(moveTo(1, 1) + eraseLine());
  out.push(bold() + color(C.amber) + ' illo' + resetAttrs());
  out.push(color(C.dim_c) + ` · pending [` + resetAttrs() + bold() + `${pendingCount}` + resetAttrs());
  out.push(color(C.dim_c) + `]  ` + resetAttrs());
  if (appState.filter.agent) out.push(color(C.dim_c) + `agent:${appState.filter.agent}  ` + resetAttrs());
  if (appState.filter.urgency) out.push(color(C.dim_c) + `urgency:${appState.filter.urgency}  ` + resetAttrs());
  if (appState.reconnecting) out.push(color(C.red) + ` [reconnecting…]` + resetAttrs());
  out.push('  ' + connDot);

  // Divider (row 2)
  out.push(moveTo(2, 1) + eraseLine());
  out.push(color(C.dim_c) + '─'.repeat(cols) + resetAttrs());

  // Footer area: last 2 rows = keybinding hint (row rows), toast (row rows-1)
  const FOOTER_ROWS = 2;
  const contentRows = rows - 2 - FOOTER_ROWS; // rows available for items

  // Render items
  let row = 3;
  const maxRow = rows - FOOTER_ROWS;

  if (items.length === 0) {
    out.push(moveTo(row, 1) + eraseLine());
    out.push(dim() + color(C.dim_c) + '  (no pending items)' + resetAttrs());
    row++;
  }

  for (let i = 0; i < items.length && row <= maxRow; i++) {
    const item = items[i];
    const isSelected = i === selIdx;
    const isSnoozed = item.snoozedUntil && item.snoozedUntil > Date.now();
    const isFlashing = appState.warnFlash.has(item.id) &&
      appState.warnFlash.get(item.id).until > Date.now();
    const flashPhase = isFlashing ? appState.warnFlash.get(item.id).phase : 0;

    // Prefix
    const prefix = isSelected ? '▶ ' : '  ';
    const uc = urgencyColor(item.urgency);

    // Selection highlight / flash
    let rowPrefix = '';
    let rowSuffix = '';
    if (isSelected) {
      rowPrefix = reverse();
    } else if (isFlashing && flashPhase % 2 === 0) {
      rowPrefix = reverse();
    }
    if (isSnoozed) rowPrefix += dim();

    // Title line
    const badge = urgencyBadge(item.urgency);
    const agentKind = item.agentKind || 'claude-code';
    const sessionSuffix = item.sessionId ? ` · ${item.sessionId.slice(0, 8)}` : '';
    const snoozeStr = isSnoozed ? ` ${dim()}${color(C.dim_c)}[snoozed ${fmtSnoozeRemaining(item.snoozedUntil)}]${resetAttrs()}` : '';
    const titleAvail = cols - 2 - 9 - 3 - agentKind.length - sessionSuffix.length - 8;
    const titleTxt = truncate(item.title, Math.max(10, titleAvail));

    // Badge coloring
    const badgeColor = `${color(uc)}`;

    if (row <= maxRow) {
      out.push(moveTo(row, 1) + eraseLine());
      if (isSelected) {
        out.push(reverse() + bold());
      } else if (isSnoozed) {
        out.push(dim());
      }
      out.push(color(uc) + prefix);
      out.push(badgeColor + badge + resetAttrs());
      if (isSelected) out.push(reverse() + bold());
      else if (isSnoozed) out.push(dim());
      out.push(` ${color(C.white)}${bold()}${truncate(item.title, Math.min(titleAvail + 20, cols - 12))}${resetAttrs()}`);
      if (isSnoozed) out.push(dim() + color(C.dim_c) + ` [snoozed ${fmtSnoozeRemaining(item.snoozedUntil)}]` + resetAttrs());
      out.push(resetAttrs());
      row++;
    }

    // Agent line: [projectName · ][branch · ][agentKind · ]session8
    if (row <= maxRow) {
      out.push(moveTo(row, 1) + eraseLine());
      if (isSnoozed) out.push(dim());
      const { cols: tuiCols } = termSize();
      const agentLineParts = [];
      if (item.projectName) agentLineParts.push(item.projectName);
      if (item.gitBranch) agentLineParts.push(item.gitBranch);
      agentLineParts.push(agentKind);
      if (item.sessionId) agentLineParts.push(item.sessionId.slice(0, 8));
      const agentLineText = agentLineParts.join(' · ');
      const agentLineTruncated = truncate(agentLineText, Math.max(10, tuiCols - 6));
      out.push(`   ${color(C.dim_c)}${agentLineTruncated}  ${fmtAge(item.createdAt)}${resetAttrs()}`);
      row++;
    }

    // Snippet
    if (item.snippet && row <= maxRow) {
      out.push(moveTo(row, 1) + eraseLine());
      if (isSnoozed) out.push(dim());
      out.push(`   ${color(C.dim_c)}${truncate(item.snippet, cols - 6)}${resetAttrs()}`);
      row++;
    }

    // Transcript context
    if (item.transcriptSnapshot) {
      const lines = item.transcriptSnapshot.split('\n');
      const expanded = appState.expandedContext.has(item.id);
      if (!expanded) {
        // Collapsed: show summary line
        if (row <= maxRow) {
          out.push(moveTo(row, 1) + eraseLine());
          if (isSnoozed) out.push(dim());
          out.push(`   ${color(C.dim_c)}▸ context (${lines.length} lines)${resetAttrs()}`);
          row++;
        }
      } else {
        // Expanded: show up to 12 lines (scrollable)
        const scroll = appState.contextScroll.get(item.id) || 0;
        const showLines = lines.slice(scroll, scroll + 12);
        if (row <= maxRow) {
          out.push(moveTo(row, 1) + eraseLine());
          if (isSnoozed) out.push(dim());
          out.push(`   ${color(C.dim_c)}▾ context (${lines.length} lines, scroll ,/.)${resetAttrs()}`);
          row++;
        }
        for (const line of showLines) {
          if (row > maxRow) break;
          out.push(moveTo(row, 1) + eraseLine());
          if (isSnoozed) out.push(dim());
          out.push(`     ${color(C.dim_c)}${truncate(line, cols - 7)}${resetAttrs()}`);
          row++;
        }
      }
    }

    // Action hints (selected item only)
    if (isSelected && row <= maxRow) {
      out.push(moveTo(row, 1) + eraseLine());
      out.push(`   ${color(C.dim_c)}[r]eply  [s]nooze  [a]ck  [x]dismiss${resetAttrs()}`);
      row++;
    }

    // Divider between items
    if (i < items.length - 1 && row <= maxRow) {
      out.push(moveTo(row, 1) + eraseLine());
      out.push(dim() + color(C.dim_c) + ' ' + '─'.repeat(cols - 2) + resetAttrs());
      row++;
    }
  }

  // Clear remaining content rows
  while (row <= maxRow) {
    out.push(moveTo(row, 1) + eraseLine());
    row++;
  }

  // Toast (row rows-1)
  out.push(moveTo(rows - 1, 1) + eraseLine());
  if (appState.toast && (appState.toast.persistent || appState.toast.expiresAt > Date.now())) {
    const toastPrefix = appState.toast.persistent ? ' ! ' : ' ✓ ';
    out.push(color(C.green) + bold() + toastPrefix + appState.toast.text + resetAttrs());
    if (appState.toast.persistent) {
      out.push(dim() + color(C.dim_c) + '  [any key to dismiss]' + resetAttrs());
    }
  }

  // Overlay: reply mode
  if (appState.overlay?.type === 'reply') {
    out.push(moveTo(rows - 1, 1) + eraseLine());
    out.push(color(C.amber) + bold() + ' reply: ' + resetAttrs());
    out.push(appState.replyText + '█');
  }

  // Overlay: snooze picker
  if (appState.overlay?.type === 'snooze') {
    out.push(moveTo(rows - 1, 1) + eraseLine());
    out.push(color(C.yellow) + bold() + ' snooze: ' + resetAttrs());
    out.push(color(C.dim_c) + '[1] 5m  [2] 15m  [3] 1h  [4] 4h  [Esc] cancel' + resetAttrs());
  }

  // Overlay: filter
  if (appState.overlay?.type === 'filter') {
    out.push(moveTo(rows - 1, 1) + eraseLine());
    out.push(color(C.amber) + bold() + ' filter: ' + resetAttrs());
    out.push(color(C.dim_c) + '(a)gent (u)rgency (k)ind (c)lear  [Esc] cancel' + resetAttrs());
  }

  // Keybinding hint (last row)
  out.push(moveTo(rows, 1) + eraseLine());
  const hints = 'j/k move · Enter resume · r reply · s snooze · a ack · x dismiss · / filter · b box · q quit';
  out.push(dim() + color(C.dim_c) + truncate(hints, cols - 1) + resetAttrs());

  process.stdout.write(out.join(''));
}

// ─── No-TTY mode ──────────────────────────────────────────────────────────────
let noTtyTimer = null;

function renderNoTty() {
  const items = filteredItems();
  const pending = items.filter((it) => !it.resolved).length;
  const snap = {
    connected: appState.connected,
    pending,
    items: items.slice(0, 10).map((it) => ({
      id: it.id, kind: it.kind, urgency: it.urgency, title: it.title,
    })),
  };
  process.stdout.write(JSON.stringify(snap) + '\n');
}

function startNoTtyLoop() {
  // Emit snapshots every 200ms until SIGTERM/SIGINT.
  // Do NOT resume stdin — background processes get stdin = /dev/null which
  // immediately fires 'end' and would cause premature exit.
  // Tests send SIGTERM to stop the process cleanly.

  // Write initial snapshot after giving the WS connection time to establish.
  setTimeout(renderNoTty, 150);

  noTtyTimer = setInterval(renderNoTty, 200);

  // Keep the event loop alive explicitly (the interval already does this,
  // but be explicit for clarity).
  noTtyTimer.ref?.();

  // In --no-tty mode, SIGTERM and SIGINT are clean exits (used by test harness).
  process.on('SIGTERM', () => { clearInterval(noTtyTimer); cleanup(0); });
  process.on('SIGINT',  () => { clearInterval(noTtyTimer); cleanup(0); });
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────
function cleanup(code = 0) {
  if (!NO_TTY) {
    process.stdout.write(showCursor() + altScreenOff() + resetAttrs());
  }
  process.exit(code);
}

// ─── Toast helper ─────────────────────────────────────────────────────────────
function showToast(text, ms = 2000) {
  appState.toast = { text, expiresAt: Date.now() + ms, persistent: false };
  setTimeout(() => {
    if (appState.toast && !appState.toast.persistent) {
      appState.toast = null;
      scheduleRender();
    }
  }, ms);
  scheduleRender();
}

function showPersistentToast(text) {
  // Persistent toasts stay until any keypress dismisses them.
  appState.toast = { text, expiresAt: Infinity, persistent: true };
  scheduleRender();
}

// ─── WebSocket connection ─────────────────────────────────────────────────────
let wsSocket = null;
let wsBuffer = Buffer.alloc(0);
let reconnectTimer = null;
let reconnectDelay = 1000;

function connectWS(port) {
  if (wsSocket) { try { wsSocket.destroy(); } catch {} }
  wsSocket = new net.Socket();
  wsSocket.setNoDelay(true);

  const key = wsHandshakeKey();
  const expectedAccept = createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  let handshakeDone = false;
  let handshakeBuf = '';

  wsSocket.connect(port, '127.0.0.1', () => {
    const handshake = [
      `GET /ws HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      `Upgrade: websocket`,
      `Connection: Upgrade`,
      `Sec-WebSocket-Key: ${key}`,
      `Sec-WebSocket-Version: 13`,
      ``,
      ``,
    ].join('\r\n');
    wsSocket.write(handshake);
  });

  wsSocket.on('data', (chunk) => {
    if (!handshakeDone) {
      handshakeBuf += chunk.toString('binary');
      const headerEnd = handshakeBuf.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      // Validate upgrade response
      if (!handshakeBuf.includes(expectedAccept)) {
        wsSocket.destroy();
        return;
      }
      handshakeDone = true;
      appState.connected = true;
      appState.reconnecting = false;
      reconnectDelay = 1000;
      appState.reconnectAttempts = 0;
      // Remaining bytes after headers are WS frame data
      const rest = handshakeBuf.slice(headerEnd + 4);
      wsBuffer = Buffer.from(rest, 'binary');
      scheduleRender();
      processWsBuffer();
      return;
    }
    wsBuffer = Buffer.concat([wsBuffer, chunk]);
    processWsBuffer();
  });

  wsSocket.on('error', () => scheduleReconnect(port));
  wsSocket.on('close', () => {
    if (handshakeDone) scheduleReconnect(port);
    else scheduleReconnect(port);
  });
}

function processWsBuffer() {
  while (wsBuffer.length >= 2) {
    const result = wsServerDecode(wsBuffer);
    if (!result) break;
    if (result.type === 'close') { wsBuffer = Buffer.alloc(0); break; }
    if (result.type === 'ping') { wsBuffer = wsBuffer.slice(result.consumed || 6); break; }
    if (!result.consumed) break;
    wsBuffer = wsBuffer.slice(result.consumed);
    if (result.text) {
      try {
        const msg = JSON.parse(result.text);
        handleWsMessage(msg);
      } catch {}
    }
  }
}

function scheduleReconnect(port) {
  if (reconnectTimer) return;
  appState.connected = false;
  appState.reconnecting = true;
  scheduleRender();
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
    appState.reconnectAttempts++;
    // Re-fetch state when we reconnect
    httpGet(port, '/state').then((data) => {
      appState.items = data.items || [];
      appState.config = data.config || {};
    }).catch(() => {});
    connectWS(port);
  }, reconnectDelay);
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case 'snapshot':
      appState.items = msg.items || [];
      appState.config = msg.config || {};
      break;
    case 'item:add':
      if (msg.item) {
        const idx = appState.items.findIndex((it) => it.id === msg.item.id);
        if (idx === -1) appState.items.push(msg.item);
        else appState.items[idx] = msg.item;
      }
      break;
    case 'item:update':
      if (msg.item) {
        const idx = appState.items.findIndex((it) => it.id === msg.item.id);
        if (idx === -1) appState.items.push(msg.item);
        else appState.items[idx] = msg.item;
      }
      break;
    case 'item:remove':
      if (msg.id) appState.items = appState.items.filter((it) => it.id !== msg.id);
      break;
    case 'item:warn':
      if (msg.id) {
        // Flash animation: set flash state, re-render a few times
        const flashUntil = Date.now() + 800; // 2× 400ms cycles
        appState.warnFlash.set(msg.id, { until: flashUntil, phase: 0 });
        let flashCount = 0;
        const flashInterval = setInterval(() => {
          flashCount++;
          const state = appState.warnFlash.get(msg.id);
          if (state) state.phase = flashCount;
          if (flashCount >= 4 || Date.now() >= flashUntil) {
            clearInterval(flashInterval);
            appState.warnFlash.delete(msg.id);
          }
          scheduleRender();
        }, 200);
      }
      break;
    case 'config':
      appState.config = msg.config || appState.config;
      break;
    case 'cleared':
      if (Array.isArray(msg.ids)) {
        appState.items = appState.items.filter((it) => !msg.ids.includes(it.id));
      }
      break;
  }
  scheduleRender();
}

// ─── Keyboard input ───────────────────────────────────────────────────────────
let inputBuf = Buffer.alloc(0);

function setupInput(port) {
  if (!process.stdin.isTTY && !NO_TTY) return;
  if (NO_TTY) return;

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding(null);

  process.stdin.on('data', (chunk) => {
    try {
      inputBuf = Buffer.concat([inputBuf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      processInputBuffer(port);
    } catch (err) {
      // Surface the error in the alt-screen so it doesn't just kill the pane silently.
      try { process.stderr.write(`\x1b[?1049l\x1b[?25h\nillo-tui input handler crashed: ${err && err.stack || err}\n`); } catch {}
      cleanup(1);
    }
  });
}

function processInputBuffer(port) {
  while (inputBuf.length > 0) {
    const result = parseKey(inputBuf);
    if (!result) break;
    inputBuf = inputBuf.slice(result.consumed);
    handleKey(result.key, port);
  }
}

function parseKey(buf) {
  if (buf.length === 0) return null;
  const b0 = buf[0];

  // Ctrl-C
  if (b0 === 0x03) return { key: 'ctrl-c', consumed: 1 };
  // Enter
  if (b0 === 0x0d || b0 === 0x0a) return { key: 'enter', consumed: 1 };
  // Backspace
  if (b0 === 0x7f || b0 === 0x08) return { key: 'backspace', consumed: 1 };
  // Escape / escape sequences
  if (b0 === 0x1b) {
    if (buf.length === 1) return { key: 'esc', consumed: 1 };
    const b1 = buf[1];
    if (b1 === 0x5b) { // CSI [
      if (buf.length < 3) return null; // wait for more
      const b2 = buf[2];
      if (b2 === 0x41) return { key: 'up',     consumed: 3 };
      if (b2 === 0x42) return { key: 'down',   consumed: 3 };
      if (b2 === 0x43) return { key: 'right',  consumed: 3 };
      if (b2 === 0x44) return { key: 'left',   consumed: 3 };
      if (b2 === 0x33 && buf.length >= 4 && buf[3] === 0x7e)
        return { key: 'delete', consumed: 4 };
      return { key: `esc-[${String.fromCharCode(b2)}`, consumed: 3 };
    }
    return { key: 'esc', consumed: 1 };
  }
  // Printable ASCII
  if (b0 >= 0x20 && b0 <= 0x7e) return { key: String.fromCharCode(b0), consumed: 1 };
  return { key: `raw-${b0}`, consumed: 1 };
}

function handleKey(key, port) {
  const { overlay } = appState;

  // Dismiss persistent toast on any keypress (falls through to normal handler).
  if (appState.toast?.persistent) {
    appState.toast = null;
    scheduleRender();
    // Fall through — don't swallow the key.
  }

  // Global quit
  if (key === 'ctrl-c' || (key === 'q' && !overlay && !appState.boxMode)) {
    cleanup(0);
    return;
  }

  // Box mode: any key exits box mode
  if (appState.boxMode && key !== 'q') {
    appState.boxMode = false;
    scheduleRender();
    return;
  }

  // Reply overlay
  if (overlay?.type === 'reply') {
    if (key === 'esc') {
      appState.overlay = null;
      appState.replyText = '';
    } else if (key === 'enter') {
      const item = selectedItem();
      if (item) {
        const text = appState.replyText;
        const itemCopy = { ...item }; // capture sessionId before overlay clears
        appState.overlay = null;
        appState.replyText = '';
        httpPost(port, `/items/${item.id}/reply`, { text })
          .then(() => {
            const sid = itemCopy.sessionId;
            if (sid) {
              showPersistentToast(`queued · type anything in session ${sid.slice(0, 8)} to deliver`);
            } else {
              showPersistentToast('queued · type anything in any Claude session to deliver');
            }
          })
          .catch((e) => showToast(`error: ${e.message}`));
      }
    } else if (key === 'backspace') {
      appState.replyText = appState.replyText.slice(0, -1);
    } else if (key.length === 1) {
      appState.replyText += key;
    }
    scheduleRender();
    return;
  }

  // Snooze overlay
  if (overlay?.type === 'snooze') {
    const snoozeMap = { '1': 300, '2': 900, '3': 3600, '4': 14400 };
    if (key === 'esc') {
      appState.overlay = null;
    } else if (snoozeMap[key]) {
      const item = selectedItem();
      if (item) {
        const seconds = snoozeMap[key];
        appState.overlay = null;
        httpPost(port, `/items/${item.id}/snooze`, { seconds })
          .then(() => showToast(`snoozed for ${Math.round(seconds / 60)}m`))
          .catch((e) => showToast(`error: ${e.message}`));
      }
    }
    scheduleRender();
    return;
  }

  // Filter overlay
  if (overlay?.type === 'filter') {
    if (key === 'esc' || key === 'c') {
      if (key === 'c') {
        appState.filter.agent = '';
        appState.filter.urgency = '';
        appState.filter.kind = '';
      }
      appState.overlay = null;
    } else if (key === 'a') {
      // Agent filter submenu: cycle through agents
      const agents = [...new Set(appState.items.map((it) => it.agentKind).filter(Boolean))];
      const cur = appState.filter.agent;
      const idx = agents.indexOf(cur);
      appState.filter.agent = agents[(idx + 1) % (agents.length + 1)] || '';
      appState.overlay = null;
    } else if (key === 'u') {
      const urgencies = ['urgent', 'normal', 'low', ''];
      const cur = appState.filter.urgency;
      const idx = urgencies.indexOf(cur);
      appState.filter.urgency = urgencies[(idx + 1) % urgencies.length];
      appState.overlay = null;
    } else if (key === 'k') {
      const kinds = ['ask_user', 'notification', 'custom', ''];
      const cur = appState.filter.kind;
      const idx = kinds.indexOf(cur);
      appState.filter.kind = kinds[(idx + 1) % kinds.length];
      appState.overlay = null;
    }
    // Reset selection when filter changes
    appState.selectedIdx = 0;
    scheduleRender();
    return;
  }

  // Normal mode
  const items = filteredItems();
  const selIdx = appState.selectedIdx;

  switch (key) {
    case 'j':
    case 'down':
      appState.selectedIdx = Math.min(selIdx + 1, Math.max(0, items.length - 1));
      break;
    case 'k':
    case 'up':
      appState.selectedIdx = Math.max(selIdx - 1, 0);
      break;
    case 'enter': {
      const item = selectedItem();
      if (item) {
        const itemCopy = { ...item };
        httpPost(port, `/items/${item.id}/resume`, {})
          .then(() => {
            const sid = itemCopy.sessionId;
            if (sid) {
              showPersistentToast(`queued · type anything in session ${sid.slice(0, 8)} to deliver`);
            } else {
              showPersistentToast('queued · type anything in any Claude session to deliver');
            }
          })
          .catch((e) => showToast(`error: ${e.message}`));
      }
      break;
    }
    case 'r':
      if (selectedItem()) {
        appState.overlay = { type: 'reply' };
        appState.replyText = '';
      }
      break;
    case 's':
      if (selectedItem()) {
        appState.overlay = { type: 'snooze' };
      }
      break;
    case 'a': {
      const item = selectedItem();
      if (item) {
        httpPost(port, `/items/${item.id}/focus`, {})
          .then(() => showToast('acknowledged'))
          .catch((e) => showToast(`error: ${e.message}`));
      }
      break;
    }
    case 'x':
    case 'delete': {
      const item = selectedItem();
      if (item) {
        httpDelete(port, `/items/${item.id}`)
          .then(() => showToast('dismissed'))
          .catch((e) => showToast(`error: ${e.message}`));
      }
      break;
    }
    case 'c': {
      const item = selectedItem();
      if (item && item.transcriptSnapshot) {
        if (appState.expandedContext.has(item.id)) {
          appState.expandedContext.delete(item.id);
          appState.contextScroll.delete(item.id);
        } else {
          appState.expandedContext.add(item.id);
          appState.contextScroll.set(item.id, 0);
        }
      }
      break;
    }
    case ',': {
      const item = selectedItem();
      if (item && appState.expandedContext.has(item.id)) {
        const lines = (item.transcriptSnapshot || '').split('\n').length;
        const cur = appState.contextScroll.get(item.id) || 0;
        appState.contextScroll.set(item.id, Math.max(0, cur - 1));
      }
      break;
    }
    case '.': {
      const item = selectedItem();
      if (item && appState.expandedContext.has(item.id)) {
        const lines = (item.transcriptSnapshot || '').split('\n');
        const cur = appState.contextScroll.get(item.id) || 0;
        appState.contextScroll.set(item.id, Math.min(cur + 1, Math.max(0, lines.length - 12)));
      }
      break;
    }
    case '/':
      appState.overlay = { type: 'filter' };
      break;
    case 'b':
      appState.boxMode = !appState.boxMode;
      break;
    default:
      break;
  }
  scheduleRender();
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const port = discoverPort();

  if (!NO_TTY) {
    // Enter alternate screen, hide cursor
    process.stdout.write(altScreenOn() + clearScreen() + hideCursor());

    // Signal handlers
    process.on('SIGINT', () => cleanup(0));
    process.on('SIGTERM', () => cleanup(0));
    process.on('SIGWINCH', () => scheduleRender());
  }

  // Try initial state fetch
  try {
    const data = await httpGet(port, '/state');
    appState.items = data.items || [];
    appState.config = data.config || {};
  } catch {
    // Daemon not up yet; WS reconnect will handle it
  }

  // Connect WebSocket
  connectWS(port);

  // Setup keyboard input
  setupInput(port);

  if (NO_TTY) {
    startNoTtyLoop();
  } else {
    // Initial render
    scheduleRender();
  }
}

main().catch((e) => {
  if (!NO_TTY) {
    process.stdout.write(showCursor() + altScreenOff() + resetAttrs());
  }
  console.error('illo-tui fatal error:', e.message);
  process.exit(1);
});
