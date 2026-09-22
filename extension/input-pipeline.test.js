const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');
const {
  collectCandidates,
  serializeCandidate,
  toJudgeElement,
  promoteAssets,
  createRepeatGuard,
  judgeFingerprint,
  CANDIDATE_CAP,
} = require('./candidates.js');

const MAIL_HTML = `<!doctype html><html><body>
  <div id="spacer" role="presentation" class="spacer" style="width:300px;height:8px"></div>
  <div id="gap" class="rail-gap" style="width:320px;height:10px"></div>
  <div id="cap-wrap">
    <span>Advertisement</span>
    <a id="cap" href="https://www.capitalone.com/credit-cards/bonus">Capital One | $200 cash bonus when you spend $500</a>
  </div>
  <div id="gam-wrap" data-ad-slot="mail-rail">
    <iframe id="gam" src="https://securepubads.g.doubleclick.net/gampad/ads?iu=/aol/mail&amp;sz=300x250"></iframe>
  </div>
  <div data-test-id="message-list">
    <div id="inbox" data-test-id="message-list-item" role="row">Mom — Sunday dinner plans. Can you bring the salad?</div>
  </div>
  <div data-test-id="toolbar"><button type="button">Compose</button></div>
  <div id="offer" role="dialog" style="position:fixed;z-index:9">Sponsored special offer</div>
  <div id="compose" role="dialog" style="position:fixed">New message</div>
</body></html>
`;

function rowsFrom(html) {
  const { document } = parseHTML(html);
  return collectCandidates(document, { max: 24, hostname: 'mail.aol.com' }).map((item, index) =>
    serializeCandidate(item, `e${index}`),
  );
}

test('promote child iframe src and anchor href onto the candidate', () => {
  const { document } = parseHTML(
    '<div id="slot"><iframe src="https://tpc.googlesyndication.com/safeframe/1-0-45/html/container.html"></iframe><a href="https://ads.example/click">x</a></div>',
  );
  const el = document.querySelector('#slot');
  const promoted = promoteAssets(el);
  assert.match(promoted.src, /googlesyndication\.com\/safeframe/);
  assert.equal(promoted.srcHost, 'tpc.googlesyndication.com');
  assert.equal(promoted.promoted, 'iframe');
  const row = serializeCandidate({ el, discover: 'iframe', evidence: '' }, 'gam');
  assert.match(row.src, /googlesyndication/);
  assert.equal(row.discover, 'ad_host_asset');
  assert.equal(row.hrefHost, 'ads.example');
  const wire = toJudgeElement(row);
  assert.equal(wire.srcHost, 'tpc.googlesyndication.com');
  assert.equal(Object.hasOwn(wire, 'classes'), false);
  assert.equal(Object.hasOwn(wire, 'idAttr'), false);
  assert.equal(Object.hasOwn(wire, 'outerHTML'), false);
  assert.equal(Object.hasOwn(wire, 'innerText'), false);
  assert.equal(Object.hasOwn(wire, 'ariaLabel'), false);
});

test('selector keeps GAM and ad text, drops spacers and mail chrome', () => {
  const rows = rowsFrom(MAIL_HTML);
  assert.equal(
    rows.some((row) => row.idAttr === 'spacer' || row.idAttr === 'gap' || row.role === 'presentation'),
    false,
  );
  assert.equal(rows.some((row) => row.idAttr === 'inbox' || /Sunday dinner/.test(row.text || '')), false);
  assert.equal(rows.some((row) => row.idAttr === 'compose' || /New message/.test(row.text || '')), false);
  assert.equal(rows.some((row) => /Compose/.test(row.text || '') && row.tag === 'button'), false);

  const cap = rows.find((row) => /Capital One/.test(row.text || ''));
  assert.ok(cap, rows.map((row) => `${row.discover}:${row.text}`).join(' | '));
  assert.equal(cap.nearbyLabel, 'Advertisement');
  assert.match(cap.href, /capitalone\.com/);
  assert.equal(cap.hrefHost, 'www.capitalone.com');

  const gam = rows.find((row) => (row.src || '').includes('securepubads.g.doubleclick.net/gampad'));
  assert.ok(gam, 'GAM iframe src was not promoted');
  assert.equal(gam.discover, 'data_ad_row');
  assert.equal(gam.srcHost, 'securepubads.g.doubleclick.net');
  assert.match(gam.hint || '', /data-ad row/);

  const offer = rows.find((row) => row.discover === 'fixed_overlay');
  assert.ok(offer);
  assert.match(offer.text, /Sponsored/);
  assert.equal(offer.fixedOrSticky, true);
  assert.ok(rows.length <= CANDIDATE_CAP);

  const wire = toJudgeElement(gam);
  for (const key of Object.keys(wire)) {
    assert.equal(
      [
        'id',
        'tag',
        'role',
        'text',
        'nearbyLabel',
        'href',
        'src',
        'hrefHost',
        'srcHost',
        'rect',
        'fixedOrSticky',
        'discover',
        'hint',
      ].includes(key),
      true,
      key,
    );
  }
});

test('repeat guard skips boot duplicates and still allows manual', () => {
  const guard = createRepeatGuard(30000);
  const page = { url: 'https://mail.aol.com/d/folders/1', title: 'AOL Mail' };
  const elements = [{ id: 'e0', tag: 'iframe', discover: 'ad_host_asset', src: 'https://gampad.example/ad' }];
  const key = judgeFingerprint(page, elements);
  assert.equal(guard.duplicate(key, 1000, 'boot'), false);
  guard.commit(key, 1000);
  assert.equal(guard.duplicate(key, 12000, 'boot2'), true);
  assert.equal(guard.duplicate(key, 22000, 'boot3'), true);
  assert.equal(guard.duplicate(key, 22000, 'manual'), false);
  assert.equal(guard.duplicate(judgeFingerprint(page, []), 23000, 'boot2'), false);
});

test('content posts slim elements and skips repeat fingerprints', () => {
  const src = fs.readFileSync(path.join(__dirname, 'content.js'), 'utf8');
  assert.match(src, /toJudgeElement/);
  assert.match(src, /elements: wire/);
  assert.match(src, /judge_skip_repeat/);
  assert.match(src, /kindLabel/);
  assert.match(src, /kind_missing_host|kindPolicy/);
});
