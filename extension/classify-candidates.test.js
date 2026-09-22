const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseHTML } = require('linkedom');
const { collectCandidates, serializeCandidate } = require('./candidates.js');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'classify-candidates.html');

test('classify path: Advertisement widget and ad.com are candidates without force-hide', () => {
  const src = fs.readFileSync(path.join(__dirname, 'content.js'), 'utf8');
  assert.match(src, /forceHideCheats:\s*false/);
  assert.match(src, /reason: 'judge_error'/);

  const { document } = parseHTML(fs.readFileSync(FIXTURE, 'utf8'));
  const rows = collectCandidates(document, { max: 24, hostname: 'canyoublockit.com' }).map((item, i) =>
    serializeCandidate(item, `e${i}`),
  );
  assert.ok(rows.length >= 2, `expected candidates, got ${rows.length}`);
  const widget = rows.find(
    (row) =>
      row.idAttr === 'ad-slot' ||
      (row.classes || []).includes('elementor-widget-html') ||
      /Advertisement/i.test(row.text || ''),
  );
  assert.ok(widget, `missing Advertisement widget: ${rows.map((r) => r.discover).join(',')}`);
  assert.ok(
    ['ad_host_script', 'ad_label', 'widget_embed'].includes(widget.discover),
    widget.discover,
  );
  const link = rows.find((row) => (row.href || '') === 'ad.com' || row.discover === 'ad_host_href');
  assert.ok(link, 'missing ad.com link candidate');
  assert.equal(
    rows.some((row) => row.tag === 'h1' || /Keep this heading/.test(row.text || '')),
    false,
  );
});
