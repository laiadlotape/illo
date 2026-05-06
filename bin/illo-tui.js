#!/usr/bin/env node
// illo-tui — v0.3 prompt-notepad sidebar.
//
// A composition surface that lives in a tmux split next to the Claude pane.
// You write, edit, review, then hand the prompt off to the Claude pane via
// tmux send-keys. Crucially: we never auto-press Enter — the human reads once
// more in the destination pane and submits themselves.
//
// Architecture: events log (top ~1/3) tails the daemon's item stream (low-noise
// filter by default). Compose pane (lower ~2/3) is an in-house editor with a
// $EDITOR escape (Ctrl-E). Hand-off via Ctrl-S (review-and-submit) or Ctrl-D
// (send + Enter).
//
// Zero npm deps. Pure Node stdlib + ANSI escapes. Hand-rolled WebSocket
// client (RFC 6455). Hand-rolled keyboard parser. Hand-rolled editor.
//
// Usage:
//   node bin/illo-tui.js           # normal TUI mode
//   node bin/illo-tui.js --no-tty  # headless smoke-test mode

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// ─── args ────────────────────────────────────────────────────────────────────
const NO_TTY = process.argv.includes('--no-tty');

// ─── plugin root + tmux helper ───────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const TMUX_SEND = path.join(PLUGIN_ROOT, 'bin', 'tmux-send.sh');

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
function eraseLine()    { return `${CSI}2K`; }
function bgColor(n)     { return `${CSI}48;5;${n}m`; }

// Palette
const C = {
  amber:       214,
  red:         203,
  gray:        245,
  green:       114,
  dim_c:       240,
  white:       255,
  blue:        111,
  yellow:      227,
  cyan:        109,
  hint:        245,  // secondary hint row; no dim() applied
  popup:       236,
  popupShadow: 234,
  popupBorder: 245,
};

function kindColor(kind) {
  if (kind === 'ask_user')     return C.amber;
  if (kind === 'notification') return C.cyan;
  if (kind === 'sent')         return C.green;
  if (kind === 'stop')         return C.gray;
  if (kind === 'custom')       return C.blue;
  return C.dim_c;
}

function urgencyColor(urgency) {
  if (urgency === 'urgent') return C.red;
  if (urgency === 'low')    return C.gray;
  return C.amber;
}

function truncate(str, width) {
  if (!str) return '';
  const s = String(str);
  if (s.length <= width) return s;
  if (width <= 1) return s.slice(0, Math.max(0, width));
  return s.slice(0, width - 1) + '…';
}

function pad(str, width) {
  const s = String(str);
  return s.length >= width ? s.slice(0, width) : s + ' '.repeat(width - s.length);
}

// Wrap text at word boundaries; falls back to hard-break for words wider than width.
function wrapText(text, width) {
  if (!text || width <= 0) return [''];
  const out = [];
  for (const rawLine of String(text).split('\n')) {
    if (rawLine.length === 0) { out.push(''); continue; }
    let remaining = rawLine;
    while (remaining.length > 0) {
      if (remaining.length <= width) {
        out.push(remaining);
        break;
      }
      // Find last space within width
      let cut = remaining.lastIndexOf(' ', width);
      if (cut <= 0) cut = width; // hard-break
      out.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut).replace(/^ /, '');
    }
  }
  return out;
}

// ─── terminal size ────────────────────────────────────────────────────────────
function termSize() {
  try {
    return { rows: process.stdout.rows || 24, cols: process.stdout.columns || 80 };
  } catch {
    return { rows: 24, cols: 80 };
  }
}

// ─── WebSocket client (RFC 6455, hand-rolled) ────────────────────────────────
function wsHandshakeKey() {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Buffer.from(bytes).toString('base64');
}

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
  if (buf.length < offset + len) return null;
  const data = Buffer.from(buf.slice(offset, offset + len));
  if (maskBytes) for (let i = 0; i < data.length; i++) data[i] ^= maskBytes[i % 4];
  const consumed = offset + len;
  return { text: data.toString('utf8'), consumed };
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
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

// ─── TUI preferences (persisted to ~/.claude/illo-sidebar/tui-prefs.json) ────
// The wrap preference is TUI-only (not daemon state), so we read/write the
// file directly rather than adding a daemon round-trip.
const ILLO_HOME = process.env.ILLO_SIDEBAR_HOME ||
  `${os.homedir()}/.claude/illo-sidebar`;
const TUI_PREFS_FILE = path.join(ILLO_HOME, 'tui-prefs.json');

function loadTuiPrefs() {
  try {
    const raw = fs.readFileSync(TUI_PREFS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveTuiPrefs(prefs) {
  try {
    fs.mkdirSync(ILLO_HOME, { recursive: true });
    fs.writeFileSync(TUI_PREFS_FILE, JSON.stringify(prefs, null, 2) + '\n', 'utf8');
  } catch {
    // non-fatal — pref just won't survive restart
  }
}

const tuiPrefs = loadTuiPrefs();

// ─── Application state ────────────────────────────────────────────────────────
const appState = {
  paneId: null,
  paneOverride: null,    // last seen daemon override
  events: [],            // all items from daemon
  config: {},
  connected: false,
  reconnecting: false,

  view: {
    eventScroll: 0,
    eventFilter: 'low-noise',  // 'low-noise' | 'verbose'
    focus: 'compose',          // 'compose' | 'events'
    helpOpen: false,           // full help overlay
  },

  compose: {
    lines: [''],
    cur: { row: 0, col: 0 },
    visibleRowOffset: 0,
    colOffset: 0,
    wrap: tuiPrefs.composeWrap !== undefined ? tuiPrefs.composeWrap : true,
    dirty: false,
    undoStack: [],
    redoStack: [],
    lastEditTs: 0,
    typingGroupOpen: false,
  },

  toast: null,        // { text, expiresAt }
  modal: null,        // { type:'event-detail', eventId } | { type:'message', text }
  eventDetail: null,  // { itemId, scroll } | null
};

// ─── compose helpers ──────────────────────────────────────────────────────────
function composeText() {
  return appState.compose.lines.join('\n');
}

function composeWordCount() {
  const txt = composeText().trim();
  if (!txt) return 0;
  return txt.split(/\s+/).length;
}

function clampCursor() {
  const c = appState.compose;
  if (c.cur.row < 0) c.cur.row = 0;
  if (c.cur.row >= c.lines.length) c.cur.row = c.lines.length - 1;
  const line = c.lines[c.cur.row] || '';
  if (c.cur.col < 0) c.cur.col = 0;
  if (c.cur.col > line.length) c.cur.col = line.length;
}

function snapshotCompose() {
  return {
    lines: appState.compose.lines.slice(),
    cur: { row: appState.compose.cur.row, col: appState.compose.cur.col },
  };
}

function pushUndo(force = false) {
  const c = appState.compose;
  const now = Date.now();
  // Within the typing-group window AND not forced → don't push another snapshot.
  if (!force && c.typingGroupOpen && now - c.lastEditTs < 2000) {
    c.lastEditTs = now;
    return;
  }
  c.undoStack.push(snapshotCompose());
  while (c.undoStack.length > 100) c.undoStack.shift();
  c.redoStack.length = 0;
  c.typingGroupOpen = !force;
  c.lastEditTs = now;
}

function endUndoGroup() {
  appState.compose.typingGroupOpen = false;
}

function applySnapshot(snap) {
  appState.compose.lines = snap.lines.slice();
  appState.compose.cur = { row: snap.cur.row, col: snap.cur.col };
  clampCursor();
}

function undo() {
  const c = appState.compose;
  if (c.undoStack.length === 0) {
    showToast('(nothing to undo)');
    return;
  }
  c.redoStack.push(snapshotCompose());
  applySnapshot(c.undoStack.pop());
  c.dirty = composeText().length > 0;
  c.typingGroupOpen = false;
}

function redo() {
  const c = appState.compose;
  if (c.redoStack.length === 0) {
    showToast('(nothing to redo)');
    return;
  }
  c.undoStack.push(snapshotCompose());
  applySnapshot(c.redoStack.pop());
  c.dirty = composeText().length > 0;
  c.typingGroupOpen = false;
}

function markDirty() {
  appState.compose.dirty = composeText().length > 0;
}

function clearCompose() {
  pushUndo(true);
  appState.compose.lines = [''];
  appState.compose.cur = { row: 0, col: 0 };
  appState.compose.visibleRowOffset = 0;
  appState.compose.colOffset = 0;
  appState.compose.dirty = false;
  endUndoGroup();
}

// ─── editor: text mutations ───────────────────────────────────────────────────
function insertChar(ch) {
  pushUndo(false);
  const c = appState.compose;
  const line = c.lines[c.cur.row] || '';
  c.lines[c.cur.row] = line.slice(0, c.cur.col) + ch + line.slice(c.cur.col);
  c.cur.col += ch.length;
  markDirty();
}

function insertNewline() {
  pushUndo(true);
  const c = appState.compose;
  const line = c.lines[c.cur.row] || '';
  const left = line.slice(0, c.cur.col);
  const right = line.slice(c.cur.col);
  // Auto-indent: copy leading whitespace of the current line
  const indent = (left.match(/^[ \t]*/) || [''])[0];
  c.lines.splice(c.cur.row, 1, left, indent + right);
  c.cur.row += 1;
  c.cur.col = indent.length;
  markDirty();
}

function backspaceChar() {
  const c = appState.compose;
  if (c.cur.col === 0 && c.cur.row === 0) return;
  pushUndo(false);
  const line = c.lines[c.cur.row] || '';
  if (c.cur.col > 0) {
    c.lines[c.cur.row] = line.slice(0, c.cur.col - 1) + line.slice(c.cur.col);
    c.cur.col -= 1;
  } else {
    // Join with previous line
    const prev = c.lines[c.cur.row - 1] || '';
    const newCol = prev.length;
    c.lines[c.cur.row - 1] = prev + line;
    c.lines.splice(c.cur.row, 1);
    c.cur.row -= 1;
    c.cur.col = newCol;
  }
  markDirty();
}

function deleteChar() {
  const c = appState.compose;
  const line = c.lines[c.cur.row] || '';
  const last = c.cur.row === c.lines.length - 1;
  if (c.cur.col === line.length && last) return;
  pushUndo(false);
  if (c.cur.col < line.length) {
    c.lines[c.cur.row] = line.slice(0, c.cur.col) + line.slice(c.cur.col + 1);
  } else {
    // Join next line
    const next = c.lines[c.cur.row + 1] || '';
    c.lines[c.cur.row] = line + next;
    c.lines.splice(c.cur.row + 1, 1);
  }
  markDirty();
}

function killToEol() {
  pushUndo(true);
  const c = appState.compose;
  const line = c.lines[c.cur.row] || '';
  if (c.cur.col >= line.length) {
    // At EOL — join next
    if (c.cur.row < c.lines.length - 1) {
      c.lines[c.cur.row] = line + (c.lines[c.cur.row + 1] || '');
      c.lines.splice(c.cur.row + 1, 1);
    }
  } else {
    c.lines[c.cur.row] = line.slice(0, c.cur.col);
  }
  markDirty();
  endUndoGroup();
}

function killLineBackward() {
  pushUndo(true);
  const c = appState.compose;
  const line = c.lines[c.cur.row] || '';
  c.lines[c.cur.row] = line.slice(c.cur.col);
  c.cur.col = 0;
  markDirty();
  endUndoGroup();
}

function deleteWordBackward() {
  pushUndo(true);
  const c = appState.compose;
  const line = c.lines[c.cur.row] || '';
  if (c.cur.col === 0) {
    // Same as backspace — join with prev line
    backspaceChar();
    endUndoGroup();
    return;
  }
  let i = c.cur.col;
  // Skip whitespace backward
  while (i > 0 && /\s/.test(line[i - 1])) i--;
  // Then skip word chars
  while (i > 0 && !/\s/.test(line[i - 1])) i--;
  c.lines[c.cur.row] = line.slice(0, i) + line.slice(c.cur.col);
  c.cur.col = i;
  markDirty();
  endUndoGroup();
}

// ─── editor: cursor movement ──────────────────────────────────────────────────
function cursorLeft() {
  endUndoGroup();
  const c = appState.compose;
  if (c.cur.col > 0) c.cur.col -= 1;
  else if (c.cur.row > 0) {
    c.cur.row -= 1;
    c.cur.col = (c.lines[c.cur.row] || '').length;
  }
}

function cursorRight() {
  endUndoGroup();
  const c = appState.compose;
  const line = c.lines[c.cur.row] || '';
  if (c.cur.col < line.length) c.cur.col += 1;
  else if (c.cur.row < c.lines.length - 1) {
    c.cur.row += 1;
    c.cur.col = 0;
  }
}

function cursorUp() {
  endUndoGroup();
  const c = appState.compose;
  if (c.cur.row > 0) {
    c.cur.row -= 1;
    const line = c.lines[c.cur.row] || '';
    if (c.cur.col > line.length) c.cur.col = line.length;
  }
}

function cursorDown() {
  endUndoGroup();
  const c = appState.compose;
  if (c.cur.row < c.lines.length - 1) {
    c.cur.row += 1;
    const line = c.lines[c.cur.row] || '';
    if (c.cur.col > line.length) c.cur.col = line.length;
  }
}

function cursorHome() {
  endUndoGroup();
  appState.compose.cur.col = 0;
}

function cursorEnd() {
  endUndoGroup();
  const c = appState.compose;
  c.cur.col = (c.lines[c.cur.row] || '').length;
}

// ─── word motion helpers ──────────────────────────────────────────────────────
// "Word" = contiguous run of [A-Za-z0-9_]. Uses skip-then-find rule.
function isWordChar(ch) {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

function cursorWordLeft() {
  endUndoGroup();
  const c = appState.compose;
  // If at col 0, wrap to end of previous line.
  if (c.cur.col === 0) {
    if (c.cur.row > 0) {
      c.cur.row -= 1;
      c.cur.col = (c.lines[c.cur.row] || '').length;
    }
    return;
  }
  const line = c.lines[c.cur.row] || '';
  let i = c.cur.col;
  // Skip non-word chars to the left
  while (i > 0 && !isWordChar(line[i - 1])) i--;
  // Skip word chars to the left
  while (i > 0 && isWordChar(line[i - 1])) i--;
  c.cur.col = i;
}

function cursorWordRight() {
  endUndoGroup();
  const c = appState.compose;
  const line = c.lines[c.cur.row] || '';
  // If at EOL, wrap to start of next line.
  if (c.cur.col >= line.length) {
    if (c.cur.row < c.lines.length - 1) {
      c.cur.row += 1;
      c.cur.col = 0;
    }
    return;
  }
  let i = c.cur.col;
  // Skip word chars to the right
  while (i < line.length && isWordChar(line[i])) i++;
  // Skip non-word chars to the right
  while (i < line.length && !isWordChar(line[i])) i++;
  c.cur.col = i;
}

// Paragraph motion: jump to next/prev blank line (line.trim() === '').
function cursorParagraphUp() {
  endUndoGroup();
  const c = appState.compose;
  let r = c.cur.row - 1;
  // Skip any blank lines immediately above
  while (r > 0 && (c.lines[r] || '').trim() === '') r--;
  // Then find the previous blank line
  while (r > 0 && (c.lines[r] || '').trim() !== '') r--;
  c.cur.row = r;
  clampCursor();
}

function cursorParagraphDown() {
  endUndoGroup();
  const c = appState.compose;
  const last = c.lines.length - 1;
  let r = c.cur.row + 1;
  // Skip any blank lines immediately below
  while (r < last && (c.lines[r] || '').trim() === '') r++;
  // Then find the next blank line
  while (r < last && (c.lines[r] || '').trim() !== '') r++;
  c.cur.row = Math.min(r, last);
  clampCursor();
}

function toggleWrap() {
  appState.compose.wrap = !appState.compose.wrap;
  // Reset horizontal scroll when switching modes
  appState.compose.colOffset = 0;
  appState.compose.visibleRowOffset = 0;
  // Persist preference
  const prefs = loadTuiPrefs();
  prefs.composeWrap = appState.compose.wrap;
  saveTuiPrefs(prefs);
  showToast(`wrap ${appState.compose.wrap ? 'on' : 'off'}`);
}

// ─── render ───────────────────────────────────────────────────────────────────
let lastRenderTime = 0;
let renderScheduled = false;
const RENDER_INTERVAL_MS = Math.floor(1000 / 30);

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

function fmtHHMM(ts) {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function eventTitle(ev) {
  // Use the daemon's normalized title; for sent items prefer payload.text first line.
  if (ev.kind === 'sent' && ev.payload?.text) {
    return (ev.payload.text.split('\n')[0] || '(empty)').trim();
  }
  return ev.title || '';
}

function visibleEvents() {
  const all = appState.events.slice();
  if (appState.view.eventFilter === 'verbose') return all;
  // low-noise: ask_user, notification, sent
  return all.filter((ev) => ['ask_user', 'notification', 'sent'].includes(ev.kind));
}

function render() {
  if (!process.stdout.isTTY && !NO_TTY) return;
  const { rows, cols } = termSize();
  const out = [];

  // ── status bar (row 1) ──────────────────────────────────────────────────
  const paneStr = appState.paneId
    ? `pane: ${appState.paneId}`
    : 'pane: <none — /sb-attach to set>';
  const focusStr = appState.view.focus === 'events' ? 'focus: events' : 'focus: compose';
  const dot = appState.connected
    ? `${color(C.green)}●${resetAttrs()}`
    : `${color(C.red)}●${resetAttrs()}`;
  const reconn = appState.reconnecting ? `${color(C.red)} [reconnecting…]${resetAttrs()}` : '';

  out.push(moveTo(1, 1) + eraseLine());
  out.push(bold() + color(C.amber) + ' illo' + resetAttrs());
  out.push(color(C.dim_c) + ' · v0.3' + resetAttrs());
  out.push(color(C.dim_c) + ' · ' + paneStr + resetAttrs());
  out.push(color(C.dim_c) + ' · ' + focusStr + resetAttrs());
  out.push(reconn);
  out.push('  ' + dot);

  // ── divider (row 2) ─────────────────────────────────────────────────────
  out.push(moveTo(2, 1) + eraseLine() + color(C.dim_c) + '─'.repeat(cols) + resetAttrs());

  // ── layout: events (top), compose (bottom) ──────────────────────────────
  // Reserved: 1 status + 1 divider + 1 events header + 1 divider + 1 compose box top + 1 box bottom + 2 hint = 8 chrome rows
  // Plus N event log rows + M compose content rows + 1 compose status line.
  const HINT_ROWS = 2;
  const STATUS_ROWS = 1;
  const DIVIDER_ROWS = 1;
  const EVENTS_HEADER_ROWS = 1;
  const COMPOSE_STATUS_ROWS = 1;
  const COMPOSE_BOX_ROWS = 2; // top + bottom border

  const fixedChrome = STATUS_ROWS + DIVIDER_ROWS + EVENTS_HEADER_ROWS + DIVIDER_ROWS
    + COMPOSE_STATUS_ROWS + COMPOSE_BOX_ROWS + HINT_ROWS;

  const usable = Math.max(6, rows - fixedChrome);
  // Default 1/3 events, 2/3 compose. Minimum compose 3 rows. Narrow: events min 4.
  let eventRows = Math.max(3, Math.floor(usable / 3));
  if (rows < 24) eventRows = Math.min(eventRows, 4);
  if (eventRows < 4 && rows < 24) eventRows = Math.min(4, usable - 3);
  if (eventRows < 1) eventRows = 1;
  let composeRows = usable - eventRows;
  if (composeRows < 3) {
    composeRows = 3;
    eventRows = Math.max(1, usable - composeRows);
  }

  // Row layout (1-indexed):
  //   1                  status
  //   2                  divider
  //   3                  events header
  //   4..3+eventRows     events log
  //   4+eventRows        divider
  //   5+eventRows        compose status
  //   6+eventRows        compose box top
  //   7+eventRows..      compose content
  //   ...                compose box bottom
  //   rows               hint

  const eventsStart = 4;
  const eventsEnd = eventsStart + eventRows - 1;
  const dividerRow = eventsEnd + 1;
  const composeStatusRow = dividerRow + 1;
  const composeBoxTopRow = composeStatusRow + 1;
  const composeContentStart = composeBoxTopRow + 1;
  const composeContentRows = composeRows;
  const composeBoxBottomRow = composeContentStart + composeContentRows;
  const hintRowPrimary = rows - 1;  // row N-1: always-visible primary keybindings
  const hintRowSecondary = rows;    // row N: contextual secondary keybindings

  // ── events header ───────────────────────────────────────────────────────
  out.push(moveTo(3, 1) + eraseLine());
  const filterLabel = appState.view.eventFilter === 'verbose' ? '[v] verbose' : '[v] low-noise';
  out.push(color(C.dim_c) + ' events (last ' + visibleEvents().length + ') · ' + filterLabel + ' · [x] clear · Ctrl-Up focus' + resetAttrs());

  // ── events log ──────────────────────────────────────────────────────────
  const evs = visibleEvents();
  // Newest at bottom. Default scroll: tail.
  const maxScroll = Math.max(0, evs.length - eventRows);
  let scroll = appState.view.eventScroll;
  if (scroll > maxScroll) scroll = maxScroll;
  if (scroll < 0) scroll = 0;
  appState.view.eventScroll = scroll;
  const startIdx = Math.max(0, evs.length - eventRows - scroll);
  const endIdx = Math.min(evs.length, startIdx + eventRows);
  const slice = evs.slice(startIdx, endIdx);

  for (let r = 0; r < eventRows; r++) {
    const rowNum = eventsStart + r;
    out.push(moveTo(rowNum, 1) + eraseLine());
    const ev = slice[r];
    if (!ev) continue;
    const time = fmtHHMM(ev.createdAt || Date.now());
    const kindStr = pad(ev.kind, 9);
    const titleAvail = Math.max(8, cols - 2 - 5 - 1 - 9 - 3 - 4);
    const titleText = truncate(eventTitle(ev), titleAvail);
    const isSelected = appState.view.focus === 'events' && (startIdx + r === evs.length - 1 - scroll);
    if (isSelected) out.push(reverse());
    out.push(color(C.dim_c) + ' ' + time + ' · ' + resetAttrs());
    out.push(color(kindColor(ev.kind)) + kindStr + resetAttrs());
    out.push(color(urgencyColor(ev.urgency)) + ' · ' + resetAttrs());
    out.push(color(C.white) + titleText + resetAttrs());
    if (isSelected) out.push(resetAttrs());
  }

  // ── divider before compose ──────────────────────────────────────────────
  out.push(moveTo(dividerRow, 1) + eraseLine() + color(C.dim_c) + '─'.repeat(cols) + resetAttrs());

  // ── compose status line ─────────────────────────────────────────────────
  out.push(moveTo(composeStatusRow, 1) + eraseLine());
  const lineCount = appState.compose.lines.length;
  const wordCount = composeWordCount();
  const dirtyTag = appState.compose.dirty ? ' · *unsaved' : '';
  const wrapTag = appState.compose.wrap ? ' · wrap:on' : ' · wrap:off';
  const composeFocusTag = appState.view.focus === 'compose' ? bold() + color(C.amber) + 'compose' + resetAttrs() : color(C.dim_c) + 'compose' + resetAttrs();
  out.push(' ' + composeFocusTag + color(C.dim_c)
    + ` · lines: ${lineCount} · words: ${wordCount}${dirtyTag}${wrapTag}` + resetAttrs());

  // ── compose box top border ──────────────────────────────────────────────
  out.push(moveTo(composeBoxTopRow, 1) + eraseLine());
  out.push(color(C.dim_c) + '┌' + '─'.repeat(Math.max(0, cols - 2)) + '┐' + resetAttrs());

  // ── compose content ─────────────────────────────────────────────────────
  // innerCols = usable characters inside the box (borders + 1 padding each side).
  const innerCols = Math.max(4, cols - 4); // 2 borders + 2 padding
  const c = appState.compose;

  if (c.wrap) {
    // ── wrap mode ────────────────────────────────────────────────────────
    // Build visual rows: each logical line wraps at innerCols.
    // We need to know the visual row of the cursor to scroll correctly.
    const wrapWidth = innerCols;

    // Count visual rows for a logical line
    function visualRowsForLine(line) {
      if (line.length === 0) return 1;
      return Math.ceil(line.length / wrapWidth);
    }

    // Map logical (logRow, logCol) → visual row offset from the start of
    // logical line's visual rows, and visual col within that row.
    function logicalToVisual(logRow, logCol) {
      const vRow = Math.floor(logCol / wrapWidth);
      const vCol = logCol % wrapWidth;
      return { vRow, vCol };
    }

    // Calculate the absolute visual row of (logRow, logCol) across all lines.
    function absoluteVisualRow(logRow, logCol) {
      let abs = 0;
      for (let i = 0; i < logRow; i++) {
        abs += visualRowsForLine(c.lines[i] || '');
      }
      abs += Math.floor(logCol / wrapWidth);
      return abs;
    }

    // Total visual rows across all logical lines
    let totalVisualRows = 0;
    for (const ln of c.lines) totalVisualRows += visualRowsForLine(ln);

    // Cursor visual row (absolute)
    const curVisRow = absoluteVisualRow(c.cur.row, c.cur.col);

    // Adjust visibleRowOffset (in visual rows) so cursor is on screen.
    if (curVisRow < c.visibleRowOffset) c.visibleRowOffset = curVisRow;
    if (curVisRow >= c.visibleRowOffset + composeContentRows) {
      c.visibleRowOffset = curVisRow - composeContentRows + 1;
    }
    if (c.visibleRowOffset < 0) c.visibleRowOffset = 0;
    // Reset horizontal scroll in wrap mode
    c.colOffset = 0;

    // Render visual rows
    // Walk logical lines, generating visual rows, and render those in
    // [visibleRowOffset, visibleRowOffset + composeContentRows).
    let absVR = 0;        // current absolute visual row
    let renderRow = 0;    // screen slot [0, composeContentRows)
    let logIdx = 0;

    outer: while (logIdx < c.lines.length && renderRow < composeContentRows) {
      const line = c.lines[logIdx] || '';
      const vCount = visualRowsForLine(line);
      for (let vi = 0; vi < vCount; vi++) {
        if (absVR >= c.visibleRowOffset) {
          const screenRow = composeContentStart + renderRow;
          out.push(moveTo(screenRow, 1) + eraseLine());
          out.push(color(C.dim_c) + '│' + resetAttrs());

          const segment = line.slice(vi * wrapWidth, (vi + 1) * wrapWidth);
          const padded = segment + ' '.repeat(Math.max(0, innerCols - segment.length));

          // Cursor on this visual row?
          const isCursorHere =
            logIdx === c.cur.row &&
            appState.view.focus === 'compose' &&
            Math.floor(c.cur.col / wrapWidth) === vi;

          if (isCursorHere) {
            const localCol = c.cur.col % wrapWidth;
            // If cursor is at EOL (localCol === segment.length which may be wrapWidth),
            // put the block at position localCol (= segment.length for last visual row).
            if (localCol <= innerCols) {
              const before = padded.slice(0, localCol);
              const at = padded[localCol] || ' ';
              const after = padded.slice(localCol + 1);
              out.push(' ' + before + reverse() + at + resetAttrs() + after + ' ');
            } else {
              out.push(' ' + padded + ' ');
            }
          } else {
            out.push(' ' + padded + ' ');
          }

          out.push(color(C.dim_c) + '│' + resetAttrs());
          renderRow++;
          if (renderRow >= composeContentRows) break outer;
        }
        absVR++;
      }
      logIdx++;
    }

    // Fill remaining rows with empty
    while (renderRow < composeContentRows) {
      const screenRow = composeContentStart + renderRow;
      out.push(moveTo(screenRow, 1) + eraseLine());
      out.push(color(C.dim_c) + '│' + resetAttrs());
      out.push(' '.repeat(innerCols + 2));
      out.push(color(C.dim_c) + '│' + resetAttrs());
      renderRow++;
    }
  } else {
    // ── no-wrap mode (horizontal scroll) — original behaviour ────────────
    // Vertical: scroll so cursor row is between 0 and composeContentRows-1.
    if (c.cur.row < c.visibleRowOffset) c.visibleRowOffset = c.cur.row;
    if (c.cur.row >= c.visibleRowOffset + composeContentRows) {
      c.visibleRowOffset = c.cur.row - composeContentRows + 1;
    }
    if (c.visibleRowOffset < 0) c.visibleRowOffset = 0;
    // Horizontal: scroll so cursor col is between 0 and innerCols-1.
    if (c.cur.col < c.colOffset) c.colOffset = c.cur.col;
    if (c.cur.col >= c.colOffset + innerCols) {
      c.colOffset = c.cur.col - innerCols + 1;
    }
    if (c.colOffset < 0) c.colOffset = 0;

    for (let r = 0; r < composeContentRows; r++) {
      const rowNum = composeContentStart + r;
      out.push(moveTo(rowNum, 1) + eraseLine());
      const lineIdx = c.visibleRowOffset + r;
      const line = c.lines[lineIdx];
      out.push(color(C.dim_c) + '│' + resetAttrs());
      if (line === undefined) {
        out.push(' '.repeat(innerCols + 2));
      } else {
        const sliced = line.slice(c.colOffset, c.colOffset + innerCols);
        // Pad to fill
        const padded = sliced + ' '.repeat(Math.max(0, innerCols - sliced.length));
        // Render with cursor overlay if this is the cursor row AND focus on compose.
        if (lineIdx === c.cur.row && appState.view.focus === 'compose') {
          const localCol = c.cur.col - c.colOffset;
          if (localCol >= 0 && localCol < innerCols) {
            const before = padded.slice(0, localCol);
            const at = padded[localCol] || ' ';
            const after = padded.slice(localCol + 1);
            out.push(' ' + before + reverse() + at + resetAttrs() + after + ' ');
          } else {
            out.push(' ' + padded + ' ');
          }
        } else {
          out.push(' ' + padded + ' ');
        }
      }
      out.push(color(C.dim_c) + '│' + resetAttrs());
    }
  }

  // ── compose box bottom border ───────────────────────────────────────────
  out.push(moveTo(composeBoxBottomRow, 1) + eraseLine());
  out.push(color(C.dim_c) + '└' + '─'.repeat(Math.max(0, cols - 2)) + '┘' + resetAttrs());

  // ── two-row hint footer ─────────────────────────────────────────────────
  // Helper: render a hint string with bright-key / description coloring.
  // Format: "Ctrl-S send" → Ctrl-S in color(255), " send" in color(C.hint).
  function renderHintStr(str) {
    // Segments separated by '·'. Each segment: "Key desc".
    const parts = str.split('·');
    let result = '';
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i].trim();
      if (!seg) continue;
      if (i > 0) result += color(C.hint) + ' · ';
      // The first "word" (space-delimited run possibly including '-') is the key chord.
      const spaceIdx = seg.indexOf(' ');
      if (spaceIdx === -1) {
        result += color(255) + seg + resetAttrs();
      } else {
        result += color(255) + seg.slice(0, spaceIdx) + resetAttrs()
               + color(C.hint) + seg.slice(spaceIdx) + resetAttrs();
      }
    }
    return result;
  }

  // Primary row (N-1): always-visible action keys — no dim().
  out.push(moveTo(hintRowPrimary, 1) + eraseLine());
  const primaryHint = 'Ctrl-S send · Ctrl-D send+Enter · Ctrl-E $EDITOR · Ctrl-Z undo · ? help';
  out.push(' ' + renderHintStr(primaryHint));

  // Secondary row (N): contextual — no dim().
  out.push(moveTo(hintRowSecondary, 1) + eraseLine());
  let secondaryHint;
  if (appState.view.focus === 'compose') {
    secondaryHint = 'Ctrl-W word-back · Ctrl-U line-back · Ctrl-K kill-EOL · Ctrl-←/→ word · Ctrl-\\ wrap · v verbose · q quit';
  } else {
    secondaryHint = 'j/k scroll · v filter · x clear · Enter detail · Ctrl-Down compose · q quit';
  }
  out.push(' ' + color(C.hint) + truncate(secondaryHint, cols - 2) + resetAttrs());

  // ── toast (drawn over primary hint row, transient) ──────────────────────
  if (appState.toast && appState.toast.expiresAt > Date.now()) {
    out.push(moveTo(hintRowPrimary, 1) + eraseLine());
    out.push(color(C.green) + bold() + ' ✓ ' + appState.toast.text + resetAttrs());
  }

  // ── modal overlay ───────────────────────────────────────────────────────
  if (appState.modal) {
    renderModal(out, rows, cols);
  }

  // ── event-detail popup ──────────────────────────────────────────────────
  if (appState.eventDetail) {
    renderEventDetail(out, rows, cols);
  }

  // ── help overlay ────────────────────────────────────────────────────────
  if (appState.view.helpOpen) {
    renderHelp(out, rows, cols);
  }

  process.stdout.write(out.join(''));
}

function renderModal(out, rows, cols) {
  const m = appState.modal;
  const w = Math.min(cols - 4, 80);
  const titleBar = ' ' + (m.title || 'detail') + ' ';
  const lines = (m.lines || []);
  const h = Math.min(rows - 4, lines.length + 4);
  const startRow = Math.max(2, Math.floor((rows - h) / 2));
  const startCol = Math.max(2, Math.floor((cols - w) / 2));

  // Top border
  out.push(moveTo(startRow, startCol) + color(C.amber)
    + '┌' + truncate(titleBar, w - 2) + '─'.repeat(Math.max(0, w - 2 - titleBar.length))
    + '┐' + resetAttrs());

  for (let i = 0; i < h - 2; i++) {
    const ln = lines[i] || '';
    out.push(moveTo(startRow + 1 + i, startCol)
      + color(C.amber) + '│' + resetAttrs()
      + ' ' + truncate(ln, w - 4) + ' '.repeat(Math.max(0, w - 4 - truncate(ln, w - 4).length))
      + ' ' + color(C.amber) + '│' + resetAttrs());
  }

  out.push(moveTo(startRow + h - 1, startCol)
    + color(C.amber) + '└' + '─'.repeat(Math.max(0, w - 2)) + '┘' + resetAttrs());

  out.push(moveTo(startRow + h, startCol)
    + color(C.hint) + ' [Esc] close' + resetAttrs());
}

function renderHelp(out, rows, cols) {
  const helpLines = [
    '── Compose pane ──────────────────────────────────────',
    'Ctrl-S          Send to claude pane (no auto-Enter)',
    'Ctrl-D          Send + press Enter',
    'Ctrl-E          Open $EDITOR on buffer',
    'Ctrl-X          Clear compose buffer',
    'Ctrl-Z          Undo',
    'Ctrl-Y          Redo',
    'Ctrl-L          Force-redraw',
    'Ctrl-A          Beginning of line',
    'Ctrl-W          Delete word backward',
    'Ctrl-U          Delete to beginning of line',
    'Ctrl-K          Kill to end of line',
    'Ctrl-← / →      Jump by word (left / right)',
    'Ctrl-↑ / ↓      Paragraph motion (up / down)',
    'Ctrl-\\          Toggle line wrap (also Alt-w)',
    '← → ↑ ↓         Move cursor',
    'Home / End      Beginning / end of line',
    'PgUp / PgDn     Scroll one screen',
    'Enter           Newline (auto-indent)',
    'Backspace       Delete char left',
    'Delete          Delete char right',
    '',
    '── Events pane ───────────────────────────────────────',
    'j / ↓           Scroll toward older events',
    'k / ↑           Scroll toward newer events',
    'PgUp / PgDn     Scroll five events',
    'v               Toggle low-noise / verbose filter',
    'x               Clear resolved events from view',
    'Enter           Open event detail modal',
    '',
    '── Global ────────────────────────────────────────────',
    'Ctrl-Up         Move focus to events log',
    'Ctrl-Down       Move focus to compose',
    '?               Toggle this help overlay',
    'Esc             Close overlay',
    'Ctrl-Q / Ctrl-C Quit',
  ];
  const w = Math.min(cols - 4, 60);
  const h = Math.min(rows - 4, helpLines.length + 4);
  const startRow = Math.max(2, Math.floor((rows - h) / 2));
  const startCol = Math.max(2, Math.floor((cols - w) / 2));
  const titleBar = ' keybindings ';

  out.push(moveTo(startRow, startCol) + color(C.amber)
    + '┌' + titleBar + '─'.repeat(Math.max(0, w - 2 - titleBar.length))
    + '┐' + resetAttrs());

  for (let i = 0; i < h - 2; i++) {
    const ln = helpLines[i] || '';
    out.push(moveTo(startRow + 1 + i, startCol)
      + color(C.amber) + '│' + resetAttrs()
      + ' ' + truncate(ln, w - 4) + ' '.repeat(Math.max(0, w - 4 - truncate(ln, w - 4).length))
      + ' ' + color(C.amber) + '│' + resetAttrs());
  }

  out.push(moveTo(startRow + h - 1, startCol)
    + color(C.amber) + '└' + '─'.repeat(Math.max(0, w - 2)) + '┘' + resetAttrs());

  out.push(moveTo(startRow + h, startCol)
    + color(C.hint) + ' [?] or [Esc] close' + resetAttrs());
}

function renderEventDetail(out, rows, cols) {
  const detail = appState.eventDetail;
  if (!detail) return;

  const ev = appState.events.find((it) => it.id === detail.itemId);
  if (!ev) return;

  // ── Popup sizing: ~80% width × ~60% height, clamped ─────────────────────
  const popupWidth  = Math.max(30, Math.min(Math.floor(cols * 0.8), cols - 4));
  const popupHeight = Math.max(8,  Math.min(Math.floor(rows * 0.6), rows - 4));

  // Content area: inner padding = 2 cols horizontal, 1 row vertical
  const popupContentWidth = popupWidth - 4; // 2 margin × 2 sides
  const bodyHeight = popupHeight - 4;        // top border + 1 padding + bottom border + 1 padding

  // ── Gather all content lines (wrapped) ──────────────────────────────────
  const allLines = [];
  // Title section
  allLines.push(...wrapText(`[${ev.kind}] ${eventTitle(ev)}`, popupContentWidth));
  // Metadata
  allLines.push('');
  allLines.push(`urgency: ${ev.urgency || 'normal'}`);
  if (ev.sessionId) allLines.push(`session: ${ev.sessionId}`);
  // Snippet
  if (ev.snippet) {
    allLines.push('');
    allLines.push('— snippet —');
    allLines.push(...wrapText(ev.snippet, popupContentWidth));
  }
  // Transcript snapshot
  if (ev.transcriptSnapshot) {
    allLines.push('');
    allLines.push('— transcript snapshot —');
    for (const ln of ev.transcriptSnapshot.split('\n').slice(0, 30)) {
      allLines.push(...wrapText(ln, popupContentWidth));
    }
  }

  // ── Clamp scroll ─────────────────────────────────────────────────────────
  const maxScroll = Math.max(0, allLines.length - bodyHeight);
  detail.scroll = Math.max(0, Math.min(detail.scroll, maxScroll));

  const startRow = Math.max(2, Math.floor((rows - popupHeight) / 2));
  const startCol = Math.max(2, Math.floor((cols - popupWidth)  / 2));

  // ── Drop shadow (one row below + one col right) ───────────────────────────
  const shadowRow = startRow + popupHeight;
  const shadowCol = startCol + 1;
  if (shadowRow <= rows) {
    out.push(moveTo(shadowRow, shadowCol)
      + bgColor(C.popupShadow) + color(C.popupShadow)
      + ' '.repeat(Math.min(popupWidth, cols - shadowCol + 1))
      + resetAttrs());
  }
  for (let r = 1; r < popupHeight; r++) {
    const sr = startRow + r;
    const sc = startCol + popupWidth;
    if (sr <= rows && sc <= cols) {
      out.push(moveTo(sr, sc)
        + bgColor(C.popupShadow) + color(C.popupShadow) + '  ' + resetAttrs());
    }
  }

  // ── Title bar (top border) ────────────────────────────────────────────────
  const titleLabel = ` event · ${ev.kind} `;
  const dashCount = Math.max(0, popupWidth - 2 - titleLabel.length);
  out.push(moveTo(startRow, startCol)
    + bgColor(C.popup) + color(C.popupBorder)
    + '┌' + truncate(titleLabel, popupWidth - 2) + '─'.repeat(dashCount)
    + '┐' + resetAttrs());

  // ── Inner top padding row ─────────────────────────────────────────────────
  out.push(moveTo(startRow + 1, startCol)
    + bgColor(C.popup) + color(C.popupBorder)
    + '│' + ' '.repeat(popupWidth - 2) + '│' + resetAttrs());

  // ── Scroll indicator: top ─────────────────────────────────────────────────
  if (detail.scroll > 0) {
    const indicator = ' ↑ more ';
    const col = startCol + Math.floor((popupWidth - indicator.length) / 2);
    out.push(moveTo(startRow + 1, col)
      + bgColor(C.popup) + color(C.hint) + indicator + resetAttrs());
  }

  // ── Body rows ─────────────────────────────────────────────────────────────
  const visibleLines = allLines.slice(detail.scroll, detail.scroll + bodyHeight);
  for (let i = 0; i < bodyHeight; i++) {
    const rowNum = startRow + 2 + i; // +2: border + padding
    const lineIdx = i;               // relative to visibleLines
    const rawLine = visibleLines[lineIdx] || '';
    // Determine if this is within the title block (first wrapped lines)
    const titleLineCount = wrapText(`[${ev.kind}] ${eventTitle(ev)}`, popupContentWidth).length;
    const absoluteIdx = detail.scroll + i;
    const isTitle = absoluteIdx < titleLineCount;

    const textColor = isTitle ? bold() + color(C.white) : color(C.hint);
    const padded = rawLine + ' '.repeat(Math.max(0, popupContentWidth - rawLine.length));

    out.push(moveTo(rowNum, startCol)
      + bgColor(C.popup) + color(C.popupBorder) + '│' + resetAttrs()
      + bgColor(C.popup) + '  ' + textColor + padded + resetAttrs()
      + bgColor(C.popup) + '  ' + color(C.popupBorder) + '│' + resetAttrs());
  }

  // ── Inner bottom padding row + scroll indicator: bottom ──────────────────
  const bottomPadRow = startRow + 2 + bodyHeight;
  out.push(moveTo(bottomPadRow, startCol)
    + bgColor(C.popup) + color(C.popupBorder)
    + '│' + ' '.repeat(popupWidth - 2) + '│' + resetAttrs());
  if (detail.scroll < maxScroll) {
    const indicator = ' ↓ more ';
    const col = startCol + Math.floor((popupWidth - indicator.length) / 2);
    out.push(moveTo(bottomPadRow, col)
      + bgColor(C.popup) + color(C.hint) + indicator + resetAttrs());
  }

  // ── Bottom border ─────────────────────────────────────────────────────────
  out.push(moveTo(startRow + popupHeight - 1, startCol)
    + bgColor(C.popup) + color(C.popupBorder)
    + '└' + '─'.repeat(Math.max(0, popupWidth - 2)) + '┘' + resetAttrs());

  // ── Footer hint ───────────────────────────────────────────────────────────
  const footerRow = startRow + popupHeight;
  if (footerRow <= rows) {
    out.push(moveTo(footerRow, startCol + 1)
      + dim() + color(C.dim_c) + ' [Esc/q] close · ↑↓ scroll · PgUp/PgDn' + resetAttrs());
  }
}

// ─── No-TTY mode ──────────────────────────────────────────────────────────────
let noTtyTimer = null;

function renderNoTty() {
  const evs = visibleEvents();
  const snap = {
    connected: appState.connected,
    paneId: appState.paneId,
    pending: appState.events.filter((it) => !it.resolved).length,
    eventFilter: appState.view.eventFilter,
    composeLines: appState.compose.lines.length,
    composeWords: composeWordCount(),
    composeWrap: appState.compose.wrap,
    hintPrimary: 'Ctrl-S send · Ctrl-D send+Enter · Ctrl-E $EDITOR · Ctrl-Z undo · ? help',
    events: evs.slice(-10).map((ev) => ({
      id: ev.id, kind: ev.kind, urgency: ev.urgency, title: eventTitle(ev),
    })),
  };
  process.stdout.write(JSON.stringify(snap) + '\n');
}

function startNoTtyLoop() {
  setTimeout(renderNoTty, 150);
  noTtyTimer = setInterval(renderNoTty, 200);
  noTtyTimer.ref?.();
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
  appState.toast = { text, expiresAt: Date.now() + ms };
  setTimeout(() => {
    if (appState.toast && appState.toast.expiresAt <= Date.now()) {
      appState.toast = null;
      scheduleRender();
    }
  }, ms + 50);
  scheduleRender();
}

// ─── pane discovery ───────────────────────────────────────────────────────────
function discoverPane() {
  // Daemon override wins.
  if (appState.paneOverride) {
    appState.paneId = appState.paneOverride;
    return appState.paneId;
  }
  try {
    const res = spawnSync('bash', [TMUX_SEND, 'discover'], { encoding: 'utf8' });
    const out = (res.stdout || '').trim();
    appState.paneId = out || null;
    return appState.paneId;
  } catch {
    appState.paneId = null;
    return null;
  }
}

// ─── send to claude pane ──────────────────────────────────────────────────────
async function sendToPane(port, opts = { autoEnter: false }) {
  const text = composeText();
  if (!text || text.trim() === '') {
    showToast('(nothing to send)');
    return;
  }
  if (!appState.paneId) discoverPane();
  if (!appState.paneId) {
    showToast('no claude pane in this window — set with /sb-attach <pane_id>', 3500);
    return;
  }
  const pane = appState.paneId;
  // Send literal text via tmux send-keys -l (helper handles quoting via stdin).
  const sendRes = spawnSync('bash', [TMUX_SEND, 'send', pane], {
    input: text,
    encoding: 'utf8',
  });
  if (sendRes.status !== 0) {
    showToast('send failed: ' + (sendRes.stderr || '').trim().slice(0, 80), 3500);
    return;
  }
  // Focus the pane so the human can review before submitting.
  spawnSync('bash', [TMUX_SEND, 'focus', pane], { encoding: 'utf8' });
  if (opts.autoEnter) {
    spawnSync('bash', [TMUX_SEND, 'enter', pane], { encoding: 'utf8' });
  }
  // Record the send in the daemon's event log.
  try {
    await httpPost(port, '/sent', { text, paneId: pane });
  } catch {
    // non-fatal: send already happened
  }
  // Clear compose buffer.
  clearCompose();
  if (opts.autoEnter) {
    showToast('sent + Enter → claude pane');
  } else {
    showToast('sent → claude pane focused; review and press Enter');
  }
}

// ─── external editor escape ───────────────────────────────────────────────────
function externalEditor() {
  if (NO_TTY) return;
  const editor = process.env.EDITOR || 'nano';
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `illo-compose-${process.pid}-${Date.now()}.md`);
  try {
    fs.writeFileSync(tmpFile, composeText(), 'utf8');
  } catch (e) {
    showToast('tmp write failed: ' + e.message);
    return;
  }
  // Pause TUI input + leave alt screen so the editor owns the terminal.
  try { process.stdin.setRawMode(false); } catch {}
  process.stdin.pause();
  process.stdout.write(showCursor() + altScreenOff() + resetAttrs());
  let res;
  try {
    res = spawnSync(editor, [tmpFile], { stdio: 'inherit' });
  } catch (e) {
    res = { status: 1, error: e };
  }
  // Re-enter alt screen + raw mode.
  process.stdout.write(altScreenOn() + clearScreen() + hideCursor());
  try { process.stdin.setRawMode(true); } catch {}
  process.stdin.resume();

  if (res && res.status === 0) {
    let newText = '';
    try { newText = fs.readFileSync(tmpFile, 'utf8'); } catch {}
    pushUndo(true);
    appState.compose.lines = newText.split('\n');
    if (appState.compose.lines.length === 0) appState.compose.lines = [''];
    // Place cursor at end.
    appState.compose.cur.row = appState.compose.lines.length - 1;
    appState.compose.cur.col = (appState.compose.lines[appState.compose.cur.row] || '').length;
    appState.compose.visibleRowOffset = 0;
    appState.compose.colOffset = 0;
    markDirty();
    endUndoGroup();
    showToast('loaded ' + appState.compose.lines.length + ' line(s) from $EDITOR');
  } else {
    showToast('editor exited non-zero — buffer unchanged');
  }
  try { fs.unlinkSync(tmpFile); } catch {}
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
      if (!handshakeBuf.includes(expectedAccept)) {
        wsSocket.destroy();
        return;
      }
      handshakeDone = true;
      appState.connected = true;
      appState.reconnecting = false;
      reconnectDelay = 1000;
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
  wsSocket.on('close', () => scheduleReconnect(port));
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
      try { handleWsMessage(JSON.parse(result.text)); } catch {}
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
    httpGet(port, '/state').then((data) => {
      appState.events = data.items || [];
      appState.config = data.config || {};
      appState.paneOverride = data.config?.paneOverride || null;
      if (appState.paneOverride) appState.paneId = appState.paneOverride;
    }).catch(() => {});
    connectWS(port);
  }, reconnectDelay);
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case 'snapshot':
      appState.events = msg.items || [];
      appState.config = msg.config || {};
      appState.paneOverride = msg.config?.paneOverride || null;
      if (appState.paneOverride) appState.paneId = appState.paneOverride;
      break;
    case 'item:add':
    case 'item:update':
      if (msg.item) {
        const idx = appState.events.findIndex((it) => it.id === msg.item.id);
        if (idx === -1) appState.events.push(msg.item);
        else appState.events[idx] = msg.item;
      }
      break;
    case 'item:remove':
      if (msg.id) appState.events = appState.events.filter((it) => it.id !== msg.id);
      break;
    case 'config':
      appState.config = msg.config || appState.config;
      const newOverride = msg.config?.paneOverride || null;
      appState.paneOverride = newOverride;
      if (newOverride) appState.paneId = newOverride;
      break;
    case 'cleared':
      if (Array.isArray(msg.ids)) {
        appState.events = appState.events.filter((it) => !msg.ids.includes(it.id));
      }
      break;
    default:
      break;
  }
  scheduleRender();
}

// ─── keyboard input ───────────────────────────────────────────────────────────
let inputBuf = Buffer.alloc(0);

function setupInput(port) {
  if (NO_TTY) return;
  if (!process.stdin.isTTY) return;

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding(null);

  process.stdin.on('data', (chunk) => {
    try {
      inputBuf = Buffer.concat([inputBuf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      processInputBuffer(port);
    } catch (err) {
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

  // C0 controls
  if (b0 === 0x01) return { key: 'ctrl-a', consumed: 1 };
  if (b0 === 0x02) return { key: 'ctrl-b', consumed: 1 };
  if (b0 === 0x03) return { key: 'ctrl-c', consumed: 1 };
  if (b0 === 0x04) return { key: 'ctrl-d', consumed: 1 };
  if (b0 === 0x05) return { key: 'ctrl-e', consumed: 1 };
  if (b0 === 0x06) return { key: 'ctrl-f', consumed: 1 };
  if (b0 === 0x08) return { key: 'backspace', consumed: 1 };
  if (b0 === 0x09) return { key: 'tab', consumed: 1 };
  if (b0 === 0x0a) return { key: 'enter', consumed: 1 };
  if (b0 === 0x0b) return { key: 'ctrl-k', consumed: 1 };
  if (b0 === 0x0c) return { key: 'ctrl-l', consumed: 1 };
  if (b0 === 0x0d) return { key: 'enter', consumed: 1 };
  if (b0 === 0x0e) return { key: 'ctrl-n', consumed: 1 };
  if (b0 === 0x10) return { key: 'ctrl-p', consumed: 1 };
  if (b0 === 0x11) return { key: 'ctrl-q', consumed: 1 };
  if (b0 === 0x13) return { key: 'ctrl-s', consumed: 1 };
  if (b0 === 0x15) return { key: 'ctrl-u', consumed: 1 };
  if (b0 === 0x17) return { key: 'ctrl-w', consumed: 1 };
  if (b0 === 0x18) return { key: 'ctrl-x', consumed: 1 };
  if (b0 === 0x19) return { key: 'ctrl-y', consumed: 1 };
  if (b0 === 0x1a) return { key: 'ctrl-z', consumed: 1 };
  if (b0 === 0x1c) return { key: 'ctrl-backslash', consumed: 1 };  // Ctrl-\ = wrap toggle
  if (b0 === 0x7f) return { key: 'backspace', consumed: 1 };

  // Escape sequences
  if (b0 === 0x1b) {
    if (buf.length === 1) return { key: 'esc', consumed: 1 };
    const b1 = buf[1];
    if (b1 === 0x5b) { // CSI [
      if (buf.length < 3) return null;
      const b2 = buf[2];
      // Plain arrows
      if (b2 === 0x41) return { key: 'up',     consumed: 3 };
      if (b2 === 0x42) return { key: 'down',   consumed: 3 };
      if (b2 === 0x43) return { key: 'right',  consumed: 3 };
      if (b2 === 0x44) return { key: 'left',   consumed: 3 };
      if (b2 === 0x48) return { key: 'home',   consumed: 3 };
      if (b2 === 0x46) return { key: 'end',    consumed: 3 };
      // Delete: ESC [ 3 ~
      if (b2 === 0x33 && buf.length >= 4 && buf[3] === 0x7e)
        return { key: 'delete', consumed: 4 };
      // PgUp / PgDn: ESC [ 5 ~ / ESC [ 6 ~
      if (b2 === 0x35 && buf.length >= 4 && buf[3] === 0x7e)
        return { key: 'pgup', consumed: 4 };
      if (b2 === 0x36 && buf.length >= 4 && buf[3] === 0x7e)
        return { key: 'pgdn', consumed: 4 };
      // Home/End alt: ESC [ 1 ~ / ESC [ 4 ~
      if (b2 === 0x31 && buf.length >= 4 && buf[3] === 0x7e)
        return { key: 'home', consumed: 4 };
      if (b2 === 0x34 && buf.length >= 4 && buf[3] === 0x7e)
        return { key: 'end', consumed: 4 };
      // Modified arrows: ESC [ 1 ; 5 A (ctrl-up), ESC [ 1 ; 5 B (ctrl-down)
      if (b2 === 0x31 && buf.length >= 6 && buf[3] === 0x3b && buf[4] === 0x35) {
        const b5 = buf[5];
        if (b5 === 0x41) return { key: 'ctrl-up',    consumed: 6 };
        if (b5 === 0x42) return { key: 'ctrl-down',  consumed: 6 };
        if (b5 === 0x43) return { key: 'ctrl-right', consumed: 6 };
        if (b5 === 0x44) return { key: 'ctrl-left',  consumed: 6 };
      }
      // Unknown CSI — swallow conservatively.
      return { key: `esc-[${String.fromCharCode(b2)}`, consumed: 3 };
    }
    if (b1 === 0x4f) { // SS3 O — Home/End in some terminals
      if (buf.length < 3) return null;
      const b2 = buf[2];
      if (b2 === 0x48) return { key: 'home', consumed: 3 };
      if (b2 === 0x46) return { key: 'end',  consumed: 3 };
      return { key: `esc-O${String.fromCharCode(b2)}`, consumed: 3 };
    }
    // Alt-letter: ESC + letter
    if (b1 >= 0x61 && b1 <= 0x7a) {
      return { key: `alt-${String.fromCharCode(b1)}`, consumed: 2 };
    }
    return { key: 'esc', consumed: 1 };
  }

  // Multi-byte UTF-8: pass through as a single "key" of the full sequence
  if ((b0 & 0xc0) === 0xc0) {
    let n = 1;
    if ((b0 & 0xf8) === 0xf0) n = 4;
    else if ((b0 & 0xf0) === 0xe0) n = 3;
    else if ((b0 & 0xe0) === 0xc0) n = 2;
    if (buf.length < n) return null;
    return { key: buf.slice(0, n).toString('utf8'), consumed: n };
  }

  // Printable ASCII
  if (b0 >= 0x20 && b0 <= 0x7e) return { key: String.fromCharCode(b0), consumed: 1 };
  return { key: `raw-${b0}`, consumed: 1 };
}

function handleKey(key, port) {
  // Help overlay: ? toggles, Esc closes
  if (appState.view.helpOpen) {
    if (key === 'esc' || key === '?' || key === 'ctrl-q') {
      appState.view.helpOpen = false;
      scheduleRender();
    }
    return;
  }

  // Event-detail popup: handle scrolling and close
  if (appState.eventDetail) {
    const detail = appState.eventDetail;
    const { rows } = termSize();
    const popupHeight = Math.max(8, Math.min(Math.floor(rows * 0.6), rows - 4));
    const bodyHeight = popupHeight - 4;

    // Compute total lines for clamping (reuse same logic as render)
    const ev = appState.events.find((it) => it.id === detail.itemId);
    let totalLines = 0;
    if (ev) {
      const popupWidth = Math.max(30, Math.min(Math.floor((process.stdout.columns || 80) * 0.8), (process.stdout.columns || 80) - 4));
      const popupContentWidth = popupWidth - 4;
      const allLines = [];
      allLines.push(...wrapText(`[${ev.kind}] ${eventTitle(ev)}`, popupContentWidth));
      allLines.push('');
      allLines.push(`urgency: ${ev.urgency || 'normal'}`);
      if (ev.sessionId) allLines.push(`session: ${ev.sessionId}`);
      if (ev.snippet) {
        allLines.push('');
        allLines.push('— snippet —');
        allLines.push(...wrapText(ev.snippet, popupContentWidth));
      }
      if (ev.transcriptSnapshot) {
        allLines.push('');
        allLines.push('— transcript snapshot —');
        for (const ln of ev.transcriptSnapshot.split('\n').slice(0, 30)) {
          allLines.push(...wrapText(ln, popupContentWidth));
        }
      }
      totalLines = allLines.length;
    }
    const maxScroll = Math.max(0, totalLines - bodyHeight);

    if (key === 'esc' || key === 'q') {
      appState.eventDetail = null;
      scheduleRender();
      return;
    }
    if (key === 'up' || key === 'k') {
      detail.scroll = Math.max(0, detail.scroll - 1);
      scheduleRender();
      return;
    }
    if (key === 'down' || key === 'j') {
      detail.scroll = Math.min(maxScroll, detail.scroll + 1);
      scheduleRender();
      return;
    }
    if (key === 'pgup') {
      detail.scroll = Math.max(0, detail.scroll - bodyHeight);
      scheduleRender();
      return;
    }
    if (key === 'pgdn') {
      detail.scroll = Math.min(maxScroll, detail.scroll + bodyHeight);
      scheduleRender();
      return;
    }
    // Any other key is swallowed while popup is open
    return;
  }

  // Modal: Esc closes
  if (appState.modal) {
    if (key === 'esc' || key === 'enter' || key === 'ctrl-q') {
      appState.modal = null;
      scheduleRender();
    }
    return;
  }

  // Global quit
  if (key === 'ctrl-q' || key === 'ctrl-c') {
    cleanup(0);
    return;
  }

  // Global help toggle
  if (key === '?') {
    appState.view.helpOpen = true;
    scheduleRender();
    return;
  }

  // Ctrl-Up / Ctrl-Down: focus toggle when in events pane;
  // in compose pane they become paragraph motion (handled in handleComposeKey).
  if (key === 'ctrl-up' && appState.view.focus === 'events') {
    // In events focus: Ctrl-Up is focus toggle (keep existing behaviour)
    // Actually: original: ctrl-up → events focus, ctrl-down → compose focus.
    // New rule: in events focus, ctrl-up/ctrl-down stay as focus toggles.
    // In compose focus, ctrl-up/ctrl-down become paragraph motion (handleComposeKey handles them).
    appState.view.focus = 'events';
    scheduleRender();
    return;
  }
  if (key === 'ctrl-down' && appState.view.focus === 'events') {
    appState.view.focus = 'compose';
    scheduleRender();
    return;
  }
  // When focus is 'compose', ctrl-up and ctrl-down fall through to handleComposeKey.

  if (appState.view.focus === 'events') {
    handleEventsKey(key, port);
    return;
  }
  handleComposeKey(key, port);
}

function handleEventsKey(key, port) {
  const evs = visibleEvents();
  const v = appState.view;
  switch (key) {
    case 'j':
    case 'down':
      v.eventScroll = Math.max(0, v.eventScroll - 1);
      break;
    case 'k':
    case 'up':
      v.eventScroll = Math.min(Math.max(0, evs.length - 1), v.eventScroll + 1);
      break;
    case 'pgdn':
      v.eventScroll = Math.max(0, v.eventScroll - 5);
      break;
    case 'pgup':
      v.eventScroll = Math.min(Math.max(0, evs.length - 1), v.eventScroll + 5);
      break;
    case 'v':
      v.eventFilter = v.eventFilter === 'verbose' ? 'low-noise' : 'verbose';
      v.eventScroll = 0;
      showToast(`event filter: ${v.eventFilter}`);
      break;
    case 'x':
      // Clear the in-memory event log view (does not delete from daemon)
      appState.events = appState.events.filter((ev) => !ev.resolved);
      v.eventScroll = 0;
      showToast('cleared resolved events from log view');
      break;
    case 'enter': {
      // Open event-detail popup for currently focused event
      const idx = evs.length - 1 - v.eventScroll;
      const ev = evs[idx];
      if (!ev) return;
      appState.eventDetail = { itemId: ev.id, scroll: 0 };
      break;
    }
    default:
      break;
  }
  scheduleRender();
}

function handleComposeKey(key, port) {
  // Ctrl shortcuts
  switch (key) {
    case 'ctrl-s':
      sendToPane(port, { autoEnter: false });
      return;
    case 'ctrl-d':
      sendToPane(port, { autoEnter: true });
      return;
    case 'ctrl-e':
      externalEditor();
      return;
    case 'ctrl-x':
      if (composeText().length === 0) {
        showToast('(buffer already empty)');
      } else {
        clearCompose();
        showToast('compose cleared');
      }
      scheduleRender();
      return;
    case 'ctrl-z':
      undo();
      scheduleRender();
      return;
    case 'ctrl-y':
      redo();
      scheduleRender();
      return;
    case 'ctrl-w':
      deleteWordBackward();
      scheduleRender();
      return;
    case 'ctrl-u':
      killLineBackward();
      scheduleRender();
      return;
    case 'ctrl-k':
      killToEol();
      scheduleRender();
      return;
    case 'ctrl-a':
      cursorHome();
      scheduleRender();
      return;
    case 'ctrl-l':
      // Redraw
      process.stdout.write(clearScreen());
      scheduleRender();
      return;
    // Word motion (Ctrl+Arrows)
    case 'ctrl-left':
      cursorWordLeft();
      scheduleRender();
      return;
    case 'ctrl-right':
      cursorWordRight();
      scheduleRender();
      return;
    // Paragraph motion (Ctrl-Up/Down in compose focus)
    case 'ctrl-up':
      cursorParagraphUp();
      scheduleRender();
      return;
    case 'ctrl-down':
      cursorParagraphDown();
      scheduleRender();
      return;
    // Line wrap toggle (Ctrl-\ and Alt-w as backup)
    case 'ctrl-backslash':
    case 'alt-w':
      toggleWrap();
      scheduleRender();
      return;
  }

  // Cursor + text editing
  switch (key) {
    case 'left':
      cursorLeft();
      break;
    case 'right':
      cursorRight();
      break;
    case 'up':
      cursorUp();
      break;
    case 'down':
      cursorDown();
      break;
    case 'home':
      cursorHome();
      break;
    case 'end':
      cursorEnd();
      break;
    case 'pgup':
      endUndoGroup();
      {
        const { rows } = termSize();
        appState.compose.cur.row = Math.max(0, appState.compose.cur.row - (rows - 1));
        clampCursor();
      }
      break;
    case 'pgdn':
      endUndoGroup();
      {
        const { rows } = termSize();
        appState.compose.cur.row = Math.min(appState.compose.lines.length - 1, appState.compose.cur.row + (rows - 1));
        clampCursor();
      }
      break;
    case 'backspace':
      backspaceChar();
      break;
    case 'delete':
      deleteChar();
      break;
    case 'enter':
      insertNewline();
      break;
    case 'tab':
      insertChar('  ');
      break;
    case 'esc':
      // No-op in compose mode (reserved for modal/help cancellation handled above)
      break;
    default:
      // Printable / utf-8 (exclude alt- sequences to avoid inserting garbage)
      if (typeof key === 'string' && key.length >= 1 && !key.startsWith('esc') && !key.startsWith('raw') && !key.startsWith('ctrl') && !key.startsWith('alt-')) {
        // Treat as text input
        insertChar(key);
      }
      break;
  }
  clampCursor();
  scheduleRender();
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const port = discoverPort();

  if (!NO_TTY) {
    process.stdout.write(altScreenOn() + clearScreen() + hideCursor());
    process.on('SIGINT', () => cleanup(0));
    process.on('SIGTERM', () => cleanup(0));
    process.on('SIGWINCH', () => scheduleRender());
  }

  // Try initial state fetch
  try {
    const data = await httpGet(port, '/state');
    appState.events = data.items || [];
    appState.config = data.config || {};
    appState.paneOverride = data.config?.paneOverride || null;
  } catch {}

  // Pane discovery
  discoverPane();

  // Connect WS
  connectWS(port);

  // Setup keyboard
  setupInput(port);

  if (NO_TTY) {
    startNoTtyLoop();
  } else {
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
