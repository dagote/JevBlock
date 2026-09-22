/**
 * Page context + one picked element for POST /v1/page-judge.
 *
 * Core fields match Adgate serializeCandidate / PageElement (`id` like `e0`).
 * Subtree fields (innerText, descendant tags, link hrefs, img srcs, outerHTML)
 * are extra payload for the results panel. Dagote's PageElement ignores unknown
 * keys and still scores the core fields. Classify only — nothing here hides DOM.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.JevPickCollect = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const TEXT_CAP = 180;
  const INNER_CAP = 6000;
  const OUTER_CAP = 2500;
  const EXCERPT_CAP = 800;
  const HEADING_CAP = 12;
  const CLASS_CAP = 16;
  const DESCENDANT_NODE_CAP = 400;
  const TAG_CAP = 40;
  const LINK_CAP = 24;
  const IMG_CAP = 16;
  const URL_CAP = 500;

  function collapse(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function cap(value, max, ellipsis) {
    const text = String(value || '');
    if (text.length <= max) return text;
    return ellipsis ? `${text.slice(0, max)}…` : text.slice(0, max);
  }

  function attr(el, name) {
    if (!el || typeof el.getAttribute !== 'function') return null;
    const value = el.getAttribute(name);
    if (value == null) return null;
    const trimmed = String(value).trim();
    return trimmed ? trimmed : null;
  }

  function readText(el) {
    if (!el) return '';
    try {
      if (typeof el.innerText === 'string' && el.innerText) return collapse(el.innerText);
    } catch {
      /* fall through */
    }
    return collapse(el.textContent || '');
  }

  function classTokens(el) {
    const out = [];
    const push = (token) => {
      const clean = String(token || '').trim().slice(0, 80);
      if (!clean || clean === 'jev-pick-hover') return;
      if (out.length < CLASS_CAP) out.push(clean);
    };
    if (el.classList && typeof el.classList[Symbol.iterator] === 'function') {
      for (const token of el.classList) push(token);
    }
    if (!out.length) {
      let raw = '';
      if (typeof el.className === 'string') raw = el.className;
      else if (el.className && el.className.baseVal) raw = String(el.className.baseVal);
      raw.split(/\s+/).forEach(push);
    }
    return out;
  }

  function hostOf(url) {
    if (!url) return null;
    const raw = String(url).trim();
    const match = raw.match(/^(?:https?:)?\/\/([^/?#]+)/i);
    if (match) return match[1].toLowerCase();
    if (/^(?:https?:\/\/)?ad\.com\/?$/i.test(raw)) return 'ad.com';
    return null;
  }

  function roundNum(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n) : 0;
  }

  function nearbyLabel(el, text) {
    const labelledBy = attr(el, 'aria-labelledby');
    if (labelledBy && el.ownerDocument && typeof el.ownerDocument.getElementById === 'function') {
      const parts = [];
      labelledBy.split(/\s+/).forEach((id) => {
        const node = el.ownerDocument.getElementById(id);
        if (!node || node === el) return;
        const labelText = readText(node);
        if (labelText) parts.push(labelText);
      });
      const joined = collapse(parts.join(' '));
      if (joined && joined.length <= 60) return joined;
    }
    const prev = el.previousElementSibling;
    if (prev) {
      const labelText = readText(prev);
      if (labelText && labelText.length <= 60) return labelText;
    }
    const parent = el.parentElement;
    if (parent) {
      const parentText = readText(parent);
      if (parentText && parentText.length <= 40 && parentText !== text) return parentText;
    }
    return null;
  }

  function subtreeOf(el) {
    const tagCounts = new Map();
    const linkHrefs = [];
    const imgSrcs = [];
    const nodes = typeof el.querySelectorAll === 'function' ? el.querySelectorAll('*') : [];
    const total = nodes.length || 0;
    const limit = Math.min(total, DESCENDANT_NODE_CAP);
    for (let i = 0; i < limit; i += 1) {
      const node = nodes[i];
      const tag = String(node.tagName || '').toLowerCase();
      if (tag) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      if (linkHrefs.length < LINK_CAP && tag === 'a') {
        const href = attr(node, 'href');
        if (href) linkHrefs.push(cap(href, URL_CAP, false));
      }
      if (imgSrcs.length < IMG_CAP && tag === 'img') {
        const src = attr(node, 'src');
        if (src) imgSrcs.push(cap(src, URL_CAP, false));
      }
    }
    const descendantTags = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, TAG_CAP)
      .map(([tag, count]) => ({ tag, count }));
    return {
      descendantTags,
      linkHrefs,
      imgSrcs,
      subtreeTruncated: total > DESCENDANT_NODE_CAP,
    };
  }

  function collectPage(doc, loc) {
    const location = loc || {};
    const root = doc || {};
    const headings = Array.from(root.querySelectorAll ? root.querySelectorAll('h1, h2, h3') : [])
      .map((heading) => cap(readText(heading), 200, false))
      .filter(Boolean)
      .slice(0, HEADING_CAP);
    let excerpt = readText(root.body || root.documentElement || root);
    excerpt = cap(excerpt, EXCERPT_CAP, false);
    return {
      url: String(location.href || ''),
      hostname: String(location.hostname || ''),
      title: String(root.title || ''),
      excerpt,
      headings,
    };
  }

  /**
   * One element. `id` defaults to `e0` (Adgate's first candidate id).
   * `text` is capped at 180 like Adgate; `innerText` keeps a longer subtree.
   */
  function serializeElement(el, options) {
    if (!el || typeof el.tagName !== 'string') return null;
    const hooks = options || {};
    const getRect =
      hooks.getRect ||
      ((node) => {
        try {
          return node.getBoundingClientRect?.() || {};
        } catch {
          return {};
        }
      });
    const getStyle =
      hooks.getStyle ||
      ((node) => {
        try {
          return globalThis.getComputedStyle?.(node) || {};
        } catch {
          return {};
        }
      });
    let rect = {};
    try {
      rect = getRect(el) || {};
    } catch {
      rect = {};
    }
    let pos = '';
    try {
      pos = String(getStyle(el)?.position || '').toLowerCase();
    } catch {
      pos = '';
    }
    const full = readText(el);
    const text = cap(full, TEXT_CAP, false);
    const href = attr(el, 'href');
    const src = attr(el, 'src') || attr(el, 'data');
    let outerHTML = '';
    try {
      outerHTML = el.outerHTML || '';
    } catch {
      outerHTML = '';
    }
    const subtree = subtreeOf(el);
    return {
      id: hooks.id || 'e0',
      tag: String(el.tagName || '').toLowerCase(),
      idAttr: attr(el, 'id'),
      classes: classTokens(el),
      role: attr(el, 'role'),
      ariaLabel: attr(el, 'aria-label'),
      text,
      nearbyLabel: nearbyLabel(el, text),
      href: href ? cap(href, URL_CAP, false) : null,
      src: src ? cap(src, URL_CAP, false) : null,
      hrefHost: hostOf(href),
      srcHost: hostOf(src),
      testId: attr(el, 'data-test-id') || attr(el, 'data-testid'),
      rect: {
        w: roundNum(rect.width),
        h: roundNum(rect.height),
        y: roundNum((rect.top || 0) + (hooks.scrollY || 0)),
        x: roundNum((rect.left || 0) + (hooks.scrollX || 0)),
      },
      fixedOrSticky: pos === 'fixed' || pos === 'sticky' || pos === 'absolute',
      discover: 'user_pick',
      innerText: cap(full, INNER_CAP, true),
      descendantTags: subtree.descendantTags,
      linkHrefs: subtree.linkHrefs,
      imgSrcs: subtree.imgSrcs,
      subtreeTruncated: subtree.subtreeTruncated,
      outerHTML: cap(outerHTML, OUTER_CAP, true),
    };
  }

  return {
    TEXT_CAP,
    INNER_CAP,
    OUTER_CAP,
    EXCERPT_CAP,
    LINK_CAP,
    IMG_CAP,
    DESCENDANT_NODE_CAP,
    collectPage,
    serializeElement,
    hostOf,
  };
});
