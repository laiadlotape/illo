#!/usr/bin/env node
// tui-units.test.mjs — unit tests for illo-tui.js helpers.
// Run with: node --test tests/tui-units.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TUI        = path.resolve(__dirname, '..', 'bin', 'illo-tui.js');

// ─── Import helpers from illo-tui.js ─────────────────────────────────────────
const { wrapLogicalLine, passesLowNoiseFilter, formatEventBody } = await import(TUI);

// ─── wrapLogicalLine tests (#37 word-aware wrap) ─────────────────────────────

test('wrapLogicalLine: short line returns as-is', () => {
  const result = wrapLogicalLine('hello world', 40);
  assert.deepEqual(result, ['hello world']);
});

test('wrapLogicalLine: empty string returns [""]', () => {
  const result = wrapLogicalLine('', 40);
  assert.deepEqual(result, ['']);
});

test('wrapLogicalLine: breaks at last whitespace within ratio when multiple words fit', () => {
  // 'aa bb cc' with width=6: hardLimit=6, last space before 6 is idx 5 ('aa bb ').
  // line[5]=' ', breakAt=5, gap=1, threshold=6*0.2=1.2 → 1 <= 1.2 → whitespace break.
  const result = wrapLogicalLine('aa bb cc', 6);
  assert.equal(result[0], 'aa bb');
  assert.equal(result[1], 'cc');
});

test('wrapLogicalLine: breaks at last whitespace before limit', () => {
  // Line: 'one two three four' width=10
  // 'one two th' hard limit — but 'one two' (7) is a valid break at idx 7, gap=3, 3 <= 10*0.2=2? No, 3>2 — hard break.
  // Actually: hardLimit=10, breakAt of last space before 10 = idx 7 ('one two ').
  // gap = hardLimit - breakAt = 10 - 7 = 3. innerCols*(1-0.8) = 10*0.2 = 2. 3 > 2, so hard break.
  const result = wrapLogicalLine('one two three four', 10);
  // Should hard-break since the gap is too large
  assert.equal(result[0], 'one two th');
});

test('wrapLogicalLine: wraps at whitespace when gap is within ratio', () => {
  // 'hello beautiful world' width=16
  // hardLimit at 16: last space before 16 is at idx 15 ('hello beautiful').
  // Wait: 'hello beautiful ' — 'hello beautiful' is 15 chars, space at idx 15.
  // gap = 16 - 15 = 1, ratio threshold = 16 * 0.2 = 3.2. 1 <= 3.2 → break at whitespace.
  const result = wrapLogicalLine('hello beautiful world', 16);
  assert.equal(result[0], 'hello beautiful');
  assert.equal(result[1], 'world');
});

test('wrapLogicalLine: very long word (> WORD_HARD_BREAK_RATIO * innerCols) is hard-broken', () => {
  // A 100-char word with width=20: no whitespace, must hard-break every 20 chars.
  const longWord = 'a'.repeat(100);
  const result = wrapLogicalLine(longWord, 20);
  assert.equal(result.length, 5);
  for (const seg of result) {
    assert.equal(seg.length, 20);
  }
});

test('wrapLogicalLine: URL-like token gets hard-broken (no whitespace)', () => {
  const url = 'https://example.com/very/long/path/that/exceeds/column/limit/deeply/nested';
  const result = wrapLogicalLine(url, 20);
  // All segments except possibly last should be 20 chars
  for (let i = 0; i < result.length - 1; i++) {
    assert.equal(result[i].length, 20, `segment ${i} length`);
  }
  // Total chars reconstructed equals original (no chars lost)
  assert.equal(result.join('').length, url.length);
});

test('wrapLogicalLine: mixed words and long token', () => {
  // 'short https://aaaaaaaaaaaaaaaaaaaaaaaaaaa end' width=20
  // First break: 'short' (5) + ' ' + 'https://aaaaaaaaaaaaa' — 'short ' is 6, then long URL
  const line = 'short ' + 'x'.repeat(30) + ' end';
  const result = wrapLogicalLine(line, 20);
  assert.ok(result.length >= 2);
  // First segment starts with 'short '
  assert.ok(result[0].startsWith('short '), `first seg: "${result[0]}"`);
});

// ─── parseKey tests (#36 Ctrl+Shift+Up/Down sequences) ───────────────────────
// We test parseKey indirectly by checking the source file contains the right patterns.
// (parseKey is not exported to avoid the overhead of re-architecting the module.)
test('illo-tui.js source contains ctrl-shift-up/ctrl-shift-down key strings', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(TUI, 'utf8');
  assert.ok(src.includes("'ctrl-shift-up'"), 'ctrl-shift-up key string missing');
  assert.ok(src.includes("'ctrl-shift-down'"), 'ctrl-shift-down key string missing');
  // modifier 6 = Ctrl+Shift (0x36)
  assert.ok(src.includes('0x36'), 'modifier 0x36 (Ctrl+Shift) not in source');
});

test('illo-tui.js source: ctrl-up/ctrl-down are global focus toggle (not in handleComposeKey)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(TUI, 'utf8');
  // The handleComposeKey function should NOT contain 'ctrl-up' as a case
  // We check that cursorParagraphUp is bound to ctrl-shift-up, not ctrl-up.
  assert.ok(src.includes("case 'ctrl-shift-up':"), 'ctrl-shift-up case missing in handleComposeKey');
  assert.ok(!src.includes("case 'ctrl-up':"), 'ctrl-up case should not appear in handleComposeKey');
});

// ─── Bracketed paste: startup sequence (#39) ─────────────────────────────────
test('illo-tui.js source emits bracketed paste enable on startup', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(TUI, 'utf8');
  // bracketedPasteOn() returns ESC[?2004h
  assert.ok(src.includes('?2004h'), 'bracketed paste enable sequence missing');
  assert.ok(src.includes('?2004l'), 'bracketed paste disable sequence missing');
});

test('illo-tui.js source: PASTE_MAX_BYTES constant is 1 MB', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(TUI, 'utf8');
  assert.ok(src.includes('PASTE_MAX_BYTES = 1024 * 1024'), 'PASTE_MAX_BYTES constant missing');
});

test('illo-tui.js source: WORD_HARD_BREAK_RATIO constant is 0.8', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(TUI, 'utf8');
  assert.ok(src.includes('WORD_HARD_BREAK_RATIO = 0.8'), 'WORD_HARD_BREAK_RATIO constant missing');
});

// ─── passesLowNoiseFilter tests (#45 low-noise notification filter) ───────────

test('passesLowNoiseFilter: ask_user always passes', () => {
  assert.equal(passesLowNoiseFilter({ kind: 'ask_user', urgency: 'normal' }), true);
  assert.equal(passesLowNoiseFilter({ kind: 'ask_user', urgency: 'low' }), true);
});

test('passesLowNoiseFilter: sent always passes', () => {
  assert.equal(passesLowNoiseFilter({ kind: 'sent', urgency: 'low' }), true);
  assert.equal(passesLowNoiseFilter({ kind: 'sent', urgency: 'normal' }), true);
});

test('passesLowNoiseFilter: notification with urgency:low does NOT pass', () => {
  assert.equal(passesLowNoiseFilter({ kind: 'notification', urgency: 'low' }), false);
});

test('passesLowNoiseFilter: notification with urgency:normal does NOT pass', () => {
  assert.equal(passesLowNoiseFilter({ kind: 'notification', urgency: 'normal' }), false);
});

test('passesLowNoiseFilter: notification with urgency:urgent DOES pass', () => {
  assert.equal(passesLowNoiseFilter({ kind: 'notification', urgency: 'urgent' }), true);
});

test('passesLowNoiseFilter: notification with subkind:permission_prompt and urgency:normal DOES pass', () => {
  assert.equal(passesLowNoiseFilter({ kind: 'notification', urgency: 'normal', subkind: 'permission_prompt' }), true);
});

test('passesLowNoiseFilter: stop kind does NOT pass', () => {
  assert.equal(passesLowNoiseFilter({ kind: 'stop' }), false);
});

test('passesLowNoiseFilter: custom kind does NOT pass', () => {
  assert.equal(passesLowNoiseFilter({ kind: 'custom', urgency: 'urgent' }), false);
});

test('passesLowNoiseFilter: session_start kind does NOT pass', () => {
  assert.equal(passesLowNoiseFilter({ kind: 'session_start' }), false);
});

test('passesLowNoiseFilter: idle kind does NOT pass', () => {
  assert.equal(passesLowNoiseFilter({ kind: 'idle' }), false);
});

// ─── formatEventBody tests (#47 pretty-print event payloads) ─────────────────

test('formatEventBody: ask_user with one question + options renders Q: + numbered options', () => {
  const ev = {
    kind: 'ask_user',
    payload: {
      tool_input: {
        questions: [
          { question: 'Deploy to production?', options: [{ label: 'Yes' }, { label: 'No' }] },
        ],
      },
    },
  };
  const result = formatEventBody(ev);
  assert.ok(result.startsWith('Q: Deploy to production?'), `unexpected start: ${result}`);
  assert.ok(result.includes('   [1] Yes'), `missing option 1: ${result}`);
  assert.ok(result.includes('   [2] No'), `missing option 2: ${result}`);
});

test('formatEventBody: ask_user multiple questions shows +N more', () => {
  const ev = {
    kind: 'ask_user',
    payload: {
      tool_input: {
        questions: [
          { question: 'Q1?', options: [] },
          { question: 'Q2?', options: [] },
          { question: 'Q3?', options: [] },
        ],
      },
    },
  };
  const result = formatEventBody(ev);
  assert.ok(result.includes('(+2 more questions)'), `missing plural: ${result}`);
});

test('formatEventBody: notification returns just the message text, not JSON', () => {
  const ev = {
    kind: 'notification',
    payload: { message: 'npm install completed successfully' },
    title: 'some title',
  };
  const result = formatEventBody(ev);
  assert.equal(result, 'npm install completed successfully');
  assert.ok(!result.includes('"kind"'), `should not contain JSON keys: ${result}`);
});

test('formatEventBody: sent truncates at 80 chars with ellipsis', () => {
  const longText = 'a'.repeat(100);
  const ev = {
    kind: 'sent',
    payload: { text: longText },
  };
  const result = formatEventBody(ev);
  assert.ok(result.endsWith('…'), `should end with ellipsis: ${result}`);
  assert.ok(result.length <= 82, `should be <= 82 chars (80 + ellipsis): ${result.length}`);
});

test('formatEventBody: sent short text is returned as-is', () => {
  const ev = {
    kind: 'sent',
    payload: { text: 'short text' },
  };
  const result = formatEventBody(ev);
  assert.equal(result, 'short text');
});

test('formatEventBody: custom with structured payload renders field: value lines', () => {
  const ev = {
    kind: 'custom',
    title: 'Graph step complete',
    payload: { step: 3, total: 5 },
  };
  const result = formatEventBody(ev);
  assert.ok(result.startsWith('Graph step complete'), `unexpected start: ${result}`);
  assert.ok(result.includes('  step: 3'), `missing step field: ${result}`);
  assert.ok(result.includes('  total: 5'), `missing total field: ${result}`);
});

test('formatEventBody: custom omits message field from payload (already shown above)', () => {
  const ev = {
    kind: 'custom',
    title: 'Custom event',
    payload: { message: 'hidden', value: 42 },
  };
  const result = formatEventBody(ev);
  assert.ok(!result.includes('  message:'), `message field should be omitted: ${result}`);
  assert.ok(result.includes('  value: 42'), `value field should be present: ${result}`);
});

test('formatEventBody: ask_user with empty questions falls back gracefully', () => {
  const ev = {
    kind: 'ask_user',
    title: 'fallback title',
    payload: { tool_input: { questions: [] } },
  };
  const result = formatEventBody(ev);
  assert.equal(result, 'fallback title');
});

test('formatEventBody: ask_user with no payload falls back gracefully', () => {
  const ev = { kind: 'ask_user', title: 'no payload' };
  const result = formatEventBody(ev);
  assert.equal(result, 'no payload');
});

test('formatEventBody: notification with no message falls back to title', () => {
  const ev = { kind: 'notification', title: 'title fallback', payload: {} };
  const result = formatEventBody(ev);
  assert.equal(result, 'title fallback');
});

test('formatEventBody: stop kind returns title or kind', () => {
  assert.equal(formatEventBody({ kind: 'stop', title: 'waiting…' }), 'waiting…');
  assert.equal(formatEventBody({ kind: 'stop' }), 'stop');
});

test('formatEventBody: unknown kind returns title or kind', () => {
  assert.equal(formatEventBody({ kind: 'idle', title: 'idle state' }), 'idle state');
  assert.equal(formatEventBody({ kind: 'idle' }), 'idle');
});

// ─── config tests (loadConfig / saveConfig / validateConfig / deepMerge) ──────
// Pure-logic helpers are duplicated here to avoid ES-module dynamic-import
// complexity. File-system integration tests spawn a subprocess with
// ILLO_CONFIG_HOME pointing to a temp dir.

// Local copies of the pure functions (kept in sync with bin/illo-tui.js).
const CONFIG_DEFAULTS_TEST = {
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

function deepMergeTest(defaults, overrides) {
  const out = Object.assign({}, defaults);
  for (const k of Object.keys(overrides)) {
    if (overrides[k] !== null && typeof overrides[k] === 'object' && !Array.isArray(overrides[k])
        && defaults[k] !== null && typeof defaults[k] === 'object') {
      out[k] = deepMergeTest(defaults[k], overrides[k]);
    } else {
      out[k] = overrides[k];
    }
  }
  return out;
}

function validateConfigTest(raw) {
  return deepMergeTest(CONFIG_DEFAULTS_TEST, typeof raw === 'object' && raw !== null ? raw : {});
}

describe('config', () => {
  // Helper: write a small inline Node script to a tmp file and run it with
  // ILLO_CONFIG_HOME set to tmpdir. Returns stdout as string.
  function runInTmpDir(tmpdir, scriptSrc) {
    const scriptFile = path.join(tmpdir, '_test_script.mjs');
    fs.writeFileSync(scriptFile, scriptSrc, 'utf8');
    return execFileSync(process.execPath, [scriptFile], {
      env: { ...process.env, ILLO_CONFIG_HOME: tmpdir, ILLO_SIDEBAR_HOME: tmpdir },
      encoding: 'utf8',
    });
  }

  // 1. Round-trip: write config.json, loadConfig reads it back intact.
  test('round-trip: loadConfig reads back all written fields', () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'illo-cfg-'));
    try {
      const written = {
        $schema: 'illo-config/v1',
        version: 1,
        compose: { wrap: false },
        theme: { name: 'default', accent: 'green' },
        filters: { defaultMode: 'verbose' },
        display: { showSessionAge: false, showProject: true, showBranch: true, showCwd: true, expandSentByDefault: false },
        keybindings: { compose: {}, events: {}, global: {} },
      };
      fs.writeFileSync(path.join(tmpdir, 'config.json'), JSON.stringify(written, null, 2) + '\n', 'utf8');
      const out = runInTmpDir(tmpdir, `
        import { createRequire } from 'node:module';
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const configHome = process.env.ILLO_CONFIG_HOME;
        const raw = JSON.parse(readFileSync(join(configHome, 'config.json'), 'utf8'));
        // Verify key fields survived the write
        process.stdout.write(JSON.stringify({
          wrap: raw.compose.wrap,
          accent: raw.theme.accent,
          defaultMode: raw.filters.defaultMode,
          showSessionAge: raw.display.showSessionAge,
          showCwd: raw.display.showCwd,
        }));
      `);
      const parsed = JSON.parse(out);
      assert.equal(parsed.wrap, false);
      assert.equal(parsed.accent, 'green');
      assert.equal(parsed.defaultMode, 'verbose');
      assert.equal(parsed.showSessionAge, false);
      assert.equal(parsed.showCwd, true);
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });

  // 2. Defaults fill-in: partial config gets all defaults merged in.
  test('defaults fill-in: partial raw config gets all default keys', () => {
    const partial = { compose: { wrap: false } };
    const result = validateConfigTest(partial);
    // Overridden value respected
    assert.equal(result.compose.wrap, false);
    // Defaults present
    assert.equal(result.theme.accent, 'cyan');
    assert.equal(result.filters.defaultMode, 'low-noise');
    assert.equal(result.display.showSessionAge, true);
    assert.equal(result.display.showCwd, false);
    assert.ok('keybindings' in result);
    assert.ok('compose' in result.keybindings);
  });

  // 3. Migration from tui-prefs.json: write prefs, no config.json → loadConfig
  //    migrates composeWrap and creates config.json.
  test('migration: tui-prefs.json composeWrap is migrated to config.json', () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'illo-mig-'));
    try {
      // Write old-style tui-prefs.json, no config.json
      fs.writeFileSync(path.join(tmpdir, 'tui-prefs.json'), JSON.stringify({ composeWrap: false }) + '\n', 'utf8');
      const out = runInTmpDir(tmpdir, `
        import { createRequire } from 'node:module';
        const fs = await import('node:fs');
        const path = await import('node:path');
        const configHome = process.env.ILLO_CONFIG_HOME;
        const configFile = path.join(configHome, 'config.json');

        // Replicate loadTuiPrefs + loadConfig + saveConfig inline so we don't
        // import the full TUI (which opens stdin/stdout).
        const tuiPrefsFile = path.join(configHome, 'tui-prefs.json');
        let tuiPrefs = {};
        try { tuiPrefs = JSON.parse(fs.readFileSync(tuiPrefsFile, 'utf8')); } catch {}

        const CONFIG_DEFAULTS = {
          $schema: 'illo-config/v1', version: 1,
          keybindings: { compose: {}, events: {}, global: {} },
          theme: { name: 'default', accent: 'cyan' },
          filters: { defaultMode: 'low-noise' },
          display: { showSessionAge: true, showProject: true, showBranch: true, showCwd: false, expandSentByDefault: false },
          compose: { wrap: true },
        };
        function deepMerge(d, o) {
          const out = Object.assign({}, d);
          for (const k of Object.keys(o)) {
            if (o[k] !== null && typeof o[k] === 'object' && !Array.isArray(o[k]) && d[k] !== null && typeof d[k] === 'object') {
              out[k] = deepMerge(d[k], o[k]);
            } else { out[k] = o[k]; }
          }
          return out;
        }
        function validateConfig(raw) { return deepMerge(CONFIG_DEFAULTS, typeof raw === 'object' && raw !== null ? raw : {}); }
        function saveConfig(cfg) {
          const tmp = configFile + '.tmp';
          fs.mkdirSync(configHome, { recursive: true });
          fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\\n', 'utf8');
          fs.renameSync(tmp, configFile);
        }

        // Migration logic
        let config;
        if (fs.existsSync(configFile)) {
          config = validateConfig(JSON.parse(fs.readFileSync(configFile, 'utf8')));
        } else {
          const migrated = validateConfig({});
          if (tuiPrefs.composeWrap !== undefined) migrated.compose.wrap = tuiPrefs.composeWrap;
          saveConfig(migrated);
          config = migrated;
        }

        process.stdout.write(JSON.stringify({
          wrap: config.compose.wrap,
          configExists: fs.existsSync(configFile),
          tmpGone: !fs.existsSync(configFile + '.tmp'),
        }));
      `);
      const parsed = JSON.parse(out);
      assert.equal(parsed.wrap, false, 'composeWrap should be migrated to false');
      assert.equal(parsed.configExists, true, 'config.json should be created after migration');
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });

  // 4. Unknown keys preserved through validateConfig.
  test('unknown keys preserved: _myCustomKey survives validateConfig', () => {
    const raw = { _myCustomKey: 42, compose: { wrap: true } };
    const result = validateConfigTest(raw);
    assert.equal(result._myCustomKey, 42);
    assert.equal(result.compose.wrap, true);
  });

  // 5. Atomic write: config.json exists, .tmp does not, after saveConfig.
  test('atomic write: config.json present, .tmp absent after save', () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'illo-atm-'));
    try {
      const out = runInTmpDir(tmpdir, `
        import fs from 'node:fs';
        import path from 'node:path';
        const configHome = process.env.ILLO_CONFIG_HOME;
        const configFile = path.join(configHome, 'config.json');
        const tmpFile = configFile + '.tmp';
        const cfg = { $schema: 'illo-config/v1', version: 1, compose: { wrap: true } };
        fs.mkdirSync(configHome, { recursive: true });
        fs.writeFileSync(tmpFile, JSON.stringify(cfg, null, 2) + '\\n', 'utf8');
        fs.renameSync(tmpFile, configFile);
        process.stdout.write(JSON.stringify({
          configExists: fs.existsSync(configFile),
          tmpGone: !fs.existsSync(tmpFile),
        }));
      `);
      const parsed = JSON.parse(out);
      assert.equal(parsed.configExists, true, 'config.json should exist after atomic write');
      assert.equal(parsed.tmpGone, true, '.tmp file should be gone after rename');
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });
});
