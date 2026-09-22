const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

test('review page shows candidate count and discovery reasons', async () => {
  const html = fs.readFileSync(path.join(__dirname, 'review.html'), 'utf8');
  const { document } = parseHTML(html);
  const sample = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'decision-log.sample.json'), 'utf8');
  const context = {
    document,
    console,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    fetch: async () => ({ ok: true, status: 200, text: async () => sample }),
    location: {
      protocol: 'http:',
      href: 'http://127.0.0.1:8766/extension/review.html?fixture=1&filter=all',
      search: '?fixture=1&filter=all',
    },
  };
  context.globalThis = context;
  context.window = context;
  vm.runInNewContext(
    [
      fs.readFileSync(path.join(__dirname, 'decision-log.js'), 'utf8'),
      fs.readFileSync(path.join(__dirname, 'review.js'), 'utf8'),
    ].join('\n'),
    context,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  const summary = document.getElementById('summary').textContent;
  assert.match(summary, /candidates 3/);
  assert.match(summary, /Found via iframe 1/);
  assert.match(summary, /fixed_overlay 1/);

  const list = document.getElementById('list').textContent;
  assert.match(list, /Found via iframe/);
  assert.match(list, /src https:\/\/12ezo5v60\.com\/inpage\.js/);
  assert.match(list, /Found via fixed_overlay/);
  assert.match(document.getElementById('status').textContent, /dry fixture/);
});
