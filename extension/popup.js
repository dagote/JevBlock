const DEFAULTS = {
  enabled: true,
  blockEnabled: false,
  reviewMode: true,
  hideMin: 0.75,
  showLabels: false,
  showPanel: false,
  extremeEarly: false,
  forceHideCheats: false,
  uiRev: 2,
  serverUrl: 'http://192.168.0.119:8770',
  ranks: null,
};
const NEED = '0.1.4';
const RANK_KEYS = ['ad', 'promo', 'unrelated_inject', 'donate_ask', 'tracking_chrome'];
const $ = (id) => document.getElementById(id);

function setStatus(text, cls) {
  $('status').textContent = text;
  $('status').className = cls || '';
}

function defaultRanks() {
  return globalThis.AdgateRanks?.normalizeRanks(null) || {};
}

function fillRanks(ranks) {
  const normalized = globalThis.AdgateRanks?.normalizeRanks(ranks) || defaultRanks();
  for (const key of RANK_KEYS) {
    const row = normalized[key] || {};
    const on = $(`rank_${key}_on`);
    const min = $(`rank_${key}_min`);
    if (on) on.checked = row.enabled === true;
    if (min) min.value = row.hideMin ?? 0.75;
  }
}

function readRanks() {
  const ranks = defaultRanks();
  for (const key of RANK_KEYS) {
    ranks[key] = {
      enabled: $(`rank_${key}_on`)?.checked === true,
      hideMin: Number($(`rank_${key}_min`)?.value) || ranks[key]?.hideMin || 0.75,
    };
  }
  return ranks;
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
  $('enabled').checked = data.enabled !== false;
  $('blockEnabled').checked = data.blockEnabled === true;
  $('reviewMode').checked = data.reviewMode !== false;
  $('showLabels').checked = data.showLabels === true;
  $('showPanel').checked = data.showPanel === true;
  $('extremeEarly').checked = data.extremeEarly === true;
  $('forceHideCheats').checked = data.forceHideCheats === true;
  $('hideMin').value = data.hideMin ?? 0.75;
  $('serverUrl').value = data.serverUrl || DEFAULTS.serverUrl;
  fillRanks(data.ranks);
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
    forceHideCheats: $('forceHideCheats').checked,
    hideMin: Number($('hideMin').value) || 0.75,
    serverUrl: $('serverUrl').value.trim().replace(/\/$/, ''),
    ranks: readRanks(),
    uiRev: 2,
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
    setStatus(
      settings.blockEnabled
        ? `Done. Removed ${removed} · empty parents ${parents}.`
        : `Done. ${result.summary?.candidates ?? 0} candidates (Block off).`,
      'ok',
    );
    if (settings.reviewMode !== false) await openReview();
  } catch (error) {
    setStatus(String(error.message || error), 'bad');
  }
};

load().catch((error) => setStatus(String(error), 'bad'));
