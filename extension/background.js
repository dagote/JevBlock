/** Adgate 0.0.4 — service worker (only place that fetch()es LAN HTTP). */

const DEFAULTS = {
  enabled: true,
  blockEnabled: false,
  reviewMode: true,
  hideMin: 0.75,
  showLabels: false,
  showPanel: false,
  extremeEarly: false,
  uiRev: 1,
  maxElements: 16,
  serverUrl: 'http://192.168.0.119:8770',
};

const VERSION = '0.0.4';
const RULESET_ID = 'ad_hosts';
const EARLY_ID = 'adgate-early';
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

async function shipEntries(serverUrl, sid, entries, client) {
  if (!entries?.length) return { shipped: 0 };
  const base = (serverUrl || DEFAULTS.serverUrl).replace(/\/$/, '');
  const res = await fetch(`${base}/v1/log`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: sid, client, entries }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { shipped: entries.length };
}

async function flushLogs(serverUrl) {
  if (!logBuffer.length) return { shipped: 0 };
  const sid = await ensureSession();
  const entries = logBuffer.splice(0, logBuffer.length);
  try {
    return await shipEntries(serverUrl, sid, entries, `extension-bg-${VERSION}`);
  } catch (e) {
    logBuffer.unshift(...entries);
    return { shipped: 0, error: String(e.message || e) };
  }
}

async function migrateUi() {
  const data = await chrome.storage.sync.get(null);
  if ((data.uiRev || 0) >= 1) return { ...DEFAULTS, ...data };
  const next = {
    ...DEFAULTS,
    ...data,
    showLabels: false,
    showPanel: false,
    reviewMode: true,
    uiRev: 1,
  };
  await chrome.storage.sync.set(next);
  return next;
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

pushLog('info', 'bg_start', { version: VERSION });
migrateUi()
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
      const settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
      try {
        const sid = message.sessionId || (await ensureSession());
        sendResponse(
          await shipEntries(settings.serverUrl, sid, message.entries || [], 'extension-content'),
        );
      } catch (e) {
        sendResponse({ shipped: 0, error: String(e.message || e) });
      }
    })();
    return true;
  }

  if (message?.type === 'ADGATE_FLUSH_LOGS') {
    chrome.storage.sync.get(DEFAULTS).then((s) => flushLogs(s.serverUrl).then(sendResponse));
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
      const settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
      const sid = await ensureSession();
      const base = settings.serverUrl.replace(/\/$/, '');
      const body = {
        page: message.page,
        elements: message.elements || [],
        hideMin: message.hideMin ?? settings.hideMin ?? 0.75,
        sessionId: sid,
        client: `extension-bg-${VERSION}`,
      };
      pushLog('info', 'page_judge_fetch', {
        url: message.page?.url,
        n: body.elements.length,
        sessionId: sid,
      });
      const res = await fetch(`${base}/v1/page-judge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180000),
      });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(text || `HTTP ${res.status}`);
      }
      if (!res.ok) throw new Error(data.detail || data.error || `HTTP ${res.status}`);
      pushLog('info', 'page_judge_ok', {
        requestId: data.requestId,
        site_type: data.site_type,
        ms: data.ms,
        hides: (data.elements || []).filter((e) => e.action === 'hide').length,
      });
      await flushLogs(settings.serverUrl);
      sendResponse(data);
    })().catch(async (err) => {
      pushLog('error', 'page_judge_fail', { error: String(err.message || err), tabUrl });
      const settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
      await flushLogs(settings.serverUrl);
      sendResponse({ error: String(err.message || err) });
    });
    return true;
  }

  return false;
});

setInterval(() => {
  chrome.storage.sync.get(DEFAULTS).then((s) => flushLogs(s.serverUrl));
}, 5000);
