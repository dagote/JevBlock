/** Legacy Extreme force_hide_* helpers. Product Block path requires forceHideCheats. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'issue5-push-spam.html');

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
  return context.removePushSpam;
}

test('issue 5: interstitial, permission prompt, and push card are force-hidden; heading stays', () => {
  const src = fs.readFileSync(path.join(__dirname, 'content.js'), 'utf8');
  const hideAt = src.indexOf('removePushSpam(document)');
  const judgeAt = src.indexOf("type: 'ADGATE_PAGE_JUDGE'");
  assert.ok(hideAt > 0 && hideAt < judgeAt);

  const { document } = parseHTML(fs.readFileSync(FIXTURE, 'utf8'));
  const rows = loadRemover()(document);
  const byReason = Object.fromEntries(rows.map((row) => [row.reason, row]));
  assert.equal(rows.length, 3);
  assert.equal(byReason.force_hide_interstitial?.removed, true);
  assert.equal(byReason.force_hide_push_permission?.removed, true);
  assert.equal(byReason.force_hide_inpage_push?.removed, true);
  assert.equal(document.querySelector('#interstitial'), null);
  assert.equal(document.querySelector('#perm'), null);
  assert.equal(document.querySelector('#push-card'), null);
  const heading = document.querySelector('h1');
  assert.ok(heading);
  assert.match(heading.textContent, /Keep this heading/);
  const help = document.querySelector('#help');
  assert.ok(help);
  assert.match(help.textContent, /Push Notification Ads/);
});
