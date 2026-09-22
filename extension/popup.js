const DEFAULTS = {
  enabled: true,
  blockEnabled: false,
  reviewMode: true,
  hideMin: 0.75,
  showLabels: false,
  showPanel: false,
  extremeEarly: false,
  uiRev: 1,
  serverUrl: 'http://192.168.0.119:8770',
};
const NEED = '0.0.6';
const $ = (id) => document.getElementById(id);

function setStatus(text, cls) {
  $('status').textContent = text;
  $('status').className = cls || '';
}

function render(scan) {
  const host = $('summary');
  host.replaceChildren();
  if (!scan) return;
  const box = document.createElement('div');
  box.className = 'summary';
  const s = scan.summary || {};
  const lines = [
    `${scan.site_type || 'unknown site'} · ${scan.blockEnabled ? 'block on' : 'block off'}`,
    `${s.candidates ?? 0} candidates · ${s.removed ?? s.hidden ?? 0} removed · ${s.cascadeRemoved ?? 0} empty parents · ${s.review ?? 0} in review band`,
    (scan.page?.url || scan.url || '').slice(0, 120),
  ];
  for (const line of lines) {
    const div = document.createElement('div');
    div.textContent = line;
    box.append(div);
  }
  host.append(box);
}

async function load() {
  const manifest = chrome.runtime.getManifest();
  $('ver').textContent = `v${manifest.version}`;
  if (manifest.version !== NEED) setStatus(`Wrong build v${manifest.version}. Need v${NEED}.`, 'bad');
  const stored = await chrome.storage.sync.get(null);
  const data = { ...DEFAULTS, ...stored };
  if (!stored.uiRev) {
    data.showLabels = false;
    data.showPanel = false;
    data.reviewMode = data.reviewMode !== false;
  }
  $('enabled').checked = data.enabled !== false;
  $('blockEnabled').checked = data.blockEnabled === true;
  $('reviewMode').checked = data.reviewMode !== false;
  $('showLabels').checked = data.showLabels === true;
  $('showPanel').checked = data.showPanel === true;
  $('extremeEarly').checked = data.extremeEarly === true;
  $('hideMin').value = data.hideMin ?? 0.75;
  $('serverUrl').value = data.serverUrl || DEFAULTS.serverUrl;
  render((await chrome.storage.local.get(['adgateLastRun'])).adgateLastRun);
}

function readSettings() {
  return {
    enabled: $('enabled').checked,
    blockEnabled: $('blockEnabled').checked,
    reviewMode: $('reviewMode').checked,
    showLabels: $('showLabels').checked,
    showPanel: $('showPanel').checked,
    extremeEarly: $('extremeEarly').checked,
    hideMin: Number($('hideMin').value) || 0.75,
    serverUrl: $('serverUrl').value.trim().replace(/\/$/, ''),
    uiRev: 1,
  };
}

async function save() {
  const settings = readSettings();
  await chrome.storage.sync.set(settings);
  await chrome.runtime.sendMessage({ type: 'ADGATE_APPLY_SETTINGS', settings });
  setStatus('Saved.', 'ok');
  return settings;
}

async function openReview() {
  await chrome.runtime.sendMessage({ type: 'ADGATE_OPEN_REVIEW' });
}

$('save').onclick = () => save().catch((error) => setStatus(String(error), 'bad'));
$('review').onclick = () => openReview().catch((error) => setStatus(String(error), 'bad'));
$('scan').onclick = async () => {
  try {
    const settings = await save();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab');
    setStatus('Judging…', '');
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'ADGATE_SCAN' });
    if (!result?.ok) throw new Error(result?.error || 'Judge failed');
    render(result);
    const removed = result.summary?.removed ?? 0;
    const parents = result.summary?.cascadeRemoved ?? 0;
    setStatus(`Judged. ${removed} removed, ${parents} empty parents.`, 'ok');
    if (settings.reviewMode !== false) await openReview();
  } catch (error) {
    setStatus(`${error.message || error}\nRefresh the tab, then try again.`, 'bad');
  }
};

load();
