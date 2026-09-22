/** JEV Pick Score 0.1.0 — one-element page-judge. Classify only; never hides DOM. */

importScripts('service.js');

const service = self.JevPickService;
if (!service || typeof service.buildPageJudgeRequest !== 'function') {
  throw new Error('JevPickService missing after importScripts(service.js)');
}

const VERSION = '0.1.0';
const CLIENT = `jev-pick-score-${VERSION}`;
const TIMEOUT_MS = 600000;
const BUSY_ATTEMPTS = 20;

const DEFAULTS = {
  serverUrl: service.DAGOTE_SERVER_URL,
  apiKey: '',
  model: service.DEFAULT_MODEL,
  pickEnabled: false,
};

let flightGen = 0;
let flightController = null;
let sessionId = null;

function log(event, fields) {
  console.info(`[jev-pick] ${event}`, fields || {});
}

async function ensureSession() {
  if (sessionId) return sessionId;
  const data = await chrome.storage.local.get(['jevPickSessionId']);
  sessionId =
    data.jevPickSessionId ||
    `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await chrome.storage.local.set({ jevPickSessionId: sessionId });
  return sessionId;
}

async function loadSettings() {
  const data = await chrome.storage.sync.get(DEFAULTS);
  return {
    serverUrl: service.normalizeServerUrl(data.serverUrl) || DEFAULTS.serverUrl,
    apiKey: String(data.apiKey || '').trim(),
    model: String(data.model || '').trim() || DEFAULTS.model,
    pickEnabled: data.pickEnabled === true,
  };
}

function publicRequest(body) {
  return {
    page: body.page,
    elements: body.elements,
    hideMin: body.hideMin,
    model: body.model,
    client: body.client,
    sessionId: body.sessionId,
  };
}

function beginFlight() {
  flightGen += 1;
  const gen = flightGen;
  if (flightController) flightController.abort();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  flightController = controller;
  return {
    gen,
    signal: controller.signal,
    isCurrent: () => gen === flightGen,
    done() {
      clearTimeout(timer);
      if (flightController === controller) flightController = null;
    },
  };
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

function safeError(err, apiKey) {
  const msg = service.redactSecret(err?.message || err, apiKey);
  if (err?.name === 'AbortError' || /abort/i.test(msg)) return `page_judge_aborted: ${msg}`;
  return msg;
}

async function postPageJudge(req, flight) {
  for (let attempt = 1; attempt <= BUSY_ATTEMPTS; attempt += 1) {
    if (!flight.isCurrent() || flight.signal.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }
    const res = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: flight.signal,
    });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    const retryAfterHeader = typeof res.headers?.get === 'function' ? res.headers.get('Retry-After') : '';
    const delayMs = service.pageJudgeBusyDelayMs({
      status: res.status,
      data,
      text,
      retryAfterHeader,
    });
    if (delayMs != null && attempt < BUSY_ATTEMPTS && flight.isCurrent()) {
      log('page_judge_busy', { attempt, status: res.status, retryAfterMs: delayMs > 0 ? delayMs : 250 });
      await sleepWithSignal(delayMs > 0 ? delayMs : 250, flight.signal);
      continue;
    }
    if (!res.ok || delayMs != null) {
      const message = service.judgeErrorMessage(data) || text || `HTTP ${res.status}`;
      throw new Error(message);
    }
    if (!data || typeof data !== 'object') throw new Error(text || `HTTP ${res.status}`);
    return data;
  }
  throw new Error('page_judge_busy');
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'JEV_PICK_PING') {
    sendResponse({ ok: true, version: VERSION });
    return true;
  }

  if (message?.type !== 'JEV_PICK_SCORE') return false;

  const flight = beginFlight();
  (async () => {
    let apiKey = '';
    let request = null;
    try {
      const settings = await loadSettings();
      apiKey = settings.apiKey;
      const element = message.element && typeof message.element === 'object' ? { ...message.element, id: 'e0' } : null;
      if (!message.page || !element) {
        sendResponse({ ok: false, error: 'missing page or element' });
        return;
      }
      const sid = await ensureSession();
      const req = service.buildPageJudgeRequest(settings, {
        page: message.page,
        elements: [element],
        hideMin: service.HIDE_MIN,
        sessionId: sid,
        client: CLIENT,
      });
      request = publicRequest(req.body);
      log('page_judge_fetch', {
        url: message.page?.url,
        n: req.body.elements.length,
        model: req.body.model,
        hideMin: req.body.hideMin,
        hasApiKey: Boolean(req.headers['x-api-key']),
        timeoutMs: TIMEOUT_MS,
      });
      const data = await postPageJudge(req, flight);
      if (!flight.isCurrent()) {
        sendResponse({ ok: false, error: 'superseded', superseded: true, request });
        return;
      }
      log('page_judge_ok', {
        requestId: data.requestId,
        site_type: data.site_type,
        ms: data.ms,
        model: req.body.model,
        hasApiKey: Boolean(req.headers['x-api-key']),
      });
      sendResponse({ ok: true, request, response: data });
    } catch (err) {
      const error = safeError(err, apiKey);
      log('page_judge_fail', { error, aborted: /aborted/i.test(error) });
      sendResponse({ ok: false, error, request });
    } finally {
      flight.done();
    }
  })();
  return true;
});
