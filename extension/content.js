/**
 * Adgate 0.0.0 — System One page judge.
 * Send page context + candidate elements → site_type + P(ad|unrelated) per element.
 */

const DEFAULTS = {
  enabled: true,
  blockEnabled: false, // annotate only by default — show % / data, do not remove
  hideMin: 0.75,
  showLabels: true,
  showPanel: true,
  maxElements: 16,
  serverUrl: 'http://192.168.0.119:8770',
};

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
  if (['html', 'body', 'main', 'article', 'header', 'nav', 'footer', 'section'].includes(tag)) return true;
  const c = cls(el);
  if (/\bh-full\b/.test(c) && /\bw-full\b/.test(c)) return true;
  try {
    const r = el.getBoundingClientRect();
    const vp = Math.max(window.innerWidth * window.innerHeight, 1);
    if ((r.width * r.height) / vp >= 0.4) return true;
  } catch {
    /* ignore */
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

  // Highest: known ad iframes (these were getting skipped when a big parent won by area)
  if (tag === 'iframe' && /mail-us|doubleclick|googlesyndication|pagead2|adnxs|taboola|outbrain|amazon-adsystem|googletagservices|adservice\.google/i.test(src)) {
    return 1_000_000 + area;
  }
  if (tag === 'ins' && /adsbygoogle/i.test(c)) return 900_000 + area;
  if (el.getAttribute('data-ad-client') || el.getAttribute('data-ad-slot')) return 880_000 + area;
  if (/^(right-rail-ad|gam-iframe-basic-mail|mail-right-rail)$/i.test(testId)) return 860_000 + area;
  if (tag === 'iframe' && src) return 700_000 + area;
  if (tag === 'iframe') return 650_000 + area; // src may fill in later
  if (/google-auto-placed/i.test(c) || /div-gpt-ad|google_ads/i.test(id)) return 600_000 + area;
  if (/ad|sponsor|promo|banner|gpt|dfp/i.test(testId + c + id)) return 200_000 + area;
  return area; // generic asides/divs last
}

/** Candidate pool — prioritize ad iframes so they never lose to huge parents. */
function collectElements(max) {
  const seeds = new Set();
  const sels = [
    'iframe', // ALL iframes, with or without src yet
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

  // Open shadow roots (some ad slots mount there)
  document.querySelectorAll('*').forEach((host) => {
    if (host.shadowRoot) {
      try {
        host.shadowRoot.querySelectorAll('iframe, ins, [data-ad-slot]').forEach((n) => seeds.add(n));
      } catch {
        /* ignore */
      }
    }
  });

  const scored = [];
  for (const el of seeds) {
    if (!(el instanceof Element)) continue;
    if (el.closest('[data-adgate-blocked],[data-adgate-ignore]')) continue;
    const tag = el.tagName.toLowerCase();
    if (['script', 'style', 'link', 'meta', 'noscript', 'html', 'body'].includes(tag)) continue;
    // Never drop iframes/ins for layout-shell heuristic
    if (isLayoutShell(el) && !['iframe', 'ins', 'object', 'embed'].includes(tag)) continue;
    const r = el.getBoundingClientRect();
    // Allow offscreen / zero-size iframes (ads often size late) if they have ad-like src
    const src = el.src || el.getAttribute('src') || '';
    const adSrc = /mail-us|doubleclick|googlesyndication|pagead|adnxs|taboola|outbrain/i.test(src);
    if (!adSrc && (r.width < 16 || r.height < 16)) continue;
    scored.push({ el, tag, pri: candidatePriority(el), src: src.slice(0, 120) });
  }
  scored.sort((a, b) => b.pri - a.pri);

  const picked = [];
  for (const item of scored) {
    // If a lower-priority ancestor/descendant is already picked, prefer the higher-priority node
    let conflictIdx = -1;
    for (let i = 0; i < picked.length; i++) {
      const p = picked[i];
      if (p.el.contains(item.el) || item.el.contains(p.el)) {
        conflictIdx = i;
        break;
      }
    }
    if (conflictIdx >= 0) {
      if (item.pri > picked[conflictIdx].pri) {
        picked.splice(conflictIdx, 1, item); // replace fat parent with ad iframe
      }
      // else keep existing higher-priority node; skip this one
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
  if (!el || !el.isConnected) return false;
  if (isLayoutShell(el) && el.tagName !== 'IFRAME') {
    // Prefer hiding an iframe child if present
    const ifr = el.querySelector('iframe');
    if (ifr) return hideEl(ifr, noul);
    log('warn', 'skip_layout', { tag: el.tagName, cls: cls(el).slice(0, 60) });
    return false;
  }
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
  try {
    el.remove();
  } catch {
    el.style.setProperty('display', 'none', 'important');
  }
  return true;
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

/** Small % chip on the element — not a full-page overlay. */
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

/** Docked panel with full judgment data (all rows). */
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
          ${d.reason ? ` · ${d.reason}` : ''}</div>
        ${d.src ? `<div style="color:#888;word-break:break-all">src: ${escapeHtml(d.src)}</div>` : ''}
        ${d.cls ? `<div style="color:#666;word-break:break-all">class: ${escapeHtml(d.cls)}</div>` : ''}
        ${d.testId ? `<div style="color:#666">testId: ${escapeHtml(d.testId)}</div>` : ''}
        ${d.rect ? `<div style="color:#555">${d.rect.w}×${d.rect.h}</div>` : ''}
      </div>`;
    })
    .join('');

  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;gap:8px;align-items:start">
      <div>
        <div style="font-weight:700">Adgate annotate</div>
        <div style="color:#c4b5fd">site: ${escapeHtml(payload.site_type || '?')}${conf}</div>
        <div style="color:#777;font-size:11px">${escapeHtml(topTypes)}</div>
        <div style="color:#666;font-size:11px">${payload.ms ?? '?'} ms · block OFF</div>
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

async function runJudge(trigger) {
  const settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  if (settings.enabled === false) {
    return { ok: false, error: 'disabled' };
  }

  clearAnnotations();
  const page = extractPage();
  const nodes = collectElements(Number(settings.maxElements) || 12);
  const elements = nodes.map((el, i) => serializeEl(el, `e${i}`));
  const byId = Object.fromEntries(nodes.map((el, i) => [`e${i}`, el]));
  const serById = Object.fromEntries(elements.map((e) => [e.id, e]));

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
  let hidden = 0;
  let review = 0;
  let allowed = 0;
  const rows = [];

  for (const j of res.elements || []) {
    const el = byId[j.id];
    const ser = serById[j.id] || {};
    let did = false;
    // Annotate-only unless blockEnabled is explicitly on
    if (blockEnabled && j.action === 'hide' && el) {
      did = hideEl(el, j.noul);
      if (did) hidden += 1;
    } else if (j.action === 'hide' || j.action === 'review') {
      review += 1; // suggested hide counted as review while annotate-only
    } else {
      allowed += 1;
    }

    const row = {
      id: j.id,
      noul: j.noul,
      action: j.action,
      reason: j.reason,
      hidden: did,
      tag: ser.tag || el?.tagName?.toLowerCase() || '',
      src: ser.src || '',
      cls: (ser.classes || []).join(' ').slice(0, 120),
      testId: ser.testId || '',
      rect: ser.rect || null,
      text: ser.text || '',
    };
    rows.push(row);

    if (settings.showLabels !== false && el?.isConnected && !did) {
      labelElement(el, row);
    }
    log('info', 'element_decision', {
      id: j.id,
      noul: j.noul,
      action: j.action,
      reason: j.reason,
      hidden: did,
      blockEnabled,
    });
  }

  const payload = {
    ts: Date.now(),
    url: page.url,
    trigger,
    blockEnabled,
    site_type: res.site_type,
    site_type_confidence: res.site_type_confidence,
    site_type_probabilities: res.site_type_probabilities,
    ms: res.ms,
    requestId: res.requestId,
    summary: { candidates: elements.length, hidden, review, allowed },
    decisions: rows,
  };
  await chrome.storage.local.set({ adgateLastScan: payload });
  if (settings.showPanel !== false) renderPanel(payload);
  log('info', 'judge_done', {
    site_type: res.site_type,
    ...payload.summary,
    ms: res.ms,
    blockEnabled,
  });
  if (self.AdgateLog) AdgateLog.flush().catch(() => {});
  return { ok: true, ...payload };
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

chrome.storage.sync.get(DEFAULTS).then((s) => {
  log('info', 'boot', { mode: '0.0.0-page-judge', enabled: s.enabled !== false });
  if (s.enabled === false) return;
  setTimeout(() => safeJudge('boot'), 1000);
  setTimeout(() => safeJudge('boot2'), 3500);
});
