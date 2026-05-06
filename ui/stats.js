// illo-sidebar stats page — v0.2
// Fetches /stats and renders summary cards + bar charts.

(() => {
  const $content = document.getElementById('stats-content');

  function fmtMs(ms) {
    if (ms == null || isNaN(ms)) return 'n/a';
    const s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    if (s < 3600) return Math.round(s / 60) + 'm';
    return (s / 3600).toFixed(1) + 'h';
  }

  function pct(n, total) {
    if (!total) return '0%';
    return Math.round((n / total) * 100) + '%';
  }

  function barChart(entries, maxVal) {
    if (!entries || entries.length === 0) {
      return '<div style="color:var(--muted);font-size:12px;">No data</div>';
    }
    const max = maxVal || Math.max(...entries.map((e) => e.count || 0)) || 1;
    return '<div class="bar-chart">' +
      entries.map((e) => {
        const w = Math.round(((e.count || 0) / max) * 100);
        return '<div class="bar-row">' +
          '<span class="bar-label" title="' + escHtml(String(e.label || '')) + '">' + escHtml(String(e.label || 'unknown')) + '</span>' +
          '<div class="bar-track"><div class="bar-fill" style="width:' + w + '%"></div></div>' +
          '<span class="bar-count">' + (e.count || 0) + '</span>' +
          '</div>';
      }).join('') +
      '</div>';
  }

  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderStats(data) {
    const total = data.total_items || 0;
    // Handle both spec names (median_resolve_ms) and actual daemon names (median_time_to_resolve_seconds)
    const medianResolveMs = data.median_resolve_ms != null
      ? data.median_resolve_ms
      : (data.median_time_to_resolve_seconds != null ? data.median_time_to_resolve_seconds * 1000 : null);
    const p95ResolveMs = data.p95_resolve_ms != null
      ? data.p95_resolve_ms
      : (data.p95_time_to_resolve_seconds != null ? data.p95_time_to_resolve_seconds * 1000 : null);
    const medianResolve = medianResolveMs;
    const p95Resolve = p95ResolveMs;
    // dismissal_rate may be a fraction (0-1) or a count; handle both
    const dismissRaw = data.dismissed_count || data.dismissal_rate || 0;
    const dismissRate = (dismissRaw <= 1 && total > 0)
      ? Math.round(dismissRaw * 100) + '%'
      : (total ? pct(dismissRaw, total) : '0%');
    const windowDays = data.window_days != null ? data.window_days + 'd' : 'n/a';
    // top_recurring_titles may be an array of {title, count} or [[title, count]]
    const topTitles = data.top_titles || data.top_recurring_titles || [];

    let html = '';

    // Summary cards
    html += '<div class="stats-cards">';
    html += card(String(total), 'total items');
    html += card(fmtMs(medianResolve), 'median resolve');
    html += card(fmtMs(p95Resolve), 'p95 resolve');
    html += card(dismissRate, 'dismissal rate');
    html += card(windowDays, 'window');
    html += '</div>';

    // By kind bar chart
    html += '<div class="stats-section">';
    html += '<h2>by kind</h2>';
    if (data.by_kind && Object.keys(data.by_kind).length > 0) {
      const entries = Object.entries(data.by_kind)
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count);
      html += barChart(entries);
    } else {
      html += '<div style="color:var(--muted);font-size:12px;">No data</div>';
    }
    html += '</div>';

    // By agent kind bar chart
    html += '<div class="stats-section">';
    html += '<h2>by agent kind</h2>';
    if (data.by_agent_kind && Object.keys(data.by_agent_kind).length > 0) {
      const entries = Object.entries(data.by_agent_kind)
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count);
      html += barChart(entries);
    } else {
      html += '<div style="color:var(--muted);font-size:12px;">No data</div>';
    }
    html += '</div>';

    // Top recurring titles
    html += '<div class="stats-section">';
    html += '<h2>top recurring titles</h2>';
    if (topTitles && topTitles.length > 0) {
      html += '<ul class="top-titles-list">';
      topTitles.forEach((entry) => {
        const title = Array.isArray(entry) ? entry[0] : (entry.title || 'unknown');
        const count = Array.isArray(entry) ? entry[1] : (entry.count || 0);
        html += '<li><span>' + escHtml(String(title)) + '</span><span class="ttl-count">' + count + '</span></li>';
      });
      html += '</ul>';
    } else {
      html += '<div style="color:var(--muted);font-size:12px;">No data</div>';
    }
    html += '</div>';

    $content.innerHTML = html;
  }

  function card(val, label) {
    return '<div class="stat-card"><span class="stat-val">' + escHtml(val) + '</span><span class="stat-label">' + escHtml(label) + '</span></div>';
  }

  fetch('/stats')
    .then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then((data) => {
      renderStats(data);
    })
    .catch((err) => {
      $content.innerHTML = '<div class="stats-error">' +
        'Could not load stats: ' + escHtml(err.message) + '<br>' +
        '<span style="color:var(--muted);font-size:11px;">The /stats endpoint may not yet be available in this daemon version.</span>' +
        '</div>';
    });
})();
