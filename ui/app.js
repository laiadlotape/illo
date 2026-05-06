// illo-sidebar UI client — v0.2
//
// Plain DOM. No build step. Connects to the local daemon over WebSocket
// for live updates and uses fetch() for actions.

(() => {
  const $list = document.getElementById('list');
  const $empty = document.getElementById('empty');
  const $box = document.getElementById('box');
  const $boxCount = document.getElementById('box-count');
  const $tpl = document.getElementById('item-tpl');
  const $dot = document.getElementById('conn-dot');
  const $btnMode = document.getElementById('btn-mode');
  const $btnClear = document.getElementById('btn-clear');
  const $btnConfig = document.getElementById('btn-config');
  const $btnNotify = document.getElementById('btn-notify');
  const $settings = document.getElementById('settings');
  const $cfgWarn = document.getElementById('cfg-warn');
  const $cfgStyle = document.getElementById('cfg-style');
  const $cfgSave = document.getElementById('cfg-save');

  let state = { config: { warnIntervalSeconds: 300, warnStyle: 'pulse' }, items: [] };
  // Track per-item DOM nodes so we can patch in place.
  const nodes = new Map();
  // Hover-to-acknowledge timer per item — counts as "focused" after 2s.
  const hoverTimers = new Map();

  // ---------- notification permission ----------
  let notifyEnabled = localStorage.getItem('illo.notifyEnabled') !== 'false';
  let notifyPermissionRequested = false;

  function updateNotifyBtn() {
    $btnNotify.textContent = 'notif: ' + (notifyEnabled ? 'on' : 'off');
  }
  updateNotifyBtn();

  $btnNotify.addEventListener('click', () => {
    notifyEnabled = !notifyEnabled;
    localStorage.setItem('illo.notifyEnabled', String(notifyEnabled));
    updateNotifyBtn();
  });

  async function maybeNotify(item) {
    if (!notifyEnabled) return;
    if (typeof Notification === 'undefined') return;
    const pageHidden = document.hidden;
    const shouldNotify = item.urgency === 'urgent' || (item.urgency === 'normal' && pageHidden);
    if (!shouldNotify) return;
    if (!notifyPermissionRequested) {
      notifyPermissionRequested = true;
      try { await Notification.requestPermission(); } catch (_) { return; }
    }
    if (Notification.permission !== 'granted') return;
    try {
      const n = new Notification(item.title || 'illo', {
        body: item.snippet || '',
        tag: item.id,
        requireInteraction: item.urgency === 'urgent',
      });
      n.addEventListener('click', () => {
        window.focus();
        const node = nodes.get(item.id);
        if (node) node.scrollIntoView({ behavior: 'smooth', block: 'center' });
        doFocus(item.id, true);
      });
    } catch (_) {}
  }

  // ---------- mode (full vs box) ----------
  function setMode(mode) {
    document.body.dataset.mode = mode;
    $btnMode.textContent = mode === 'full' ? 'box' : 'list';
    localStorage.setItem('illo.mode', mode);
  }
  setMode(localStorage.getItem('illo.mode') || 'full');
  $btnMode.addEventListener('click', () => {
    const next = document.body.dataset.mode === 'full' ? 'box' : 'full';
    setMode(next);
  });
  $box.addEventListener('click', () => setMode('full'));

  // Keyboard shortcut: 'b' toggles modes when the sidebar window is focused.
  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if (e.key === 'b') {
      setMode(document.body.dataset.mode === 'full' ? 'box' : 'full');
    }
  });

  // ---------- settings panel ----------
  $btnConfig.addEventListener('click', () => $settings.classList.toggle('hidden'));
  $cfgSave.addEventListener('click', async () => {
    const body = {
      warnIntervalSeconds: Number($cfgWarn.value || 0),
      warnStyle: $cfgStyle.value,
    };
    await fetch('/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    $settings.classList.add('hidden');
  });

  $btnClear.addEventListener('click', async () => {
    await fetch('/clear', { method: 'POST' });
  });

  // ---------- filter chips ----------
  let filterMode = localStorage.getItem('illo.filter') || 'pending'; // 'all' | 'pending' | 'snoozed'
  let filterUrgency = ''; // '' = any
  let filterKind = '';    // '' = any
  let filterAgent = '';   // '' = any

  function setFilterMode(mode) {
    filterMode = mode;
    localStorage.setItem('illo.filter', mode);
    document.querySelectorAll('.chip[data-filter]').forEach((c) => {
      c.classList.toggle('active', c.dataset.filter === mode);
    });
    render();
  }

  document.querySelectorAll('.chip[data-filter]').forEach((c) => {
    c.classList.toggle('active', c.dataset.filter === filterMode);
    c.addEventListener('click', () => setFilterMode(c.dataset.filter));
  });

  // Urgency dropdown
  const $filterUrgency = document.getElementById('filter-urgency');
  const $chipUrgency = document.getElementById('chip-urgency');
  document.getElementById('urgency-menu').querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      filterUrgency = btn.dataset.urgency;
      $chipUrgency.textContent = filterUrgency ? 'urgency: ' + filterUrgency + ' ▾' : 'by urgency ▾';
      $chipUrgency.classList.toggle('active', !!filterUrgency);
      $filterUrgency.classList.remove('open');
      render();
    });
  });
  $chipUrgency.addEventListener('click', (e) => {
    e.stopPropagation();
    $filterUrgency.classList.toggle('open');
    document.getElementById('filter-kind').classList.remove('open');
    document.getElementById('filter-agent').classList.remove('open');
  });

  // Kind dropdown
  const $filterKind = document.getElementById('filter-kind');
  const $chipKind = document.getElementById('chip-kind');
  document.getElementById('kind-menu').querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      filterKind = btn.dataset.kind;
      $chipKind.textContent = filterKind ? 'kind: ' + filterKind + ' ▾' : 'by kind ▾';
      $chipKind.classList.toggle('active', !!filterKind);
      $filterKind.classList.remove('open');
      render();
    });
  });
  $chipKind.addEventListener('click', (e) => {
    e.stopPropagation();
    $filterKind.classList.toggle('open');
    $filterUrgency.classList.remove('open');
    document.getElementById('filter-agent').classList.remove('open');
  });

  // Agent dropdown (populated dynamically)
  const $filterAgent = document.getElementById('filter-agent');
  const $chipAgent = document.getElementById('chip-agent');
  const $agentMenu = document.getElementById('agent-menu');

  function updateAgentMenu() {
    const kinds = new Set();
    state.items.forEach((i) => { if (i.agentKind) kinds.add(i.agentKind); });
    // Keep first "any" button, rebuild the rest
    const existing = Array.from($agentMenu.querySelectorAll('button[data-agent]'));
    // remove all except first (any)
    existing.slice(1).forEach((b) => b.remove());
    kinds.forEach((k) => {
      const btn = document.createElement('button');
      btn.dataset.agent = k;
      btn.textContent = k;
      if (filterAgent === k) btn.classList.add('active');
      btn.addEventListener('click', () => {
        filterAgent = btn.dataset.agent;
        $chipAgent.textContent = filterAgent ? 'agent: ' + filterAgent + ' ▾' : 'by agent ▾';
        $chipAgent.classList.toggle('active', !!filterAgent);
        $filterAgent.classList.remove('open');
        render();
      });
      $agentMenu.appendChild(btn);
    });
  }

  $agentMenu.querySelector('button[data-agent]').addEventListener('click', () => {
    filterAgent = '';
    $chipAgent.textContent = 'by agent ▾';
    $chipAgent.classList.remove('active');
    $filterAgent.classList.remove('open');
    render();
  });
  $chipAgent.addEventListener('click', (e) => {
    e.stopPropagation();
    $filterAgent.classList.toggle('open');
    $filterUrgency.classList.remove('open');
    $filterKind.classList.remove('open');
  });

  // Close dropdowns on outside click
  document.addEventListener('click', () => {
    $filterUrgency.classList.remove('open');
    $filterKind.classList.remove('open');
    $filterAgent.classList.remove('open');
  });

  function applyFilters(items) {
    const now = Date.now();
    return items.filter((i) => {
      // base filter
      if (filterMode === 'pending') {
        if (i.resolved) return false;
        // exclude snoozed from pending view
        if (i.snoozedUntil && i.snoozedUntil > now) return false;
      } else if (filterMode === 'snoozed') {
        if (!(i.snoozedUntil && i.snoozedUntil > now)) return false;
      }
      // urgency filter
      if (filterUrgency && i.urgency !== filterUrgency) return false;
      // kind filter
      if (filterKind && i.kind !== filterKind) return false;
      // agent filter
      if (filterAgent && i.agentKind !== filterAgent) return false;
      return true;
    });
  }

  // ---------- rendering ----------
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

  function ensureNode(item) {
    let node = nodes.get(item.id);
    if (node) return node;
    node = $tpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = item.id;

    // kind
    node.querySelector('.kind').textContent = item.kind.replace(/_/g, ' ');
    node.querySelector('.kind').classList.add('kind-' + item.kind);

    // title + snippet
    node.querySelector('.item-title').textContent = item.title;
    node.querySelector('.item-snippet').textContent = item.snippet || '';
    node.querySelector('.age').dataset.ts = item.createdAt;

    // urgency badge
    const $badge = node.querySelector('.urgency-badge');
    const urg = item.urgency || 'normal';
    $badge.textContent = urg;
    $badge.classList.add('urgency-' + urg);

    // agent identity line
    const $agentLine = node.querySelector('.agent-line');
    if (item.agentKind) {
      const sid = item.sessionId ? item.sessionId.slice(0, 8) : null;
      $agentLine.textContent = item.agentKind + (sid ? ' · ' + sid : '');
      $agentLine.style.display = '';
    }

    // transcript snapshot
    const $expander = node.querySelector('.transcript-expander');
    if (item.transcriptSnapshot) {
      node.querySelector('.transcript-pre').textContent = item.transcriptSnapshot;
      $expander.style.display = '';
    }

    // action buttons
    node.querySelector('.btn-resume').addEventListener('click', () => doResume(item.id));
    node.querySelector('.btn-ack').addEventListener('click', () => doFocus(item.id));
    node.querySelector('.btn-dismiss').addEventListener('click', () => doDismiss(item.id));

    // snooze dropdown
    const $snoozeWrapper = node.querySelector('.snooze-wrapper');
    const $btnSnooze = node.querySelector('.btn-snooze');
    $btnSnooze.addEventListener('click', (e) => {
      e.stopPropagation();
      $snoozeWrapper.classList.toggle('open');
    });
    node.querySelectorAll('.snooze-menu button[data-snooze]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        $snoozeWrapper.classList.remove('open');
        doSnooze(item.id, Number(btn.dataset.snooze));
      });
    });
    document.addEventListener('click', () => $snoozeWrapper.classList.remove('open'));

    // quick reply
    const $qr = node.querySelector('.quick-reply');
    const $textarea = node.querySelector('.reply-textarea');
    const $btnSend = node.querySelector('.btn-send');

    if (item.quickReplyEnabled === false) {
      $qr.style.display = 'none';
    } else {
      // auto-grow textarea
      $textarea.addEventListener('input', () => autoGrow($textarea));
      // Cmd/Ctrl+Enter submits
      $textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          submitReply(item.id, node);
        }
      });
      $btnSend.addEventListener('click', () => submitReply(item.id, node));
    }

    // Hover for >2s implies the user has at least seen it.
    node.addEventListener('mouseenter', () => {
      const t = setTimeout(() => doFocus(item.id, /*silent*/ true), 2000);
      hoverTimers.set(item.id, t);
    });
    node.addEventListener('mouseleave', () => {
      const t = hoverTimers.get(item.id);
      if (t) clearTimeout(t);
      hoverTimers.delete(item.id);
    });

    nodes.set(item.id, node);
    return node;
  }

  function autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 130) + 'px';
  }

  function applyItem(item, node) {
    node.classList.toggle('acknowledged', !!item.focused && !item.resolved);
    node.classList.toggle('resolved', !!item.resolved);

    // snooze visual state
    const now = Date.now();
    const snoozed = item.snoozedUntil && item.snoozedUntil > now;
    node.classList.toggle('snoozed', !!snoozed);
    const $snoozeBadge = node.querySelector('.snooze-badge');
    if (snoozed) {
      const remaining = fmtSnoozeRemaining(item.snoozedUntil);
      if (remaining) {
        $snoozeBadge.textContent = '[snoozed ' + remaining + ']';
        $snoozeBadge.style.display = '';
      } else {
        $snoozeBadge.style.display = 'none';
      }
    } else {
      $snoozeBadge.style.display = 'none';
    }

    // replied state
    if (item.replied) {
      const $qr = node.querySelector('.quick-reply');
      if ($qr && !node.querySelector('.replied-pill')) {
        $qr.style.display = 'none';
      }
    }
  }

  function render() {
    // Update agent dropdown options
    updateAgentMenu();

    const now = Date.now();
    // For 'all' mode, show items from last 60s after resolve; for others use applyFilters
    let visibleItems;
    if (filterMode === 'all') {
      visibleItems = state.items.filter((i) => !i.resolved || (now - (i.resolvedAt || 0)) < 60000);
      // still apply urgency/kind/agent secondary filters
      visibleItems = visibleItems.filter((i) => {
        if (filterUrgency && i.urgency !== filterUrgency) return false;
        if (filterKind && i.kind !== filterKind) return false;
        if (filterAgent && i.agentKind !== filterAgent) return false;
        return true;
      });
    } else {
      visibleItems = applyFilters(state.items);
    }

    $empty.style.display = visibleItems.length ? 'none' : 'block';
    // Sync DOM in order.
    $list.querySelectorAll('.item').forEach((n) => {
      if (!visibleItems.find((i) => i.id === n.dataset.id)) {
        n.remove();
        nodes.delete(n.dataset.id);
      }
    });
    for (const item of visibleItems) {
      const node = ensureNode(item);
      applyItem(item, node);
      if (!node.parentNode) $list.appendChild(node);
    }
    // Box count = unresolved + unfocused.
    const pending = state.items.filter((i) => !i.resolved && !i.focused).length;
    $boxCount.textContent = String(pending);
    $box.classList.toggle('warning', pending > 0);
  }

  // Periodic age + snooze badge refresh (every 15s)
  setInterval(() => {
    document.querySelectorAll('.age').forEach((a) => {
      const ts = Number(a.dataset.ts);
      if (ts) a.textContent = fmtAge(ts);
    });
    // Refresh snooze badges and remove expired ones
    const now = Date.now();
    state.items.forEach((item) => {
      const node = nodes.get(item.id);
      if (!node) return;
      const $snoozeBadge = node.querySelector('.snooze-badge');
      if (!$snoozeBadge) return;
      if (item.snoozedUntil && item.snoozedUntil > now) {
        const remaining = fmtSnoozeRemaining(item.snoozedUntil);
        if (remaining) {
          $snoozeBadge.textContent = '[snoozed ' + remaining + ']';
          $snoozeBadge.style.display = '';
          node.classList.add('snoozed');
        } else {
          $snoozeBadge.style.display = 'none';
          node.classList.remove('snoozed');
        }
      } else {
        $snoozeBadge.style.display = 'none';
        node.classList.remove('snoozed');
      }
    });
    // Re-render if pending filter active (snooze expiry may reveal items)
    if (filterMode === 'pending' || filterMode === 'snoozed') render();
  }, 15000);

  // Age refresh every second
  setInterval(() => {
    document.querySelectorAll('.age').forEach((a) => {
      const ts = Number(a.dataset.ts);
      if (ts) a.textContent = fmtAge(ts);
    });
  }, 1000);

  // ---------- actions ----------
  async function doFocus(id, silent = false) {
    await fetch(`/items/${id}/focus`, { method: 'POST' });
    const item = state.items.find((i) => i.id === id);
    if (item) {
      item.focused = true;
      const node = nodes.get(id);
      if (node) applyItem(item, node);
    }
    if (!silent) render();
  }

  async function doResume(id) {
    await fetch(`/items/${id}/resume`, { method: 'POST' });
    const node = nodes.get(id);
    if (node) {
      node.classList.add('acknowledged');
      const hint = document.createElement('div');
      hint.style.cssText = 'margin-top:6px;font-size:11px;color:var(--muted)';
      hint.textContent = 'Resume queued. Type your reply in the Claude CLI; the original context will be re-injected automatically.';
      node.appendChild(hint);
    }
  }

  async function doDismiss(id) {
    await fetch(`/items/${id}`, { method: 'DELETE' });
  }

  async function doSnooze(id, seconds) {
    try {
      const res = await fetch(`/items/${id}/snooze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seconds }),
      });
      if (res.ok) {
        // Optimistically update the item
        const item = state.items.find((i) => i.id === id);
        if (item) {
          item.snoozedUntil = Date.now() + seconds * 1000;
          const node = nodes.get(id);
          if (node) applyItem(item, node);
          render();
        }
      }
    } catch (_) {}
  }

  async function submitReply(id, node) {
    const $textarea = node.querySelector('.reply-textarea');
    const text = $textarea.value.trim();
    if (!text) return;
    try {
      const res = await fetch(`/items/${id}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (res.ok) {
        // Replace quick reply with replied pill
        const $qr = node.querySelector('.quick-reply');
        $qr.style.display = 'none';
        const pill = document.createElement('div');
        pill.className = 'replied-pill';
        pill.innerHTML = '[replied] <span class="replied-text">' + escHtml(text) + '</span>';
        node.appendChild(pill);
        // Update local state
        const item = state.items.find((i) => i.id === id);
        if (item) {
          item.replied = true;
          item.focused = true;
        }
      }
    } catch (_) {}
  }

  function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---------- WS connection ----------
  function connect() {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    ws.addEventListener('open', () => $dot.classList.add('ok'));
    ws.addEventListener('close', () => {
      $dot.classList.remove('ok');
      setTimeout(connect, 1000);
    });
    ws.addEventListener('error', () => {});
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      switch (msg.type) {
        case 'snapshot':
          state = { config: msg.config, items: msg.items };
          $cfgWarn.value = state.config.warnIntervalSeconds;
          $cfgStyle.value = state.config.warnStyle;
          render();
          break;
        case 'item:add': {
          state.items.push(msg.item);
          render();
          flashWarn(msg.item.id);
          maybeNotify(msg.item);
          break;
        }
        case 'item:update': {
          const idx = state.items.findIndex((i) => i.id === msg.item.id);
          if (idx >= 0) state.items[idx] = msg.item;
          // Rebuild node if needed (new fields may appear)
          nodes.delete(msg.item.id);
          render();
          break;
        }
        case 'item:remove': {
          state.items = state.items.filter((i) => i.id !== msg.id);
          const node = nodes.get(msg.id);
          if (node) {
            node.remove();
            nodes.delete(msg.id);
          }
          render();
          break;
        }
        case 'item:warn': {
          flashWarn(msg.id, msg.style);
          break;
        }
        case 'config': {
          state.config = msg.config;
          $cfgWarn.value = msg.config.warnIntervalSeconds;
          $cfgStyle.value = msg.config.warnStyle;
          break;
        }
        case 'cleared': {
          state.items = state.items.filter((i) => !msg.ids.includes(i.id));
          render();
          break;
        }
      }
    });
  }

  function flashWarn(id, style) {
    const node = nodes.get(id);
    if (!node) return;
    const useStyle = style || state.config.warnStyle || 'pulse';
    if (useStyle === 'none') return;
    node.classList.remove('warning', 'style-pulse', 'style-blink', 'style-glow');
    // Force reflow so the animation restarts.
    void node.offsetWidth;
    node.classList.add('warning', 'style-' + useStyle);
    // The animation iteration count is fixed in CSS; remove the class after.
    setTimeout(() => node.classList.remove('warning', 'style-' + useStyle), 6000);
  }

  // Initial state via REST in case WS isn't ready yet.
  fetch('/state').then((r) => r.json()).then((s) => {
    state = s;
    $cfgWarn.value = state.config.warnIntervalSeconds;
    $cfgStyle.value = state.config.warnStyle;
    render();
  }).catch(() => {});

  connect();
})();
