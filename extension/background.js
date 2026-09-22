/** Adgate 0.0.0 — service worker (only place that fetch()es LAN HTTP). */

const DEFAULTS = {
  enabled: true,
  blockEnabled: false,
  hideMin: 0.75,
  showLabels: true,
  showPanel: true,
  maxElements: 16,
  serverUrl: 'http://192.168.0.119:8770',
};

const VERSION = '0.0.3';
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

pushLog('info', 'bg_start', { version: VERSION });

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
