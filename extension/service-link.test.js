const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  DAGOTE_SERVER_URL,
  OLD_LAN_SERVER_URL,
  DEFAULT_MODEL,
  FALLBACK_MODELS,
  migrateStoredSettings,
  buildPageJudgeRequest,
  buildLogRequest,
  modelListUrls,
  parseModelsPayload,
  fetchModelList,
  redactSecret,
} = require('./service-link.js');

test('default service URL is Dagote hosted JEV', () => {
  assert.equal(DAGOTE_SERVER_URL, 'https://www.dagote.ai/api/jev');
  assert.equal(DEFAULT_MODEL, 'jev-latest');
  assert.deepEqual(
    FALLBACK_MODELS.map((row) => row.id),
    ['jev-tiny', 'jev-latest', 'jev-3b'],
  );
});

test('page-judge request sends explicit model and x-api-key', () => {
  const req = buildPageJudgeRequest(
    {
      serverUrl: 'https://www.dagote.ai/api/jev/',
      apiKey: 'secret-key',
      model: 'jev-3b',
      hideMin: 0.8,
    },
    {
      page: { url: 'https://example.com/' },
      elements: [{ id: 'e0' }],
      hideMin: 0.7,
      sessionId: 's1',
      client: 'test',
    },
  );
  assert.equal(req.url, 'https://www.dagote.ai/api/jev/v1/page-judge');
  assert.equal(req.headers['Content-Type'], 'application/json');
  assert.equal(req.headers['x-api-key'], 'secret-key');
  assert.equal(req.body.model, 'jev-3b');
  assert.equal(req.body.hideMin, 0.7);
  assert.equal(req.body.sessionId, 's1');
  assert.equal(JSON.stringify(req.body).includes('secret-key'), false);
});

test('blank api key is omitted and blank model falls back to jev-latest', () => {
  const req = buildPageJudgeRequest(
    { serverUrl: '', apiKey: '   ', model: '  ' },
    { page: { url: 'https://example.com/' }, elements: [] },
  );
  assert.equal(req.url, `${DAGOTE_SERVER_URL}/v1/page-judge`);
  assert.equal(Object.hasOwn(req.headers, 'x-api-key'), false);
  assert.equal(req.body.model, 'jev-latest');
});

test('log request sends the key header and does not require model', () => {
  const req = buildLogRequest(
    { serverUrl: OLD_LAN_SERVER_URL, apiKey: 'lan-optional', model: 'jev-tiny' },
    { sessionId: 's2', client: 'extension-bg', entries: [{ event: 'boot' }] },
  );
  assert.equal(req.url, 'http://192.168.0.119:8770/v1/log');
  assert.equal(req.headers['x-api-key'], 'lan-optional');
  assert.equal(Object.hasOwn(req.body, 'model'), false);
  assert.equal(req.body.entries.length, 1);
  assert.equal(JSON.stringify(req.body).includes('lan-optional'), false);
});

test('migration upgrades empty or old LAN URL once and keeps a custom URL', () => {
  const legacy = migrateStoredSettings({
    uiRev: 2,
    serverUrl: 'http://192.168.0.119:8770/',
    forceHideCheats: true,
    showLabels: true,
  });
  assert.equal(legacy.changed, true);
  assert.equal(legacy.patch.serverUrl, DAGOTE_SERVER_URL);
  assert.equal(legacy.patch.model, 'jev-latest');
  assert.equal(legacy.patch.apiKey, '');
  assert.equal(legacy.patch.uiRev, 3);
  assert.equal(Object.hasOwn(legacy.patch, 'forceHideCheats'), false);
  assert.equal(Object.hasOwn(legacy.patch, 'showLabels'), false);

  const custom = migrateStoredSettings({
    uiRev: 2,
    serverUrl: 'http://10.0.0.8:8770/',
    apiKey: 'kept',
    model: 'jev-tiny',
  });
  assert.equal(Object.hasOwn(custom.patch, 'serverUrl'), false);
  assert.equal(custom.patch.uiRev, 3);
  assert.equal(Object.hasOwn(custom.patch, 'apiKey'), false);
  assert.equal(Object.hasOwn(custom.patch, 'model'), false);

  const typedLanAfterUpgrade = migrateStoredSettings({
    uiRev: 3,
    serverUrl: OLD_LAN_SERVER_URL,
    model: 'jev-tiny',
    apiKey: 'k',
  });
  assert.equal(typedLanAfterUpgrade.changed, false);

  const fresh = migrateStoredSettings({});
  assert.equal(fresh.patch.serverUrl, DAGOTE_SERVER_URL);
  assert.equal(fresh.patch.forceHideCheats, false);
  assert.equal(fresh.patch.reviewMode, true);
  assert.equal(fresh.patch.uiRev, 3);
});

test('model discovery uses /models and a parent path only after 404', async () => {
  assert.deepEqual(modelListUrls('https://www.dagote.ai/api/jev'), [
    'https://www.dagote.ai/api/jev/models',
    'https://www.dagote.ai/api/models',
  ]);
  assert.deepEqual(modelListUrls('http://192.168.0.119:8770'), [
    'http://192.168.0.119:8770/models',
  ]);

  const sample = {
    object: 'list',
    data: [
      { id: 'jev-tiny', hf_id: 'Qwen/Qwen2.5-0.5B-Instruct', aliases: ['jev-tiny'] },
      { id: 'jev-latest', hf_id: 'Qwen/Qwen2.5-1.5B-Instruct' },
    ],
    default: 'jev-latest',
    loaded: ['Qwen/Qwen2.5-0.5B-Instruct'],
  };
  const parsed = parseModelsPayload(sample);
  assert.equal(parsed.defaultModel, 'jev-latest');
  assert.deepEqual(
    parsed.models.map((row) => row.id),
    ['jev-tiny', 'jev-latest'],
  );

  const calls = [];
  const listed = await fetchModelList('https://www.dagote.ai/api/jev', async (url, init) => {
    calls.push(url);
    assert.equal(Object.hasOwn(init.headers, 'x-api-key'), false);
    return {
      status: 200,
      ok: true,
      json: async () => sample,
    };
  });
  assert.deepEqual(calls, ['https://www.dagote.ai/api/jev/models']);
  assert.equal(listed.models.length, 2);

  const parentCalls = [];
  const fromParent = await fetchModelList(
    'https://www.dagote.ai/api/jev',
    async (url, init) => {
      parentCalls.push(url);
      assert.equal(init.headers['x-api-key'], 'secret-key');
      if (url.endsWith('/api/jev/models')) return { status: 404, ok: false, json: async () => ({}) };
      return {
        status: 200,
        ok: true,
        json: async () => ({ data: [{ id: 'jev-3b', hf_id: 'Qwen/Qwen2.5-3B-Instruct' }], default: 'jev-3b' }),
      };
    },
    'secret-key',
  );
  assert.deepEqual(parentCalls, [
    'https://www.dagote.ai/api/jev/models',
    'https://www.dagote.ai/api/models',
  ]);
  assert.equal(fromParent.defaultModel, 'jev-3b');

  const networkCalls = [];
  await assert.rejects(
    fetchModelList('https://www.dagote.ai/api/jev', async (url) => {
      networkCalls.push(url);
      throw new Error('offline secret-key');
    }, 'secret-key'),
    /offline \[redacted\]/,
  );
  assert.deepEqual(networkCalls, ['https://www.dagote.ai/api/jev/models']);
});

test('redactSecret strips the api key and extension defaults name Dagote', () => {
  assert.equal(redactSecret('header secret-key failed', 'secret-key'), 'header [redacted] failed');
  assert.equal(redactSecret('no key', ''), 'no key');

  for (const file of ['popup.js', 'background.js', 'content.js']) {
    const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
    const defaults = src.match(/const DEFAULTS = \{[\s\S]*?\n\};/)?.[0] || '';
    assert.match(defaults, /serverUrl:\s*'https:\/\/www\.dagote\.ai\/api\/jev'/);
    assert.match(defaults, /apiKey:\s*''/);
    assert.match(defaults, /model:\s*'jev-latest'/);
    assert.match(defaults, /uiRev:\s*3/);
    assert.equal(defaults.includes(OLD_LAN_SERVER_URL), false);
  }
  const html = fs.readFileSync(path.join(__dirname, 'popup.html'), 'utf8');
  assert.match(html, /id="serverUrl"[^>]*value="https:\/\/www\.dagote\.ai\/api\/jev"/);
  assert.match(html, /id="apiKey"/);
  assert.match(html, /id="model"/);
  assert.match(html, /Service URL/);

  const background = fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8');
  assert.match(background, /importScripts\(['"]service-link\.js['"]\)/);
  assert.match(background, /buildPageJudgeRequest/);
  assert.match(background, /buildLogRequest/);
  assert.equal(/console\.log\([^)]*apiKey/.test(background), false);
});
