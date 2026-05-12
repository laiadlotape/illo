// ux.spec.js — Playwright end-to-end tests for the illo-sidebar UI.
//
// Spawns a fresh daemon on an ephemeral port, exercises the UI in Chromium,
// and tears everything down in afterAll.
//
// Run:  cd tests && npx playwright test ux.spec.js
// Needs: npx playwright install chromium

import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Skip when browsers aren't installed and we're not in a CI environment
// that would have set PLAYWRIGHT_BROWSERS_PATH or installed them.
const SKIP_REASON = 'Chromium not installed — run: npx playwright install chromium';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_JS = path.resolve(__dirname, '..', 'daemon', 'server.js');

let daemonProc = null;
let daemonPort = null;
let stateDir = null;

// Helper: wait for /healthz to respond
async function waitForDaemon(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (resp.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Daemon on port ${port} did not come up within ${timeoutMs}ms`);
}

// Helper: POST JSON to the daemon
async function postEvent(port, body) {
  return fetch(`http://127.0.0.1:${port}/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test.beforeAll(async () => {
  stateDir = mkdtempSync(path.join(tmpdir(), 'illo-ux-test-'));
  // Port 0 would require reading the actual assigned port from the port file;
  // instead pick a high random port to avoid collisions.
  daemonPort = 17800 + Math.floor(Math.random() * 200);

  daemonProc = spawn('node', [DAEMON_JS], {
    env: {
      ...process.env,
      ILLO_SIDEBAR_PORT: String(daemonPort),
      ILLO_SIDEBAR_HOME: stateDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  daemonProc.stdout.on('data', () => {});
  daemonProc.stderr.on('data', () => {});

  await waitForDaemon(daemonPort);
});

test.afterAll(async () => {
  if (daemonProc) {
    daemonProc.kill('SIGTERM');
    daemonProc = null;
  }
  if (stateDir && existsSync(stateDir)) {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// Check browser availability once
test.beforeEach(async ({ browserName }, testInfo) => {
  // If we get here, the browser is available (Playwright instantiated it).
  // The skip guard below is belt-and-suspenders for CI without browsers.
  void browserName;
  void testInfo;
});

// ---- tests ----

test('empty state shows "No pending inputs"', async ({ page }) => {
  test.skip(
    !existsSync(path.join(process.env.HOME || '', '.cache', 'ms-playwright')) &&
      process.env.CI !== '1' &&
      !process.env.PLAYWRIGHT_BROWSERS_PATH,
    SKIP_REASON
  );

  await page.goto(`http://127.0.0.1:${daemonPort}/`);
  await expect(page.locator('#empty')).toBeVisible();
  await expect(page.locator('#empty')).toContainText('No pending inputs');
});

test('POST ask_user event shows new .item with correct title', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${daemonPort}/`);

  // Ensure empty state first
  await expect(page.locator('#empty')).toBeVisible();

  // POST the event
  const resp = await page.request.post(`http://127.0.0.1:${daemonPort}/event`, {
    data: {
      kind: 'ask_user',
      session_id: 'ux-test-session',
      tool_input: {
        questions: [
          {
            question: 'Should I deploy now?',
            options: [{ label: 'Yes' }, { label: 'No' }],
          },
        ],
      },
    },
  });
  expect(resp.ok()).toBeTruthy();

  // Item should appear within 2s
  const item = page.locator('.item').first();
  await expect(item).toBeVisible({ timeout: 2000 });

  // Title should contain the question text
  await expect(page.locator('.item-title').first()).toContainText('Should I deploy now?');
});

test('new item has warning style-pulse classes initially (up to 6s flash)', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${daemonPort}/`);

  // Delete all existing items first for a clean state
  const stateResp = await fetch(`http://127.0.0.1:${daemonPort}/state`);
  const stateData = await stateResp.json();
  for (const it of stateData.items) {
    await fetch(`http://127.0.0.1:${daemonPort}/items/${it.id}`, { method: 'DELETE' });
  }

  // POST a fresh ask_user
  await page.request.post(`http://127.0.0.1:${daemonPort}/event`, {
    data: {
      kind: 'ask_user',
      session_id: 'warn-test',
      tool_input: {
        questions: [{ question: 'Flash test?', options: [{ label: 'OK' }] }],
      },
    },
  });

  // The item should exist
  const item = page.locator('.item').first();
  await expect(item).toBeVisible({ timeout: 2000 });

  // Right after add, the flashWarn() fires; item should have warning classes.
  // The animation lasts 6s so we have a window to observe it.
  await expect(item).toHaveClass(/warning/, { timeout: 2000 });
});

test('re-warn: setting warnIntervalSeconds=2 then waiting triggers another warning flash', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${daemonPort}/`);

  // Clear state
  const stateResp = await fetch(`http://127.0.0.1:${daemonPort}/state`);
  const stateData = await stateResp.json();
  for (const it of stateData.items) {
    await fetch(`http://127.0.0.1:${daemonPort}/items/${it.id}`, { method: 'DELETE' });
  }

  // Post item
  const evtResp = await page.request.post(`http://127.0.0.1:${daemonPort}/event`, {
    data: {
      kind: 'ask_user',
      session_id: 're-warn-test',
      tool_input: { questions: [{ question: 'Re-warn test?', options: [] }] },
    },
  });
  expect(evtResp.ok()).toBeTruthy();

  const item = page.locator('.item').first();
  await expect(item).toBeVisible({ timeout: 2000 });

  // Wait for initial warning class to fade (6s animation)
  await expect(item).not.toHaveClass(/warning/, { timeout: 7000 });

  // Backdating lastWarnedAt and setting a 2s re-warn interval will trigger a
  // re-warn within ~3s. We reach into state via /config endpoint.
  await page.request.post(`http://127.0.0.1:${daemonPort}/config`, {
    data: { warnIntervalSeconds: 2 },
  });

  // The daemon checks every 1s and fires when (now - lastWarnedAt) >= 2000ms.
  // lastWarnedAt was set when the item was created (several seconds ago), so
  // the re-warn should fire within ~1 second of changing the interval.
  await expect(item).toHaveClass(/warning/, { timeout: 4000 });
});

test('hover for >2s sets focused:true via /focus', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${daemonPort}/`);

  // Clear and create a fresh item
  const stateResp = await fetch(`http://127.0.0.1:${daemonPort}/state`);
  const stateData = await stateResp.json();
  for (const it of stateData.items) {
    await fetch(`http://127.0.0.1:${daemonPort}/items/${it.id}`, { method: 'DELETE' });
  }

  const evtResp = await page.request.post(`http://127.0.0.1:${daemonPort}/event`, {
    data: {
      kind: 'ask_user',
      session_id: 'hover-test',
      tool_input: { questions: [{ question: 'Hover test?', options: [] }] },
    },
  });
  const evtJson = await evtResp.json();
  const itemId = evtJson.item.id;

  const item = page.locator('.item').first();
  await expect(item).toBeVisible({ timeout: 2000 });

  // Hover the item for >2.2s to trigger the auto-focus timer
  await item.hover();
  await page.waitForTimeout(2300);

  // Poll /state to verify focused:true was set
  let focused = false;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const s = await fetch(`http://127.0.0.1:${daemonPort}/state`).then((r) => r.json());
    const it = s.items.find((i) => i.id === itemId);
    if (it?.focused) {
      focused = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  expect(focused).toBe(true);
});

test('click "resume here" shows hint text and writes pending_resume.json', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${daemonPort}/`);

  // Clear and create a fresh item
  const stateResp = await fetch(`http://127.0.0.1:${daemonPort}/state`);
  const stateData = await stateResp.json();
  for (const it of stateData.items) {
    await fetch(`http://127.0.0.1:${daemonPort}/items/${it.id}`, { method: 'DELETE' });
  }

  await page.request.post(`http://127.0.0.1:${daemonPort}/event`, {
    data: {
      kind: 'ask_user',
      session_id: 'resume-test',
      tool_input: { questions: [{ question: 'Resume click test?', options: [] }] },
    },
  });

  const item = page.locator('.item').first();
  await expect(item).toBeVisible({ timeout: 2000 });

  // Click the "resume here" button
  await item.locator('.btn-resume').click();

  // Hint text appears inside the item node — look in the whole list section since
  // an item:update WS message may cause the node to be recreated
  await expect(page.locator('#list')).toContainText('Resume queued', { timeout: 3000 });

  // After PR #14 the resume file is per-session: pending_resume_<sessionId>.json.
  // The legacy global pending_resume.json is only used when the item has no sessionId.
  expect(existsSync(path.join(stateDir, 'pending_resume_resume-test.json'))).toBe(true);
});

test('click "box" button switches to data-mode="box" and box shows count', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${daemonPort}/`);

  // Ensure there is at least one unresolved/unfocused item for the count to show
  const stateResp = await fetch(`http://127.0.0.1:${daemonPort}/state`);
  const stateData = await stateResp.json();
  for (const it of stateData.items) {
    await fetch(`http://127.0.0.1:${daemonPort}/items/${it.id}`, { method: 'DELETE' });
  }

  await page.request.post(`http://127.0.0.1:${daemonPort}/event`, {
    data: {
      kind: 'ask_user',
      session_id: 'box-test',
      tool_input: { questions: [{ question: 'Box mode test?', options: [] }] },
    },
  });
  await expect(page.locator('.item').first()).toBeVisible({ timeout: 2000 });

  // Click the "box" button in the header
  await page.locator('#btn-mode').click();

  // body should have data-mode="box"
  await expect(page.locator('body')).toHaveAttribute('data-mode', 'box');

  // The floating box should be visible and show the count
  await expect(page.locator('#box')).toBeVisible();
  await expect(page.locator('#box-count')).toContainText(/[1-9]/);
});

test('press "b" key flips mode from box back to full', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${daemonPort}/`);

  // Switch to box mode first
  await page.locator('#btn-mode').click();
  await expect(page.locator('body')).toHaveAttribute('data-mode', 'box');

  // Press 'b' to flip back
  await page.keyboard.press('b');

  await expect(page.locator('body')).toHaveAttribute('data-mode', 'full');
});

test('DELETE item then click "clear" returns to empty state', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${daemonPort}/`);

  // Make sure there are some items
  const stateResp = await fetch(`http://127.0.0.1:${daemonPort}/state`);
  const stateData = await stateResp.json();
  for (const it of stateData.items) {
    await fetch(`http://127.0.0.1:${daemonPort}/items/${it.id}`, { method: 'DELETE' });
  }

  // Post a new item
  const evtResp = await page.request.post(`http://127.0.0.1:${daemonPort}/event`, {
    data: {
      kind: 'ask_user',
      session_id: 'clear-test',
      tool_input: { questions: [{ question: 'Clear test?', options: [] }] },
    },
  });
  const evtJson = await evtResp.json();
  const itemId = evtJson.item.id;

  await expect(page.locator('.item').first()).toBeVisible({ timeout: 2000 });

  // Switch to "all" filter so resolved items remain visible for the resolved class check
  await page.locator('.chip[data-filter="all"]').click();

  // Mark the item resolved via ask_user_answered (so /clear will pick it up)
  await page.request.post(`http://127.0.0.1:${daemonPort}/event`, {
    data: { kind: 'ask_user_answered', session_id: 'clear-test' },
  });

  // Wait for item to appear resolved (it gets opacity 0.4 + resolved class)
  // Use filter to find any item with resolved class — id selector may fail if node recreated
  await expect(page.locator('.item.resolved').first()).toBeVisible({ timeout: 3000 });

  // Click "clear" button in the header
  await page.locator('#btn-clear').click();

  // Resolved items disappear; empty state should return within the 60s display window
  // The UI removes items from state on 'cleared' WS message.
  await expect(page.locator('#empty')).toBeVisible({ timeout: 3000 });
});

// ---- v0.2 UX tests ----

// Helper: clear all items from the daemon state
async function clearAllItems(port) {
  const s = await fetch(`http://127.0.0.1:${port}/state`).then((r) => r.json());
  for (const it of s.items) {
    await fetch(`http://127.0.0.1:${port}/items/${it.id}`, { method: 'DELETE' });
  }
}

test('v0.2 urgency badge — urgent item renders .urgency-badge.urgency-urgent with text "urgent"', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${daemonPort}/`);
  await clearAllItems(daemonPort);

  const evtResp = await page.request.post(`http://127.0.0.1:${daemonPort}/event`, {
    data: {
      kind: 'notification',
      message: 'Urgent alert for badge test',
      urgency: 'urgent',
    },
  });
  expect(evtResp.ok()).toBeTruthy();

  const item = page.locator('.item').first();
  await expect(item).toBeVisible({ timeout: 2000 });

  // The urgency badge should have both classes and text "urgent"
  const badge = item.locator('.urgency-badge.urgency-urgent');
  await expect(badge).toBeVisible({ timeout: 2000 });
  await expect(badge).toContainText('urgent');
});

test('v0.2 agent identity — langgraph item shows .agent-line with "langgraph"', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${daemonPort}/`);
  await clearAllItems(daemonPort);

  const evtResp = await page.request.post(`http://127.0.0.1:${daemonPort}/event`, {
    data: {
      kind: 'custom',
      agent_id: 'langgraph:graph-7',
      agent_kind: 'langgraph',
      title: 'LangGraph agent identity test',
      snippet: 'Testing agent-line render',
    },
  });
  expect(evtResp.ok()).toBeTruthy();

  // Anchor on the title text so the locator is immune to ordering races
  const item = page.locator('.item:has(.item-title:has-text("LangGraph agent identity test"))');
  await expect(item).toBeVisible({ timeout: 2000 });

  const agentLine = item.locator('.agent-line');
  await expect(agentLine).toBeVisible({ timeout: 2000 });
  await expect(agentLine).toContainText('langgraph');
});

test('v0.2 transcript snapshot — expander visible; expand to show <pre> content', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${daemonPort}/`);
  await clearAllItems(daemonPort);

  const transcript = 'line1\nline2\nline3';
  const evtResp = await page.request.post(`http://127.0.0.1:${daemonPort}/event`, {
    data: {
      kind: 'notification',
      message: 'Transcript snapshot test',
      transcript_snapshot: transcript,
    },
  });
  expect(evtResp.ok()).toBeTruthy();

  const item = page.locator('.item').first();
  await expect(item).toBeVisible({ timeout: 2000 });

  // The transcript expander should be visible
  const expander = item.locator('.transcript-expander');
  await expect(expander).toBeVisible({ timeout: 2000 });

  // Click the summary to expand
  await expander.locator('summary').click();

  // The <pre> inside should contain the transcript text
  const pre = expander.locator('.transcript-pre');
  await expect(pre).toContainText('line1', { timeout: 2000 });
  await expect(pre).toContainText('line2');
  await expect(pre).toContainText('line3');
});

test('v0.2 snooze — click snooze 15m; badge shows [snoozed; item opacity < 0.6; daemon snoozedUntil in future', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${daemonPort}/`);
  await clearAllItems(daemonPort);

  // Switch to "all" filter so snoozed items remain visible
  await page.locator('.chip[data-filter="all"]').click();

  const evtResp = await page.request.post(`http://127.0.0.1:${daemonPort}/event`, {
    data: {
      kind: 'ask_user',
      session_id: 'snooze-ux-test',
      tool_input: { questions: [{ question: 'Snooze UX test?', options: [{ label: 'OK' }] }] },
    },
  });
  expect(evtResp.ok()).toBeTruthy();
  const evtJson = await evtResp.json();
  const itemId = evtJson.item.id;

  // Use first() to handle potential DOM duplicates from item:update cycle
  const item = page.locator(`.item[data-id="${itemId}"]`).first();
  await expect(item).toBeVisible({ timeout: 2000 });

  // Open the snooze dropdown
  const snoozeBtn = item.locator('.btn-snooze');
  await snoozeBtn.click();

  // Click 15m
  const snooze15m = item.locator('.snooze-menu button[data-snooze="900"]');
  await expect(snooze15m).toBeVisible({ timeout: 2000 });
  await snooze15m.click();

  // The snooze badge should appear with [snoozed (filter for the one with text)
  const snoozeBadge = page.locator('.snooze-badge').filter({ hasText: /\[snoozed/ }).first();
  await expect(snoozeBadge).toBeVisible({ timeout: 3000 });
  const badgeText = await snoozeBadge.textContent();
  expect(badgeText).toMatch(/\[snoozed/);

  // Poll /state to assert snoozedUntil is in the future (the reliable server-side check)
  const now = Date.now();
  const stateData = await fetch(`http://127.0.0.1:${daemonPort}/state`).then((r) => r.json());
  const it = stateData.items.find((i) => i.id === itemId);
  expect(it).toBeTruthy();
  expect(it.snoozedUntil).toBeGreaterThan(now);

  // Check opacity via the snoozed item in the DOM — look for any item with .snoozed class
  const snoozedItem = page.locator('.item.snoozed').first();
  await expect(snoozedItem).toBeVisible({ timeout: 3000 });
  const opacity = await snoozedItem.evaluate((el) => parseFloat(getComputedStyle(el).opacity));
  expect(opacity).toBeLessThan(0.6);
});

test('v0.2 quick reply — type and Cmd+Enter sends reply; daemon replied=true; UI shows [replied]', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${daemonPort}/`);
  await clearAllItems(daemonPort);

  // Switch to "all" filter so resolved items stay visible briefly
  await page.locator('.chip[data-filter="all"]').click();

  const evtResp = await page.request.post(`http://127.0.0.1:${daemonPort}/event`, {
    data: {
      kind: 'ask_user',
      session_id: 'reply-ux-test',
      quick_reply_enabled: true,
      tool_input: { questions: [{ question: 'Quick reply UX test?', options: [] }] },
    },
  });
  expect(evtResp.ok()).toBeTruthy();
  const evtJson = await evtResp.json();
  const itemId = evtJson.item.id;

  // Use first() in case of DOM duplicates from item:update cycle
  const item = page.locator(`.item[data-id="${itemId}"]`).first();
  await expect(item).toBeVisible({ timeout: 2000 });

  // Type into the textarea
  const textarea = item.locator('.reply-textarea');
  await textarea.fill('yes please');

  // Press Cmd+Enter to submit
  await textarea.press('Meta+Enter');

  // Poll /state to assert replied:true
  let replied = false;
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const s = await fetch(`http://127.0.0.1:${daemonPort}/state`).then((r) => r.json());
    const it = s.items.find((i) => i.id === itemId);
    if (it?.replied) {
      replied = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  expect(replied).toBe(true);

  // After PR #14 the .replied-pill renders the queued-delivery hint instead of `[replied]`.
  // It now reads e.g. "queued · type in session reply-ux to deliver yes please".
  await expect(page.locator('.replied-pill').first()).toBeVisible({ timeout: 3000 });
  await expect(page.locator('.replied-pill').first()).toContainText('queued · type in session');
});

test('v0.2 filter chips — urgency filter shows only urgent item', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${daemonPort}/`);
  await clearAllItems(daemonPort);

  // Switch to "all" filter so all items are visible
  await page.locator('.chip[data-filter="all"]').click();

  // POST urgent item
  const urgentResp = await page.request.post(`http://127.0.0.1:${daemonPort}/event`, {
    data: {
      kind: 'notification',
      message: 'URGENT filter chip test',
      urgency: 'urgent',
    },
  });
  const urgentJson = await urgentResp.json();
  const urgentId = urgentJson.item.id;

  // POST low item
  const lowResp = await page.request.post(`http://127.0.0.1:${daemonPort}/event`, {
    data: {
      kind: 'notification',
      message: 'LOW filter chip test',
      urgency: 'low',
    },
  });
  const lowJson = await lowResp.json();
  const lowId = lowJson.item.id;

  // Both should be visible initially
  await expect(page.locator(`.item[data-id="${urgentId}"]`)).toBeVisible({ timeout: 2000 });
  await expect(page.locator(`.item[data-id="${lowId}"]`)).toBeVisible({ timeout: 2000 });

  // Click "by urgency ▾" to open the dropdown
  await page.locator('#chip-urgency').click();

  // Select "urgent"
  await page.locator('#urgency-menu button[data-urgency="urgent"]').click();

  // Only the urgent item should be in the list; low item should not be visible
  await expect(page.locator(`.item[data-id="${urgentId}"]`)).toBeVisible({ timeout: 2000 });
  await expect(page.locator(`.item[data-id="${lowId}"]`)).not.toBeVisible({ timeout: 2000 });

  // Reset by clicking "by urgency ▾" → "any"
  await page.locator('#chip-urgency').click();
  await page.locator('#urgency-menu button[data-urgency=""]').click();

  // Both items should now be visible again
  await expect(page.locator(`.item[data-id="${urgentId}"]`)).toBeVisible({ timeout: 2000 });
  await expect(page.locator(`.item[data-id="${lowId}"]`)).toBeVisible({ timeout: 2000 });
});

test('v0.2 stats page — summary cards and by_kind bar exist after items pushed', async ({ page }) => {
  // Push a few items so /stats has data
  await fetch(`http://127.0.0.1:${daemonPort}/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'notification', message: 'Stats test item 1' }),
  });
  await fetch(`http://127.0.0.1:${daemonPort}/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'ask_user', tool_input: { questions: [{ question: 'Stats test?' }] } }),
  });

  await page.goto(`http://127.0.0.1:${daemonPort}/stats.html`);

  // Summary cards should be rendered
  await expect(page.locator('.stat-card').first()).toBeVisible({ timeout: 5000 });

  // Should have multiple stat cards (total items, median resolve, p95, dismissal rate, window)
  const cardCount = await page.locator('.stat-card').count();
  expect(cardCount).toBeGreaterThanOrEqual(4);

  // The by_kind bar chart section should appear
  await expect(page.locator('.stats-section').first()).toBeVisible();

  // At least one bar-row should exist (from the items we pushed)
  const barCount = await page.locator('.bar-row').count();
  expect(barCount).toBeGreaterThanOrEqual(1);
});

test('v0.2 browser notifications — stub Notification; urgent item triggers stub call', async ({ page }) => {
  // Install a Notification stub before the page script runs
  await page.addInitScript(() => {
    window.__notificationCalls = [];
    class FakeNotification {
      constructor(title, opts) {
        window.__notificationCalls.push({ title, opts });
        this._title = title;
      }
      addEventListener() {}
      static get permission() { return 'granted'; }
      static requestPermission() { return Promise.resolve('granted'); }
    }
    // Override the global Notification
    Object.defineProperty(window, 'Notification', {
      value: FakeNotification,
      writable: true,
      configurable: true,
    });
  });

  await page.goto(`http://127.0.0.1:${daemonPort}/`);
  await clearAllItems(daemonPort);

  // Make sure notification toggle is "on"
  const notifyBtn = page.locator('#btn-notify');
  const btnText = await notifyBtn.textContent();
  if (btnText.includes('off')) {
    await notifyBtn.click(); // flip to on
  }

  // Push an urgent item — this should trigger maybeNotify() in app.js
  const evtResp = await page.request.post(`http://127.0.0.1:${daemonPort}/event`, {
    data: {
      kind: 'notification',
      message: 'Notification stub test — urgent',
      urgency: 'urgent',
    },
  });
  expect(evtResp.ok()).toBeTruthy();

  // Wait for the item to appear (confirms WS message was processed)
  await expect(page.locator('.item').first()).toBeVisible({ timeout: 2000 });

  // Poll for the notification stub to have been called
  let called = false;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const calls = await page.evaluate(() => window.__notificationCalls);
    if (calls && calls.length > 0) {
      called = true;
      // Verify the title matches the item title
      expect(calls[0].title).toContain('Notification stub test');
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  expect(called).toBe(true);
});
