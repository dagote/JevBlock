/** Legacy Extreme force_hide_* helpers. Product Block path requires forceHideCheats. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'issue3-ad-com-link.html');

function loadRemover() {
  const context = {
    console,
    setTimeout,
    clearTimeout,
    getComputedStyle() {
      return { position: '' };
    },
    Element: class Element {},
    location: { href: 'https://canyoublockit.com/extreme-test/', hostname: 'canyoublockit.com' },
    self: {},
    window: { addEventListener() {} },
    document: { addEventListener() {}, documentElement: { appendChild() {} }, querySelectorAll: () => [] },
    chrome: {
      runtime: {
        lastError: null,
        onMessage: { addListener() {} },
        sendMessage() {
          return Promise.resolve();
        },
      },
      storage: {
        onChanged: { addListener() {} },
        sync: {
          get: async () => ({ uiRev: 1, enabled: false }),
          set: async () => {},
        },
        local: { get: async () => ({}), set: async () => {} },
      },
    },
  };
  context.globalThis = context;
  context.AdgateCollapse = require('./empty-parent.js');
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'content.js'), 'utf8'), context);
  return context.removeAdComLinks;
}

test('issue 3: ad.com anchor is force-hidden; heading and help stay', () => {
  const src = fs.readFileSync(path.join(__dirname, 'content.js'), 'utf8');
  const run = src.slice(src.indexOf('async function runJudge'), src.indexOf('async function safeJudge'));
  const hideAt = run.indexOf('removeAdComLinks(document)');
  const judgeAt = run.indexOf('classifyPicked(');
  assert.ok(hideAt > 0 && hideAt < judgeAt);
  assert.match(src, /type: 'ADGATE_PAGE_JUDGE'/);

  const { document } = parseHTML(fs.readFileSync(FIXTURE, 'utf8'));
  const rows = loadRemover()(document);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, 'force_hide_ad_com_link');
  assert.equal(rows[0].removed, true);
  assert.equal(document.querySelector('a[href="ad.com"]'), null);
  assert.equal(document.querySelector('#ad-link'), null);
  const heading = document.querySelector('h1');
  assert.ok(heading);
  assert.match(heading.textContent, /Keep this heading/);
  const help = document.querySelector('#help');
  assert.ok(help);
  assert.match(help.textContent, /Direct Link Ads/);
  assert.match(help.textContent, /direct link to an Ad/i);
});
