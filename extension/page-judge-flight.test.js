const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PAGE_JUDGE_TIMEOUT_MS, createPageJudgeFlight } = require('./page-judge-flight.js');

test('page-judge timeout is at least 10 minutes', () => {
  assert.ok(PAGE_JUDGE_TIMEOUT_MS >= 600000);
  assert.equal(PAGE_JUDGE_TIMEOUT_MS, 900000);
});

test('single-flight begin aborts the previous controller', () => {
  const flight = createPageJudgeFlight(60_000);
  const first = flight.begin();
  assert.equal(flight.inFlight, true);
  assert.equal(first.isCurrent(), true);

  let aborted = false;
  first.signal.addEventListener('abort', () => {
    aborted = true;
  });

  const second = flight.begin();
  assert.equal(aborted, true);
  assert.equal(first.isCurrent(), false);
  assert.equal(second.isCurrent(), true);
  assert.equal(second.gen, first.gen + 1);

  second.done();
  assert.equal(flight.inFlight, false);
});

test('background wires single-flight + long page-judge timeout', () => {
  const src = fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8');
  assert.match(src, /importScripts\(['"]page-judge-flight\.js['"]\)/);
  assert.match(src, /createPageJudgeFlight/);
  assert.match(src, /PAGE_JUDGE_TIMEOUT_MS|flight\.timeoutMs|signal:\s*flightHandle\.signal/);
  assert.match(src, /isCurrent/);
});

test('content uses safeJudge for manual scan and limits classify boot storms', () => {
  const src = fs.readFileSync(path.join(__dirname, 'content.js'), 'utf8');
  assert.match(src, /ADGATE_SCAN[\s\S]*safeJudge\(['"]manual['"]\)/);
  assert.equal(src.includes("runJudge('manual')"), false);
  // Classify path (Block off): one boot only — no boot2/boot3/boot4 storms.
  const bootBlock = src.slice(src.indexOf("mode: '0.1.3-classify'"));
  assert.match(bootBlock, /safeJudge\(['"]boot['"]\)/);
  assert.equal(bootBlock.includes("safeJudge('boot2')"), true); // only when blockEnabled
  const classifyBoot = bootBlock.match(
    /if \(s\.enabled === false\) return;[\s\S]*?\n\}\);/,
  )?.[0];
  assert.ok(classifyBoot);
  assert.match(classifyBoot, /setTimeout\(\(\) => safeJudge\('boot'/);
  // boot2+ must be inside blockEnabled guard
  const blockGuard = classifyBoot.indexOf('blockEnabled === true');
  const boot2 = classifyBoot.indexOf("safeJudge('boot2')");
  assert.ok(blockGuard > 0 && boot2 > blockGuard);
});
