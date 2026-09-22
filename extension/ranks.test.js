const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { decideHide, normalizeRanks, resolveHostKind, DEFAULT_RANKS, ELEMENT_KINDS } = require('./ranks.js');

test('ranks: defaults hide ad/promo and leave donate_ask off', () => {
  const ranks = normalizeRanks(null);
  assert.equal(ranks.ad.enabled, true);
  assert.equal(ranks.promo.enabled, true);
  assert.equal(ranks.donate_ask.enabled, false);
  assert.equal(ranks.unrelated_inject.enabled, false);
  assert.equal(ELEMENT_KINDS.includes('ad'), true);
});

test('ranks: decideHide uses class threshold and enabled flag', () => {
  const settings = {
    hideMin: 0.75,
    ranks: normalizeRanks({
      ad: { enabled: true, hideMin: 0.75 },
      donate_ask: { enabled: false, hideMin: 0.5 },
      unrelated_inject: { enabled: true, hideMin: 0.9 },
    }),
  };
  assert.equal(decideHide(settings, { kind: 'ad', noul: 0.8 }).hide, true);
  assert.equal(decideHide(settings, { kind: 'ad', noul: 0.8 }).reason, 'rank_ad');
  assert.equal(decideHide(settings, { kind: 'ad', noul: 0.5 }).hide, false);
  assert.equal(decideHide(settings, { kind: 'donate_ask', noul: 0.99 }).hide, false);
  assert.equal(decideHide(settings, { kind: 'unrelated_inject', noul: 0.8 }).hide, false);
  assert.equal(decideHide(settings, { kind: 'unrelated_inject', noul: 0.95 }).hide, true);
  assert.equal(decideHide(settings, { kind: 'unrelated_inject', noul: 0.95 }).reason, 'rank_unrelated_inject');
});

test('hosted page-judge fixture has noul without kind; missing kind is ad only when hide or high', () => {
  const live = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'hosted-page-judge-no-kind.json'), 'utf8'),
  );
  const el = live.elements[0];
  assert.equal(live.requestId, '5b42b1641a12');
  assert.equal(typeof el.noul, 'number');
  assert.equal(el.action, 'hide');
  assert.equal(Object.hasOwn(el, 'kind'), false);
  assert.throws(() => {
    if (!Object.hasOwn(el, 'kind')) throw new Error('host page-judge omitted kind');
    return el.kind;
  }, /omitted kind/);

  const settings = { hideMin: 0.75, ranks: normalizeRanks(null) };
  const decided = decideHide(settings, el);
  assert.equal(decided.kind, 'ad');
  assert.equal(decided.hostOmittedKind, true);
  assert.equal(decided.hide, true);
  assert.match(decided.reason, /rank_ad/);
  assert.match(decided.reason, /host omitted kind/);
  assert.deepEqual(resolveHostKind(el, 0.75), { kind: 'ad', hostOmittedKind: true });

  const low = { id: 'e1', noul: 0.12, action: 'allow', reason: 's1_ad_or_unrelated' };
  const unlabeled = decideHide(settings, low);
  assert.equal(unlabeled.kind, '');
  assert.equal(unlabeled.hide, false);
  assert.equal(unlabeled.hostOmittedKind, true);
  assert.match(unlabeled.reason, /host omitted kind/);

  const literal = decideHide(settings, {
    id: 'e2',
    noul: 0.95,
    action: 'hide',
    reason: 's1_ad_or_unrelated',
    kind: 'unknown',
  });
  assert.equal(literal.kind, 'unknown');
  assert.equal(literal.hostOmittedKind, false);
  assert.equal(literal.hide, false);
});

test('ranks: enabling donate_ask changes hide behavior', () => {
  const off = { hideMin: 0.75, ranks: normalizeRanks(DEFAULT_RANKS) };
  const on = {
    hideMin: 0.75,
    ranks: normalizeRanks({ ...DEFAULT_RANKS, donate_ask: { enabled: true, hideMin: 0.7 } }),
  };
  const judgment = { kind: 'donate_ask', noul: 0.8, reason: 's1_ad_or_unrelated' };
  assert.equal(decideHide(off, judgment).hide, false);
  assert.equal(decideHide(on, judgment).hide, true);
});
