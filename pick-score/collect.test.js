const test = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
const { collectPage, serializeElement, TEXT_CAP, INNER_CAP, OUTER_CAP, LINK_CAP, IMG_CAP } = require('./collect.js');

function doc(html) {
  return parseHTML(html).document;
}

const hooks = {
  getRect: () => ({ width: 320, height: 48, top: 12, left: 8 }),
  getStyle: () => ({ position: 'fixed' }),
  scrollX: 3,
  scrollY: 40,
};

test('picked element matches Adgate page-judge fields and adds subtree payload', () => {
  const document = doc(`<!doctype html>
    <html><head><title>Example News</title></head>
    <body>
      <h1>Top story</h1>
      <h2>Details</h2>
      <p id="sponsor-label">Sponsored</p>
      <div id="card" class="promo box" role="region" aria-label="Offer" data-testid="card">
        <a href="https://ads.example/click">Buy now please</a>
        <img src="https://cdn.example/a.png" alt="" />
        <p>Deal text that is visible</p>
      </div>
    </body></html>`);
  const card = document.getElementById('card');
  const element = serializeElement(card, hooks);
  const page = collectPage(document, { href: 'https://news.example/a', hostname: 'news.example' });

  assert.equal(page.url, 'https://news.example/a');
  assert.equal(page.hostname, 'news.example');
  assert.equal(page.title, 'Example News');
  assert.deepEqual(page.headings, ['Top story', 'Details']);
  assert.match(page.excerpt, /Top story/);

  assert.equal(element.id, 'e0');
  assert.equal(element.tag, 'div');
  assert.equal(element.idAttr, 'card');
  assert.deepEqual(element.classes, ['promo', 'box']);
  assert.equal(element.role, 'region');
  assert.equal(element.ariaLabel, 'Offer');
  assert.equal(element.testId, 'card');
  assert.equal(element.nearbyLabel, 'Sponsored');
  assert.equal(element.href, null);
  assert.equal(element.src, null);
  assert.equal(element.fixedOrSticky, true);
  assert.deepEqual(element.rect, { w: 320, h: 48, x: 11, y: 52 });
  assert.equal(element.discover, 'user_pick');
  assert.match(element.text, /Buy now please/);
  assert.ok(element.text.length <= TEXT_CAP);
  assert.match(element.innerText, /Deal text/);
  assert.deepEqual(element.linkHrefs, ['https://ads.example/click']);
  assert.deepEqual(element.imgSrcs, ['https://cdn.example/a.png']);
  assert.ok(element.descendantTags.some((row) => row.tag === 'a' && row.count === 1));
  assert.equal(element.subtreeTruncated, false);
  assert.match(element.outerHTML, /id="card"/);
  assert.equal(typeof element.text, 'string');
  assert.equal(Array.isArray(element.classes), true);
  assert.equal(typeof element.fixedOrSticky, 'boolean');
});

test('href host and caps follow the page-judge element', () => {
  const document = doc(`<a id="adcom" href="https://ad.com/x">Go</a>`);
  const element = serializeElement(document.getElementById('adcom'), {
    getStyle: () => ({ position: 'static' }),
  });
  assert.equal(element.tag, 'a');
  assert.equal(element.href, 'https://ad.com/x');
  assert.equal(element.hrefHost, 'ad.com');
  assert.equal(element.fixedOrSticky, false);
  assert.equal(element.id, 'e0');
});

test('text, innerText, outerHTML, links, and images are capped', () => {
  const long = 'word '.repeat(2000);
  const links = Array.from({ length: LINK_CAP + 6 }, (_, i) => `<a href="https://ex.test/${i}">l</a>`).join('');
  const imgs = Array.from({ length: IMG_CAP + 4 }, (_, i) => `<img src="https://cdn.test/${i}.png" />`).join('');
  const document = doc(`<div id="fat" data-blob="${'x'.repeat(OUTER_CAP + 80)}">${long}${links}${imgs}</div>`);
  const element = serializeElement(document.getElementById('fat'));
  assert.equal(element.text.length, TEXT_CAP);
  assert.ok(element.innerText.length <= INNER_CAP + 1);
  assert.ok(element.innerText.endsWith('…'));
  assert.ok(element.outerHTML.length <= OUTER_CAP + 1);
  assert.ok(element.outerHTML.endsWith('…'));
  assert.equal(element.linkHrefs.length, LINK_CAP);
  assert.equal(element.imgSrcs.length, IMG_CAP);
  assert.equal(JSON.stringify(element).includes('secret-key'), false);
});
