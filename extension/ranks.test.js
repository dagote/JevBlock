const test = require('node:test');
const assert = require('node:assert/strict');
const { decideHide, normalizeRanks, DEFAULT_RANKS, ELEMENT_KINDS } = require('./ranks.js');

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

test('ranks: missing host kind uses the ad rank and labels kind_missing_host', () => {
  const settings = { hideMin: 0.75, ranks: normalizeRanks(DEFAULT_RANKS) };
  const high = decideHide(settings, { noul: 0.82, action: 'hide', reason: 's1_ad_or_unrelated' });
  assert.equal(high.hide, true);
  assert.equal(high.action, 'hide');
  assert.equal(high.kind, 'ad');
  assert.equal(high.kindPolicy, 'ad');
  assert.equal(high.kindLabel, 'kind_missing_host');
  assert.equal(high.hostKind, null);
  assert.equal(high.reason, 'kind_missing_host');

  const hostHideLow = decideHide(settings, { noul: 0.4, action: 'hide' });
  assert.equal(hostHideLow.hide, false);
  assert.equal(hostHideLow.kindLabel, 'kind_missing_host');
  assert.equal(hostHideLow.kindPolicy, 'ad');

  const review = decideHide(settings, { noul: 0.62, action: 'review' });
  assert.equal(review.hide, false);
  assert.equal(review.action, 'review');
  assert.equal(review.kindLabel, null);
  assert.equal(review.kind, 'other');

  const adOff = decideHide(settings, {
    noul: 0.9,
    action: 'hide',
    ranks: null,
  });
  const disabled = {
    hideMin: 0.75,
    ranks: normalizeRanks({ ad: { enabled: false, hideMin: 0.75 } }),
  };
  assert.equal(decideHide(disabled, { noul: 0.9, action: 'hide' }).hide, false);
  assert.equal(adOff.kindLabel, 'kind_missing_host');

  const hosted = decideHide(settings, { kind: 'ad', noul: 0.8, action: 'review' });
  assert.equal(hosted.reason, 'rank_ad');
  assert.equal(hosted.kindLabel, null);
  assert.equal(hosted.hostKind, 'ad');
});

test('ranks: mail GAM and data-ad priors hide a weak noul without faking host kind', () => {
  const settings = { hideMin: 0.75, ranks: normalizeRanks(DEFAULT_RANKS) };
  const gam = decideHide(settings, { noul: 0.27, action: 'allow', slotPrior: 'mail_gam' });
  assert.equal(gam.hide, true);
  assert.equal(gam.action, 'hide');
  assert.equal(gam.reason, 'prior_mail_gam');
  assert.equal(gam.prior, 'prior_mail_gam');
  assert.equal(gam.kindLabel, 'kind_missing_host');
  assert.equal(gam.hostKind, null);

  const row = decideHide(settings, { noul: 0.44, action: 'allow', slotPrior: 'data_ad_row' });
  assert.equal(row.hide, true);
  assert.equal(row.reason, 'prior_data_ad_row');

  const strong = decideHide(settings, { noul: 0.9, action: 'hide', slotPrior: 'mail_gam' });
  assert.equal(strong.reason, 'kind_missing_host');
  assert.equal(strong.prior, undefined);

  const copy = decideHide(settings, { noul: 0.65, action: 'review', slotPrior: '' });
  assert.equal(copy.hide, false);
  assert.equal(copy.action, 'review');
  assert.equal(copy.prior, undefined);

  const off = {
    hideMin: 0.75,
    ranks: normalizeRanks({ ad: { enabled: false, hideMin: 0.75 } }),
  };
  assert.equal(decideHide(off, { noul: 0.27, action: 'allow', slotPrior: 'mail_gam' }).hide, false);
});
