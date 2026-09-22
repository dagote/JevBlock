/**
 * Service URL, API key, and explicit model selection.
 *
 * Service worker: importScripts('service-link.js')
 * Popup / content: <script src="service-link.js">
 * Node tests: require('./service-link.js')
 *
 * Chrome MV3 evaluates importScripts in the same global lexical scope as the
 * service worker. Keep every binding inside this factory.
 *
 * apiKey is stored in chrome.storage.sync with the other settings. A key is a
 * short string, well under sync's 8KB per-item quota (QUOTA_BYTES_PER_ITEM),
 * so sync is the right store. Never log the key.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AdgateServiceLink = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DAGOTE_SERVER_URL = 'https://www.dagote.ai/api/jev';
  const OLD_LAN_SERVER_URL = 'http://192.168.0.119:8770';
  const DEFAULT_MODEL = 'jev-latest';
  const UI_REV = 3;
  const FALLBACK_MODELS = [
    { id: 'jev-tiny', hf_id: 'Qwen/Qwen2.5-0.5B-Instruct' },
    { id: 'jev-latest', hf_id: 'Qwen/Qwen2.5-1.5B-Instruct' },
    { id: 'jev-3b', hf_id: 'Qwen/Qwen2.5-3B-Instruct' },
  ];

  function normalizeServerUrl(url) {
    return String(url || '').trim().replace(/\/+$/, '');
  }

  function isLegacyServerUrl(url) {
    const normalized = normalizeServerUrl(url);
    if (!normalized) return true;
    return normalized.toLowerCase() === OLD_LAN_SERVER_URL;
  }

  /**
   * One-time upgrade to uiRev 3.
   * Empty or the old baked-in LAN default becomes the Dagote URL.
   * A custom URL is kept. After uiRev 3, typing the LAN URL back is kept too.
   */
  function migrateStoredSettings(stored) {
    const data = stored && typeof stored === 'object' ? stored : {};
    const patch = {};
    const rev = Number(data.uiRev) || 0;

    if (rev < 2) {
      patch.showLabels = false;
      patch.showPanel = false;
      patch.reviewMode = true;
      patch.forceHideCheats = false;
    }

    if (rev < UI_REV) {
      if (isLegacyServerUrl(data.serverUrl)) patch.serverUrl = DAGOTE_SERVER_URL;
      if (data.apiKey == null) patch.apiKey = '';
      if (!String(data.model || '').trim()) patch.model = DEFAULT_MODEL;
      patch.uiRev = UI_REV;
    } else {
      if (data.apiKey == null) patch.apiKey = '';
      if (!String(data.model || '').trim()) patch.model = DEFAULT_MODEL;
    }

    const changed = Object.keys(patch).some((key) => data[key] !== patch[key]);
    return { patch: changed ? patch : {}, changed };
  }

  function jsonHeaders(apiKey) {
    const headers = { 'Content-Type': 'application/json' };
    const key = String(apiKey || '').trim();
    if (key) headers['x-api-key'] = key;
    return headers;
  }

  function redactSecret(text, secret) {
    const key = String(secret || '').trim();
    const message = String(text || '');
    if (!key) return message;
    return message.split(key).join('[redacted]');
  }

  function buildPageJudgeRequest(settings, payload) {
    const cfg = settings || {};
    const bodyIn = payload || {};
    const base = normalizeServerUrl(cfg.serverUrl) || DAGOTE_SERVER_URL;
    const model = String(cfg.model || '').trim() || DEFAULT_MODEL;
    return {
      url: `${base}/v1/page-judge`,
      headers: jsonHeaders(cfg.apiKey),
      body: {
        page: bodyIn.page,
        elements: bodyIn.elements || [],
        hideMin: bodyIn.hideMin ?? cfg.hideMin ?? 0.75,
        sessionId: bodyIn.sessionId,
        client: bodyIn.client,
        model,
      },
    };
  }

  function buildLogRequest(settings, payload) {
    const cfg = settings || {};
    const bodyIn = payload || {};
    const base = normalizeServerUrl(cfg.serverUrl) || DAGOTE_SERVER_URL;
    return {
      url: `${base}/v1/log`,
      headers: jsonHeaders(cfg.apiKey),
      body: {
        sessionId: bodyIn.sessionId,
        client: bodyIn.client,
        entries: bodyIn.entries || [],
      },
    };
  }

  function modelListUrls(serverUrl) {
    const base = normalizeServerUrl(serverUrl) || DAGOTE_SERVER_URL;
    const primary = `${base}/models`;
    const urls = [primary];
    try {
      const parsed = new URL(base);
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length) {
        parts.pop();
        const parentPath = parts.length ? `/${parts.join('/')}` : '';
        const parent = `${parsed.origin}${parentPath}/models`;
        if (parent !== primary) urls.push(parent);
      }
    } catch {
      /* invalid URL: primary only */
    }
    return urls;
  }

  function parseModelsPayload(payload) {
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    const models = [];
    for (const row of rows) {
      const id = String(row?.id || '').trim();
      if (!id) continue;
      models.push({
        id,
        hf_id: row?.hf_id ? String(row.hf_id) : '',
        aliases: Array.isArray(row?.aliases) ? row.aliases.map(String) : [],
      });
    }
    return {
      models,
      defaultModel: String(payload?.default || '').trim(),
      loaded: Array.isArray(payload?.loaded) ? payload.loaded.map(String) : [],
    };
  }

  async function fetchModelList(serverUrl, fetchImpl, apiKey) {
    const fetchFn = fetchImpl;
    if (typeof fetchFn !== 'function') throw new Error('fetch unavailable');
    const urls = modelListUrls(serverUrl);
    const headers = {};
    const key = String(apiKey || '').trim();
    if (key) headers['x-api-key'] = key;
    const init = { method: 'GET', headers };
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      init.signal = AbortSignal.timeout(8000);
    }
    let lastStatus = 0;
    for (let i = 0; i < urls.length; i += 1) {
      const url = urls[i];
      let res;
      try {
        res = await fetchFn(url, init);
      } catch (error) {
        throw new Error(redactSecret(error?.message || error, key));
      }
      if (res.status === 404 && i < urls.length - 1) {
        lastStatus = 404;
        continue;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const payload = await res.json();
      const parsed = parseModelsPayload(payload);
      if (!parsed.models.length) throw new Error('model list empty');
      return parsed;
    }
    throw new Error(lastStatus ? `HTTP ${lastStatus}` : 'model list failed');
  }

  return {
    DAGOTE_SERVER_URL,
    OLD_LAN_SERVER_URL,
    DEFAULT_MODEL,
    UI_REV,
    FALLBACK_MODELS,
    normalizeServerUrl,
    isLegacyServerUrl,
    migrateStoredSettings,
    jsonHeaders,
    redactSecret,
    buildPageJudgeRequest,
    buildLogRequest,
    modelListUrls,
    parseModelsPayload,
    fetchModelList,
  };
});
