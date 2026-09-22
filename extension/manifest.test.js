const test = require('node:test');
const assert = require('node:assert/strict');
const manifest = require('./manifest.json');

test('manifest wires review scripts and keeps early.js opt-in', () => {
  assert.equal(manifest.version, '0.0.9');
  assert.ok(manifest.permissions.includes('declarativeNetRequest'));
  const rules = manifest.declarative_net_request.rule_resources[0];
  assert.equal(rules.id, 'ad_hosts');
  assert.equal(rules.enabled, false);
  assert.equal(rules.path, 'rules.json');
  const scripts = manifest.content_scripts[0].js;
  assert.deepEqual(scripts.slice(0, 2), ['empty-parent.js', 'decision-log.js']);
  assert.equal(scripts.includes('early.js'), false);
  assert.equal(scripts.includes('candidates.js'), true);
  assert.ok(scripts.indexOf('candidates.js') < scripts.indexOf('content.js'));
  assert.equal(scripts.includes('content.js'), true);
});
