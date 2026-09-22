const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');
const { collectCandidates, serializeCandidate, isForcedHide, AD_HOST_RE } = require('./candidates.js');
const { collapseEmptyAncestors } = require('./empty-parent.js');

const LIVE = path.join(__dirname, '..', 'fixtures', 'extreme-test.live.html');

function scan(document) {
  return collectCandidates(document, { max: 24 }).map((item) => ({
    item,
    row: serializeCandidate(item, 'e'),
  }));
}

/** Chrome dump-dom leaves prefetch links before head. linkedom then sets document.body to an empty foster body; the article is the body that contains the h1. */
function pageBody(document) {
  const h1 = document.querySelector('h1');
  return (h1 && h1.closest && h1.closest('body')) || document.body;
}

function stripAdScripts(document) {
  document.querySelectorAll('script').forEach((script) => {
    const src = script.getAttribute('src') || '';
    if (AD_HOST_RE.test(src) || AD_HOST_RE.test(script.textContent || '')) script.remove();
  });
}

function removeForced(document) {
  const picked = scan(document).filter(({ row }) => isForcedHide(row));
  let removed = 0;
  for (const { item, row } of picked) {
    if (!item.el.isConnected) continue;
    const parent = item.el.parentElement;
    item.el.remove();
    collapseEmptyAncestors(parent);
    removed += 1;
    assert.equal(isForcedHide(row), true);
  }
  return removed;
}

test('live Extreme DOM is not the two junk iframes', () => {
  const html = fs.readFileSync(LIVE, 'utf8');
  assert.match(html, /__clb-1837835_1_container/);
  assert.match(html, /ybs2ffs7v\.com\/lv\/esnk\/1837835\/code\.js/);
  assert.match(html, /href="ad\.com"/);
  const { document } = parseHTML(html);
  const rows = scan(document).map(({ row }) => row);
  const discovers = rows.map((row) => row.discover);
  assert.equal(discovers.includes('iframe'), false, discovers.join(','));
  assert.equal(
    rows.some((row) => (row.src || '').startsWith('javascript:') || (row.classes || []).includes('iubenda-ibadge')),
    false,
  );
  const forced = rows.filter((row) => isForcedHide(row));
  assert.ok(forced.length >= 8, `only ${forced.length} hideable slots: ${discovers.join(',')}`);
  assert.ok(forced.some((row) => (row.src || '').includes('ybs2ffs7v.com')));
  assert.ok(forced.some((row) => (row.href || '') === 'ad.com'));
  assert.ok(forced.some((row) => row.discover === 'vast_player' && (row.src || '').includes('12ezo5v60.com')));
  assert.ok(forced.filter((row) => /Advertisement/.test(row.text || '')).length >= 4);
});

test('live Extreme DOM still hides Advertisement slots after ad scripts are stripped', () => {
  const { document } = parseHTML(fs.readFileSync(LIVE, 'utf8'));
  stripAdScripts(document);
  const rows = scan(document).map(({ row }) => row);
  const forced = rows.filter((row) => isForcedHide(row));
  assert.ok(
    forced.length >= 5,
    `stripped DOM only produced ${forced.length}: ${rows.map((row) => row.discover).join(',')}`,
  );
  assert.equal(
    rows.some((row) => row.discover === 'iframe'),
    false,
  );
  const removed = removeForced(document);
  assert.ok(removed >= 5, `removed ${removed}`);
  const body = pageBody(document);
  assert.ok(document.querySelector('h1'));
  assert.match(document.querySelector('h1').textContent, /eXtreme Adblocker Test/);
  assert.match(body.textContent, /Banner Ads/);
  assert.match(body.textContent, /Do you see advertisements around this box/);
  assert.match(body.textContent, /Direct Link Ads/);
  assert.match(body.textContent, /direct link to an Ad/);
  assert.match(body.textContent, /Push Notification Ads/);
  assert.match(body.textContent, /Did you receive an Ad before playing the video/);
  assert.equal(document.querySelector('a[href="ad.com"]'), null);
  assert.equal(
    [...document.querySelectorAll('center, p, span')].some((el) =>
      /^advertisement$/i.test((el.textContent || '').replace(/\s+/g, ' ').trim()),
    ),
    false,
  );
  assert.ok(document.querySelector('iframe[src="javascript:false"]'));
  assert.ok(document.querySelector('.iubenda-ibadge'));
});
