const test = require('node:test');
const assert = require('node:assert/strict');
const { isSafetyStop, isPageShell, isFullBleed, hasMeaningfulContent, collapseEmptyAncestors } = require('./empty-parent.js');

class FakeNode {
  constructor(text) {
    this.nodeType = 3;
    this.nodeValue = text;
    this.parentElement = null;
    this.childNodes = [];
  }
}

class FakeEl {
  constructor(tag, opts = {}) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.id = opts.id || '';
    this.className = opts.className || '';
    this.attrs = opts.attrs || {};
    this.parentElement = null;
    this.childNodes = [];
    this.rect = opts.rect || { width: 100, height: 100 };
    this.removed = false;
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }

  getBoundingClientRect() {
    return this.rect;
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parentElement = this;
      this.childNodes.push(node);
    }
    return this;
  }

  remove() {
    this.removed = true;
    const parent = this.parentElement;
    if (!parent) return;
    parent.childNodes = parent.childNodes.filter((node) => node !== this);
    this.parentElement = null;
  }

  querySelector(sel) {
    const all = this.querySelectorAll(sel);
    return all[0] || null;
  }

  querySelectorAll(sel) {
    const parts = sel.split(',').map((part) => part.trim());
    const out = [];
    const walk = (el) => {
      for (const child of el.childNodes) {
        if (child.nodeType !== 1) continue;
        if (parts.some((part) => matches(child, part))) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
}

function matches(el, sel) {
  if (sel === 'a[href]') return el.tagName === 'A' && !!el.getAttribute('href');
  return el.tagName === sel.toUpperCase();
}

function text(value) {
  return new FakeNode(value);
}

test('collapses empty ad shells and stops at body', () => {
  const body = new FakeEl('body');
  const rail = new FakeEl('div', { className: 'rail' });
  const slot = new FakeEl('div', { id: 'slot', className: 'ad-slot' });
  const frame = new FakeEl('iframe');
  body.append(rail);
  rail.append(slot);
  slot.append(frame);

  frame.remove();
  const removed = collapseEmptyAncestors(slot);

  assert.equal(removed.length, 2);
  assert.deepEqual(removed[0], {
    tag: 'div',
    idAttr: 'slot',
    classes: ['ad-slot'],
    reason: 'empty_parent',
  });
  assert.equal(removed[1].classes[0], 'rail');
  assert.equal(removed[1].reason, 'empty_parent');
  assert.equal(body.removed, false);
  assert.equal(slot.removed, true);
  assert.equal(rail.removed, true);
});

test('keeps a parent that still has article text', () => {
  const wrap = new FakeEl('div', { className: 'story' });
  const frame = new FakeEl('iframe');
  wrap.append(frame, text('The actual story stays.'));
  frame.remove();
  assert.equal(hasMeaningfulContent(wrap), true);
  assert.deepEqual(collapseEmptyAncestors(wrap), []);
  assert.equal(wrap.removed, false);
});

test('removes an empty wrapper inside main and stops at main', () => {
  const main = new FakeEl('main');
  const slot = new FakeEl('div', { className: 'ad-slot' });
  const frame = new FakeEl('iframe');
  main.append(slot);
  slot.append(frame);
  frame.remove();
  const removed = collapseEmptyAncestors(slot);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].tag, 'div');
  assert.equal(main.removed, false);
  assert.equal(isSafetyStop(main), true);
});

test('treats a lone advertisement label as empty chrome', () => {
  const slot = new FakeEl('aside', { className: 'sponsor' });
  slot.append(text('Advertisement'));
  assert.equal(hasMeaningfulContent(slot), false);
  const removed = collapseEmptyAncestors(slot);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].tag, 'aside');
});

test('keeps a parent with a real image and drops a tracking pixel shell', () => {
  const withPhoto = new FakeEl('div');
  withPhoto.append(new FakeEl('img', { rect: { width: 300, height: 200 } }));
  assert.equal(hasMeaningfulContent(withPhoto), true);

  const pixelShell = new FakeEl('div', { className: 'pixel' });
  pixelShell.append(new FakeEl('img', { rect: { width: 1, height: 1 } }));
  assert.equal(hasMeaningfulContent(pixelShell), false);
  assert.equal(collapseEmptyAncestors(pixelShell).length, 1);
});

test('keeps a full-bleed shell that still has real content, and app roots', () => {
  const shell = new FakeEl('div', { className: 'h-full w-full' });
  const slot = new FakeEl('div', { className: 'ad-slot' });
  const heading = new FakeEl('h1');
  heading.append(text('Caution1'));
  shell.append(slot, heading);
  const crowded = new FakeEl('div', {
    className: Array.from({ length: 14 }, (_, i) => `u${i}`).concat(['h-full', 'w-full']).join(' '),
  });
  const crowdedHeading = new FakeEl('h2');
  crowdedHeading.append(text('Caution1'));
  crowded.append(crowdedHeading);
  assert.equal(isFullBleed(crowded), true);
  assert.equal(isPageShell(shell), true);
  assert.equal(isPageShell(crowded), true);
  assert.deepEqual(collapseEmptyAncestors(crowded), []);
  const removed = collapseEmptyAncestors(slot);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].classes[0], 'ad-slot');
  assert.equal(shell.removed, false);
  assert.equal(heading.removed, false);

  const root = new FakeEl('div', { id: 'root' });
  assert.equal(isSafetyStop(root), true);
  assert.deepEqual(collapseEmptyAncestors(root), []);
});

test('blank or zero-size iframes do not keep a parent meaningful', () => {
  const blank = new FakeEl('div', { className: 'ad-slot' });
  blank.append(new FakeEl('iframe', { attrs: { src: 'about:blank' }, rect: { width: 300, height: 250 } }));
  assert.equal(hasMeaningfulContent(blank), false);
  assert.equal(collapseEmptyAncestors(blank).length, 1);
  assert.equal(blank.removed, true);

  const emptySrc = new FakeEl('div', { className: 'ad-slot' });
  emptySrc.append(new FakeEl('iframe', { attrs: { src: '' }, rect: { width: 320, height: 50 } }));
  assert.equal(hasMeaningfulContent(emptySrc), false);
  assert.equal(collapseEmptyAncestors(emptySrc).length, 1);

  const propertyBlank = new FakeEl('div');
  const frame = new FakeEl('iframe', { rect: { width: 300, height: 250 } });
  frame.src = 'about:blank';
  propertyBlank.append(frame);
  assert.equal(hasMeaningfulContent(propertyBlank), false);

  const tiny = new FakeEl('div', { className: 'pixel' });
  tiny.append(
    new FakeEl('iframe', { attrs: { src: 'https://ads.example/unit' }, rect: { width: 0, height: 0 } }),
  );
  assert.equal(hasMeaningfulContent(tiny), false);
  assert.equal(collapseEmptyAncestors(tiny).length, 1);

  const live = new FakeEl('div');
  live.append(
    new FakeEl('iframe', { attrs: { src: 'https://ads.example/unit' }, rect: { width: 300, height: 250 } }),
  );
  assert.equal(hasMeaningfulContent(live), true);
  assert.deepEqual(collapseEmptyAncestors(live), []);
  assert.equal(live.removed, false);
});

test('h-full w-full empty ad rail collapses after the iframe is gone; heading and main stay', () => {
  const body = new FakeEl('body');
  const main = new FakeEl('main');
  const heading = new FakeEl('h1');
  heading.append(text('Caution1'));
  const grid = new FakeEl('div', { className: 'grid' });
  const many = Array.from({ length: 14 }, (_, i) => `u${i}`).concat(['h-full', 'w-full']).join(' ');
  const rail = new FakeEl('div', { id: 'rail', className: many });
  const story = new FakeEl('div', { className: 'story' });
  const storyHeading = new FakeEl('h2');
  storyHeading.append(text('Keep this heading'));
  story.append(storyHeading);
  const frame = new FakeEl('iframe', { attrs: { src: 'https://ads.example/rail' }, rect: { width: 300, height: 600 } });
  rail.append(frame);
  grid.append(rail, story);
  main.append(heading, grid);
  body.append(main);

  frame.remove();
  assert.equal(isFullBleed(rail), true);
  assert.equal(hasMeaningfulContent(rail), false);
  assert.equal(isPageShell(rail), false);
  const removed = collapseEmptyAncestors(rail);
  assert.equal(rail.removed, true);
  assert.ok(removed.some((parent) => parent.idAttr === 'rail'));
  assert.equal(grid.removed, false);
  assert.equal(story.removed, false);
  assert.equal(storyHeading.removed, false);
  assert.equal(main.removed, false);
  assert.equal(heading.removed, false);
  assert.equal(body.removed, false);
  assert.equal(isSafetyStop(main), true);
});

test('large empty viewport rail collapses and a contentful large shell stays', () => {
  const view = { innerWidth: 1280, innerHeight: 800 };
  const rail = new FakeEl('aside', { className: 'rail', rect: { width: 900, height: 700 } });
  rail.ownerDocument = { defaultView: view };
  rail.append(new FakeEl('iframe', { attrs: { src: 'about:blank' }, rect: { width: 900, height: 700 } }));
  assert.equal(isPageShell(rail), false);
  assert.equal(collapseEmptyAncestors(rail).length, 1);
  assert.equal(rail.removed, true);

  const page = new FakeEl('div', { rect: { width: 900, height: 700 } });
  page.ownerDocument = { defaultView: view };
  const heading = new FakeEl('h1');
  heading.append(text('Caution1'));
  page.append(heading);
  assert.equal(isPageShell(page), true);
  assert.deepEqual(collapseEmptyAncestors(page), []);
  assert.equal(page.removed, false);
  assert.equal(heading.removed, false);
});

test('stops at landmark roles and ignore markers', () => {
  const region = new FakeEl('div', { attrs: { role: 'main' } });
  assert.equal(isSafetyStop(region), true);
  assert.deepEqual(collapseEmptyAncestors(region), []);

  const keeper = new FakeEl('div', { attrs: { 'data-adgate-ignore': '' } });
  assert.equal(isSafetyStop(keeper), true);
  assert.equal(isSafetyStop(new FakeEl('header')), true);
  assert.equal(isSafetyStop(new FakeEl('div')), false);
});
