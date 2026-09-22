const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');
const { collectCandidates, serializeCandidate } = require('./candidates.js');
const { collapseEmptyAncestors } = require('./empty-parent.js');

function loadFixture() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'extreme-test.snippet.html'), 'utf8');
  return parseHTML(html);
}

function rowsFrom(document) {
  return collectCandidates(document, { max: 24 }).map((item, index) => serializeCandidate(item, `e${index}`));
}

test('extreme snippet: real slots are candidates and page chrome is not', () => {
  const { document } = loadFixture();
  const rows = rowsFrom(document);

  const banner = rows.find((row) => (row.src || '').includes('ybs2ffs7v.com/lv/esnk/1837835'));
  assert.ok(banner, 'code-block-8 widget missing');
  assert.equal(banner.discover, 'ad_host_script');
  assert.equal(banner.tag, 'div');
  assert.ok(banner.classes.includes('elementor-widget-html'));
  assert.ok(banner.classes.includes('elementor-element-928b71a'));
  assert.match(banner.text, /Advertisement/);
  assert.equal(banner.fixedOrSticky, false);

  const otherSlot = rows.find((row) => (row.src || '').includes('ybs2ffs7v.com/lv/esnk/1986950'));
  assert.ok(otherSlot);
  assert.equal(otherSlot.discover, 'ad_host_script');
  assert.ok(otherSlot.classes.includes('elementor-element-a73e39c'));

  const fvc = rows.find((row) => (row.src || '').includes('fvcwqkkqmuv.com/aas/r45d/vki/1752012'));
  assert.ok(fvc);
  assert.equal(fvc.discover, 'ad_host_script');
  assert.ok(fvc.classes.includes('elementor-element-ca10baa'));

  const link = rows.find((row) => row.discover === 'ad_host_href');
  assert.ok(link);
  assert.equal(link.tag, 'a');
  assert.match(link.href, /(^|[^a-z0-9])ad\.com\b/);
  assert.match(link.text, /Do Not Click This Link/);

  const vast = rows.find((row) => row.discover === 'vast_player');
  assert.ok(vast);
  assert.match(vast.src, /12ezo5v60\.com\/ceef\/gdt3g0\/tbt\/1754290\/tlk\.xml/);
  assert.ok(vast.classes.includes('elementor-widget-shortcode'));
  assert.ok(vast.classes.includes('elementor-element-99c1b2f'));

  const blank = rows.find((row) => row.classes.includes('elementor-element-8db3f61'));
  assert.ok(blank);
  assert.equal(blank.discover, 'blank_html_widget');
  assert.equal(blank.text, '');

  const headPush = rows.find((row) => (row.src || '').includes('12ezo5v60.com/pn07uscr'));
  assert.ok(headPush);
  assert.equal(headPush.tag, 'script');
  assert.equal(headPush.discover, 'ad_host_script');

  assert.equal(rows.some((row) => row.tag === 'h1'), false);
  assert.equal(rows.some((row) => row.tag === 'nav' || row.tag === 'header'), false);
  assert.equal(rows.some((row) => row.classes.includes('menu-link')), false);
  assert.equal(rows.some((row) => row.classes.includes('main-header-bar')), false);
  assert.equal(rows.some((row) => row.classes.includes('elementor-background-overlay')), false);
  assert.equal(rows.some((row) => row.classes.includes('custom-logo')), false);
  assert.equal(rows.some((row) => row.classes.includes('wp-image-3462')), false);
  assert.equal(rows.some((row) => /Banner Ads/.test(row.text)), false);
  assert.equal(rows.some((row) => /Do you see advertisements/.test(row.text)), false);
  assert.equal(rows.some((row) => /Direct Link Ads/.test(row.text)), false);
  assert.equal(rows.some((row) => /Did you receive an Ad before playing/.test(row.text)), false);
  assert.equal(rows.some((row) => /Push Notification Ads/.test(row.text)), false);

  for (const row of rows) {
    assert.equal(typeof row.discover, 'string');
    assert.ok(row.discover.length > 0);
    assert.ok('href' in row);
    assert.ok(Array.isArray(row.classes));
    assert.ok('idAttr' in row);
    assert.equal(typeof row.text, 'string');
    assert.ok('role' in row);
    assert.equal(typeof row.fixedOrSticky, 'boolean');
  }
});

test('extreme snippet: removal collapses empty ad shells and keeps help, headings, and nav', () => {
  const { document } = loadFixture();

  const banner = document.querySelector('[data-id="928b71a"]');
  const bannerParent = banner.parentElement;
  banner.remove();
  collapseEmptyAncestors(bannerParent);
  assert.equal(document.querySelector('[data-id="928b71a"]'), null);
  assert.match(document.body.textContent, /Banner Ads/);
  assert.match(document.body.textContent, /Do you see advertisements around this box/);
  assert.ok(document.querySelector('[data-id="e0e4cb7"]'));
  assert.ok(document.querySelector('[data-id="4881fb9"]'));

  const link = document.querySelector('a[href="ad.com"]');
  const linkParent = link.parentElement;
  link.remove();
  collapseEmptyAncestors(linkParent);
  assert.equal(document.querySelector('a[href="ad.com"]'), null);
  assert.match(document.body.textContent, /Direct Link Ads/);
  assert.match(document.body.textContent, /direct link to an Ad/);
  assert.ok(document.querySelector('[data-id="e09beb2"]'));
  assert.ok(document.querySelector('.wp-image-3462'));

  const only = document.querySelector('[data-id="a73e39c"]');
  const onlyParent = only.parentElement;
  only.remove();
  const collapsed = collapseEmptyAncestors(onlyParent);
  assert.ok(collapsed.length >= 1);
  assert.equal(document.querySelector('[data-id="a73e39c"]'), null);
  assert.equal(document.querySelector('[data-id="8e07b09"]'), null);
  assert.equal(document.querySelector('[data-id="33b2ae7"]'), null);
  assert.ok(document.querySelector('h1'));
  assert.match(document.querySelector('h1').textContent, /eXtreme Adblocker Test/);
  assert.ok(document.querySelector('#primary-site-navigation'));
  assert.match(document.querySelector('.menu-link').textContent, /Push Notification Ads/);
  assert.ok(document.querySelector('main'));
  assert.match(document.body.textContent, /Did you receive an Ad before playing the video/);
});

test('late-injected extreme hosts, dialogs, and push prompts are candidates', () => {
  const { document } = loadFixture();
  const host = document.createElement('div');
  host.innerHTML = [
    '<iframe src="//12ezo5v60.com/bultykh/ipp24/7/bazinga/1766077"></iframe>',
    '<div role="dialog" style="position:fixed;z-index:2147483647">Special offer</div>',
    '<div class="notification-permission" style="position:fixed">Allow</div>',
    '<div class="elementor-background-overlay" style="position:fixed"></div>',
    '<div role="advertisement">Sponsored</div>',
  ].join('');
  document.body.append(host);

  const rows = rowsFrom(document);
  const frame = rows.find(
    (row) => row.tag === 'iframe' && (row.src || '').includes('12ezo5v60.com/bultykh/ipp24/7/bazinga/1766077'),
  );
  assert.ok(frame);
  assert.equal(frame.discover, 'ad_host_asset');

  const dialog = rows.find((row) => row.discover === 'fixed_overlay');
  assert.ok(dialog);
  assert.equal(dialog.role, 'dialog');
  assert.equal(dialog.fixedOrSticky, true);
  assert.match(dialog.text, /Special offer/);

  const push = rows.find((row) => row.discover === 'push_permission');
  assert.ok(push);
  assert.ok(push.classes.includes('notification-permission'));
  assert.equal(push.fixedOrSticky, true);

  const aria = rows.find((row) => row.discover === 'role_advertisement');
  assert.ok(aria);
  assert.equal(aria.role, 'advertisement');

  assert.equal(
    rows.some((row) => row.classes.includes('elementor-background-overlay')),
    false,
  );
});

test('content script delegates discovery and no longer uses substring ad selectors', () => {
  const src = fs.readFileSync(path.join(__dirname, 'content.js'), 'utf8');
  assert.match(src, /AdgateCandidates\.collectCandidates/);
  assert.match(src, /discover: ser\.discover/);
  assert.match(src, /href: ser\.href/);
  assert.equal(src.includes('[class*="ad"]'), false);
  assert.equal(src.includes('[class*="overlay"]'), false);
  assert.equal(src.includes("[id*='ad']") || src.includes('[id*="ad"]'), false);
});
