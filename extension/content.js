/**
 * Adgate 0.0.4 — page judge, block path, review log.
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
  uiRev: 1,
  maxElements: 16,
  serverUrl: 'http://192.168.0.119:8770',
};

const CLIENT = 'extension-0.0.4';
const AD_SRC_RE =
  /mail-us|doubleclick|googlesyndication|pagead2|adnxs|taboola|outbrain|amazon-adsystem|googletagservices|adservice\.google|popads|propellerads|adsterra|clickadu|exoclick|juicyads|mgid|revcontent|12ezo5v60|ybs2ffs7v|fvcwqkkqmuv/i;
const AD_HINT_RE = /ad|ads|sponsor|promo|banner|gpt|dfp|interstitial|overlay|popunder|push/i;

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

function isPageLandmark(el) {
  const tag = el.tagName.toLowerCase();
  if (['html', 'body', 'main', 'header', 'nav', 'footer'].includes(tag)) return true;
  const role = (el.getAttribute('role') || '').toLowerCase();
  return role === 'main';
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

function serializeEl(el, id) {
  const r = el.getBoundingClientRect();
  let stylePos = '';
  try {
    stylePos = getComputedStyle(el).position;
  } catch {
    /* ignore */
  }
  let text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  if (text.length > 180) text = text.slice(0, 180);
  return {
    id,
    tag: el.tagName.toLowerCase(),
    idAttr: el.id || null,
    classes: cls(el).split(/\s+/).filter(Boolean).slice(0, 16),
    role: el.getAttribute('role'),
    ariaLabel: el.getAttribute('aria-label'),
    text,
    href: el.href || el.getAttribute('href') || null,
    src: el.currentSrc || el.src || el.getAttribute('src') || null,
    testId: el.getAttribute('data-test-id'),
    rect: {
      w: Math.round(r.width),
      h: Math.round(r.height),
      y: Math.round(r.top + window.scrollY),
      x: Math.round(r.left + window.scrollX),
    },
    fixedOrSticky: stylePos === 'fixed' || stylePos === 'sticky' || stylePos === 'absolute',
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

function candidatePriority(el) {
  const tag = el.tagName.toLowerCase();
  const src = el.currentSrc || el.src || el.getAttribute('src') || '';
  const testId = el.getAttribute('data-test-id') || '';
  const c = cls(el);
  const id = el.id || '';
  let r;
  try {
    r = el.getBoundingClientRect();
  } catch {
    r = { width: 0, height: 0 };
  }
  const area = Math.max(r.width, 0) * Math.max(r.height, 0);
  let pos = '';
  try {
    pos = getComputedStyle(el).position;
  } catch {
    /* ignore */
  }
  const overlay = pos === 'fixed' || pos === 'sticky';

  if (tag === 'iframe' && AD_SRC_RE.test(src)) return 1_000_000 + area;
  if (tag === 'ins' && /adsbygoogle/i.test(c)) return 900_000 + area;
  if (el.getAttribute('data-ad-client') || el.getAttribute('data-ad-slot')) return 880_000 + area;
  if (/^(right-rail-ad|gam-iframe-basic-mail|mail-right-rail)$/i.test(testId)) return 860_000 + area;
  if (tag === 'iframe' && src) return 700_000 + area;
  if (tag === 'iframe') return 650_000 + area;
  if (overlay && (AD_HINT_RE.test(`${id} ${c}`) || area > 40_000)) return 640_000 + area;
  if (/google-auto-placed/i.test(c) || /div-gpt-ad|google_ads/i.test(id)) return 600_000 + area;
  if (AD_HINT_RE.test(testId + c + id)) return 200_000 + area;
  return area;
}

function collectFixedOverlays(seeds) {
  let checked = 0;
  const nodes = document.querySelectorAll('div, aside, section, iframe, ins, a');
  for (const el of nodes) {
    if (checked++ > 300) break;
    if (seeds.has(el) || isPageLandmark(el)) continue;
    let pos = '';
    let z = 0;
    try {
      const cs = getComputedStyle(el);
      pos = cs.position;
      z = Number.parseInt(cs.zIndex, 10) || 0;
    } catch {
      continue;
    }
    if (pos !== 'fixed' && pos !== 'sticky') continue;
    let r;
    try {
      r = el.getBoundingClientRect();
    } catch {
      continue;
    }
    const vp = Math.max(window.innerWidth * window.innerHeight, 1);
    const cov = (Math.max(r.width, 0) * Math.max(r.height, 0)) / vp;
    const hinted = AD_HINT_RE.test(`${el.id || ''} ${cls(el)}`);
    const tag = el.tagName.toLowerCase();
    const large = cov >= 0.18;
    const highFloat = z >= 2000 && r.height >= 120 && r.width >= 200;
    if (large || hinted || highFloat || (tag === 'iframe' && (cov >= 0.05 || r.height >= 40))) {
      seeds.add(el);
    }
  }
}

/** Candidate pool — iframes, ad hosts, and fixed/sticky overlays. */
function collectElements(max) {
  const seeds = new Set();
  const sels = [
    'iframe',
    'ins.adsbygoogle',
    'ins[class*="ad"]',
    '[data-ad-client]',
    '[data-ad-slot]',
    '.google-auto-placed',
    '[id*="google_ads"]',
    '[id*="div-gpt-ad"]',
    '[data-test-id*="rail"]',
    '[data-test-id*="ad"]',
    '[data-test-id*="gam"]',
    '[data-test-id*="sponsor"]',
    'aside',
    '[class*="ad-"]',
    '[class*="ads"]',
    '[class*="sponsor"]',
    '[class*="banner"]',
    '[class*="interstitial"]',
    '[id*="interstitial"]',
    '[class*="overlay"]',
    '[id*="overlay"]',
    '[class*="pushdown"]',
    '[class*="ad-push"]',
    '[id*="ad-push"]',
    '[id*="ad"]',
    '[id*="gpt"]',
    'object',
    'embed',
  ];
  for (const s of sels) {
    try {
      document.querySelectorAll(s).forEach((n) => seeds.add(n));
    } catch {
      /* ignore */
    }
  }

  document.querySelectorAll('*').forEach((host) => {
    if (host.shadowRoot) {
      try {
        host.shadowRoot.querySelectorAll('iframe, ins, [data-ad-slot]').forEach((n) => seeds.add(n));
      } catch {
        /* ignore */
      }
    }
  });

  try {
    collectFixedOverlays(seeds);
  } catch {
    /* ignore */
  }

  const scored = [];
  for (const el of seeds) {
    if (!(el instanceof Element)) continue;
    if (el.closest('[data-adgate-blocked],[data-adgate-ignore]')) continue;
    const tag = el.tagName.toLowerCase();
    if (['script', 'style', 'link', 'meta', 'noscript', 'html', 'body'].includes(tag)) continue;
    if (isPageLandmark(el)) continue;
    if (isLayoutShell(el) && !['iframe', 'ins', 'object', 'embed'].includes(tag)) continue;
    const r = el.getBoundingClientRect();
    const src = el.src || el.getAttribute('src') || '';
    const adSrc = AD_SRC_RE.test(src);
    if (!adSrc && (r.width < 16 || r.height < 16)) continue;
    scored.push({ el, tag, pri: candidatePriority(el), src: src.slice(0, 120) });
  }
  scored.sort((a, b) => b.pri - a.pri);

  const picked = [];
  for (const item of scored) {
    let conflictIdx = -1;
    for (let i = 0; i < picked.length; i++) {
      const p = picked[i];
      if (p.el.contains(item.el) || item.el.contains(p.el)) {
        conflictIdx = i;
        break;
      }
    }
    if (conflictIdx >= 0) {
      if (item.pri > picked[conflictIdx].pri) picked.splice(conflictIdx, 1, item);
      continue;
    }
    picked.push(item);
    if (picked.length >= max) break;
  }

  log('info', 'candidates_collected', {
    max,
    totalSeeds: seeds.size,
    picked: picked.length,
    sample: picked.slice(0, 8).map((p) => ({
      tag: p.tag,
      pri: Math.round(p.pri),
      src: p.src,
      cls: cls(p.el).slice(0, 40),
    })),
  });

  return picked.map((p) => p.el);
}

function hideEl(el, noul) {
  if (!el || !el.isConnected) return { removed: false, cascade: [], before: null };
  if (isLayoutShell(el) && el.tagName !== 'IFRAME') {
    const ifr = el.querySelector('iframe');
    if (ifr) return hideEl(ifr, noul);
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
          ${d.reason ? ` · ${d.reason}` : ''}</div>
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
  if ((stored.uiRev || 0) >= 1) return data;
  const migrated = {
    showLabels: false,
    showPanel: false,
    reviewMode: true,
    uiRev: 1,
  };
  await chrome.storage.sync.set(migrated);
  return { ...data, ...migrated };
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
  const nodes = collectElements(Number(settings.maxElements) || 12);
  const elements = nodes.map((el, i) => serializeEl(el, `e${i}`));
  const byId = Object.fromEntries(nodes.map((el, i) => [`e${i}`, el]));

  log('info', 'judge_start', { trigger, n: elements.length, title: page.title.slice(0, 80) });

  const res = await sendMessage({
    type: 'ADGATE_PAGE_JUDGE',
    page,
    elements,
    hideMin: Number(settings.hideMin) || 0.75,
  });

  if (res?.error) {
    log('error', 'judge_fail', { error: res.error });
    throw new Error(res.error);
  }

  const blockEnabled = settings.blockEnabled === true;
  const decisionRows = [];
  suppressMutations = true;

  for (const j of res.elements || []) {
    const el = byId[j.id];
    const ser = elements.find((row) => row.id === j.id) || {};
    let removed = false;
    let cascade = [];
    let before = null;
    if (blockEnabled && j.action === 'hide' && el) {
      const outcome = hideEl(el, j.noul);
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
      classes: ser.classes || [],
      idAttr: ser.idAttr || null,
      rect: ser.rect || null,
      text: ser.text || '',
      testId: ser.testId || null,
      fixedOrSticky: !!ser.fixedOrSticky,
      noul: j.noul,
      action: j.action,
      reason: j.reason,
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
      action: j.action,
      reason: j.reason,
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
    if (suppressMutations || extra >= 2) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (suppressMutations) return;
      extra += 1;
      safeJudge('mutation');
    }, 1600);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
  window.__adgateMo = mo;
}

window.addEventListener('adgate-early-log', (event) => {
  const detail = event?.detail || {};
  if (!detail.event) return;
  log('info', detail.event, detail.fields || {});
});

loadSettings().then((s) => {
  log('info', 'boot', {
    mode: '0.0.4-review',
    enabled: s.enabled !== false,
    blockEnabled: s.blockEnabled === true,
    reviewMode: s.reviewMode !== false,
  });
  if (s.enabled === false) return;
  watchLateInject(s);
  setTimeout(() => safeJudge('boot'), 1000);
  setTimeout(() => safeJudge('boot2'), 3500);
});
