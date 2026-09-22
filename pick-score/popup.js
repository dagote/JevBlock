const service = globalThis.JevPickService;
const DEFAULTS = {
  serverUrl: service.DAGOTE_SERVER_URL,
  apiKey: '',
  model: service.DEFAULT_MODEL,
  pickEnabled: false,
};
const CUSTOM_MODEL = '__custom__';
const $ = (id) => document.getElementById(id);

function setStatus(text, cls) {
  $('status').textContent = text;
  $('status').className = cls || '';
}

function modelLabel(model) {
  if (model?.hf_id && model.hf_id !== model.id) return `${model.id} — ${model.hf_id}`;
  return model?.id || '';
}

function fillModelSelect(models, selectedId) {
  const select = $('model');
  const list = Array.isArray(models) && models.length ? models : service.FALLBACK_MODELS;
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
  $('modelCustom').hidden = $('model').value !== CUSTOM_MODEL;
}

function readModelId() {
  if ($('model').value === CUSTOM_MODEL) return $('modelCustom').value.trim() || DEFAULTS.model;
  return ($('model').value || DEFAULTS.model).trim() || DEFAULTS.model;
}

function readSettings() {
  return {
    serverUrl: service.normalizeServerUrl($('serverUrl').value) || DEFAULTS.serverUrl,
    apiKey: $('apiKey').value.trim(),
    model: readModelId(),
  };
}

function paintPick(on) {
  const button = $('pick');
  button.classList.toggle('on', on);
  button.setAttribute('aria-pressed', on ? 'true' : 'false');
  button.textContent = on ? 'Pick mode ON' : 'Pick mode OFF';
}

let modelFetchGen = 0;

async function refreshModels({ quiet = false } = {}) {
  const gen = ++modelFetchGen;
  const selectedAtStart = readModelId();
  const serverUrl = service.normalizeServerUrl($('serverUrl').value) || DEFAULTS.serverUrl;
  const apiKey = $('apiKey').value.trim();
  try {
    const parsed = await service.fetchModelList(serverUrl, fetch, apiKey);
    if (gen !== modelFetchGen) return parsed;
    fillModelSelect(parsed.models, selectedAtStart);
    return parsed;
  } catch (error) {
    if (gen !== modelFetchGen) return null;
    fillModelSelect(service.FALLBACK_MODELS, selectedAtStart);
    if (!quiet) {
      setStatus(`Model list unavailable (${service.redactSecret(error?.message || error, apiKey)}). Fallback ids kept.`, '');
    }
    return null;
  }
}

async function save() {
  const settings = readSettings();
  await chrome.storage.sync.set(settings);
  $('serverUrl').value = settings.serverUrl;
  return settings;
}

async function armTab(on) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab');
  const url = tab.url || '';
  if (url && !/^https?:/i.test(url)) {
    throw new Error('This page is not http(s). Open a normal page, then turn pick mode on.');
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'JEV_PICK_SET', pickEnabled: on });
    return;
  } catch {
    /* content script is not on this tab yet */
  }
  if (!on) return;
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['collect.js', 'content.js'],
  });
}

async function togglePick() {
  const next = $('pick').getAttribute('aria-pressed') !== 'true';
  await save();
  await chrome.storage.sync.set({ pickEnabled: next });
  paintPick(next);
  await armTab(next);
  setStatus(
    next
      ? 'Pick mode ON. Hover an element, then click. Esc cancels.'
      : 'Pick mode OFF.',
    'ok',
  );
}

async function load() {
  const manifest = chrome.runtime.getManifest();
  $('ver').textContent = `v${manifest.version}`;
  const data = await chrome.storage.sync.get(DEFAULTS);
  $('serverUrl').value = data.serverUrl || DEFAULTS.serverUrl;
  $('apiKey').value = data.apiKey || '';
  fillModelSelect(service.FALLBACK_MODELS, data.model || DEFAULTS.model);
  paintPick(data.pickEnabled === true);
  await refreshModels({ quiet: true });
}

$('model').onchange = () => syncCustomModel();
$('refreshModels').onclick = () =>
  refreshModels({ quiet: false }).then((listed) => {
    if (listed) setStatus('Model list updated.', 'ok');
  });
$('save').onclick = () =>
  save()
    .then(() => refreshModels({ quiet: true }))
    .then((listed) => setStatus(listed ? 'Saved.' : 'Saved. Model list could not be refreshed; fallback ids kept.', 'ok'))
    .catch((error) => setStatus(service.redactSecret(error?.message || error, $('apiKey').value.trim()), 'bad'));
$('pick').onclick = () => togglePick().catch((error) => setStatus(service.redactSecret(error?.message || error, $('apiKey').value.trim()), 'bad'));

load().catch((error) => setStatus(service.redactSecret(error?.message || error, ''), 'bad'));
