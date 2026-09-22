/**
 * Adgate 0.1.0 — JEV classify + user ranks; Extreme force-hide cheats opt-in.
 * Annotate chips stay off unless Advanced is enabled.
 */

const DEFAULTS = {
  enabled: true,
  blockEnabled: false,
  reviewMode: true,
  hideMin: 0.75,
  showLabels: false,
  showPanel: false,
  extremeEarly: false,
  forceHideCheats: false,
  uiRev: 2,
  maxElements: 24,
  serverUrl: 'http://192.168.0.119:8770',
  ranks: null,
};

const CLIENT = 'extension-0.1.0';

let suppressMutations = false;

function log(level, event, fields) {
  try {
    if (self.AdgateLog?.[level]) AdgateLog[level](event, { page: location.href, ...fields });
  } catch {
    /* ignore */
  }
  try {
    chrome.runtime
      .sendMessage({ type: 'ADGATE_LOG', level, event, fields: { page: location.href, ...fields } })
      .catch(() => {});
  } catch {
    /* ignore */
  }
}

function cls(el) {
  if (!el?.className) return '';
  if (typeof el.className === 'string') return el.className;
  return String(el.className.baseVal || '');
}

function isLayoutShell(el) {
  if (!(el instanceof Element)) return true;
  const tag = el.tagName.toLowerCase();
  if (['html', 'body', 'main', 'header', 'nav', 'footer'].includes(tag)) return true;
  let pos = '';
  try {
    pos = getComputedStyle(el).position;
  } catch {
    /* ignore */
  }
  const overlay = pos === 'fixed' || pos === 'sticky';
  if (['article', 'section'].includes(tag) && !overlay) return true;
  const c = cls(el);
  if (!overlay && /\bh-full\b/.test(c) && /\bw-full\b/.test(c)) return true;
  if (!overlay) {
    try {
      const r = el.getBoundingClientRect();
      const vp = Math.max(window.innerWidth * window.innerHeight, 1);
      if ((r.width * r.height) / vp >= 0.4) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

function extractPage() {
  const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
    .map((h) => (h.innerText || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 12);
  let excerpt = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
  if (excerpt.length > 800) excerpt = excerpt.slice(0, 800);
  return {
    url: location.href,
    hostname: location.hostname,
    title: document.title || '',
    excerpt,
    headings,
  };
}

function layoutHooks() {
  return {
    getRect(el) {
      return el.getBoundingClientRect();
    },
    getStyle(el) {
      return getComputedStyle(el);
    },
    viewport: {
      width: window.innerWidth || 1280,
      height: window.innerHeight || 720,
    },
    scrollX: window.scrollX || 0,
    scrollY: window.scrollY || 0,
  };
}

function snapshotEl(el) {
  let html = '';
  try {
    html = el.outerHTML || '';
  } catch {
    /* ignore */
  }
  if (html.length > 600) html = `${html.slice(0, 600)}…`;
  let text = '';
  try {
    text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  } catch {
    /* ignore */
  }
  if (text.length > 180) text = text.slice(0, 180);
  return { html, text };
}

/** Live DOM scan. Zero-size Elementor slots stay; substring class matches do not. */
function collectElements(max) {
  const picked = globalThis.AdgateCandidates.collectCandidates(document, {
    ...layoutHooks(),
    max,
  });
  log('info', 'candidates_collected', {
    max,
    picked: picked.length,
    sample: picked.slice(0, 12).map((item) => ({
      tag: item.el.tagName.toLowerCase(),
      discover: item.discover,
      pri: Math.round(item.pri),
      src: (item.evidence || '').slice(0, 140),
      cls: cls(item.el).slice(0, 80),
      id: item.el.id || '',
    })),
  });
  return picked;
}

const AD_WIDGET_SRC_RE = /ybs2ffs7v\.com|fvcwqkkqmuv\.com/i;

/** Issue #1: Elementor html widgets labeled Advertisement or fed by ybs/fvc scripts. */
function findAdvertisementWidgets(doc) {
  const root = typeof doc.querySelectorAll === 'function' ? doc : doc.documentElement || doc.body;
  if (!root || !root.querySelectorAll) return [];
  const hits = new Map();
  root.querySelectorAll('.elementor-widget-html').forEach((widget) => {
    const scripts = widget.querySelectorAll ? widget.querySelectorAll('script[src]') : [];
    let fed = false;
    for (let i = 0; i < scripts.length; i++) {
      if (AD_WIDGET_SRC_RE.test(scripts[i].getAttribute('src') || '')) fed = true;
    }
    let labeled = false;
    const labels = widget.querySelectorAll ? widget.querySelectorAll('center, p, span, div, label, small') : [];
    for (let i = 0; i < labels.length; i++) {
      const raw = labels[i].textContent || '';
      if (raw.length > 40) continue;
      if (/^advertisements?$/i.test(raw.replace(/\s+/g, ' ').trim())) labeled = true;
    }
    if (fed) hits.set(widget, 'force_hide_ad_host_widget');
    else if (labeled) hits.set(widget, 'force_hide_advertisement_label');
  });
  return [...hits.entries()];
}

function removeAdvertisementWidgets(doc) {
  const rows = [];
  findAdvertisementWidgets(doc).forEach(([el, reason], i) => {
    if (!el.isConnected) return;
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 180);
    const outcome = hideEl(el, 1, true);
    rows.push({
      id: `h${i}`,
      tag: String(el.tagName || '').toLowerCase(),
      src: null,
      href: null,
      classes: cls(el).split(/\s+/).filter(Boolean).slice(0, 16),
      idAttr: el.id || null,
      role: el.getAttribute('role'),
      rect: null,
      text,
      fixedOrSticky: false,
      discover: reason,
      noul: 1,
      action: 'hide',
      reason,
      removed: outcome.removed,
      cascadeParents: outcome.cascade,
      before: outcome.before,
    });
  });
  return rows;
}

const CLB_CONTAINER_RE = /__clb-\S*_container/;

/** Issue #2: Clickadu-style __clb-*_container creatives left after Advertisement widgets are removed. */
function findClbContainers(doc) {
  const root = typeof doc.querySelectorAll === 'function' ? doc : doc.documentElement || doc.body;
  if (!root || !root.querySelectorAll) return [];
  const hits = [];
  root.querySelectorAll('[id*="__clb-"], [class*="__clb-"]').forEach((el) => {
    if (!CLB_CONTAINER_RE.test(`${el.id || ''} ${cls(el)}`)) return;
    if (hits.some((prev) => prev === el || (prev.contains && prev.contains(el)))) return;
    hits.push(el);
  });
  return hits;
}

function removeClbContainers(doc) {
  const rows = [];
  findClbContainers(doc).forEach((el, i) => {
    if (!el.isConnected) return;
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 180);
    const outcome = hideEl(el, 1, true);
    rows.push({
      id: `c${i}`,
      tag: String(el.tagName || '').toLowerCase(),
      src: el.getAttribute('src'),
      href: null,
      classes: cls(el).split(/\s+/).filter(Boolean).slice(0, 16),
      idAttr: el.id || null,
      role: el.getAttribute('role'),
      rect: null,
      text,
      fixedOrSticky: false,
      discover: 'force_hide_clb_container',
      noul: 1,
      action: 'hide',
      reason: 'force_hide_clb_container',
      removed: outcome.removed,
      cascadeParents: outcome.cascade,
      before: outcome.before,
    });
  });
  return rows;
}

const AD_COM_HREF_RE = /^(?:https?:\/\/)?ad\.com\/?$/i;

/** Issue #3: Extreme Test direct-link ads. Hide the ad.com anchor only; leave help copy. */
function findAdComLinks(doc) {
  const root = typeof doc.querySelectorAll === 'function' ? doc : doc.documentElement || doc.body;
  if (!root || !root.querySelectorAll) return [];
  const hits = [];
  root.querySelectorAll('a[href]').forEach((el) => {
    if (AD_COM_HREF_RE.test((el.getAttribute('href') || '').trim())) hits.push(el);
  });
  return hits;
}

function removeAdComLinks(doc) {
  const rows = [];
  findAdComLinks(doc).forEach((el, i) => {
    if (!el.isConnected) return;
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 180);
    const href = el.getAttribute('href');
    const outcome = hideEl(el, 1, true);
    rows.push({
      id: `a${i}`,
      tag: 'a',
      src: null,
      href: href || null,
      classes: cls(el).split(/\s+/).filter(Boolean).slice(0, 16),
      idAttr: el.id || null,
      role: el.getAttribute('role'),
      rect: null,
      text,
      fixedOrSticky: false,
      discover: 'force_hide_ad_com_link',
      noul: 1,
      action: 'hide',
      reason: 'force_hide_ad_com_link',
      removed: outcome.removed,
      cascadeParents: outcome.cascade,
      before: outcome.before,
    });
  });
  return rows;
}

const VAST_HOST_RE = /12ezo5v60\.com/i;
const VAST_TAG_RE = /vastTag|vast_options/i;

function vastSlotWidget(el) {
  let cur = el;
  while (cur && cur.nodeType === 1) {
    const c = cls(cur);
    if (/elementor-widget-shortcode|elementor-widget-html/.test(c)) return cur;
    const tag = String(cur.tagName || '').toLowerCase();
    if (
      cur !== el &&
      (['html', 'body', 'main', 'header', 'nav', 'footer', 'section'].includes(tag) ||
        /elementor-widget-text-editor|elementor-column|elementor-section|elementor-widget-wrap/.test(c))
    ) {
      break;
    }
    cur = cur.parentElement;
  }
  return null;
}

function widgetHasVast(widget) {
  if (!widget || !widget.querySelectorAll) return false;
  const scripts = widget.querySelectorAll('script');
  for (let i = 0; i < scripts.length; i++) {
    const src = scripts[i].getAttribute('src') || '';
    const text = (scripts[i].textContent || '').replace(/\\\//g, '/');
    if (VAST_HOST_RE.test(src) || VAST_HOST_RE.test(text)) return true;
    if (VAST_TAG_RE.test(text) && VAST_HOST_RE.test(text)) return true;
    if (/vastTag/i.test(text) && /https?:\/\//i.test(text)) return true;
  }
  if (widget.querySelector('.vast_video_loading, .fluid_video_wrapper')) return true;
  return false;
}

/** Issue #4: Elementor shortcode/html widgets that load a VAST pre-roll tag. */
function findVastSlots(doc) {
  const root = typeof doc.querySelectorAll === 'function' ? doc : doc.documentElement || doc.body;
  if (!root || !root.querySelectorAll) return [];
  const hits = [];
  root.querySelectorAll('.elementor-widget-shortcode, .elementor-widget-html').forEach((widget) => {
    if (!widgetHasVast(widget)) return;
    if (hits.includes(widget)) return;
    hits.push(widget);
  });
  root.querySelectorAll('script').forEach((script) => {
    const blob = `${script.getAttribute('src') || ''} ${(script.textContent || '').replace(/\\\//g, '/')}`;
    if (!VAST_HOST_RE.test(blob) && !(/vastTag/i.test(blob) && /https?:\/\//i.test(blob))) return;
    const widget = vastSlotWidget(script);
    if (!widget || hits.includes(widget)) return;
    hits.push(widget);
  });
  return hits;
}

function removeVastSlots(doc) {
  const rows = [];
  findVastSlots(doc).forEach((el, i) => {
    if (!el.isConnected) return;
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 180);
    const outcome = hideEl(el, 1, true);
    rows.push({
      id: `v${i}`,
      tag: String(el.tagName || '').toLowerCase(),
      src: null,
      href: null,
      classes: cls(el).split(/\s+/).filter(Boolean).slice(0, 16),
      idAttr: el.id || null,
      role: el.getAttribute('role'),
      rect: null,
      text,
      fixedOrSticky: false,
      discover: 'force_hide_vast_slot',
      noul: 1,
      action: 'hide',
      reason: 'force_hide_vast_slot',
      removed: outcome.removed,
      cascadeParents: outcome.cascade,
      before: outcome.before,
    });
  });
  return rows;
}

function isFixedOrSticky(el) {
  const style = (el.getAttribute && el.getAttribute('style')) || '';
  if (/position\s*:\s*(fixed|sticky)/i.test(style)) return true;
  try {
    const pos = getComputedStyle(el).position;
    return pos === 'fixed' || pos === 'sticky';
  } catch {
    return false;
  }
}

/** Issue #5: interstitial dialogs, notification permission spam, floating in-page push cards. */
function classifyPushSpam(el) {
  if (!el || el.nodeType !== 1) return null;
  const tag = String(el.tagName || '').toLowerCase();
  if (['html', 'body', 'head', 'main', 'nav', 'header', 'footer'].includes(tag)) return null;
  if (el.closest && el.closest('.elementor-widget-text-editor, .elementor-widget-image')) return null;
  const c = cls(el);
  if (/elementor-background-overlay/.test(c)) return null;
  const role = (el.getAttribute('role') || '').toLowerCase();
  const blob = `${c} ${el.id || ''} ${(el.textContent || '').replace(/\s+/g, ' ').trim()}`;
  const fixed = isFixedOrSticky(el);

  if (/\bnotification-permission\b/i.test(c) || /wants to\b.{0,80}notifications/i.test(blob)) {
    return 'force_hide_push_permission';
  }
  if (/\binpage-?push\b|\bpush-card\b|\bpush_notification\b|\bfloating-?push\b/i.test(`${c} ${el.id || ''}`)) {
    return 'force_hide_inpage_push';
  }
  if (fixed && (role === 'dialog' || role === 'alertdialog' || /interstitial|special.?offer/i.test(blob))) {
    return 'force_hide_interstitial';
  }
  return null;
}

function findPushSpam(doc) {
  const root = typeof doc.querySelectorAll === 'function' ? doc : doc.documentElement || doc.body;
  if (!root || !root.querySelectorAll) return [];
  const hits = new Map();
  root
    .querySelectorAll(
      '[role="dialog"], [role="alertdialog"], .notification-permission, [class*="inpage-push"], [class*="push-card"], [class*="push_notification"], [class*="floating-push"], [style*="fixed"], [style*="sticky"]',
    )
    .forEach((el) => {
      const reason = classifyPushSpam(el);
      if (!reason) return;
      for (const prev of hits.keys()) {
        if (prev === el || (prev.contains && prev.contains(el))) return;
        if (el.contains && el.contains(prev)) hits.delete(prev);
      }
      hits.set(el, reason);
    });
  return [...hits.entries()];
}

function removePushSpam(doc) {
  const rows = [];
  findPushSpam(doc).forEach(([el, reason], i) => {
    if (!el.isConnected) return;
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 180);
    const outcome = hideEl(el, 1, true);
    rows.push({
      id: `p${i}`,
      tag: String(el.tagName || '').toLowerCase(),
      src: null,
      href: null,
      classes: cls(el).split(/\s+/).filter(Boolean).slice(0, 16),
      idAttr: el.id || null,
      role: el.getAttribute('role'),
      rect: null,
      text,
      fixedOrSticky: isFixedOrSticky(el),
      discover: reason,
      noul: 1,
      action: 'hide',
      reason,
      removed: outcome.removed,
      cascadeParents: outcome.cascade,
      before: outcome.before,
    });
  });
  return rows;
}

function hideEl(el, noul, slot) {
  if (!el || !el.isConnected) return { removed: false, cascade: [], before: null };
  if (!slot && isLayoutShell(el) && el.tagName !== 'IFRAME') {
    const ifr = el.querySelector('iframe');
    if (ifr) return hideEl(ifr, noul, false);
    log('warn', 'skip_layout', { tag: el.tagName, cls: cls(el).slice(0, 60) });
    return { removed: false, cascade: [], before: null };
  }
  const before = snapshotEl(el);
  el.setAttribute('data-adgate-blocked', String(noul));
  if (el.tagName === 'IFRAME') {
    try {
      el.src = 'about:blank';
    } catch {
      /* ignore */
    }
  }
  el.querySelectorAll?.('iframe').forEach((f) => {
    try {
      f.src = 'about:blank';
    } catch {
      /* ignore */
    }
  });
  const parent = el.parentElement;
  try {
    el.remove();
  } catch {
    el.style.setProperty('display', 'none', 'important');
    return { removed: false, cascade: [], before };
  }
  const cascade = globalThis.AdgateCollapse?.collapseEmptyAncestors(parent) || [];
  return { removed: true, cascade, before };
}

function clearAnnotations() {
  document.querySelectorAll('[data-adgate-label],[data-adgate-panel]').forEach((n) => n.remove());
  document.querySelectorAll('[data-adgate-marked]').forEach((el) => {
    el.style.removeProperty('outline');
    el.style.removeProperty('outline-offset');
    el.removeAttribute('data-adgate-marked');
    el.removeAttribute('title');
  });
}

function colorForP(p) {
  if (p >= 0.75) return '#7c3aed';
  if (p >= 0.45) return '#d97706';
  return '#64748b';
}

/** Optional advanced annotate chip. Review mode does not call this. */
function labelElement(el, row) {
  if (!el?.isConnected) return;
  const r = el.getBoundingClientRect();
  if (r.width < 8 || r.height < 8) return;

  const pct = Math.round(row.noul * 100);
  const color = colorForP(row.noul);
  el.setAttribute('data-adgate-marked', row.id);
  el.style.setProperty('outline', `2px solid ${color}`, 'important');
  el.style.setProperty('outline-offset', '2px', 'important');
  el.title = [
    `Adgate ${pct}%`,
    `suggest: ${row.action}`,
    `reason: ${row.reason || ''}`,
    `tag: ${row.tag}`,
    row.src ? `src: ${row.src}` : '',
    row.cls ? `class: ${row.cls}` : '',
    row.testId ? `testId: ${row.testId}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const chip = document.createElement('div');
  chip.setAttribute('data-adgate-label', row.id);
  chip.textContent = `${pct}%`;
  Object.assign(chip.style, {
    position: 'fixed',
    left: `${Math.max(2, Math.min(r.left, window.innerWidth - 48))}px`,
    top: `${Math.max(2, Math.min(r.top, window.innerHeight - 24))}px`,
    zIndex: '2147483645',
    background: color,
    color: '#fff',
    font: '700 12px/1.2 ui-monospace, monospace',
    padding: '3px 6px',
    borderRadius: '4px',
    pointerEvents: 'none',
    boxShadow: '0 1px 3px rgba(0,0,0,.35)',
  });
  document.documentElement.appendChild(chip);
}

function renderPanel(payload) {
  document.querySelectorAll('[data-adgate-panel]').forEach((n) => n.remove());
  const panel = document.createElement('div');
  panel.setAttribute('data-adgate-panel', '1');
  Object.assign(panel.style, {
    position: 'fixed',
    right: '12px',
    bottom: '12px',
    width: 'min(420px, 92vw)',
    maxHeight: '45vh',
    overflow: 'auto',
    zIndex: '2147483646',
    background: 'rgba(18,18,26,0.96)',
    color: '#e8e8ef',
    border: '1px solid #444',
    borderRadius: '10px',
    padding: '10px 12px',
    font: '12px/1.35 system-ui, sans-serif',
    boxShadow: '0 8px 28px rgba(0,0,0,.45)',
  });

  const conf =
    payload.site_type_confidence != null
      ? ` · conf ${Math.round(payload.site_type_confidence * 100)}%`
      : '';
  const probs = payload.site_type_probabilities || {};
  const topTypes = Object.entries(probs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, v]) => `${k} ${Math.round(v * 100)}%`)
    .join(' · ');

  const rows = [...(payload.decisions || [])].sort((a, b) => b.noul - a.noul);
  const body = rows
    .map((d) => {
      const pct = Math.round(d.noul * 100);
      return `<div style="border-top:1px solid #333;padding:6px 0">
        <div><b style="color:${colorForP(d.noul)}">${pct}%</b>
          · <code>${d.id}</code> · ${d.tag} · <i>${d.action}</i>
          ${d.removed ? ' · removed' : ''}
          ${d.reason ? ` · ${d.reason}` : ''}
          ${d.discover ? ` · via ${escapeHtml(d.discover)}` : ''}</div>
        ${d.src ? `<div style="color:#888;word-break:break-all">src: ${escapeHtml(d.src)}</div>` : ''}
        ${(d.cascadeParents || []).length ? `<div style="color:#a78bfa">empty parents: ${d.cascadeParents.length}</div>` : ''}
      </div>`;
    })
    .join('');

  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;gap:8px;align-items:start">
      <div>
        <div style="font-weight:700">Adgate annotate (advanced)</div>
        <div style="color:#c4b5fd">site: ${escapeHtml(payload.site_type || '?')}${conf}</div>
        <div style="color:#777;font-size:11px">${escapeHtml(topTypes)}</div>
        <div style="color:#666;font-size:11px">${payload.ms ?? '?'} ms · block ${payload.blockEnabled ? 'ON' : 'OFF'}</div>
      </div>
      <button type="button" data-adgate-close style="background:#333;color:#fff;border:0;border-radius:6px;padding:4px 8px;cursor:pointer">✕</button>
    </div>
    ${body || '<div style="margin-top:8px;color:#888">No candidates</div>'}
  `;
  panel.querySelector('[data-adgate-close]')?.addEventListener('click', () => panel.remove());
  document.documentElement.appendChild(panel);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sendMessage(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message || String(err)));
      else resolve(res);
    });
  });
}

async function loadSettings() {
  const stored = await chrome.storage.sync.get(null);
  const data = { ...DEFAULTS, ...stored };
  data.forceHideCheats = data.forceHideCheats === true;
  data.ranks = globalThis.AdgateRanks?.normalizeRanks(data.ranks) || data.ranks;
  if ((stored.uiRev || 0) >= 2) return data;
  const migrated = {
    showLabels: false,
    showPanel: false,
    reviewMode: true,
    forceHideCheats: false,
    uiRev: 2,
  };
  await chrome.storage.sync.set(migrated);
  return { ...data, ...migrated, ranks: data.ranks };
}

async function rememberRun(run) {
  const prev = await chrome.storage.local.get(['adgateRunHistory']);
  const history = Array.isArray(prev.adgateRunHistory) ? prev.adgateRunHistory : [];
  history.unshift(run);
  await chrome.storage.local.set({
    adgateLastRun: run,
    adgateLastScan: run,
    adgateRunHistory: history.slice(0, 8),
  });
}

async function runJudge(trigger) {
  const settings = await loadSettings();
  if (settings.enabled === false) {
    return { ok: false, error: 'disabled' };
  }

  clearAnnotations();
  const page = extractPage();
  const blockEnabled = settings.blockEnabled === true;
  const decisionRows = [];
  suppressMutations = true;

  if (blockEnabled && settings.forceHideCheats === true) {
    // Legacy Extreme force_hide_* — opt-in only. Default product is JEV + ranks.
    decisionRows.push(...removeAdvertisementWidgets(document));
    decisionRows.push(...removeClbContainers(document));
    decisionRows.push(...removeAdComLinks(document));
    decisionRows.push(...removeVastSlots(document));
    decisionRows.push(...removePushSpam(document));
  }

  const picked = collectElements(Number(settings.maxElements) || 24).filter((item) => item.el?.isConnected);
  const hooks = layoutHooks();
  const elements = picked.map((item, i) => globalThis.AdgateCandidates.serializeCandidate(item, `e${i}`, hooks));
  const byId = Object.fromEntries(picked.map((item, i) => [`e${i}`, item.el]));

  log('info', 'judge_start', { trigger, n: elements.length, heuristic: decisionRows.length, title: page.title.slice(0, 80) });

  let res = {
    elements: [],
    requestId: null,
    site_type: null,
    ms: 0,
    hideMin: Number(settings.hideMin) || 0.75,
    reviewMin: globalThis.AdgateDecisionLog?.REVIEW_MIN,
  };
  let jevError = null;
  if (elements.length) {
    try {
      res = await sendMessage({
        type: 'ADGATE_PAGE_JUDGE',
        page,
        elements,
        hideMin: Number(settings.hideMin) || 0.75,
      });
      if (res?.error) jevError = new Error(res.error);
    } catch (err) {
      jevError = err;
    }
    if (jevError) log('error', 'judge_fail', { error: String(jevError.message || jevError), heuristic: decisionRows.length });
  }

  if (!jevError) for (const j of res.elements || []) {
    const el = byId[j.id];
    const ser = elements.find((row) => row.id === j.id) || {};
    let removed = false;
    let cascade = [];
    let before = null;
    const cheatForced =
      blockEnabled &&
      settings.forceHideCheats === true &&
      globalThis.AdgateCandidates?.isForcedHide?.(ser);
    const ranked = globalThis.AdgateRanks?.decideHide(settings, j) || {
      hide: j.action === 'hide',
      action: j.action,
      reason: j.reason,
      kind: j.kind || 'other',
    };
    let action = ranked.action || j.action;
    let reason = ranked.reason || j.reason;
    const kind = ranked.kind || j.kind || 'other';
    if (cheatForced && action !== 'hide') {
      action = 'hide';
      reason = `client_${ser.discover || 'ad_slot'}`;
    }
    const doHide = blockEnabled && (action === 'hide' || ranked.hide || cheatForced);
    if (doHide && el) {
      const outcome = hideEl(el, j.noul, cheatForced || ranked.hide);
      removed = outcome.removed;
      cascade = outcome.cascade;
      before = outcome.before;
      for (const parent of cascade) {
        try {
          self.AdgateLog?.info('cascade_remove', {
            page: location.href,
            childId: j.id,
            reason: parent.reason,
            tag: parent.tag,
            idAttr: parent.idAttr,
            classes: parent.classes,
          });
        } catch {
          /* ignore */
        }
      }
    }

    const row = {
      id: j.id,
      tag: ser.tag || el?.tagName?.toLowerCase() || '',
      src: ser.src || null,
      href: ser.href || null,
      classes: ser.classes || [],
      idAttr: ser.idAttr || null,
      role: ser.role || null,
      rect: ser.rect || null,
      text: ser.text || '',
      nearbyLabel: ser.nearbyLabel || null,
      testId: ser.testId || null,
      fixedOrSticky: !!ser.fixedOrSticky,
      discover: ser.discover || '',
      noul: j.noul,
      kind,
      action,
      reason,
      removed,
      cascadeParents: cascade,
      before,
    };
    decisionRows.push(row);

    if (settings.showLabels === true && el?.isConnected && !removed) {
      labelElement(el, {
        ...row,
        cls: (ser.classes || []).join(' '),
      });
    }
    log('info', 'element_decision', {
      id: j.id,
      noul: j.noul,
      action,
      reason,
      discover: row.discover,
      href: row.href,
      removed,
      cascade: cascade.length,
      blockEnabled,
    });
  }

  const run = globalThis.AdgateDecisionLog.buildDecisionLog({
    ts: new Date().toISOString(),
    requestId: res.requestId,
    page,
    site_type: res.site_type,
    site_type_confidence: res.site_type_confidence,
    site_type_probabilities: res.site_type_probabilities,
    hideMin: res.hideMin ?? (Number(settings.hideMin) || 0.75),
    reviewMin: res.reviewMin ?? globalThis.AdgateDecisionLog.REVIEW_MIN,
    blockEnabled,
    trigger,
    client: CLIENT,
    ms: res.ms,
    decisions: decisionRows,
  });

  await rememberRun(run);
  try {
    if (self.AdgateLog) {
      AdgateLog.info('decision_run', { page: location.href, run });
      for (let attempt = 0; attempt < 4; attempt++) {
        const shipped = await AdgateLog.flush();
        if (shipped?.shipped || !AdgateLog.getBuffer().length) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  } catch {
    /* ignore */
  }

  if (settings.showPanel === true) {
    renderPanel({ ...run, decisions: run.decisions });
  }

  log('info', 'judge_done', {
    site_type: res.site_type,
    ...run.summary,
    ms: res.ms,
    blockEnabled,
    requestId: res.requestId,
  });

  setTimeout(() => {
    suppressMutations = false;
  }, 700);

  if (jevError) throw jevError;
  return { ok: true, ...run };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'ADGATE_SCAN') {
    runJudge('manual')
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
});

let busy = false;
let queued = false;
async function safeJudge(trigger) {
  if (busy) {
    queued = true;
    return;
  }
  busy = true;
  try {
    await runJudge(trigger);
  } catch (e) {
    log('error', 'safe_judge_fail', { error: String(e.message || e), trigger });
  } finally {
    busy = false;
    if (queued) {
      queued = false;
      setTimeout(() => safeJudge('queued'), 600);
    }
  }
}

function watchLateInject(settings) {
  if (settings.blockEnabled !== true || window.__adgateMo) return;
  let timer = null;
  let extra = 0;
  const mo = new MutationObserver(() => {
    if (suppressMutations || extra >= 4) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (suppressMutations) return;
      extra += 1;
      safeJudge('mutation');
    }, 1000);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
  window.__adgateMo = mo;
}

window.addEventListener('adgate-early-log', (event) => {
  const detail = event?.detail || {};
  if (!detail.event) return;
  log('info', detail.event, detail.fields || {});
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !changes.blockEnabled?.newValue) return;
  loadSettings().then((s) => {
    if (s.enabled === false || s.blockEnabled !== true) return;
    watchLateInject(s);
    safeJudge('block-on');
  });
});

loadSettings().then((s) => {
  log('info', 'boot', {
    mode: '0.1.0-classify',
    forceHideCheats: s.forceHideCheats === true,
    enabled: s.enabled !== false,
    blockEnabled: s.blockEnabled === true,
    reviewMode: s.reviewMode !== false,
  });
  if (s.enabled === false) return;
  watchLateInject(s);
  setTimeout(() => safeJudge('boot'), 1000);
  setTimeout(() => safeJudge('boot2'), 4000);
  if (s.blockEnabled === true) {
    setTimeout(() => safeJudge('boot3'), 8000);
    setTimeout(() => safeJudge('boot4'), 14000);
  }
});
