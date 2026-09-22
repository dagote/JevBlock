/**
 * Headless Chrome smoke: pick mode, trusted click, one page-judge POST.
 * Uses a local fake judge. Does not call Dagote and does not prove Extreme.
 *
 *   node pick-score/smoke.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = 'smoke-key';
const PAGE = `<!doctype html><html><head><title>Pick fixture</title></head><body>
<h1>Fixture</h1>
<p id="label">Sponsored</p>
<a id="target" href="https://example.com/away">Do not navigate</a>
</body></html>`;

function startServer() {
  let body = null;
  let sawKey = false;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/models')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'jev-tiny', hf_id: 'smoke' }], default: 'jev-tiny', loaded: [] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/page-judge') {
      sawKey = req.headers['x-api-key'] === API_KEY;
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          requestId: 'req_smoke',
          site_type: 'news',
          site_type_confidence: 0.8,
          site_type_probabilities: { news: 0.8 },
          elements: [{ id: 'e0', noul: 0.91, action: 'hide', reason: 'rank_ad', kind: 'ad', kindModel: 'ad' }],
          ms: 12,
          hideMin: 0.75,
          reviewMin: 0.45,
          jev_model: 'jev-tiny',
          truncated: false,
        }));
      });
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(PAGE);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, getBody: () => body, sawKey: () => sawKey }));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function poll(fn, ms, label) {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < ms) {
    try {
      const value = await fn();
      if (value) return value;
      last = JSON.stringify(value);
    } catch (error) {
      last = error?.message || String(error);
    }
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${label}: ${last}`);
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const logs = [];
  let next = 0;
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('devtools websocket failed')));
  });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.consoleAPICalled' || msg.method === 'Runtime.exceptionThrown') {
      logs.push(JSON.stringify(msg.params));
    }
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  });
  async function send(method, params = {}, sessionId) {
    const id = ++next;
    const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    ws.send(JSON.stringify(payload));
    return result;
  }
  return { ws, send, opened, logs };
}

async function main() {
  const api = await startServer();
  const base = `http://127.0.0.1:${api.port}`;
  const userData = mkdtempSync(path.join(tmpdir(), 'jev-pick-'));
  let browser = null;
  let devtools = null;
  const stderr = [];
  try {
    // Branded Chrome ignores --load-extension. --disable-extensions-except still
    // loads this folder when DisableDisableExtensionsExceptCommandLineSwitch is off.
    // Invoke the binary directly so a wrapper cannot pin another user-data-dir.
    const chromeBin = existsSync('/opt/google/chrome/chrome') ? '/opt/google/chrome/chrome' : 'google-chrome';
    browser = spawn(
      chromeBin,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check',
        '--remote-debugging-port=0',
        '--disable-features=DisableDisableExtensionsExceptCommandLineSwitch',
        `--user-data-dir=${userData}`,
        `--disable-extensions-except=${root}`,
        'about:blank',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const wsUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`chrome did not open devtools\n${stderr.join('')}`)), 20000);
      browser.stderr.on('data', (chunk) => {
        const text = String(chunk);
        stderr.push(text);
        const match = text.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      browser.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`chrome exited ${code}\n${stderr.join('')}`));
      });
    });
    devtools = connect(wsUrl);
    await devtools.opened;

    const worker = await poll(async () => {
      const { targetInfos } = await devtools.send('Target.getTargets');
      return targetInfos.find((target) => target.type === 'service_worker' && /background\.js$/.test(target.url || ''));
    }, 15000, 'service worker');
    const attached = await devtools.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
    const sw = attached.sessionId;
    await devtools.send('Runtime.enable', {}, sw);
    const stored = await devtools.send(
      'Runtime.evaluate',
      {
        awaitPromise: true,
        expression: `new Promise((resolve, reject) => {
          chrome.storage.sync.set(${JSON.stringify({
            serverUrl: base,
            apiKey: API_KEY,
            model: 'jev-tiny',
            pickEnabled: true,
          })}, () => {
            const err = chrome.runtime.lastError;
            if (err) reject(new Error(err.message));
            else resolve('stored');
          });
        })`,
      },
      sw,
    );
    if (stored.exceptionDetails) throw new Error(`storage set failed: ${JSON.stringify(stored.exceptionDetails)}`);

    const created = await devtools.send('Target.createTarget', { url: `${base}/page.html` });
    const pageAttached = await devtools.send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
    const page = pageAttached.sessionId;
    await devtools.send('Runtime.enable', {}, page);
    await devtools.send('Page.enable', {}, page);

    await poll(async () => {
      const result = await devtools.send(
        'Runtime.evaluate',
        {
          expression: `(() => {
            const badge = document.getElementById('jev-pick-score-root')?.shadowRoot?.querySelector('.badge');
            if (!badge || badge.hidden) return '';
            return 'armed';
          })()`,
          returnByValue: true,
        },
        page,
      );
      return result.result?.value || '';
    }, 10000, 'pick badge');

    const rect = await devtools.send(
      'Runtime.evaluate',
      {
        expression: `(() => {
          const r = document.getElementById('target').getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        })()`,
        returnByValue: true,
      },
      page,
    );
    const point = rect.result.value;
    await devtools.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' },
      page,
    );
    const outline = await poll(async () => {
      const result = await devtools.send(
        'Runtime.evaluate',
        {
          expression: `(() => {
            const box = document.getElementById('jev-pick-score-root')?.shadowRoot?.querySelector('.box');
            if (!box || box.style.display === 'none') return '';
            const width = parseFloat(box.style.width);
            return width > 0 ? 'outlined' : '';
          })()`,
          returnByValue: true,
        },
        page,
      );
      return result.result?.value || '';
    }, 5000, 'hover outline');
    if (outline !== 'outlined') throw new Error('hover outline missing');
    for (const type of ['mousePressed', 'mouseReleased']) {
      await devtools.send(
        'Input.dispatchMouseEvent',
        { type, x: point.x, y: point.y, button: 'left', clickCount: 1 },
        page,
      );
    }

    const panelText = await poll(async () => {
      const result = await devtools.send(
        'Runtime.evaluate',
        {
          expression: `(() => {
            const panel = document.getElementById('jev-pick-score-root')?.shadowRoot?.querySelector('.panel');
            if (!panel || panel.dataset.jevPickStatus !== 'ok') return '';
            return panel.innerText;
          })()`,
          returnByValue: true,
        },
        page,
      );
      return result.result?.value || '';
    }, 10000, 'score panel');

    const href = await devtools.send(
      'Runtime.evaluate',
      { expression: 'location.href', returnByValue: true },
      page,
    );
    const body = api.getBody();
    if (!body) throw new Error('page-judge was not called');
    if (!api.sawKey()) throw new Error('x-api-key header missing or wrong');
    if (JSON.stringify(body).includes(API_KEY)) throw new Error('api key leaked into the page-judge body');
    if (body.model !== 'jev-tiny') throw new Error(`model ${body.model}`);
    if (body.hideMin !== 0.75) throw new Error(`hideMin ${body.hideMin}`);
    if (!Array.isArray(body.elements) || body.elements.length !== 1) throw new Error('expected one element');
    if (body.elements[0].id !== 'e0') throw new Error(`element id ${body.elements[0].id}`);
    if (body.elements[0].tag !== 'a') throw new Error(`element tag ${body.elements[0].tag}`);
    if (body.elements[0].href !== 'https://example.com/away') throw new Error('href was not the clicked link');
    if (body.page?.title !== 'Pick fixture') throw new Error('page title missing');
    if (!String(href.result?.value || '').includes('/page.html')) throw new Error(`navigation was not cancelled: ${href.result?.value}`);
    for (const needle of ['ad', '0.910', '91%', 'rank_ad', 'news', 'req_smoke']) {
      if (!panelText.includes(needle)) throw new Error(`panel missing ${needle}`);
    }
    const leaked = devtools.logs.filter((line) => line.includes(API_KEY));
    if (leaked.length) throw new Error('api key appeared in extension console logs');

    for (const type of ['keyDown', 'keyUp']) {
      await devtools.send(
        'Input.dispatchKeyEvent',
        { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
        page,
      );
    }
    await poll(async () => {
      const result = await devtools.send(
        'Runtime.evaluate',
        {
          expression: `(() => {
            const shadow = document.getElementById('jev-pick-score-root')?.shadowRoot;
            const badge = shadow?.querySelector('.badge');
            const panel = shadow?.querySelector('.panel');
            if (!badge?.hidden) return '';
            if (panel?.dataset?.jevPickStatus !== 'ok') return '';
            return 'cancelled';
          })()`,
          returnByValue: true,
        },
        page,
      );
      return result.result?.value || '';
    }, 5000, 'escape cancels pick mode');
    console.log('smoke ok: hover outline, click stayed on the page, one page-judge call, panel showed kind/noul/site_type, Esc left the panel up');
  } finally {
    if (devtools) devtools.ws.close();
    if (browser) browser.kill('SIGKILL');
    await new Promise((resolve) => api.server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
