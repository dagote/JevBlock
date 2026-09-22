const $ = (id) => document.getElementById(id);

let current = null;
let pinned = false;
let filter = 'removed';

function setStatus(text) {
  $('status').textContent = text;
}

function pct(noul) {
  return typeof noul === 'number' ? `${Math.round(noul * 100)}%` : '—';
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function parseRunText(text) {
  return globalThis.AdgateDecisionLog.parseRunText(text);
}

function matchesFilter(row) {
  if (filter === 'all') return true;
  if (filter === 'removed') return row.removed || (row.cascadeParents || []).length > 0;
  return row.action === filter;
}

function renderSummary(run) {
  const host = $('summary');
  host.replaceChildren();
  const s = run.summary || {};
  const site = el('div', 'meta');
  const conf =
    run.site_type_confidence != null ? ` · ${Math.round(run.site_type_confidence * 100)}% conf` : '';
  site.textContent = `${run.site_type || 'unknown site'}${conf} · hide ≥ ${run.hideMin ?? 0.75} · review ${run.reviewMin ?? 0.45}–${run.hideMin ?? 0.75}`;
  host.append(site);
  const url = el('div', 'meta', run.page?.url || '');
  host.append(url);
  const stats = el('div', 'stats');
  const bits = [
    `candidates ${s.candidates ?? 0}`,
    `removed ${s.removed ?? 0}`,
    `empty parents ${s.cascadeRemoved ?? 0}`,
    `review ${s.review ?? 0}`,
    `allowed ${s.allowed ?? 0}`,
    run.blockEnabled ? 'block on' : 'block off',
    run.dryRun ? 'dry fixture' : '',
  ].filter(Boolean);
  for (const bit of bits) stats.append(el('span', 'stat', bit));
  host.append(stats);
  const discovered = discoverLine(run.decisions);
  if (discovered) host.append(el('div', 'meta', `Found via ${discovered}`));
}

function discoverLine(decisions) {
  const counts = new Map();
  for (const row of decisions || []) {
    const key = row.discover || 'unspecified';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].map(([key, count]) => `${key} ${count}`).join(' · ');
}

function renderCard(row) {
  const card = el('article', 'card');
  const before = el('div');
  before.append(el('div', 'kicker', 'Before'));
  before.append(el('div', '', `${row.tag || 'node'} · ${row.id}`));
  before.append(el('div', 'meta', `Found via ${row.discover || 'unspecified'}`));
  if (row.kind) before.append(el('div', 'meta', `Class ${row.kind}`));
  if (row.kindPolicy) before.append(el('div', 'meta', `Rank policy ${row.kindPolicy}`));
  if (row.kind === 'kind_missing_host') before.append(el('div', 'meta', 'Host omitted kind'));
  const bits = [];
  if (row.href) bits.push(`href ${row.href}`);
  if (row.src) bits.push(`src ${row.src}`);
  if ((row.classes || []).length) bits.push(`class ${(row.classes || []).join(' ')}`);
  if (row.idAttr) bits.push(`id ${row.idAttr}`);
  if (row.nearbyLabel) bits.push(`nearby ${row.nearbyLabel}`);
  if (row.rect) bits.push(`${row.rect.w}×${row.rect.h} at ${row.rect.x},${row.rect.y}`);
  if (row.fixedOrSticky) bits.push('fixed/sticky');
  if (row.text) bits.push(row.text);
  before.append(el('div', 'meta', bits.join(' · ') || 'No snapshot fields'));
  if (row.before?.html) before.append(el('pre', '', row.before.html));

  const after = el('div');
  after.append(el('div', 'kicker', 'After'));
  const score = el('div', `score ${row.action || ''}`, pct(row.noul));
  after.append(score);
  const bar = el('div', `bar ${row.action || ''}`);
  const fill = document.createElement('span');
  fill.style.width = `${Math.max(0, Math.min(100, Math.round((row.noul || 0) * 100)))}%`;
  bar.append(fill);
  after.append(bar);
  const badge = el(
    'span',
    `badge ${row.removed ? 'removed' : 'kept'}`,
    row.removed ? 'Removed' : row.action === 'hide' ? 'Hide suggested' : 'Kept',
  );
  after.append(badge);
  const why = [
    row.kind ? `class ${row.kind}` : null,
    row.action || '—',
    row.reason || 'no reason',
    row.removed && String(row.reason || '').startsWith('rank_') ? 'user rank' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  after.append(document.createTextNode(` ${why}`));
  const parents = row.cascadeParents || [];
  if (parents.length) {
    const list = document.createElement('ul');
    for (const parent of parents) {
      const classes = (parent.classes || []).join('.');
      const label = `${parent.tag || 'node'}${parent.idAttr ? `#${parent.idAttr}` : ''}${classes ? `.${classes}` : ''} · ${parent.reason || 'empty_parent'}`;
      list.append(el('li', '', `Also removed empty parent ${label}`));
    }
    after.append(list);
  }
  card.append(before, after);
  return card;
}

function render(run) {
  current = run;
  const list = $('list');
  $('filters').hidden = false;
  if (!run?.decisions) {
    list.replaceChildren(el('div', 'empty', 'This file has no decisions array.'));
    return;
  }
  renderSummary(run);
  const rows = run.decisions.filter(matchesFilter).sort((a, b) => (b.noul || 0) - (a.noul || 0));
  list.replaceChildren();
  if (!rows.length) {
    list.append(el('div', 'empty', 'Nothing in this filter.'));
  } else {
    for (const row of rows) list.append(renderCard(row));
  }
  const when = run.ts ? new Date(run.ts).toLocaleString() : 'unknown time';
  setStatus(`${run.requestId || 'no request id'} · ${when}`);
}

function showEmpty() {
  $('summary').replaceChildren();
  $('filters').hidden = true;
  $('list').replaceChildren(
    el(
      'div',
      'empty',
      'No run yet. Judge a tab with the popup, or load fixtures/decision-log.sample.json (or its .jsonl).',
    ),
  );
}

function fillHistory(history) {
  const select = $('history');
  select.replaceChildren();
  const runs = Array.isArray(history) ? history : [];
  if (!runs.length) {
    select.append(new Option('No saved runs', ''));
    return;
  }
  runs.forEach((run, index) => {
    const label = `${run.page?.hostname || 'page'} · ${run.summary?.removed ?? 0} removed · ${run.requestId || index}`;
    select.append(new Option(label, String(index)));
  });
}

async function loadLatest() {
  pinned = false;
  if (!globalThis.chrome?.storage?.local) {
    showEmpty();
    setStatus('Open this page from the Adgate popup.');
    return;
  }
  const data = await chrome.storage.local.get(['adgateLastRun', 'adgateRunHistory']);
  fillHistory(data.adgateRunHistory || (data.adgateLastRun ? [data.adgateLastRun] : []));
  if (!data.adgateLastRun) {
    showEmpty();
    setStatus('Waiting for a judge run.');
    return;
  }
  render(data.adgateLastRun);
}

$('latest').onclick = () => loadLatest().catch((error) => setStatus(String(error.message || error)));

$('file').onchange = async () => {
  const file = $('file').files?.[0];
  if (!file) return;
  try {
    pinned = true;
    render(parseRunText(await file.text()));
    setStatus(`Loaded ${file.name}`);
  } catch (error) {
    setStatus(String(error.message || error));
  }
};

$('export-json').onclick = () => {
  if (!current) return setStatus('Nothing to export.');
  const id = current.requestId || 'run';
  download(`adgate-run-${id}.json`, JSON.stringify(current, null, 2), 'application/json');
};

$('export-jsonl').onclick = () => {
  if (!current) return setStatus('Nothing to export.');
  const id = current.requestId || 'run';
  const line = globalThis.AdgateDecisionLog?.toJsonl(current) || JSON.stringify(current);
  download(`adgate-run-${id}.jsonl`, `${line}\n`, 'application/x-ndjson');
};

document.querySelectorAll('#filters button').forEach((button) => {
  button.onclick = () => {
    filter = button.dataset.filter;
    document.querySelectorAll('#filters button').forEach((other) => {
      other.setAttribute('aria-pressed', other === button ? 'true' : 'false');
    });
    if (current) render(current);
  };
});

$('history').onchange = async () => {
  if (!globalThis.chrome?.storage?.local) return;
  const data = await chrome.storage.local.get(['adgateRunHistory']);
  const run = (data.adgateRunHistory || [])[Number($('history').value)];
  if (run) {
    pinned = true;
    render(run);
  }
};

if (globalThis.chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || pinned) return;
    if (changes.adgateLastRun?.newValue) render(changes.adgateLastRun.newValue);
    if (changes.adgateRunHistory?.newValue) fillHistory(changes.adgateRunHistory.newValue);
  });
}

function maybeLoadFixture() {
  if (!location.protocol.startsWith('http')) return Promise.resolve(false);
  const params = new URLSearchParams(location.search);
  if (params.get('fixture') !== '1') return Promise.resolve(false);
  const requested = params.get('filter');
  if (requested) {
    filter = requested;
    document.querySelectorAll('#filters button').forEach((button) => {
      button.setAttribute('aria-pressed', button.dataset.filter === filter ? 'true' : 'false');
    });
  }
  return fetch(new URL('../fixtures/decision-log.sample.json', location.href)).then(async (res) => {
    if (!res.ok) throw new Error(`fixture HTTP ${res.status}`);
    pinned = true;
    render(parseRunText(await res.text()));
    setStatus('Loaded dry fixture (no live scorer).');
    return true;
  });
}

loadLatest()
  .catch((error) => setStatus(String(error.message || error)))
  .then(() => maybeLoadFixture())
  .catch((error) => setStatus(String(error.message || error)));
