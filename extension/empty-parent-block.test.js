const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'issue6-empty-parent.html');

function loadContent(document) {
  const view = document?.defaultView;
  const context = {
    console,
    setTimeout,
    clearTimeout,
    getComputedStyle(el) {
      if (view && view.getComputedStyle) return view.getComputedStyle(el);
      return { position: '' };
    },
    Element: view?.Element || class Element {},
    location: { href: 'https://canyoublockit.com/extreme-test/', hostname: 'canyoublockit.com' },
    self: {},
    window: view || { addEventListener() {} },
    document: document || { addEventListener() {}, documentElement: { appendChild() {} }, querySelectorAll: () => [] },
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
  return context;
}

test('issue 6: Block path removes ad then collapses empty wrappers; heading stays', () => {
  const { document } = parseHTML(fs.readFileSync(FIXTURE, 'utf8'));
  const rows = loadContent(document).removeAdvertisementWidgets(document);
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

test('layout-shell hide collapses an empty h-full ad rail; heading and main stay', () => {
  const { document } = parseHTML(`<!doctype html><body>
    <main>
      <h1>Caution1</h1>
      <p id="content">Main content stays</p>
      <div id="grid" class="grid">
        <div id="rail" class="h-full w-full">
          <iframe id="ad" src="https://ads.example/slot" width="300" height="600"></iframe>
        </div>
        <div id="story"><h2>Keep this heading</h2></div>
      </div>
    </main>
  </body>`);
  const creative = document.querySelector('#ad');
  creative.getBoundingClientRect = () => ({ width: 300, height: 600, top: 0, left: 0, right: 300, bottom: 600 });
  const outcome = loadContent(document).hideEl(document.querySelector('#rail'), 0.9, false);
  assert.equal(outcome.removed, true);
  assert.ok(outcome.cascade.some((parent) => parent.idAttr === 'rail' && parent.reason === 'empty_parent'));
  assert.equal(document.querySelector('#rail'), null);
  assert.equal(document.querySelector('#ad'), null);
  assert.ok(document.querySelector('#grid'));
  assert.ok(document.querySelector('#story'));
  assert.match(document.querySelector('h2').textContent, /Keep this heading/);
  assert.ok(document.querySelector('main'));
  assert.match(document.querySelector('h1').textContent, /Caution1/);
  assert.match(document.querySelector('#content').textContent, /Main content stays/);
});

test('blank iframe does not pin an ad slot; real heading inside a rail stays', () => {
  const { document } = parseHTML(`<!doctype html><body>
    <main>
      <h1>Caution1</h1>
      <div id="slot">
        <iframe id="ad" src="https://ads.example/unit" width="300" height="250"></iframe>
        <iframe id="blank" src="about:blank" width="300" height="250"></iframe>
      </div>
      <div id="rail" class="h-full w-full">
        <h2>Keep this heading</h2>
        <iframe id="creative" src="https://ads.example/creative" width="300" height="250"></iframe>
      </div>
    </main>
  </body>`);
  const api = loadContent(document);
  const slotOutcome = api.hideEl(document.querySelector('#ad'), 0.9, false);
  assert.equal(slotOutcome.removed, true);
  assert.equal(document.querySelector('#slot'), null);
  assert.equal(document.querySelector('#blank'), null);

  const railOutcome = api.hideEl(document.querySelector('#rail'), 0.9, false);
  assert.equal(railOutcome.removed, true);
  assert.equal(document.querySelector('#creative'), null);
  assert.ok(document.querySelector('#rail'));
  assert.match(document.querySelector('#rail').textContent, /Keep this heading/);
  assert.ok(document.querySelector('main'));
  assert.match(document.querySelector('h1').textContent, /Caution1/);
});
