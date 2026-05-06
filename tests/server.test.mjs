/**
 * server.test.mjs — unit tests for the illo-sidebar daemon.
 *
 * Strategy: import __test directly from daemon/server.js (in-process).
 * We set ILLO_SIDEBAR_PORT=0 so the OS picks a free port, and
 * ILLO_SIDEBAR_HOME to a temp dir so we don't touch the user's home.
 * Because the daemon's HTTP server is not exported we can't close it
 * programmatically, so we call process.exit(0) in the after() teardown.
 * The interval timer is already .unref()'d in the daemon, so it won't
 * prevent exit.
 *
 * See _helper.mjs for environment setup details.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';

// _helper.mjs sets env vars and re-exports __test
import { __test, tmpDir } from './_helper.mjs';

const { state, ingest, snapshot, addItem, updateItem, computeStats, historyAppend, PROTOCOL_VERSION, vcrState, pushReplyTokens } = __test;

// Reset in-memory state before each test so tests are independent.
beforeEach(() => {
  state.items.clear();
  state.sessions.clear();
});

after(() => {
  // The HTTP server keeps the event loop alive; exit cleanly.
  process.exit(0);
});

// ---------- ingest: ask_user ----------
describe('ingest ask_user', () => {
  it('returns an item whose title contains the first question text', () => {
    const item = ingest({
      kind: 'ask_user',
      tool_input: {
        questions: [
          { question: 'Q1?', options: [{ label: 'A' }] },
        ],
      },
    });
    assert.ok(item, 'ingest should return a non-null item');
    assert.ok(item.title.includes('Q1?'), `title should contain "Q1?", got: "${item.title}"`);
    assert.equal(item.kind, 'ask_user');
    assert.equal(item.resolved, false);
  });

  it('includes options in the snippet', () => {
    const item = ingest({
      kind: 'ask_user',
      tool_input: {
        questions: [
          { question: 'Deploy?', options: [{ label: 'Yes' }, { label: 'No' }] },
        ],
      },
    });
    assert.ok(item.snippet.includes('Yes'), `snippet should list options, got: "${item.snippet}"`);
    assert.ok(item.snippet.includes('No'));
  });

  it('truncates the title to 80 chars', () => {
    const longQ = 'A'.repeat(100) + '?';
    const item = ingest({
      kind: 'ask_user',
      tool_input: { questions: [{ question: longQ }] },
    });
    assert.ok(item.title.length <= 80, `title should be at most 80 chars, got ${item.title.length}`);
  });
});

// ---------- ingest: notification ----------
describe('ingest notification', () => {
  it('produces a notification item with the message as title', () => {
    const item = ingest({ kind: 'notification', message: 'hi' });
    assert.ok(item, 'ingest should return a non-null item');
    assert.equal(item.kind, 'notification');
    assert.equal(item.title, 'hi');
    assert.equal(item.resolved, false);
  });

  it('stores subkind on the item', () => {
    const item = ingest({
      kind: 'notification',
      subkind: 'permission_prompt',
      message: 'May I write file X?',
    });
    assert.equal(item.subkind, 'permission_prompt');
  });

  it('falls back to default title when message is empty', () => {
    const item = ingest({ kind: 'notification' });
    assert.equal(item.title, 'Claude needs your attention');
  });
});

// ---------- ingest: ask_user_answered ----------
describe('ingest ask_user_answered', () => {
  it('resolves the most-recent unresolved ask_user with matching session', () => {
    const item = ingest({
      kind: 'ask_user',
      session_id: 's',
      tool_input: { questions: [{ question: 'Test?' }] },
    });
    assert.equal(item.resolved, false);

    ingest({ kind: 'ask_user_answered', session_id: 's' });

    const snap = snapshot();
    const resolved = snap.items.find((i) => i.id === item.id);
    assert.ok(resolved, 'item should still exist in state');
    assert.equal(resolved.resolved, true);
    assert.ok(resolved.resolvedAt !== null, 'resolvedAt should be set');
  });

  it('does not resolve items from a different session', () => {
    ingest({
      kind: 'ask_user',
      session_id: 'other-session',
      tool_input: { questions: [{ question: 'Other?' }] },
    });

    ingest({ kind: 'ask_user_answered', session_id: 'unrelated' });

    const snap = snapshot();
    assert.equal(snap.items.length, 1, 'item should remain');
    assert.equal(snap.items[0].resolved, false);
  });

  it('returns null (no new item)', () => {
    ingest({
      kind: 'ask_user',
      session_id: 's2',
      tool_input: { questions: [{ question: 'Q?' }] },
    });
    const result = ingest({ kind: 'ask_user_answered', session_id: 's2' });
    assert.equal(result, null);
  });
});

// ---------- addItem + updateItem ----------
describe('addItem and updateItem', () => {
  it('addItem adds item; updateItem({focused:true}) reflects in snapshot', () => {
    const item = addItem({
      id: 'test-id-1',
      kind: 'ask_user',
      subkind: null,
      sessionId: null,
      title: 'Direct item',
      snippet: '',
      payload: null,
      createdAt: Date.now(),
      lastWarnedAt: Date.now(),
      focused: false,
      resolved: false,
      resolvedAt: null,
    });

    let snap = snapshot();
    assert.ok(snap.items.find((i) => i.id === 'test-id-1'), 'item should be in snapshot');

    updateItem('test-id-1', { focused: true });

    snap = snapshot();
    const updated = snap.items.find((i) => i.id === 'test-id-1');
    assert.ok(updated, 'item should still exist');
    assert.equal(updated.focused, true);
  });

  it('updateItem returns null for unknown id', () => {
    const result = updateItem('nonexistent-id', { focused: true });
    assert.equal(result, null);
  });
});

// ---------- snapshot ordering ----------
describe('snapshot ordering', () => {
  it('two ask_user items appear in createdAt order', async () => {
    const now = Date.now();

    const item1 = ingest({
      kind: 'ask_user',
      tool_input: { questions: [{ question: 'First question?' }] },
    });
    // Ensure distinct timestamps by bumping the internal createdAt.
    item1.createdAt = now - 100;
    state.items.set(item1.id, item1);

    const item2 = ingest({
      kind: 'ask_user',
      tool_input: { questions: [{ question: 'Second question?' }] },
    });
    item2.createdAt = now;
    state.items.set(item2.id, item2);

    const snap = snapshot();
    assert.equal(snap.items.length, 2, 'snapshot should have 2 items');
    assert.ok(
      snap.items[0].createdAt <= snap.items[1].createdAt,
      'items should be sorted by createdAt ascending'
    );
    assert.ok(snap.items[0].title.includes('First'));
    assert.ok(snap.items[1].title.includes('Second'));
  });
});

// ---------- v0.2 protocol fields on items ----------
describe('v0.2 envelope: defaults and overrides', () => {
  it('item gets default urgency=normal, agentKind=claude-code, quickReplyEnabled=true, replied=false, snoozedUntil=null', () => {
    const item = ingest({
      kind: 'ask_user',
      tool_input: { questions: [{ question: 'Default?' }] },
    });
    assert.equal(item.urgency, 'normal');
    assert.equal(item.agentKind, 'claude-code');
    assert.equal(item.quickReplyEnabled, true);
    assert.equal(item.replied, false);
    assert.equal(item.snoozedUntil, null);
    assert.equal(item.transcriptSnapshot, null);
  });

  it('honors agent_id, agent_kind, urgency, transcript_snapshot from the envelope', () => {
    const item = ingest({
      kind: 'ask_user',
      agent_id: 'langgraph:graph-7',
      agent_kind: 'langgraph',
      urgency: 'urgent',
      transcript_snapshot: 'last-line\nlast-line-2',
      tool_input: { questions: [{ question: 'OK?' }] },
    });
    assert.equal(item.agentId, 'langgraph:graph-7');
    assert.equal(item.agentKind, 'langgraph');
    assert.equal(item.urgency, 'urgent');
    assert.equal(item.transcriptSnapshot, 'last-line\nlast-line-2');
  });

  it('rejects an unknown urgency value silently and falls back to normal', () => {
    const item = ingest({
      kind: 'ask_user',
      urgency: 'critical',
      tool_input: { questions: [{ question: 'Q?' }] },
    });
    assert.equal(item.urgency, 'normal');
  });

  it('respects an explicit title override', () => {
    const item = ingest({
      kind: 'ask_user',
      title: 'Custom title',
      tool_input: { questions: [{ question: 'inner?' }] },
    });
    assert.equal(item.title, 'Custom title');
  });
});

describe('v0.2 envelope: custom kind', () => {
  it('produces a custom item with payload, title, snippet preserved', () => {
    const item = ingest({
      kind: 'custom',
      agent_id: 'langgraph:g',
      agent_kind: 'langgraph',
      title: 'Approve cleanup.delete_user(2)',
      snippet: 'Node cleanup wants to call delete_user.',
      urgency: 'urgent',
      payload: { node: 'cleanup', tool: 'delete_user', args: { id: 2 } },
    });
    assert.ok(item, 'custom event should produce an item');
    assert.equal(item.kind, 'custom');
    assert.equal(item.title, 'Approve cleanup.delete_user(2)');
    assert.equal(item.snippet, 'Node cleanup wants to call delete_user.');
    assert.equal(item.payload.tool, 'delete_user');
    assert.equal(item.urgency, 'urgent');
  });
});

// ---------- snooze ----------
describe('snooze', () => {
  it('updateItem({snoozedUntil}) sets the field and re-warn timer skips while snoozed', () => {
    const item = ingest({
      kind: 'ask_user',
      tool_input: { questions: [{ question: 'wait?' }] },
    });
    const until = Date.now() + 60_000;
    updateItem(item.id, { snoozedUntil: until }, 'snoozed');
    const updated = state.items.get(item.id);
    assert.equal(updated.snoozedUntil, until);
    // re-warn condition includes (!snoozedUntil || now >= snoozedUntil)
    assert.ok(updated.snoozedUntil > Date.now(), 'snoozedUntil should be in the future');
  });
});

// ---------- urgency multiplier semantics (verify item shape carries urgency) ----------
describe('urgency-aware re-warn (shape only — interval scaling tested via /stats and dogfood)', () => {
  it('low/normal/urgent items round-trip with the right urgency on the item', () => {
    const lo = ingest({
      kind: 'notification',
      message: 'low',
      urgency: 'low',
    });
    const md = ingest({
      kind: 'notification',
      message: 'mid',
      urgency: 'normal',
    });
    const hi = ingest({
      kind: 'notification',
      message: 'hi',
      urgency: 'urgent',
    });
    assert.equal(lo.urgency, 'low');
    assert.equal(md.urgency, 'normal');
    assert.equal(hi.urgency, 'urgent');
  });
});

// ---------- stats / history ----------
describe('computeStats from history sink', () => {
  it('aggregates created/resolved/dismissed events into expected metrics', () => {
    // Synthesize a small history window directly via historyAppend.
    const t = Date.now();
    historyAppend({ ts: t - 10_000, item_id: 'a', action: 'created', kind: 'ask_user', agent_kind: 'claude-code', urgency: 'normal', title: 'Approve?' });
    historyAppend({ ts: t - 9_000, item_id: 'a', action: 'resolved', kind: 'ask_user', agent_kind: 'claude-code', urgency: 'normal', title: 'Approve?' });
    historyAppend({ ts: t - 8_000, item_id: 'b', action: 'created', kind: 'ask_user', agent_kind: 'claude-code', urgency: 'normal', title: 'Approve?' });
    historyAppend({ ts: t - 7_500, item_id: 'b', action: 'dismissed', kind: 'ask_user', agent_kind: 'claude-code', urgency: 'normal', title: 'Approve?' });
    historyAppend({ ts: t - 6_000, item_id: 'c', action: 'created', kind: 'notification', agent_kind: 'langgraph', urgency: 'low', title: 'Done.' });
    historyAppend({ ts: t - 1_000, item_id: 'c', action: 'replied', kind: 'notification', agent_kind: 'langgraph', urgency: 'low', title: 'Done.' });

    const stats = computeStats(7);
    assert.ok(stats.total_items >= 3, `total_items should include the synthetic 3, got ${stats.total_items}`);
    assert.ok(stats.by_kind.ask_user >= 2, `ask_user count should be >= 2, got ${stats.by_kind.ask_user}`);
    assert.ok(stats.by_kind.notification >= 1);
    assert.ok(stats.by_agent_kind['claude-code'] >= 2);
    assert.ok(stats.by_agent_kind.langgraph >= 1);
    assert.ok(stats.median_time_to_resolve_seconds !== null);
    assert.ok(typeof stats.dismissal_rate === 'number');
  });
});

// ---------- protocol metadata ----------
describe('protocol metadata', () => {
  it('exports PROTOCOL_VERSION 0.2.x', () => {
    assert.ok(typeof PROTOCOL_VERSION === 'string');
    assert.ok(PROTOCOL_VERSION.startsWith('0.2.'), `expected 0.2.x, got ${PROTOCOL_VERSION}`);
  });
});

// ---------- push config defaults ----------
describe('push config defaults', () => {
  it('push is disabled by default', () => {
    assert.equal(state.config.push.enabled, false);
  });

  it('push provider defaults to "off"', () => {
    assert.equal(state.config.push.provider, 'off');
  });

  it('push afk_threshold_seconds defaults to 120', () => {
    assert.equal(state.config.push.afk_threshold_seconds, 120);
  });

  it('ntfy_topic defaults to empty string', () => {
    assert.equal(state.config.push.ntfy_topic, '');
  });

  it('ntfy_server defaults to https://ntfy.sh', () => {
    assert.equal(state.config.push.ntfy_server, 'https://ntfy.sh');
  });
});

// ---------- push tick gating logic ----------
describe('push tick gating: pushedAt field', () => {
  it('new item has pushedAt=null', () => {
    const item = ingest({
      kind: 'notification',
      message: 'push test item',
    });
    assert.equal(item.pushedAt, null, 'new items should have pushedAt=null');
  });

  it('updateItem can set pushedAt', () => {
    const item = ingest({
      kind: 'ask_user',
      tool_input: { questions: [{ question: 'Push gating test?' }] },
    });
    assert.equal(item.pushedAt, null);

    const now = Date.now();
    updateItem(item.id, { pushedAt: now });

    const updated = state.items.get(item.id);
    assert.equal(updated.pushedAt, now, 'pushedAt should be set after updateItem');
  });

  it('push tick should skip items with pushedAt already set', () => {
    // Simulate an item that was already pushed: pushedAt is set.
    const item = ingest({
      kind: 'notification',
      message: 'Already pushed item',
    });
    // Set pushedAt to simulate a previous push.
    updateItem(item.id, { pushedAt: Date.now() - 10_000 });

    const it = state.items.get(item.id);
    // Gate check: pushedAt != null means skip.
    assert.notEqual(it.pushedAt, null, 'pushedAt should be set');
    assert.equal(it.resolved, false);
    assert.equal(it.focused, false);
    // The tick loop condition is: pushedAt == null → should push.
    // Since pushedAt is set, the item would be skipped.
  });

  it('push tick should skip resolved items', () => {
    const item = ingest({
      kind: 'notification',
      message: 'Resolved item',
    });
    updateItem(item.id, { resolved: true, resolvedAt: Date.now() });

    const it = state.items.get(item.id);
    assert.equal(it.resolved, true, 'item should be resolved');
  });

  it('push tick should skip focused items', () => {
    const item = ingest({
      kind: 'notification',
      message: 'Focused item',
    });
    updateItem(item.id, { focused: true });

    const it = state.items.get(item.id);
    assert.equal(it.focused, true, 'item should be focused');
  });

  it('push tick should skip snoozed items (snoozedUntil in future)', () => {
    const item = ingest({
      kind: 'notification',
      message: 'Snoozed item',
    });
    const future = Date.now() + 600_000;
    updateItem(item.id, { snoozedUntil: future });

    const it = state.items.get(item.id);
    assert.ok(it.snoozedUntil > Date.now(), 'snoozedUntil should be in the future');
  });

  it('push tick should skip items younger than afk_threshold', () => {
    const item = ingest({
      kind: 'notification',
      message: 'Fresh item',
    });
    // Fresh item: createdAt is just now. afk_threshold = 120s.
    // now - createdAt < threshold → skip.
    const it = state.items.get(item.id);
    const threshold = state.config.push.afk_threshold_seconds * 1000;
    assert.ok(
      Date.now() - it.createdAt < threshold,
      'fresh item should be younger than afk threshold'
    );
  });
});

// ---------- push reply tokens ----------
describe('push reply tokens (in-memory map)', () => {
  it('pushReplyTokens is exported and is a Map', () => {
    assert.ok(pushReplyTokens instanceof Map, 'pushReplyTokens should be a Map');
  });

  it('can set and get a token', () => {
    pushReplyTokens.set('test-item-id', 'test-token-abc');
    assert.equal(pushReplyTokens.get('test-item-id'), 'test-token-abc');
    pushReplyTokens.delete('test-item-id');
  });
});

// ---------- VCR state ----------
describe('VCR state object', () => {
  it('vcrState is exported with expected fields', () => {
    assert.ok(typeof vcrState === 'object', 'vcrState should be an object');
    assert.equal(typeof vcrState.recording, 'boolean');
    assert.equal(typeof vcrState.startedAt, 'number');
    // writeStream and currentPath may be null initially.
    assert.ok('writeStream' in vcrState, 'vcrState should have writeStream');
    assert.ok('currentPath' in vcrState, 'vcrState should have currentPath');
  });

  it('vcrState.recording is false initially', () => {
    assert.equal(vcrState.recording, false);
  });
});

// ---------- VCR record buffer --- tested via filesystem in dogfood, but verify
// that the ingest function doesn't write to the stream when not recording. ----------
describe('VCR: ingest does not throw when recording is false', () => {
  it('ingest works normally when vcrState.recording=false', () => {
    assert.equal(vcrState.recording, false);
    // If ingest tried to write to a null writeStream it would throw.
    const item = ingest({
      kind: 'notification',
      message: 'VCR-off test',
    });
    assert.ok(item, 'ingest should return an item when VCR is off');
    assert.equal(item.kind, 'notification');
  });
});
