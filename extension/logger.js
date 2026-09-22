/**
 * Page/content-script logger.
 * NEVER fetch() http:// from here — HTTPS pages block it (mixed content).
 * All shipping goes through the extension service worker.
 */
(function (global) {
  if (global.AdgateLog) return;
  const MAX_BUFFER = 200;
  const buffer = [];
  let sessionId = null;
  let shipping = false;

  function ensureSession() {
    if (sessionId) return Promise.resolve(sessionId);
    return chrome.storage.local.get(['adgateSessionId']).then((data) => {
      sessionId =
        data.adgateSessionId ||
        `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      return chrome.storage.local.set({ adgateSessionId: sessionId }).then(() => sessionId);
    });
  }

  function push(level, event, fields) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      event,
      ...(fields || {}),
    };
    buffer.push(entry);
    if (buffer.length > MAX_BUFFER) buffer.shift();
    try {
      const line = `[adgate] ${level} ${event} ${JSON.stringify(fields || {})}`;
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
    } catch {
      /* ignore */
    }
    chrome.storage.local.set({ adgateLastLogs: buffer.slice(-80) }).catch(() => {});
    return entry;
  }

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message || String(err)));
          else resolve(response);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  async function flush() {
    if (shipping || buffer.length === 0) return { shipped: 0 };
    shipping = true;
    const entries = buffer.splice(0, buffer.length);
    try {
      const sid = await ensureSession();
      const res = await sendMessage({
        type: 'ADGATE_SHIP_LOGS',
        sessionId: sid,
        entries,
      });
      if (res?.error) {
        buffer.unshift(...entries);
        push('error', 'log_ship_failed', { error: res.error });
        return { shipped: 0, error: res.error };
      }
      return { shipped: entries.length, sessionId: sid, ...(res || {}) };
    } catch (e) {
      buffer.unshift(...entries);
      // Don't recurse push→flush on connection errors during teardown
      try {
        console.warn('[adgate] log_ship_error', e.message || e);
      } catch {
        /* ignore */
      }
      return { shipped: 0, error: String(e.message || e) };
    } finally {
      shipping = false;
    }
  }

  setInterval(() => {
    flush().catch(() => {});
  }, 4000);

  global.AdgateLog = {
    info: (event, fields) => push('info', event, fields),
    warn: (event, fields) => push('warn', event, fields),
    error: (event, fields) => push('error', event, fields),
    flush,
    ensureSession,
    getBuffer: () => buffer.slice(),
    getSessionId: () => sessionId,
  };
})(typeof self !== 'undefined' ? self : window);
