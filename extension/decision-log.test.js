const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SCHEMA, REVIEW_MIN, buildDecisionLog, toJsonl, parseRunText } = require('./decision-log.js');

test('buildDecisionLog records removal, review band, and cascade parents', () => {
  const run = buildDecisionLog({
    ts: '2026-09-22T00:00:00.000Z',
    requestId: 'req-1',
    page: { url: 'https://canyoublockit.com/extreme-test/', hostname: 'canyoublockit.com', title: 'Extreme' },
    site_type: 'marketing',
    site_type_confidence: 0.8,
    hideMin: 0.75,
    blockEnabled: true,
    trigger: 'manual',
    client: 'extension-0.0.4',
    ms: 12,
    decisions: [
      {
        id: 'e0',
        tag: 'iframe',
        src: 'https://12ezo5v60.com/push',
        href: null,
        discover: 'ad_host_script',
        classes: ['ad-frame'],
        rect: { w: 300, h: 250, x: 10, y: 20 },
        noul: 0.93,
        action: 'hide',
        reason: 's1_plus_adhost_prior',
        removed: true,
        cascadeParents: [{ tag: 'div', idAttr: 'slot', classes: ['ad-slot'], reason: 'empty_parent' }],
      },
      {
        id: 'e1',
        tag: 'div',
        classes: 'overlay sticky',
        noul: 0.52,
        action: 'review',
        reason: 's1_ad_or_unrelated',
        removed: false,
      },
    ],
  });

  assert.equal(run.schema, SCHEMA);
  assert.equal(run.page.url, 'https://canyoublockit.com/extreme-test/');
  assert.equal(run.site_type, 'marketing');
  assert.equal(run.hideMin, 0.75);
  assert.equal(run.reviewMin, REVIEW_MIN);
  assert.equal(run.summary.removed, 1);
  assert.equal(run.summary.review, 1);
  assert.equal(run.summary.cascadeRemoved, 1);
  assert.equal(run.decisions[0].removed, true);
  assert.equal(run.decisions[0].discover, 'ad_host_script');
  assert.equal(run.decisions[0].href, null);
  assert.equal(run.decisions[0].cascadeParents[0].reason, 'empty_parent');
  assert.deepEqual(run.decisions[1].classes, ['overlay', 'sticky']);
  const line = toJsonl(run);
  assert.equal(JSON.parse(line).requestId, 'req-1');
  assert.equal(line.includes('\n'), false);
});

test('sample fixture matches the decision log schema', () => {
  const file = path.join(__dirname, '..', 'fixtures', 'decision-log.sample.json');
  const jsonl = path.join(__dirname, '..', 'fixtures', 'decision-log.sample.jsonl');
  const run = JSON.parse(fs.readFileSync(file, 'utf8'));
  const line = fs.readFileSync(jsonl, 'utf8').trim();
  const fromJsonl = JSON.parse(line);

  assert.equal(run.schema, SCHEMA);
  assert.equal(run.dryRun, true);
  assert.equal(run.page.url, 'https://canyoublockit.com/extreme-test/');
  assert.equal(typeof run.site_type, 'string');
  assert.ok(run.decisions.length >= 1);
  for (const row of run.decisions) {
    assert.ok(row.id);
    assert.ok(row.tag);
    assert.ok('src' in row);
    assert.ok(Array.isArray(row.classes));
    assert.ok(row.rect);
    assert.equal(typeof row.noul, 'number');
    assert.ok(['hide', 'review', 'allow'].includes(row.action));
    assert.equal(typeof row.reason, 'string');
    assert.equal(typeof row.removed, 'boolean');
    assert.ok(Array.isArray(row.cascadeParents));
  }
  const cascaded = run.decisions.find((row) => row.cascadeParents.length);
  assert.equal(cascaded.cascadeParents[0].reason, 'empty_parent');
  assert.equal(fromJsonl.requestId, run.requestId);
  assert.equal(line.includes('\n'), false);
  assert.equal(parseRunText(fs.readFileSync(file, 'utf8')).requestId, run.requestId);
  assert.equal(parseRunText(fs.readFileSync(jsonl, 'utf8')).requestId, run.requestId);
  assert.equal(parseRunText(JSON.stringify({ event: 'decision_run', run })).requestId, run.requestId);
  assert.deepEqual(buildDecisionLog(run).summary, run.summary);
});
