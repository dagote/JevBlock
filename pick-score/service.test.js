const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const adgate = require('../extension/service-link.js');
const {
  DAGOTE_SERVER_URL,
  DEFAULT_MODEL,
  HIDE_MIN,
  FALLBACK_MODELS,
  buildPageJudgeRequest,
  modelListUrls,
  redactSecret,
  pageJudgeBusyDelayMs,
  fetchModelList,
} = require('./service.js');

test('page-judge request matches Adgate service-link', () => {
  const settings = {
    serverUrl: 'https://www.dagote.ai/api/jev/',
    apiKey: 'secret-key',
    model: 'jev-3b',
    hideMin: 0.8,
  };
  const payload = {
    page: { url: 'https://example.com/', hostname: 'example.com', title: 'Example', excerpt: '', headings: [] },
    elements: [{ id: 'e0', tag: 'div' }],
    hideMin: 0.75,
    sessionId: 's1',
    client: 'jev-pick-score-0.1.0',
  };
  const req = buildPageJudgeRequest(settings, payload);
  assert.deepEqual(req, adgate.buildPageJudgeRequest(settings, payload));
  assert.equal(req.url, 'https://www.dagote.ai/api/jev/v1/page-judge');
  assert.equal(req.headers['x-api-key'], 'secret-key');
  assert.equal(req.body.model, 'jev-3b');
  assert.equal(req.body.hideMin, 0.75);
  assert.equal(req.body.elements.length, 1);
  assert.equal(req.body.elements[0].id, 'e0');
  assert.equal(JSON.stringify(req.body).includes('secret-key'), false);
});

test('blank key is omitted and blank model falls back to jev-tiny', () => {
  assert.equal(DAGOTE_SERVER_URL, 'https://www.dagote.ai/api/jev');
  assert.equal(DEFAULT_MODEL, 'jev-tiny');
  assert.equal(HIDE_MIN, 0.75);
  assert.deepEqual(
    FALLBACK_MODELS.map((row) => row.id),
    ['jev-tiny', 'jev-latest', 'jev-3b'],
  );
  const req = buildPageJudgeRequest(
    { serverUrl: '', apiKey: '   ', model: '  ' },
    { page: { url: 'https://example.com/' }, elements: [] },
  );
  assert.deepEqual(req, adgate.buildPageJudgeRequest(
    { serverUrl: '', apiKey: '   ', model: '  ' },
    { page: { url: 'https://example.com/' }, elements: [] },
  ));
  assert.equal(Object.hasOwn(req.headers, 'x-api-key'), false);
  assert.equal(req.body.model, 'jev-tiny');
  assert.equal(req.body.hideMin, 0.75);
});

test('model list URLs and busy delay match Adgate', () => {
  const serverUrl = 'https://www.dagote.ai/api/jev';
  assert.deepEqual(modelListUrls(serverUrl), adgate.modelListUrls(serverUrl));
  const cases = [
    { status: 429, data: { retryAfter: 3, error: 'Already generating a reply' } },
    { status: 200, data: { elements: [{ text: 'Already generating a reply' }] } },
    { status: 500, data: { error: 'nope' } },
    { status: 429, data: { retryAfter: 9999 } },
  ];
  for (const row of cases) {
    assert.equal(pageJudgeBusyDelayMs(row), adgate.pageJudgeBusyDelayMs(row));
  }
});

test('redactSecret strips the api key and fetch errors are redacted', async () => {
  assert.equal(redactSecret('bad secret-key in url', 'secret-key'), 'bad [redacted] in url');
  await assert.rejects(
    () =>
      fetchModelList('https://www.dagote.ai/api/jev', async () => {
        throw new Error('network secret-key failed');
      }, 'secret-key'),
    /\[redacted\]/,
  );
});

test('background posts one element and does not log the api key', () => {
  const background = fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8');
  assert.match(background, /buildPageJudgeRequest/);
  assert.match(background, /hideMin: service\.HIDE_MIN/);
  assert.match(background, /elements: \[element\]/);
  assert.match(background, /redactSecret|safeError/);
  assert.match(background, /hasApiKey/);
  assert.doesNotMatch(background, /force_hide|forceHide/);
  assert.doesNotMatch(background, /console\.(log|info|warn|error|debug)\([^;\n]*headers/);
  assert.doesNotMatch(background, /sk-[A-Za-z0-9]{8,}/);
});
