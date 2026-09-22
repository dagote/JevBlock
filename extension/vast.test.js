const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'issue4-vast-slot.html');

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
  return context.removeVastSlots;
}

test('issue 4: VAST shortcode widget is force-hidden; heading and help stay', () => {
  const src = fs.readFileSync(path.join(__dirname, 'content.js'), 'utf8');
  const hideAt = src.indexOf('removeVastSlots(document)');
  const judgeAt = src.indexOf("type: 'ADGATE_PAGE_JUDGE'");
  assert.ok(hideAt > 0 && hideAt < judgeAt);

  const { document } = parseHTML(fs.readFileSync(FIXTURE, 'utf8'));
  const rows = loadRemover()(document);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, 'force_hide_vast_slot');
  assert.equal(rows[0].removed, true);
  assert.equal(document.querySelector('#vast'), null);
  assert.equal(document.querySelector('.elementor-element-99c1b2f'), null);
  const heading = document.querySelector('h1');
  assert.ok(heading);
  assert.match(heading.textContent, /Keep this heading/);
  const help = document.querySelector('#help');
  assert.ok(help);
  assert.match(help.textContent, /Did you receive an Ad before playing the video/);
});
