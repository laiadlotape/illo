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
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// ─── args ────────────────────────────────────────────────────────────────────
const NO_TTY = process.argv.includes('--no-tty');

// ─── constants ────────────────────────────────────────────────────────────────
// Word-aware wrap: if backing up to a whitespace boundary would leave a
// trailing gap wider than (1 - WORD_HARD_BREAK_RATIO) * innerCols we give up
// and hard-break instead (handles very long URLs / identifiers).
const WORD_HARD_BREAK_RATIO = 0.8;

// Bracketed paste cap (bytes)
const PASTE_MAX_BYTES = 1024 * 1024;

// ─── plugin root + tmux helper ───────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const PLUGIN_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version; }
  catch { return '?'; }
})();
const TMUX_SEND = path.join(PLUGIN_ROOT, 'bin', 'tmux-send.sh');
const RECORD_SH = path.join(PLUGIN_ROOT, 'bin', 'record.sh');
const REC_STATE_FILE = path.join(os.tmpdir(), 'illo-rec-state.txt');
// Check once at startup; recording features are silently disabled when absent.
const ASCIINEMA_AVAILABLE = spawnSync('which', ['asciinema'], { stdio: 'ignore' }).status === 0;

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
function altScreenOn()      { return `${CSI}?1049h`; }
function altScreenOff()     { return `${CSI}?1049l`; }
function bracketedPasteOn() { return `${CSI}?2004h`; }
function bracketedPasteOff(){ return `${CSI}?2004l`; }
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

// Word-aware line wrapper for compose pane (single logical line → visual rows).
// Does NOT split on '\n' — callers must handle multi-line text first.
// Export-friendly: referenced by tests/tui-units.test.mjs.
export function wrapLogicalLine(line, innerCols) {
  if (!line || line.length === 0) return [''];
  if (line.length <= innerCols) return [line];
  const rows = [];
  let i = 0;
  while (i < line.length) {
    if (line.length - i <= innerCols) {
      rows.push(line.slice(i));
      break;
    }
    const hardLimit = i + innerCols;
    // Search backwards from hardLimit for the last whitespace in [i, hardLimit).
    let breakAt = -1;
    for (let j = hardLimit - 1; j >= i; j--) {
      if (/\s/.test(line[j])) { breakAt = j; break; }
    }
    // Use whitespace break only if it doesn't eat more than
    // (1 - WORD_HARD_BREAK_RATIO) of the line width as trailing space.
    if (breakAt !== -1 && (hardLimit - breakAt) <= innerCols * (1 - WORD_HARD_BREAK_RATIO)) {
      rows.push(line.slice(i, breakAt));
      i = breakAt + 1; // consume the whitespace char
    } else {
      rows.push(line.slice(i, hardLimit));
      i = hardLimit;
    }
  }
  return rows.length > 0 ? rows : [''];
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

const ILLO_CONFIG_HOME = process.env.ILLO_CONFIG_HOME || path.join(os.homedir(), '.claude', 'illo');
const ILLO_CONFIG_FILE = path.join(ILLO_CONFIG_HOME, 'config.json');
const ILLO_CONFIG_TMP  = ILLO_CONFIG_FILE + '.tmp';

const CONFIG_DEFAULTS = {
  $schema: 'illo-config/v1',
  version: 1,
  keybindings: { compose: {}, events: {}, global: {} },
  theme: { name: 'default', accent: 'cyan' },
  filters: { defaultMode: 'low-noise' },
  display: {
    showSessionAge: true,
    showProject: true,
    showBranch: true,
    showCwd: false,
    expandSentByDefault: false,
  },
  compose: { wrap: true },
};

function deepMerge(defaults, overrides) {
  const out = Object.assign({}, defaults);
  for (const k of Object.keys(overrides)) {
    if (overrides[k] !== null && typeof overrides[k] === 'object' && !Array.isArray(overrides[k])
        && defaults[k] !== null && typeof defaults[k] === 'object') {
      out[k] = deepMerge(defaults[k], overrides[k]);
    } else {
      out[k] = overrides[k];
    }
  }
  return out;
}

function validateConfig(raw) {
  // Deep-merge with defaults so missing keys get filled in.
  // Unknown keys in raw are preserved (forward-compat for hand-edits).
  return deepMerge(CONFIG_DEFAULTS, typeof raw === 'object' && raw !== null ? raw : {});
}

function loadConfig() {
  // 1. Try new config.json
  try {
    const raw = JSON.parse(fs.readFileSync(ILLO_CONFIG_FILE, 'utf8'));
    return validateConfig(raw);
  } catch {
    // fall through to migration
  }
  // 2. Migrate from tui-prefs.json if present
  const prefs = loadTuiPrefs();
  const migrated = validateConfig({});
  if (prefs.composeWrap !== undefined) migrated.compose.wrap = prefs.composeWrap;
  // Write migrated config so future starts skip this path
  saveConfig(migrated);
  return migrated;
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(ILLO_CONFIG_HOME, { recursive: true });
    fs.writeFileSync(ILLO_CONFIG_TMP, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    fs.renameSync(ILLO_CONFIG_TMP, ILLO_CONFIG_FILE);
  } catch {
    // non-fatal
  }
}

function getConfig(dotPath, defaultVal) {
  const parts = dotPath.split('.');
  let cur = illoConfig;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object' || !(p in cur)) return defaultVal;
    cur = cur[p];
  }
  return cur;
}

function setConfig(dotPath, value) {
  const parts = dotPath.split('.');
  let cur = illoConfig;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] === null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
  saveConfig(illoConfig);
}

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

const illoConfig = loadConfig();
const tuiPrefs = loadTuiPrefs();

// ─── Application state ────────────────────────────────────────────────────────
const appState = {
  paneId: null,
  paneOverride: null,    // last seen daemon override
  events: [],            // all items from daemon
  config: {},
  connected: false,
  reconnecting: false,
  recording: false,

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
    wrap: getConfig('compose.wrap', true),
    dirty: false,
    undoStack: [],
    redoStack: [],
    lastEditTs: 0,
    typingGroupOpen: false,
  },

  toast: null,        // { text, expiresAt }
  modal: null,        // { type:'event-detail', eventId } | { type:'message', text }
  eventDetail: null,  // { itemId, scroll } | null
  pasteBuffer: null,  // string | null — accumulates bracketed paste content

  settings: {
    open: false,
    section: 0,        // which section is highlighted in the left column
    cursor: 0,         // which row in the right column
    awaitingKey: null, // { scope, action } while capturing a new keybind
    draft: null,       // deep-clone of illoConfig while panel is open
  },
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
  // Skip non-word chars backward
  while (i > 0 && !isWordChar(line[i - 1])) i--;
  // Skip word chars backward
  while (i > 0 && isWordChar(line[i - 1])) i--;
  c.lines[c.cur.row] = line.slice(0, i) + line.slice(c.cur.col);
  c.cur.col = i;
  markDirty();
  endUndoGroup();
}

function deleteWordForward() {
  pushUndo(true);
  const c = appState.compose;
  const line = c.lines[c.cur.row] || '';
  if (c.cur.col >= line.length) {
    // At EOL — join with next line (same as Delete key)
    if (c.cur.row < c.lines.length - 1) {
      c.lines[c.cur.row] = line + c.lines[c.cur.row + 1];
      c.lines.splice(c.cur.row + 1, 1);
      markDirty();
    }
    endUndoGroup();
    return;
  }
  let i = c.cur.col;
  // Skip whitespace forward
  while (i < line.length && /\s/.test(line[i])) i++;
  // Skip word chars forward
  while (i < line.length && !/\s/.test(line[i])) i++;
  c.lines[c.cur.row] = line.slice(0, c.cur.col) + line.slice(i);
  markDirty();
  endUndoGroup();
}

function moveLineUp() {
  pushUndo(true);
  const c = appState.compose;
  if (c.cur.row === 0) { endUndoGroup(); return; }
  const tmp = c.lines[c.cur.row];
  c.lines[c.cur.row] = c.lines[c.cur.row - 1];
  c.lines[c.cur.row - 1] = tmp;
  c.cur.row -= 1;
  clampCursor();
  markDirty();
  endUndoGroup();
}

function moveLineDown() {
  pushUndo(true);
  const c = appState.compose;
  if (c.cur.row >= c.lines.length - 1) { endUndoGroup(); return; }
  const tmp = c.lines[c.cur.row];
  c.lines[c.cur.row] = c.lines[c.cur.row + 1];
  c.lines[c.cur.row + 1] = tmp;
  c.cur.row += 1;
  clampCursor();
  markDirty();
  endUndoGroup();
}

function duplicateLineUp() {
  pushUndo(true);
  const c = appState.compose;
  const line = c.lines[c.cur.row] || '';
  c.lines.splice(c.cur.row, 0, line);
  // cursor stays on upper copy (same row)
  markDirty();
  endUndoGroup();
}

function duplicateLineDown() {
  pushUndo(true);
  const c = appState.compose;
  const line = c.lines[c.cur.row] || '';
  c.lines.splice(c.cur.row + 1, 0, line);
  c.cur.row += 1;
  markDirty();
  endUndoGroup();
}

function cursorBufferStart() {
  endUndoGroup();
  appState.compose.cur.row = 0;
  appState.compose.cur.col = 0;
}

function cursorBufferEnd() {
  endUndoGroup();
  const c = appState.compose;
  c.cur.row = c.lines.length - 1;
  c.cur.col = (c.lines[c.cur.row] || '').length;
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
  setConfig('compose.wrap', appState.compose.wrap);
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

// formatEventBody — pretty-prints an event into a human-readable multi-line string.
// Export-friendly: referenced by tests/tui-units.test.mjs.
export function formatEventBody(ev) {
  switch (ev.kind) {
    case 'ask_user': {
      const ti = ev.payload?.tool_input || ev.payload || {};
      const qs = Array.isArray(ti.questions) ? ti.questions : [];
      if (qs.length === 0) return ev.title || '(no question)';
      const q = qs[0];
      const lines = ['Q: ' + (q.question || '(unnamed)')];
      if (Array.isArray(q.options)) {
        q.options.forEach((o, i) => lines.push(`   [${i + 1}] ${o.label || o}`));
      }
      if (qs.length > 1) lines.push(`   (+${qs.length - 1} more question${qs.length > 2 ? 's' : ''})`);
      return lines.join('\n');
    }
    case 'notification': {
      return ev.payload?.message || ev.title || '(no message)';
    }
    case 'sent': {
      const text = ev.payload?.text || ev.title || '';
      return text.length > 80 ? text.slice(0, 80) + '…' : text;
    }
    case 'custom': {
      const lines = [ev.title || '(custom event)'];
      if (ev.snippet) lines.push(ev.snippet);
      if (ev.payload && typeof ev.payload === 'object') {
        for (const [k, v] of Object.entries(ev.payload)) {
          if (k === 'message') continue;
          if (typeof v === 'string' || typeof v === 'number') {
            lines.push(`  ${k}: ${v}`);
          }
        }
      }
      return lines.join('\n');
    }
    case 'stop':
    case 'session_start':
    case 'session_end':
    case 'user_prompt':
      return ev.title || ev.kind;
    default:
      return ev.title || ev.kind || '';
  }
}

// Export-friendly: referenced by tests/tui-units.test.mjs.
// Returns true when an event/item should appear in low-noise mode.
export function passesLowNoiseFilter(ev) {
  const k = ev.kind;
  if (k === 'ask_user') return true;
  if (k === 'sent') return true;
  if (k === 'notification') {
    return ev.urgency === 'urgent' || ev.subkind === 'permission_prompt';
  }
  return false;
}

function visibleEvents() {
  const all = appState.events.slice();
  if (appState.view.eventFilter === 'verbose') return all;
  // low-noise: ask_user, sent, and urgent/permission-prompt notifications only
  return all.filter(passesLowNoiseFilter);
}

function render() {
  if (!process.stdout.isTTY && !NO_TTY) return;
  const { rows, cols } = termSize();
  const out = [];

  // ── status bar (row 1) ──────────────────────────────────────────────────
  const paneStr = appState.paneId
    ? `pane: ${appState.paneId}`
    : 'pane: <none — /illo-attach to set>';
  const focusStr = appState.view.focus === 'events' ? 'focus: events' : 'focus: compose';
  const dot = appState.connected
    ? `${color(C.green)}●${resetAttrs()}`
    : `${color(C.red)}●${resetAttrs()}`;
  const reconn = appState.reconnecting ? `${color(C.red)} [reconnecting…]${resetAttrs()}` : '';
  const recIndicator = appState.recording ? ` ${bold()}${color(196)}● REC${resetAttrs()}` : '';

  out.push(moveTo(1, 1) + eraseLine());
  out.push(bold() + color(C.amber) + ' illo' + resetAttrs());
  out.push(color(C.dim_c) + ' · v' + PLUGIN_VERSION + resetAttrs());
  out.push(color(C.dim_c) + ' · ' + paneStr + resetAttrs());
  out.push(color(C.dim_c) + ' · ' + focusStr + resetAttrs());
  out.push(reconn);
  out.push(recIndicator);
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
    const titleText = truncate(formatEventBody(ev).split('\n')[0], titleAvail);
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
  const hasContent = appState.compose.lines.join('').trim().length > 0;
  const dirtyTag = (appState.compose.dirty && hasContent) ? ' · *unsaved' : '';
  const wrapTag = appState.compose.wrap ? ' · wrap:on' : ' · wrap:off';
  const composeFocusTag = appState.view.focus === 'compose' ? bold() + color(C.amber) + 'prompt' + resetAttrs() : color(C.dim_c) + 'prompt' + resetAttrs();
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
    // Build visual rows using word-aware wrapLogicalLine().
    // Each entry: { logIdx, segIdx, segment, charStart }
    //   logIdx   = index into c.lines
    //   segIdx   = visual sub-row within the logical line
    //   segment  = text of this visual row
    //   charStart = logical col offset at which this segment begins
    const allVisualRows = [];
    for (let li = 0; li < c.lines.length; li++) {
      const line = c.lines[li] || '';
      const segs = wrapLogicalLine(line, innerCols);
      let charOff = 0;
      for (let si = 0; si < segs.length; si++) {
        allVisualRows.push({ logIdx: li, segIdx: si, segment: segs[si], charStart: charOff });
        charOff += segs[si].length;
        // Skip the consumed whitespace char between segments (except last).
        if (si < segs.length - 1) charOff += 1;
      }
    }

    // Find absolute visual row of the cursor (the last segment whose charStart ≤ cur.col).
    let curVisRow = 0;
    for (let vr = 0; vr < allVisualRows.length; vr++) {
      const { logIdx: li, charStart } = allVisualRows[vr];
      if (li === c.cur.row && charStart <= c.cur.col) curVisRow = vr;
      if (li > c.cur.row) break;
    }

    // Adjust visibleRowOffset so cursor stays on screen.
    if (curVisRow < c.visibleRowOffset) c.visibleRowOffset = curVisRow;
    if (curVisRow >= c.visibleRowOffset + composeContentRows) {
      c.visibleRowOffset = curVisRow - composeContentRows + 1;
    }
    if (c.visibleRowOffset < 0) c.visibleRowOffset = 0;
    // Reset horizontal scroll in wrap mode
    c.colOffset = 0;

    // Render visible visual rows.
    let renderRow = 0;
    const visStart = c.visibleRowOffset;
    const visEnd   = visStart + composeContentRows;

    for (let vr = visStart; vr < Math.min(visEnd, allVisualRows.length); vr++) {
      const { logIdx: li, segment, charStart } = allVisualRows[vr];
      const screenRow = composeContentStart + renderRow;
      out.push(moveTo(screenRow, 1) + eraseLine());
      out.push(color(C.dim_c) + '│' + resetAttrs());

      const padded = segment + ' '.repeat(Math.max(0, innerCols - segment.length));

      // Cursor on this visual row?
      const isCursorHere = li === c.cur.row && appState.view.focus === 'compose' && vr === curVisRow;

      if (isCursorHere) {
        const localCol = c.cur.col - charStart;
        if (localCol >= 0 && localCol <= innerCols) {
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
    secondaryHint = 'Ctrl-W word-back · Ctrl-U line-back · Ctrl-K kill-EOL · Ctrl-←/→ word · Ctrl-Shift-↑/↓ paragraph · Ctrl-\\ wrap · q quit';
  } else {
    secondaryHint = 'j/k scroll · v filter · x clear · Enter detail · Ctrl-Down prompt · q quit';
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

  // ── settings panel ──────────────────────────────────────────────────────
  if (appState.settings.open) {
    renderSettings(out, rows, cols);
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
    '── Prompt pane ───────────────────────────────────────',
    'Ctrl-S          Send to claude pane (no auto-Enter)',
    'Ctrl-D          Send + press Enter',
    'Ctrl-E          Open $EDITOR on buffer',
    'Ctrl-X          Clear prompt buffer',
    'Ctrl-Z          Undo',
    'Ctrl-Y          Redo',
    'Ctrl-L          Force-redraw',
    'Ctrl-A          Beginning of line',
    'Ctrl-W          Delete word backward',
    'Ctrl-U          Delete to beginning of line',
    'Ctrl-K          Kill to end of line',
    'Ctrl-← / →      Jump by word (left / right)',
    'Ctrl-Shift-↑ / ↓  Paragraph motion (up / down)',
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
    'Ctrl-Up         Move focus to events log (always)',
    'Ctrl-Down       Move focus to compose (always)',
    '?               Toggle this help overlay',
    ',               Open settings panel',
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

// ─── Settings panel ───────────────────────────────────────────────────────────

const SETTINGS_SECTIONS = ['Display', 'Filters', 'Compose', 'Keybindings', 'About'];

function settingsSectionRows(sectionIdx) {
  switch (sectionIdx) {
    case 0: return ['showSessionAge', 'showProject', 'showBranch', 'showCwd', 'expandSentByDefault'];
    case 1: return ['defaultMode'];
    case 2: return ['wrap'];
    case 3: return ['_keybindings_coming_soon'];
    case 4: return ['_version', '_configFile', '_homepage'];
    default: return [];
  }
}

function applySettingsToggle(draft, section, cursor) {
  const rows = settingsSectionRows(section);
  const row = rows[cursor];
  if (!row || row.startsWith('_')) return;
  switch (section) {
    case 0: draft.display[row] = !draft.display[row]; break;
    case 1:
      draft.filters.defaultMode =
        draft.filters.defaultMode === 'low-noise' ? 'verbose' : 'low-noise';
      break;
    case 2: draft.compose.wrap = !draft.compose.wrap; break;
  }
}

function settingsRowLabel(sectionIdx, rowKey, draft) {
  const DISPLAY_LABELS = {
    showSessionAge:       'Show session age · Xm suffix on events',
    showProject:          'Show project name suffix',
    showBranch:           'Show git branch suffix',
    showCwd:              'Show cwd suffix (verbose)',
    expandSentByDefault:  'Auto-expand sent items',
  };

  switch (sectionIdx) {
    case 0: {
      const val = draft.display[rowKey];
      const box = val ? '[✓]' : '[ ]';
      return `${box} ${DISPLAY_LABELS[rowKey] || rowKey}`;
    }
    case 1: {
      const mode = draft.filters.defaultMode;
      return `< ${mode} >  Default event filter`;
    }
    case 2: {
      const val = draft.compose.wrap;
      const box = val ? '[✓]' : '[ ]';
      return `${box} Word-wrap compose buffer`;
    }
    case 3:
      return 'Keybinding overrides — coming in a future release';
    case 4:
      if (rowKey === '_version')    return `Version: ${PLUGIN_VERSION}`;
      if (rowKey === '_configFile') return `Config:  ${ILLO_CONFIG_FILE}`;
      if (rowKey === '_homepage')   return 'Home:    https://github.com/laiadlotape/illo';
      return rowKey;
    default: return rowKey;
  }
}

function renderSettings(out, rows, cols) {
  const s = appState.settings;
  const draft = s.draft;

  // Overall box: ~70% width × ~70% height, centered
  const boxW = Math.max(50, Math.min(Math.floor(cols * 0.70), cols - 4));
  const boxH = Math.max(10, Math.min(Math.floor(rows * 0.70), rows - 4));
  const startRow = Math.max(2, Math.floor((rows - boxH) / 2));
  const startCol = Math.max(2, Math.floor((cols - boxW) / 2));

  const LEFT_COL_W = 14; // chars for section name column (not counting borders)
  const innerW = boxW - 2; // exclude left+right borders
  const rightColW = innerW - LEFT_COL_W - 1; // -1 for divider

  const titleBar = ' settings ';

  // Top border
  out.push(moveTo(startRow, startCol) + color(C.amber)
    + '┌' + titleBar + '─'.repeat(Math.max(0, boxW - 2 - titleBar.length))
    + '┐' + resetAttrs());

  // Content rows (boxH - 2 rows: exclude top and bottom borders)
  const contentRows = boxH - 2;

  for (let i = 0; i < contentRows; i++) {
    const sectionIdx = i; // one section label per row (saturates at last section)
    const isActiveSect = sectionIdx < SETTINGS_SECTIONS.length && sectionIdx === s.section;
    const sectionName  = sectionIdx < SETTINGS_SECTIONS.length ? SETTINGS_SECTIONS[sectionIdx] : '';

    // Left column: section names
    let leftCell;
    if (sectionIdx < SETTINGS_SECTIONS.length) {
      const padded = sectionName.padEnd(LEFT_COL_W);
      if (isActiveSect) {
        leftCell = bgColor(C.amber) + color(0) + padded + resetAttrs();
      } else {
        leftCell = color(C.dim_c) + padded + resetAttrs();
      }
    } else {
      leftCell = ' '.repeat(LEFT_COL_W);
    }

    // Right column: rows for the active section
    const sectionRows = settingsSectionRows(s.section);
    const rowKey = sectionRows[i];
    let rightCell = '';
    if (rowKey !== undefined) {
      const label = settingsRowLabel(s.section, rowKey, draft);
      const isCursor = i === s.cursor;
      const isReadOnly = rowKey.startsWith('_') || s.section === 3;
      const truncLabel = truncate(label, rightColW - 2);
      if (isCursor && !isReadOnly) {
        rightCell = bold() + color(C.white) + '> ' + truncLabel + resetAttrs();
      } else if (isCursor && isReadOnly) {
        rightCell = color(C.hint) + '> ' + truncLabel + resetAttrs();
      } else if (isReadOnly) {
        rightCell = color(C.dim_c) + '  ' + truncLabel + resetAttrs();
      } else {
        rightCell = color(C.gray) + '  ' + truncLabel + resetAttrs();
      }
    }

    // Pad right cell to fill the right column width
    const visibleRightLen = rightCell.replace(/\x1b\[[0-9;]*m/g, '').length;
    const rightPad = ' '.repeat(Math.max(0, rightColW - visibleRightLen));

    out.push(moveTo(startRow + 1 + i, startCol)
      + color(C.amber) + '│' + resetAttrs()
      + leftCell
      + color(C.amber) + '│' + resetAttrs()
      + rightCell + rightPad
      + color(C.amber) + '│' + resetAttrs());
  }

  // Bottom border
  out.push(moveTo(startRow + boxH - 1, startCol)
    + color(C.amber) + '└' + '─'.repeat(Math.max(0, boxW - 2)) + '┘' + resetAttrs());

  // Footer
  const footer = s.awaitingKey
    ? ' Press any key to set keybind — Esc to cancel'
    : ' [j/k] move  [Space/←→] toggle  [s] save  [r] revert  [d] defaults  [Esc] cancel';
  out.push(moveTo(startRow + boxH, startCol)
    + color(C.hint) + truncate(footer, cols - startCol) + resetAttrs());
}

function handleSettingsKey(key) {
  const s = appState.settings;

  // Keybind capture mode
  if (s.awaitingKey) {
    if (key === 'esc') { s.awaitingKey = null; scheduleRender(); return; }
    // future: set s.draft.keybindings[scope][action] = key
    s.awaitingKey = null;
    scheduleRender();
    return;
  }

  switch (key) {
    case 'esc':
    case ',':
      s.open = false; s.draft = null; scheduleRender(); return;
    case 'j':
    case 'down': {
      const rowCount = settingsSectionRows(s.section).length;
      if (s.cursor < rowCount - 1) s.cursor++;
      else if (s.section < SETTINGS_SECTIONS.length - 1) {
        s.section++; s.cursor = 0;
      }
      scheduleRender(); return;
    }
    case 'k':
    case 'up':
      if (s.cursor > 0) s.cursor--;
      else if (s.section > 0) {
        s.section--; s.cursor = settingsSectionRows(s.section).length - 1;
      }
      scheduleRender(); return;
    case 'tab':
      s.section = (s.section + 1) % SETTINGS_SECTIONS.length;
      s.cursor = 0;
      scheduleRender(); return;
    case 'space':
    case 'right':
    case 'left':
      applySettingsToggle(s.draft, s.section, s.cursor);
      scheduleRender(); return;
    case 's':
      // Save
      Object.assign(illoConfig, s.draft);
      saveConfig(illoConfig);
      s.open = false; s.draft = null;
      showToast('Settings saved');
      scheduleRender(); return;
    case 'r':
      // Revert to last saved
      s.draft = JSON.parse(JSON.stringify(illoConfig));
      s.cursor = 0;
      showToast('Reverted to saved settings');
      scheduleRender(); return;
    case 'd':
      // Reset to defaults
      s.draft = JSON.parse(JSON.stringify(CONFIG_DEFAULTS));
      s.cursor = 0;
      showToast('Reset to defaults (press s to confirm)');
      scheduleRender(); return;
  }
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
  // Pretty-printed body
  const formattedBody = formatEventBody(ev);
  if (formattedBody) {
    allLines.push('');
    allLines.push('— detail —');
    for (const ln of formattedBody.split('\n')) {
      allLines.push(...wrapText(ln, popupContentWidth));
    }
  }
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
      formattedLine: formatEventBody(ev).split('\n')[0],
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
    process.stdout.write(bracketedPasteOff() + showCursor() + altScreenOff() + resetAttrs());
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
    showToast('no claude pane in this window — set with /illo-attach <pane_id>', 3500);
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
  appState.compose.dirty = false;
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
    appState.compose.dirty = false;
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

// ANSI escape strip regexes for paste sanitization
const RE_CSI  = /\x1b\[[0-9;]*[A-Za-z]/g;
const RE_OSC  = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

function sanitizePaste(raw) {
  return raw
    .replace(RE_CSI, '')
    .replace(RE_OSC, '');
}

function applyPaste(text) {
  if (!text) return;
  // Cap at PASTE_MAX_BYTES
  if (Buffer.byteLength(text, 'utf8') > PASTE_MAX_BYTES) {
    text = Buffer.from(text, 'utf8').slice(0, PASTE_MAX_BYTES).toString('utf8');
  }
  const stripped = sanitizePaste(text);
  if (!stripped) return;
  // Single undo group for the whole paste
  pushUndo(true);
  const newLines = stripped.split('\n');
  const c = appState.compose;
  const line = c.lines[c.cur.row] || '';
  const left = line.slice(0, c.cur.col);
  const right = line.slice(c.cur.col);
  if (newLines.length === 1) {
    // Single-line paste — insert inline
    c.lines[c.cur.row] = left + newLines[0] + right;
    c.cur.col = left.length + newLines[0].length;
  } else {
    // Multi-line paste: split current line, splice in paste lines
    const firstLine = left + newLines[0];
    const lastLine  = newLines[newLines.length - 1] + right;
    const middle    = newLines.slice(1, -1);
    const spliced   = [firstLine, ...middle, lastLine];
    c.lines.splice(c.cur.row, 1, ...spliced);
    c.cur.row += newLines.length - 1;
    c.cur.col = newLines[newLines.length - 1].length;
  }
  markDirty();
  endUndoGroup();
  clampCursor();
  scheduleRender();
}

function processInputBuffer(port) {
  while (inputBuf.length > 0) {
    // If we are inside a bracketed paste, scan for the end marker.
    if (appState.pasteBuffer !== null) {
      const endMarker = Buffer.from('\x1b[201~');
      const idx = inputBuf.indexOf(endMarker);
      if (idx === -1) {
        // End marker not yet in buffer — stash everything and wait.
        appState.pasteBuffer += inputBuf.toString('utf8');
        inputBuf = Buffer.alloc(0);
        return;
      }
      // Found the end marker.
      appState.pasteBuffer += inputBuf.slice(0, idx).toString('utf8');
      inputBuf = inputBuf.slice(idx + endMarker.length);
      const pasted = appState.pasteBuffer;
      appState.pasteBuffer = null;
      if (appState.view.focus === 'compose') applyPaste(pasted);
      continue;
    }
    const result = parseKey(inputBuf);
    if (!result) break;
    inputBuf = inputBuf.slice(result.consumed);
    if (result.key === 'paste-start') {
      appState.pasteBuffer = '';
      continue;
    }
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
  if (b0 === 0x08) return { key: 'ctrl-backspace', consumed: 1 };
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
      // Ctrl+Delete: ESC [ 3 ; 5 ~
      if (b2 === 0x33 && buf.length >= 6 && buf[3] === 0x3b && buf[4] === 0x35 && buf[5] === 0x7e)
        return { key: 'ctrl-delete', consumed: 6 };
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
      // Modified arrows: ESC [ 1 ; <modifier> <letter>
      // modifier 5 = Ctrl, modifier 6 = Ctrl+Shift
      if (b2 === 0x31 && buf.length >= 6 && buf[3] === 0x3b) {
        const mod = buf[4];
        const b5  = buf[5];
        if (mod === 0x32) { // Shift
          if (b5 === 0x41) return { key: 'shift-up',   consumed: 6 };
          if (b5 === 0x42) return { key: 'shift-down', consumed: 6 };
        }
        if (mod === 0x35) { // Ctrl
          if (b5 === 0x41) return { key: 'ctrl-up',    consumed: 6 };
          if (b5 === 0x42) return { key: 'ctrl-down',  consumed: 6 };
          if (b5 === 0x43) return { key: 'ctrl-right', consumed: 6 };
          if (b5 === 0x44) return { key: 'ctrl-left',  consumed: 6 };
          if (b5 === 0x48) return { key: 'ctrl-home',  consumed: 6 };
          if (b5 === 0x46) return { key: 'ctrl-end',   consumed: 6 };
        }
        if (mod === 0x36) { // Ctrl+Shift
          if (b5 === 0x41) return { key: 'ctrl-shift-up',   consumed: 6 };
          if (b5 === 0x42) return { key: 'ctrl-shift-down', consumed: 6 };
        }
        if (mod === 0x0a) { // Alt+Shift (modifier 10)
          if (b5 === 0x41) return { key: 'alt-shift-up',   consumed: 6 };
          if (b5 === 0x42) return { key: 'alt-shift-down', consumed: 6 };
        }
      }
      // Bracketed paste markers: ESC [ 200 ~ (6 bytes) / ESC [ 201 ~ (6 bytes)
      if (b2 === 0x32 && buf.length >= 4 && buf[3] === 0x30) {
        // prefix is ESC [ 2 0 — could be paste-start (200~) or paste-end (201~); need 6 bytes.
        if (buf.length < 6) return null; // wait for more data
        if (buf[4] === 0x30 && buf[5] === 0x7e)
          return { key: 'paste-start', consumed: 6 };
        if (buf[4] === 0x31 && buf[5] === 0x7e)
          return { key: 'paste-end', consumed: 6 };
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
    // Alt+Backspace: ESC + 0x7f
    if (b1 === 0x7f) return { key: 'alt-backspace', consumed: 2 };
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
  // Settings panel: intercepts all keys when open
  if (appState.settings.open) {
    handleSettingsKey(key);
    return;
  }

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
      const formattedBody2 = formatEventBody(ev);
      if (formattedBody2) {
        allLines.push('');
        allLines.push('— detail —');
        for (const ln of formattedBody2.split('\n')) {
          allLines.push(...wrapText(ln, popupContentWidth));
        }
      }
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

  // Global settings panel
  if (key === ',') {
    appState.settings.open = true;
    appState.settings.section = 0;
    appState.settings.cursor = 0;
    appState.settings.draft = JSON.parse(JSON.stringify(illoConfig));
    scheduleRender();
    return;
  }

  // Ctrl-Up / Ctrl-Down: ALWAYS focus toggle (compose ↔ events), regardless of pane.
  // Ctrl-Shift-Up / Ctrl-Shift-Down: paragraph motion in compose (handled in handleComposeKey).
  if (key === 'ctrl-up') {
    appState.view.focus = 'events';
    scheduleRender();
    return;
  }
  if (key === 'ctrl-down') {
    appState.view.focus = 'compose';
    scheduleRender();
    return;
  }

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
    case 'x': {
      // Count resolved events before removing them
      const resolved = appState.events.filter((ev) => ev.resolved === true);
      const n = resolved.length;
      if (n === 0) {
        showToast('nothing to clear');
      } else {
        // POST to /clear so daemon removes resolved items server-side
        httpPost(port, '/clear', {}).catch(() => {});
        // Update local state immediately
        appState.events = appState.events.filter((ev) => ev.resolved !== true);
        v.eventScroll = 0;
        showToast(`cleared ${n} resolved event${n === 1 ? '' : 's'}`);
      }
      break;
    }
    case 'enter': {
      // Open event-detail popup for currently focused event
      const idx = evs.length - 1 - v.eventScroll;
      const ev = evs[idx];
      if (!ev) return;
      appState.eventDetail = { itemId: ev.id, scroll: 0 };
      break;
    }
    case 'r': {
      if (!ASCIINEMA_AVAILABLE) {
        showToast('recording requires asciinema — pip install asciinema');
        return;
      }
      const proc = spawn('bash', [RECORD_SH, 'toggle'], { stdio: 'ignore' });
      appState.recording = !appState.recording;
      showToast(appState.recording ? 'recording started' : 'recording stopped — converting gif…');
      proc.unref();
      scheduleRender();
      return;
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
        appState.compose.dirty = false;
        showToast('prompt cleared');
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
    // Paragraph motion (Ctrl-Shift-Up/Down in compose focus)
    case 'ctrl-shift-up':
      cursorParagraphUp();
      scheduleRender();
      return;
    case 'ctrl-shift-down':
      cursorParagraphDown();
      scheduleRender();
      return;
    // Line wrap toggle (Ctrl-\ and Alt-w as backup)
    case 'ctrl-backslash':
    case 'alt-w':
      toggleWrap();
      scheduleRender();
      return;
    case 'ctrl-backspace':
    case 'alt-backspace':
      deleteWordBackward();
      scheduleRender();
      return;
    case 'ctrl-delete':
    case 'alt-d':
      deleteWordForward();
      scheduleRender();
      return;
    case 'shift-up':
      moveLineUp();
      scheduleRender();
      return;
    case 'shift-down':
      moveLineDown();
      scheduleRender();
      return;
    case 'alt-shift-up':
      duplicateLineUp();
      scheduleRender();
      return;
    case 'alt-shift-down':
      duplicateLineDown();
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
    case 'ctrl-home':
      cursorBufferStart();
      break;
    case 'ctrl-end':
      cursorBufferEnd();
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
    process.stdout.write(altScreenOn() + clearScreen() + hideCursor() + bracketedPasteOn());
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

  // Sync recording indicator with any in-progress recording started before TUI launched
  try { appState.recording = fs.existsSync(REC_STATE_FILE); } catch { /* non-fatal */ }

  // Poll the state file every second so the ● REC indicator updates live
  // when recording is toggled from outside (shell or /illo-record command).
  setInterval(() => {
    try {
      const now = fs.existsSync(REC_STATE_FILE);
      if (now !== appState.recording) {
        appState.recording = now;
        scheduleRender();
      }
    } catch { /* non-fatal */ }
  }, 1000);

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
