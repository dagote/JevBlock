const DEFAULTS = {
  enabled: true,
  blockEnabled: false,
  hideMin: 0.75,
  showLabels: true,
  showPanel: true,
  serverUrl: 'http://192.168.0.119:8770',
};
const NEED = '0.0.3';
const $ = (id) => document.getElementById(id);

function setStatus(t, cls) {
  $('status').textContent = t;
  $('status').className = cls || '';
}

function render(scan) {
  const site = $('site');
  const pills = $('pills');
  const list = $('list');
  site.style.display = 'none';
  pills.innerHTML = '';
  list.innerHTML = '';
  $('rawwrap').style.display = 'none';
  if (!scan) {
    setStatus('No judgment yet. Open a page → Judge this tab.', '');
    return;
  }

  site.style.display = 'block';
  const conf =
    scan.site_type_confidence != null ? ` (${Math.round(scan.site_type_confidence * 100)}% conf)` : '';
  const probs = Object.entries(scan.site_type_probabilities || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k, v]) => `${k} ${Math.round(v * 100)}%`)
    .join(' · ');
  site.innerHTML = `<div>Site type: <strong>${scan.site_type || '?'}</strong>${conf}</div>
    <div style="color:#888;margin-top:4px">${probs}</div>
    <div style="color:#666;margin-top:4px;font-size:11px">${(scan.url || '').slice(0, 100)}</div>
    <div style="color:#666;font-size:11px">blockEnabled=${!!scan.blockEnabled} · ${scan.ms ?? '?'} ms · ${scan.requestId || ''}</div>`;

  const s = scan.summary || {};
  pills.innerHTML = [
    `candidates ${s.candidates ?? '—'}`,
    `hidden ${s.hidden ?? 0}`,
    `review/suggest ${s.review ?? 0}`,
    `allow ${s.allowed ?? 0}`,
  ]
    .map((t) => `<span class="pill">${t}</span>`)
    .join('');

  const rows = [...(scan.decisions || [])].sort((a, b) => b.noul - a.noul);
  if (!rows.length) {
    setStatus('No element candidates.', 'ok');
    return;
  }

  for (const d of rows) {
    const det = document.createElement('details');
    det.open = d.noul >= 0.45;
    const pct = Math.round(d.noul * 100);
    det.innerHTML = `<summary><span class="${d.action}"><b>${pct}%</b> · ${d.action}</span>
      · ${d.id} · ${d.tag}${d.hidden ? ' · REMOVED' : ''}</summary>
      <div class="meta">reason: ${d.reason || '—'}</div>
      <div class="meta">src: ${d.src || '—'}</div>
      <div class="meta">class: ${d.cls || '—'}</div>
      <div class="meta">testId: ${d.testId || '—'}</div>
      <div class="meta">text: ${(d.text || '—').slice(0, 160)}</div>
      <div class="meta">rect: ${d.rect ? `${d.rect.w}×${d.rect.h}` : '—'}</div>`;
    list.appendChild(det);
  }

  $('rawwrap').style.display = 'block';
  $('raw').textContent = JSON.stringify(scan, null, 2);
  setStatus(`Judged ${new Date(scan.ts).toLocaleTimeString()} (annotate mode)`, 'ok');
}

async function load() {
  const m = chrome.runtime.getManifest();
  $('ver').textContent = `v${m.version}`;
  if (m.version !== NEED) setStatus(`Wrong build v${m.version}. Need v${NEED}.`, 'bad');
  const data = await chrome.storage.sync.get(DEFAULTS);
  $('enabled').checked = data.enabled !== false;
  $('blockEnabled').checked = data.blockEnabled === true;
  $('showLabels').checked = data.showLabels !== false;
  $('showPanel').checked = data.showPanel !== false;
  $('hideMin').value = data.hideMin ?? 0.75;
  $('serverUrl').value = data.serverUrl || DEFAULTS.serverUrl;
  render((await chrome.storage.local.get(['adgateLastScan'])).adgateLastScan);
}

async function save() {
  const settings = {
    enabled: $('enabled').checked,
    blockEnabled: $('blockEnabled').checked,
    showLabels: $('showLabels').checked,
    showPanel: $('showPanel').checked,
    hideMin: Number($('hideMin').value) || 0.75,
    serverUrl: $('serverUrl').value.trim().replace(/\/$/, ''),
  };
  await chrome.storage.sync.set(settings);
  setStatus('Saved.', 'ok');
  return settings;
}

$('save').onclick = () => save().catch((e) => setStatus(String(e), 'bad'));
$('scan').onclick = async () => {
  try {
    await save();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab');
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'ADGATE_SCAN' });
    if (!result?.ok) throw new Error(result?.error || 'Judge failed');
    render(result);
  } catch (e) {
    setStatus(`${e.message || e}\nRefresh tab, then try again.`, 'bad');
  }
};

load();
