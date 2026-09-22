const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');
const {
  NEIGHBORHOOD_MAX,
  collectNeighborhoodCandidates,
  neighborhoodWrapper,
  shouldRunNeighborhoodFollowup,
} = require('./candidates.js');

function widget(id, src) {
  return `<div class="elementor-widget elementor-widget-html" id="${id}" data-id="${id}">
    <div class="elementor-widget-container">
      <div class="code-block"><script src="${src}"></script></div>
    </div>
  </div>`;
}

function pageHtml(inner) {
  return `<!DOCTYPE html><html><body><main>${inner}</main></body></html>`;
}

function sectionHtml(inner) {
  return `<section class="elementor-section">
    <div class="elementor-container">
      <div class="elementor-column">
        <div class="elementor-widget-wrap">${inner}</div>
      </div>
    </div>
  </section>`;
}

test('neighborhood collects sibling widgets in the same wrap and skips page chrome', () => {
  const { document } = parseHTML(
    pageHtml(`
      ${sectionHtml(`
        <div class="elementor-widget elementor-widget-text-editor" id="help">
          <div class="elementor-widget-container"><h5>Banner Ads</h5><div>Do you see advertisements around this box?</div></div>
        </div>
        ${widget('ad-a', 'https://ybs2ffs7v.com/a.js')}
        ${widget('ad-b', 'https://ybs2ffs7v.com/b.js')}
      `)}
      <div class="elementor-widget-wrap" id="other-wrap">${widget('ad-c', 'https://ybs2ffs7v.com/c.js')}</div>
    `),
  );
  const adA = document.getElementById('ad-a');
  const script = adA.querySelector('script');
  const wrap = neighborhoodWrapper(script);
  assert.ok(wrap);
  assert.match(wrap.className, /elementor-widget-wrap/);
  assert.equal(wrap.contains(document.getElementById('ad-b')), true);
  assert.equal(wrap.contains(document.getElementById('ad-c')), false);
  assert.equal(neighborhoodWrapper(document.querySelector('main')), null);

  adA.remove();
  const neighbors = collectNeighborhoodCandidates(document, {
    anchors: [{ wrapper: wrap }],
    exclude: new Set([adA]),
    hostname: 'canyoublockit.com',
  });
  const ids = neighbors.map((item) => item.el.id);
  assert.deepEqual(ids, ['ad-b']);
  assert.equal(
    neighbors.some((item) => /Banner Ads/.test(item.el.textContent || '')),
    false,
  );
});

test('neighborhood skips already-hidden and already-judged siblings', () => {
  const { document } = parseHTML(
    pageHtml(
      sectionHtml(`
      ${widget('ad-a', 'https://ybs2ffs7v.com/a.js')}
      ${widget('ad-b', 'https://ybs2ffs7v.com/b.js')}
      ${widget('ad-c', 'https://fvcwqkkqmuv.com/c.js')}
      <div class="elementor-widget elementor-widget-html" id="ad-d" hidden>
        <script src="https://ybs2ffs7v.com/d.js"></script>
      </div>
      <div class="elementor-widget elementor-widget-html" id="ad-e" style="display:none">
        <script src="https://ybs2ffs7v.com/e.js"></script>
      </div>
    `),
    ),
  );
  const adA = document.getElementById('ad-a');
  const wrap = neighborhoodWrapper(adA);
  const adB = document.getElementById('ad-b');
  adB.setAttribute('data-adgate-blocked', '1');
  adA.remove();
  const visible = collectNeighborhoodCandidates(document, {
    anchors: [{ wrapper: wrap }],
    exclude: new Set([adA]),
    hostname: 'canyoublockit.com',
  });
  assert.deepEqual(
    visible.map((item) => item.el.id),
    ['ad-c'],
  );
  const judged = collectNeighborhoodCandidates(document, {
    anchors: [{ wrapper: wrap }],
    exclude: new Set([adA, document.getElementById('ad-c')]),
    hostname: 'canyoublockit.com',
  });
  assert.deepEqual(
    judged.map((item) => item.el.id),
    [],
  );
});

test('neighborhood caps extra nodes at 10 by default and 12 at most', () => {
  const parts = [widget('gone', 'https://ybs2ffs7v.com/gone.js')];
  for (let i = 0; i < 15; i++) parts.push(widget(`s${i}`, `https://ybs2ffs7v.com/${i}.js`));
  const { document } = parseHTML(pageHtml(sectionHtml(parts.join(''))));
  const gone = document.getElementById('gone');
  const wrap = neighborhoodWrapper(gone);
  gone.remove();
  const def = collectNeighborhoodCandidates(document, {
    anchors: [{ wrapper: wrap }],
    exclude: new Set([gone]),
    hostname: 'example.com',
  });
  assert.equal(NEIGHBORHOOD_MAX, 10);
  assert.equal(def.length, 10);
  assert.equal(def.some((item) => item.el.id === 's0'), true);
  assert.equal(def.some((item) => item.el.id === 's14'), false);

  const hard = collectNeighborhoodCandidates(document, {
    anchors: [{ wrapper: wrap }],
    exclude: new Set([gone]),
    max: 100,
    hostname: 'example.com',
  });
  assert.equal(hard.length, 12);
});

test('neighborhood does not scan a landmark wrapper', () => {
  const { document } = parseHTML(`<!DOCTYPE html><body><main id="m">
    ${widget('ad-a', 'https://ybs2ffs7v.com/a.js')}
    ${widget('ad-b', 'https://ybs2ffs7v.com/b.js')}
  </main></body>`);
  const adA = document.getElementById('ad-a');
  assert.equal(neighborhoodWrapper(adA), null);
  adA.remove();
  const neighbors = collectNeighborhoodCandidates(document, {
    anchors: [{ wrapper: document.getElementById('m') }],
    hostname: 'example.com',
  });
  assert.deepEqual(neighbors, []);
});

test('neighborhood follow-up is a single pass', () => {
  assert.equal(shouldRunNeighborhoodFollowup({ pass: 0, hiddenCount: 1, neighborCount: 3 }), true);
  assert.equal(shouldRunNeighborhoodFollowup({ pass: 0, hiddenCount: 0, neighborCount: 3 }), false);
  assert.equal(shouldRunNeighborhoodFollowup({ pass: 0, hiddenCount: 2, neighborCount: 0 }), false);

  let pass = 0;
  let runs = 0;
  let neighbors = 4;
  const hiddenCount = 2;
  while (shouldRunNeighborhoodFollowup({ pass, hiddenCount, neighborCount: neighbors })) {
    runs += 1;
    pass = 1;
    neighbors = 9;
  }
  assert.equal(runs, 1);
  assert.equal(shouldRunNeighborhoodFollowup({ pass, hiddenCount, neighborCount: neighbors }), false);
});

test('content runs one neighborhood follow-up through the same page-judge and still cascades', () => {
  const src = fs.readFileSync(path.join(__dirname, 'content.js'), 'utf8');
  assert.match(src, /collapseEmptyAncestors/);
  assert.match(src, /cascade_remove/);
  assert.match(src, /neighborhood_rescan/);
  assert.equal((src.match(/collectNeighborhoodCandidates\(/g) || []).length, 1);
  assert.equal((src.match(/shouldRunNeighborhoodFollowup\?\.\(/g) || []).length, 1);
  assert.equal((src.match(/type: 'ADGATE_PAGE_JUDGE'/g) || []).length, 1);
  assert.match(src, /allowCheats: false/);
  assert.match(src, /recordAnchors: false/);
  assert.equal(src.includes("safeJudge('neighborhood'"), false);
  assert.equal(/while\s*\([\s\S]{0,160}neighborhood/i.test(src), false);
  const follow = src.indexOf('neighborhoodPass = 1');
  assert.ok(follow > src.indexOf('collectNeighborhoodCandidates'));
  assert.equal(src.indexOf('neighborhoodPass = 1', follow + 1), -1);
  const rescan = src.slice(src.indexOf("log('info', 'neighborhood_rescan'"));
  assert.match(rescan, /added:/);
  assert.match(rescan, /hides:/);
  assert.match(rescan, /cascade:/);
});
