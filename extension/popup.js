const DEFAULTS = {
  enabled: true,
  blockEnabled: false,
  reviewMode: true,
  hideMin: 0.75,
  showLabels: false,
  showPanel: false,
  extremeEarly: false,
  forceHideCheats: false,
  uiRev: 3,
  serverUrl: 'https://www.dagote.ai/api/jev',
  apiKey: '',
  model: 'jev-latest',
  ranks: null,
};
const NEED = '0.1.5';
const CUSTOM_MODEL = '__custom__';
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

function modelLabel(model) {
  if (model?.hf_id && model.hf_id !== model.id) return `${model.id} — ${model.hf_id}`;
  return model?.id || '';
}

function fillModelSelect(models, selectedId) {
  const select = $('model');
  const list = Array.isArray(models) && models.length ? models : globalThis.AdgateServiceLink.FALLBACK_MODELS;
  const selected = String(selectedId || '').trim();
  select.replaceChildren();
  const seen = new Set();
  for (const model of list) {
    const id = String(model?.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = modelLabel(model);
    select.append(opt);
  }
  if (selected && !seen.has(selected)) {
    const opt = document.createElement('option');
    opt.value = selected;
    opt.textContent = selected;
    select.append(opt);
  }
  const custom = document.createElement('option');
  custom.value = CUSTOM_MODEL;
  custom.textContent = 'Custom id…';
  select.append(custom);
  const hasSelected = selected && Array.from(select.options).some((opt) => opt.value === selected);
  if (hasSelected) {
    select.value = selected;
    $('modelCustom').value = '';
  } else if (selected) {
    select.value = CUSTOM_MODEL;
    $('modelCustom').value = selected;
  } else {
    select.value = DEFAULTS.model;
  }
  syncCustomModel();
}

function syncCustomModel() {
  const custom = $('model').value === CUSTOM_MODEL;
  $('modelCustom').hidden = !custom;
}

function readModelId() {
  if ($('model').value === CUSTOM_MODEL) {
    return $('modelCustom').value.trim() || DEFAULTS.model;
  }
  return ($('model').value || DEFAULTS.model).trim() || DEFAULTS.model;
}

let modelFetchGen = 0;

async function refreshModels({ preferServerDefault = false, quiet = false } = {}) {
  const gen = ++modelFetchGen;
  const selectedAtStart = readModelId();
  const serverUrl = globalThis.AdgateServiceLink.normalizeServerUrl($('serverUrl').value) || DEFAULTS.serverUrl;
  const apiKey = $('apiKey').value.trim();
  try {
    const parsed = await globalThis.AdgateServiceLink.fetchModelList(serverUrl, fetch, apiKey);
    if (gen !== modelFetchGen) return parsed;
    const untouched = readModelId() === selectedAtStart;
    const selected =
      preferServerDefault && untouched && parsed.defaultModel ? parsed.defaultModel : readModelId();
    fillModelSelect(parsed.models, selected);
    if (preferServerDefault && untouched && parsed.defaultModel && parsed.defaultModel !== selectedAtStart) {
      await chrome.storage.sync.set({ model: parsed.defaultModel });
    }
    return parsed;
  } catch (error) {
    if (gen !== modelFetchGen) return null;
    fillModelSelect(globalThis.AdgateServiceLink.FALLBACK_MODELS, selectedAtStart);
    if (!quiet) {
      const message = globalThis.AdgateServiceLink.redactSecret(error?.message || error, apiKey);
      setStatus(`Model list unavailable (${message}). Fallback ids kept.`, '');
    }
    return null;
  }
}

async function load() {
  const manifest = chrome.runtime.getManifest();
  $('ver').textContent = `v${manifest.version}`;
  if (manifest.version !== NEED) setStatus(`Wrong build v${manifest.version}. Need v${NEED}.`, 'bad');
  const stored = await chrome.storage.sync.get(null);
  const hadModel = Boolean(String(stored.model || '').trim());
  const migrated = globalThis.AdgateServiceLink.migrateStoredSettings(stored);
  if (migrated.changed) await chrome.storage.sync.set(migrated.patch);
  const data = { ...DEFAULTS, ...stored, ...migrated.patch };
  $('enabled').checked = data.enabled !== false;
  $('blockEnabled').checked = data.blockEnabled === true;
  $('reviewMode').checked = data.reviewMode !== false;
  $('showLabels').checked = data.showLabels === true;
  $('showPanel').checked = data.showPanel === true;
  $('extremeEarly').checked = data.extremeEarly === true;
  $('forceHideCheats').checked = data.forceHideCheats === true;
  $('hideMin').value = data.hideMin ?? 0.75;
  $('serverUrl').value = data.serverUrl || DEFAULTS.serverUrl;
  $('apiKey').value = data.apiKey || '';
  fillModelSelect(globalThis.AdgateServiceLink.FALLBACK_MODELS, data.model || DEFAULTS.model);
  fillRanks(data.ranks);
  render((await chrome.storage.local.get(['adgateLastRun'])).adgateLastRun);
  await refreshModels({ preferServerDefault: !hadModel, quiet: true });
}

function readSettings() {
  const serverUrl =
    globalThis.AdgateServiceLink.normalizeServerUrl($('serverUrl').value) || DEFAULTS.serverUrl;
  return {
    enabled: $('enabled').checked,
    blockEnabled: $('blockEnabled').checked,
    reviewMode: $('reviewMode').checked,
    showLabels: $('showLabels').checked,
    showPanel: $('showPanel').checked,
    extremeEarly: $('extremeEarly').checked,
    forceHideCheats: $('forceHideCheats').checked,
    hideMin: Number($('hideMin').value) || 0.75,
    serverUrl,
    apiKey: $('apiKey').value.trim(),
    model: readModelId(),
    ranks: readRanks(),
    uiRev: 3,
  };
}

async function save() {
  const settings = readSettings();
  await chrome.storage.sync.set(settings);
  const apply = { ...settings };
  delete apply.apiKey;
  await chrome.runtime.sendMessage({ type: 'ADGATE_APPLY_SETTINGS', settings: apply });
  const listed = await refreshModels({ preferServerDefault: false, quiet: true });
  setStatus(listed ? 'Saved.' : 'Saved. Model list could not be refreshed; fallback ids kept.', 'ok');
  return settings;
}

async function openReview() {
  await chrome.runtime.sendMessage({ type: 'ADGATE_OPEN_REVIEW' });
}

$('model').onchange = () => syncCustomModel();
$('refreshModels').onclick = () =>
  refreshModels({ preferServerDefault: false, quiet: false }).then((listed) => {
    if (listed) setStatus('Model list updated.', 'ok');
  }).catch((error) => setStatus(String(error.message || error), 'bad'));
$('save').onclick = () => save().catch((error) => setStatus(String(error.message || error), 'bad'));
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
