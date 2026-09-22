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
  assert.match(src, /pageJudgeApi\.createPageJudgeFlight/);
  assert.match(src, /pageJudgeApi\.PAGE_JUDGE_TIMEOUT_MS/);
  assert.match(src, /signal:\s*flightHandle\.signal/);
  assert.match(src, /isCurrent/);
  // Shared SW global: do not redeclare names the imported script might leak.
  assert.equal(/const\s*\{\s*PAGE_JUDGE_TIMEOUT_MS/.test(src), false);
  assert.equal(/const\s+PAGE_JUDGE_TIMEOUT_MS\b/.test(src), false);
  assert.equal(/function\s+createPageJudgeFlight\b/.test(src), false);
});

test('importScripts flight helper does not collide on a shared global', () => {
  const vm = require('node:vm');
  const flightSrc = fs.readFileSync(path.join(__dirname, 'page-judge-flight.js'), 'utf8');
  const context = {
    AbortController,
    setTimeout,
    clearTimeout,
    module: undefined,
  };
  context.globalThis = context;
  context.self = context;
  vm.createContext(context);
  vm.runInContext(flightSrc, context, { filename: 'page-judge-flight.js' });
  vm.runInContext(flightSrc, context, { filename: 'page-judge-flight.js' });
  const bound = vm.runInContext(
    `
    const pageJudgeApi = self.AdgatePageJudgeFlight;
    const pageJudgeFlight = pageJudgeApi.createPageJudgeFlight(pageJudgeApi.PAGE_JUDGE_TIMEOUT_MS);
    ({ timeout: pageJudgeApi.PAGE_JUDGE_TIMEOUT_MS, inFlight: pageJudgeFlight.inFlight })
    `,
    context,
    { filename: 'background-binding.js' },
  );
  assert.equal(bound.timeout, 900000);
  assert.equal(bound.inFlight, false);
  assert.equal(typeof context.AdgatePageJudgeFlight.createPageJudgeFlight, 'function');
});

test('content uses safeJudge for manual scan and limits classify boot storms', () => {
  const src = fs.readFileSync(path.join(__dirname, 'content.js'), 'utf8');
  assert.match(src, /ADGATE_SCAN[\s\S]*safeJudge\(['"]manual['"]\)/);
  assert.equal(src.includes("runJudge('manual')"), false);
  const bootBlock = src.slice(src.indexOf("mode: '0.1.4-classify'"));
  assert.match(bootBlock, /safeJudge\(['"]boot['"]\)/);
  assert.equal(bootBlock.includes("safeJudge('boot2')"), true);
  const classifyBoot = bootBlock.match(
    /if \(s\.enabled === false\) return;[\s\S]*?\n\}\);/,
  )?.[0];
  assert.ok(classifyBoot);
  assert.match(classifyBoot, /setTimeout\(\(\) => safeJudge\('boot'/);
  const blockGuard = classifyBoot.indexOf('blockEnabled === true');
  const boot2 = classifyBoot.indexOf("safeJudge('boot2')");
  assert.ok(blockGuard > 0 && boot2 > blockGuard);
});
