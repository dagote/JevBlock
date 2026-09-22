const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolveHostKind: adgateResolve } = require('../extension/ranks.js');
const { resolveHostKind } = require('./host-kind.js');

test('pick score uses the same missing-kind rule as Adgate on the live Dagote fixture', () => {
  const live = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'hosted-page-judge-no-kind.json'), 'utf8'),
  );
  const el = live.elements[0];
  assert.equal(Object.hasOwn(el, 'kind'), false);
  assert.equal(el.noul > 0.75, true);
  assert.deepEqual(resolveHostKind(el, 0.75), { kind: 'ad', hostOmittedKind: true });
  assert.deepEqual(resolveHostKind(el, 0.75), adgateResolve(el, 0.75));

  const low = { id: 'e1', noul: 0.2, action: 'allow', reason: 's1_ad_or_unrelated' };
  assert.deepEqual(resolveHostKind(low, 0.75), { kind: '', hostOmittedKind: true });
  assert.equal(resolveHostKind({ ...low, kind: 'unknown' }, 0.75).kind, 'unknown');

  const content = fs.readFileSync(path.join(__dirname, 'content.js'), 'utf8');
  assert.match(content, /host omitted kind/);
  assert.equal(content.includes('unknown kind'), false);
  const manifest = require('./manifest.json');
  const scripts = manifest.content_scripts[0].js;
  assert.ok(scripts.indexOf('host-kind.js') < scripts.indexOf('content.js'));
});
