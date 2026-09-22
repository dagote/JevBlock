const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('forceHideCheats is off by default and gates Extreme removers', () => {
  const src = fs.readFileSync(path.join(__dirname, 'content.js'), 'utf8');
  assert.match(src, /forceHideCheats:\s*false/);
  assert.match(src, /forceHideCheats === true/);
  assert.match(src, /removeAdvertisementWidgets/);
  const defaults = src.match(/const DEFAULTS = \{[\s\S]*?\};/)?.[0] || '';
  assert.match(defaults, /forceHideCheats:\s*false/);
  assert.equal(defaults.includes('forceHideCheats: true'), false);

  const gateIdx = src.indexOf("settings.forceHideCheats === true");
  const adsIdx = src.indexOf('removeAdvertisementWidgets(document)');
  const clbIdx = src.indexOf('removeClbContainers(document)');
  const judgeIdx = src.indexOf("type: 'ADGATE_PAGE_JUDGE'");
  assert.ok(gateIdx > 0 && adsIdx > gateIdx && clbIdx > gateIdx);
  assert.ok(adsIdx < judgeIdx);
});

test('decision log normalizes kind and nearbyLabel', () => {
  const { buildDecisionLog } = require('./decision-log.js');
  const run = buildDecisionLog({
    page: { url: 'https://example.com/', hostname: 'example.com', title: 't' },
    site_type: 'news',
    blockEnabled: true,
    decisions: [
      {
        id: 'e0',
        tag: 'iframe',
        noul: 0.9,
        kind: 'ad',
        action: 'hide',
        reason: 'rank_ad',
        removed: true,
        nearbyLabel: 'Sponsored',
        discover: 'iframe',
      },
    ],
  });
  assert.equal(run.decisions[0].kind, 'ad');
  assert.equal(run.decisions[0].nearbyLabel, 'Sponsored');
  assert.equal(run.decisions[0].reason, 'rank_ad');
});
