const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'issue6-empty-parent.html');

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
  return context.removeAdvertisementWidgets;
}

test('issue 6: Block path removes ad then collapses empty wrappers; heading stays', () => {
  const { document } = parseHTML(fs.readFileSync(FIXTURE, 'utf8'));
  const rows = loadRemover()(document);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].removed, true);
  assert.ok(rows[0].cascadeParents.length >= 2);
  assert.ok(rows[0].cascadeParents.every((parent) => parent.reason === 'empty_parent'));
  assert.equal(document.querySelector('#inner'), null);
  assert.equal(document.querySelector('#mid'), null);
  assert.equal(document.querySelector('#outer'), null);
  assert.equal(document.querySelector('script[src*="ybs2ffs7v.com"]'), null);
  const heading = document.querySelector('h1');
  assert.ok(heading);
  assert.match(heading.textContent, /Keep this heading/);
  const content = document.querySelector('#content');
  assert.ok(content);
  assert.match(content.textContent, /Main content stays/);
  assert.ok(document.querySelector('main'));
});
