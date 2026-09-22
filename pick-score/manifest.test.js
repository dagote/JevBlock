const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const manifest = require('./manifest.json');
const adgate = require('../extension/manifest.json');

test('pick-score is a separate MV3 extension and Adgate stays 0.1.7', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, 'JEV Pick Score');
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.ok(manifest.host_permissions.includes('https://www.dagote.ai/*'));
  assert.ok(manifest.host_permissions.includes('http://*/*'));
  assert.ok(manifest.host_permissions.includes('https://*/*'));
  assert.deepEqual(manifest.content_scripts[0].matches, ['http://*/*', 'https://*/*']);
  assert.deepEqual(manifest.content_scripts[0].js, ['collect.js', 'content.js']);
  assert.equal(manifest.permissions.includes('declarativeNetRequest'), false);
  assert.equal(adgate.name, 'Adgate');
  assert.equal(adgate.version, '0.1.7');
});

test('popup and content script implement pick mode without force-hide', () => {
  const dir = __dirname;
  const popup = fs.readFileSync(path.join(dir, 'popup.html'), 'utf8');
  const popupJs = fs.readFileSync(path.join(dir, 'popup.js'), 'utf8');
  const content = fs.readFileSync(path.join(dir, 'content.js'), 'utf8');
  assert.match(popup, /https:\/\/www\.dagote\.ai\/api\/jev/);
  assert.match(popup, /type="password"/);
  assert.match(popup, /jev-tiny/);
  assert.match(popup, /Refresh models/);
  assert.match(popup, /Pick mode OFF/);
  assert.match(popupJs, /chrome\.storage\.sync/);
  assert.match(popupJs, /pickEnabled/);
  assert.match(popupJs, /fetchModelList/);
  assert.match(content, /preventDefault\(\)/);
  assert.match(content, /stopPropagation\(\)/);
  assert.match(content, /Escape/);
  assert.match(content, /JEV_PICK_SCORE/);
  assert.match(content, /site_type/);
  assert.match(content, /requestId/);
  assert.doesNotMatch(content, /force_hide|forceHide|hideEl\s*\(/);
  assert.doesNotMatch(`${popup}\n${popupJs}\n${content}`, /sk-[A-Za-z0-9]{8,}/);
});
