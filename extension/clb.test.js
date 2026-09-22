/** Legacy Extreme force_hide_* helpers. Product Block path requires forceHideCheats. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'issue2-clb-container.html');

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
  return context.removeClbContainers;
}

test('issue 2: __clb container is force-hidden and the heading stays', () => {
  const src = fs.readFileSync(path.join(__dirname, 'content.js'), 'utf8');
  const hideAt = src.indexOf('removeClbContainers(document)');
  const judgeAt = src.indexOf("type: 'ADGATE_PAGE_JUDGE'");
  assert.ok(hideAt > 0 && hideAt < judgeAt);

  const { document } = parseHTML(fs.readFileSync(FIXTURE, 'utf8'));
  const rows = loadRemover()(document);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, 'force_hide_clb_container');
  assert.equal(rows[0].removed, true);
  assert.equal(document.querySelector('#__clb-1837835_1_container'), null);
  assert.equal(document.querySelector('[id*="__clb-"]'), null);
  const heading = document.querySelector('h1');
  assert.ok(heading);
  assert.match(heading.textContent, /Keep this heading/);
});
