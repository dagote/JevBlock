/**
 * After a hide-action node is removed, drop ancestor shells that no longer
 * contain meaningful text or media. Never remove document / landmark stops.
 * Blank, about:blank, and ~0-size iframes are not media. Empty full-bleed
 * ad rails collapse; full-bleed boxes that still hold real content stay.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AdgateCollapse = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const STOP_TAGS = new Set(['html', 'body', 'head', 'main', 'header', 'nav', 'footer']);
  const STOP_ROLES = new Set(['main', 'banner', 'navigation', 'contentinfo']);
  const MEDIA_SELECTOR = 'img, video, audio, canvas, svg, picture, iframe, object, embed';
  const CONTROL_SELECTOR = 'input, textarea, select, button, a[href]';
  const AD_LABEL_RE =
    /^(ad|ads|advert|advertisement|advertisements|sponsored|sponsored content|promoted|promotion)$/i;
  const ROOT_IDS = new Set(['root', 'app', '__next', '__nuxt']);
  const MAX_DEPTH = 12;

  function isSafetyStop(el) {
    if (!el || el.nodeType !== 1) return true;
    const tag = String(el.tagName || '').toLowerCase();
    if (STOP_TAGS.has(tag)) return true;
    const role = String((el.getAttribute && el.getAttribute('role')) || '').toLowerCase();
    if (STOP_ROLES.has(role)) return true;
    if (el.getAttribute && el.getAttribute('data-adgate-ignore') != null) return true;
    if (ROOT_IDS.has(String(el.id || '').toLowerCase())) return true;
    return false;
  }

  function classBlob(el) {
    if (!el) return '';
    if (typeof el.className === 'string') return el.className;
    if (el.className && el.className.baseVal) return String(el.className.baseVal);
    return '';
  }

  function viewOf(el) {
    try {
      if (el.ownerDocument && el.ownerDocument.defaultView) return el.ownerDocument.defaultView;
    } catch {
      /* ignore */
    }
    if (typeof globalThis !== 'undefined' && globalThis.window) return globalThis.window;
    return undefined;
  }

  /** h-full+w-full, or a box that covers about 40% of the viewport. */
  function isFullBleed(el) {
    if (!el || el.nodeType !== 1) return false;
    const blob = classBlob(el);
    if (/\bh-full\b/.test(blob) && /\bw-full\b/.test(blob)) return true;
    const view = viewOf(el);
    if (!view || !el.getBoundingClientRect) return false;
    try {
      const rect = el.getBoundingClientRect();
      const vp = Math.max(view.innerWidth * view.innerHeight, 1);
      if ((rect.width * rect.height) / vp >= 0.4) return true;
    } catch {
      return false;
    }
    return false;
  }

  /**
   * Full-bleed is page chrome only while it still holds real content.
   * An empty h-full/w-full or large ad column (often a flex/grid rail)
   * is not a page root and may collapse.
   */
  function isPageShell(el) {
    if (!isFullBleed(el)) return false;
    if (!hasMeaningfulContent(el)) return false;
    return true;
  }

  function classListOf(el) {
    let className = '';
    if (typeof el.className === 'string') className = el.className;
    else if (el.className && el.className.baseVal) className = String(el.className.baseVal);
    return className.split(/\s+/).filter(Boolean).slice(0, 12);
  }

  function collectText(el) {
    let out = '';
    function walk(node) {
      if (!node) return;
      if (node.nodeType === 3) {
        out += node.nodeValue || '';
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = String(node.tagName || '').toUpperCase();
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return;
      const kids = node.childNodes || [];
      for (let i = 0; i < kids.length; i++) walk(kids[i]);
    }
    walk(el);
    return out.replace(/\s+/g, ' ').trim();
  }

  function frameSrc(node) {
    try {
      if (node.getAttribute) {
        const attr = node.getAttribute('src');
        if (attr != null) return String(attr).trim();
      }
    } catch {
      /* ignore */
    }
    if (node.src == null) return '';
    return String(node.src).trim();
  }

  function isBlankFrameSrc(src) {
    if (!src) return true;
    const lower = src.replace(/\s+/g, '').toLowerCase();
    return lower === 'about:blank' || lower.startsWith('about:blank#') || lower.startsWith('about:blank?');
  }

  /** Visible box is ~0. Prefer layout rect; fall back to width/height attributes. */
  function isTinyBox(node) {
    if (node.getBoundingClientRect) {
      try {
        const rect = node.getBoundingClientRect();
        const w = Number(rect.width);
        const h = Number(rect.height);
        if (Number.isFinite(w) && Number.isFinite(h)) return w <= 2 && h <= 2;
      } catch {
        return false;
      }
    }
    if (!node.getAttribute) return false;
    const w = Number(node.getAttribute('width'));
    const h = Number(node.getAttribute('height'));
    if (!Number.isFinite(w) || !Number.isFinite(h)) return false;
    return w <= 2 && h <= 2;
  }

  function hasMeaningfulContent(el) {
    const media = el.querySelectorAll ? el.querySelectorAll(MEDIA_SELECTOR) : [];
    for (let i = 0; i < media.length; i++) {
      const node = media[i];
      const tag = String(node.tagName || '').toUpperCase();
      if (tag === 'IMG') {
        let w = 3;
        let h = 3;
        try {
          const rect = node.getBoundingClientRect();
          w = rect.width;
          h = rect.height;
        } catch {
          return true;
        }
        if (w <= 2 && h <= 2) continue;
      }
      if (tag === 'IFRAME') {
        if (isBlankFrameSrc(frameSrc(node)) || isTinyBox(node)) continue;
      }
      return true;
    }

    const controls = el.querySelectorAll ? el.querySelectorAll(CONTROL_SELECTOR) : [];
    for (let i = 0; i < controls.length; i++) {
      const node = controls[i];
      const tag = String(node.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      const text = collectText(node);
      if (text && !AD_LABEL_RE.test(text)) return true;
      if (node.querySelector && node.querySelector('img, svg, canvas')) return true;
    }

    const text = collectText(el);
    if (!text || text.length <= 1) return false;
    if (AD_LABEL_RE.test(text)) return false;
    return true;
  }

  function describeRemovedParent(el) {
    return {
      tag: String(el.tagName || '').toLowerCase(),
      idAttr: el.id || null,
      classes: classListOf(el),
      reason: 'empty_parent',
    };
  }

  /** Walk upward from `parent` (the removed node's parent) and detach empty shells. */
  function collapseEmptyAncestors(parent) {
    const removed = [];
    let current = parent;
    let depth = 0;
    while (current && depth < MAX_DEPTH) {
      depth += 1;
      if (isSafetyStop(current) || isPageShell(current)) break;
      if (hasMeaningfulContent(current)) break;
      const next = current.parentElement;
      const info = describeRemovedParent(current);
      try {
        current.remove();
      } catch {
        break;
      }
      removed.push(info);
      current = next;
    }
    return removed;
  }

  return {
    isSafetyStop,
    isPageShell,
    isFullBleed,
    hasMeaningfulContent,
    collapseEmptyAncestors,
    describeRemovedParent,
  };
});
