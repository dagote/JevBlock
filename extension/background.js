/** Adgate 0.1.7 — service worker. page-judge and log fetch live here. */

importScripts('page-judge-flight.js');
importScripts('service-link.js');

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
  maxElements: 24,
  serverUrl: 'https://www.dagote.ai/api/jev',
  apiKey: '',
  model: 'jev-tiny',
};

const VERSION = '0.1.7';
const PAGE_JUDGE_BUSY_ATTEMPTS = 30;
const RULESET_ID = 'ad_hosts';
const EARLY_ID = 'adgate-early';
// Do not destructure PAGE_JUDGE_TIMEOUT_MS / createPageJudgeFlight into this
// scope: importScripts shares the service-worker global, and a leaked binding
// with the same name throws "already been declared".
const pageJudgeApi = self.AdgatePageJudgeFlight;
if (!pageJudgeApi || typeof pageJudgeApi.createPageJudgeFlight !== 'function') {
  throw new Error('AdgatePageJudgeFlight missing after importScripts(page-judge-flight.js)');
}
const pageJudgeFlight = pageJudgeApi.createPageJudgeFlight(pageJudgeApi.PAGE_JUDGE_TIMEOUT_MS);
const serviceLink = self.AdgateServiceLink;
if (!serviceLink || typeof serviceLink.buildPageJudgeRequest !== 'function') {
  throw new Error('AdgateServiceLink missing after importScripts(service-link.js)');
}
const logBuffer = [];
let sessionId = null;

function pushLog(level, event, fields) {
  const entry = { ts: new Date().toISOString(), level, event, ...(fields || {}) };
  logBuffer.push(entry);
  if (logBuffer.length > 200) logBuffer.shift();
  console.log(`[adgate-bg] ${level} ${event}`, fields || {});
  chrome.storage.local.set({ adgateLastLogs: logBuffer.slice(-80) }).catch(() => {});
}

async function ensureSession() {
  if (sessionId) return sessionId;
  const data = await chrome.storage.local.get(['adgateSessionId']);
  sessionId =
    data.adgateSessionId ||
    `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await chrome.storage.local.set({ adgateSessionId: sessionId });
  return sessionId;
}

async function loadStoredSettings() {
  const data = await chrome.storage.sync.get(null);
  const migrated = serviceLink.migrateStoredSettings(data);
  if (migrated.changed) await chrome.storage.sync.set(migrated.patch);
  return { ...DEFAULTS, ...data, ...migrated.patch };
}

async function shipEntries(settings, sid, entries, client) {
  if (!entries?.length) return { shipped: 0 };
  const req = serviceLink.buildLogRequest(settings, {
    sessionId: sid,
    client,
    entries,
  });
  const res = await fetch(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify(req.body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { shipped: entries.length };
}

async function flushLogs(settings) {
  if (!logBuffer.length) return { shipped: 0 };
  const sid = await ensureSession();
  const entries = logBuffer.splice(0, logBuffer.length);
  try {
    return await shipEntries(settings, sid, entries, `extension-bg-${VERSION}`);
  } catch (e) {
    logBuffer.unshift(...entries);
    return { shipped: 0, error: serviceLink.redactSecret(e.message || e, settings?.apiKey) };
  }
}

async function syncBlockRules(blockEnabled) {
  if (!chrome.declarativeNetRequest?.updateEnabledRulesets) return;
  await chrome.declarativeNetRequest.updateEnabledRulesets({
    enableRulesetIds: blockEnabled ? [RULESET_ID] : [],
    disableRulesetIds: blockEnabled ? [] : [RULESET_ID],
  });
  pushLog('info', 'dnr_sync', { blockEnabled: !!blockEnabled });
}

async function syncEarlyScript(enabled) {
  if (!chrome.scripting?.registerContentScripts) return;
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [EARLY_ID] });
  if (enabled && !existing.length) {
    await chrome.scripting.registerContentScripts([
      {
        id: EARLY_ID,
        matches: ['http://*/*', 'https://*/*'],
        js: ['early.js'],
        runAt: 'document_start',
        world: 'MAIN',
        persistAcrossSessions: true,
      },
    ]);
  } else if (!enabled && existing.length) {
    await chrome.scripting.unregisterContentScripts({ ids: [EARLY_ID] });
  }
  pushLog('info', 'early_sync', { enabled: !!enabled });
}

function sleepWithSignal(ms, signal) {
  if (signal?.aborted) {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  }
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function judgeFailureMessage(data, text, status) {
  if (data && typeof data === 'object') {
    if (typeof data.detail === 'string' && data.detail) return data.detail;
    if (typeof data.error === 'string' && data.error) return data.error;
    if (data.error && typeof data.error === 'object' && data.error.message) {
      return String(data.error.message);
    }
  }
  return text || `HTTP ${status}`;
}

async function postPageJudge(req, flightHandle) {
  for (let attempt = 1; attempt <= PAGE_JUDGE_BUSY_ATTEMPTS; attempt += 1) {
    if (!flightHandle.isCurrent() || flightHandle.signal.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }
    const res = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: flightHandle.signal,
    });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    const retryAfterHeader = typeof res.headers?.get === 'function' ? res.headers.get('Retry-After') : '';
    const delayMs = serviceLink.pageJudgeBusyDelayMs({
      status: res.status,
      data,
      text,
      retryAfterHeader,
    });
    if (delayMs != null && attempt < PAGE_JUDGE_BUSY_ATTEMPTS && flightHandle.isCurrent()) {
      const waitMs = delayMs > 0 ? delayMs : 250;
      pushLog('info', 'page_judge_busy', {
        attempt,
        status: res.status,
        retryAfterMs: waitMs,
      });
      await sleepWithSignal(waitMs, flightHandle.signal);
      continue;
    }
    if (!res.ok || delayMs != null) {
      throw new Error(judgeFailureMessage(data, text, res.status));
    }
    if (!data || typeof data !== 'object') {
      throw new Error(text || `HTTP ${res.status}`);
    }
    return data;
  }
  throw new Error('page_judge_busy');
}

async function applyRuntimeSettings(settings) {
  try {
    await syncBlockRules(settings.blockEnabled === true);
  } catch (e) {
    pushLog('warn', 'dnr_sync_fail', { error: String(e.message || e) });
  }
  try {
    await syncEarlyScript(settings.extremeEarly === true);
  } catch (e) {
    pushLog('warn', 'early_sync_fail', { error: String(e.message || e) });
  }
}

async function openReview() {
  const url = chrome.runtime.getURL('review.html');
  const stored = await chrome.storage.session.get(['reviewTabId']);
  const existingId = stored.reviewTabId;
  if (existingId != null) {
    try {
      const tab = await chrome.tabs.get(existingId);
      if (!tab.url || tab.url === url) {
        await chrome.tabs.update(existingId, { active: true });
        if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
        return { ok: true, focused: true };
      }
    } catch {
      /* review tab was closed */
    }
  }
  const created = await chrome.tabs.create({ url });
  if (created?.id != null) await chrome.storage.session.set({ reviewTabId: created.id });
  return { ok: true, created: true };
}

pushLog('info', 'bg_start', { version: VERSION, pageJudgeTimeoutMs: pageJudgeApi.PAGE_JUDGE_TIMEOUT_MS });
loadStoredSettings()
  .then((settings) => applyRuntimeSettings(settings))
  .catch((e) => pushLog('warn', 'boot_settings_fail', { error: String(e.message || e) }));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabUrl = sender.tab?.url || '';

  if (message?.type === 'ADGATE_PING') {
    sendResponse({ ok: true, version: VERSION, awake: true });
    return true;
  }

  if (message?.type === 'ADGATE_LOG') {
    pushLog(message.level || 'info', message.event || 'client', {
      tabUrl,
      ...(message.fields || {}),
    });
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === 'ADGATE_SHIP_LOGS') {
    (async () => {
      const settings = await loadStoredSettings();
      try {
        const sid = message.sessionId || (await ensureSession());
        sendResponse(
          await shipEntries(settings, sid, message.entries || [], 'extension-content'),
        );
      } catch (e) {
        sendResponse({ shipped: 0, error: serviceLink.redactSecret(e.message || e, settings.apiKey) });
      }
    })();
    return true;
  }

  if (message?.type === 'ADGATE_FLUSH_LOGS') {
    loadStoredSettings().then((s) => flushLogs(s).then(sendResponse));
    return true;
  }

  if (message?.type === 'ADGATE_OPEN_REVIEW') {
    openReview()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }

  if (message?.type === 'ADGATE_APPLY_SETTINGS') {
    applyRuntimeSettings(message.settings || {})
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }

  if (message?.type === 'ADGATE_PAGE_JUDGE') {
    (async () => {
      const flightHandle = pageJudgeFlight.begin();
      try {
        const settings = await loadStoredSettings();
        const sid = await ensureSession();
        const req = serviceLink.buildPageJudgeRequest(settings, {
          page: message.page,
          elements: message.elements || [],
          hideMin: message.hideMin ?? settings.hideMin ?? 0.75,
          sessionId: sid,
          client: `extension-bg-${VERSION}`,
        });
        const body = req.body;
        pushLog('info', 'page_judge_fetch', {
          url: message.page?.url,
          n: body.elements.length,
          sessionId: sid,
          gen: flightHandle.gen,
          timeoutMs: pageJudgeApi.PAGE_JUDGE_TIMEOUT_MS,
          model: body.model,
          hasApiKey: Boolean(req.headers['x-api-key']),
        });
        const data = await postPageJudge(req, flightHandle);
        if (!flightHandle.isCurrent()) {
          pushLog('info', 'page_judge_superseded', { gen: flightHandle.gen, requestId: data.requestId });
          sendResponse({ error: 'page_judge_superseded' });
          return;
        }
        pushLog('info', 'page_judge_ok', {
          requestId: data.requestId,
          site_type: data.site_type,
          ms: data.ms,
          hides: (data.elements || []).filter((e) => e.action === 'hide').length,
        });
        await flushLogs(settings);
        sendResponse(data);
      } finally {
        flightHandle.done();
      }
    })().catch(async (err) => {
      const settings = await loadStoredSettings().catch(() => DEFAULTS);
      const msg = serviceLink.redactSecret(err.message || err, settings.apiKey);
      const aborted = /abort/i.test(msg) || err?.name === 'AbortError';
      pushLog('error', 'page_judge_fail', {
        error: msg,
        tabUrl,
        aborted,
      });
      await flushLogs(settings);
      sendResponse({
        error: aborted ? `page_judge_aborted: ${msg}` : msg,
      });
    });
    return true;
  }

  return false;
});

setInterval(() => {
  loadStoredSettings().then((s) => flushLogs(s)).catch(() => {});
}, 5000);
