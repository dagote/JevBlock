/**
 * JEV Pick Score — hover, click one element, show the page-judge result.
 * Classify only. This script never removes or hides page nodes.
 */
(function () {
  if (globalThis.__jevPickScoreBooted) {
    globalThis.__jevPickScoreSync?.();
    return;
  }
  globalThis.__jevPickScoreBooted = true;

  const collect = globalThis.JevPickCollect;
  const ROOT_ID = 'jev-pick-score-root';

  let pickOn = false;
  let hovered = null;
  let scoreGen = 0;
  let panelState = null;
  let root = null;
  let box = null;
  let badge = null;
  let panel = null;

  const PANEL_CSS = `
    .box {
      position: fixed;
      box-sizing: border-box;
      border: 2px solid #22d3ee;
      background: rgba(34, 211, 238, 0.16);
      pointer-events: none;
      z-index: 2147483646;
      display: none;
    }
    .badge, .panel {
      pointer-events: auto;
      position: fixed;
      z-index: 2147483647;
      font: 13px/1.45 ui-sans-serif, system-ui, sans-serif;
      color: #e8eef2;
    }
    .badge {
      left: 12px;
      bottom: 12px;
      background: #0f766e;
      color: #fff;
      border: 0;
      border-radius: 999px;
      padding: 8px 12px;
      cursor: pointer;
      font-weight: 700;
      box-shadow: 0 8px 24px rgba(0,0,0,.35);
    }
    .panel {
      top: 12px;
      right: 12px;
      width: 360px;
      max-width: calc(100vw - 24px);
      max-height: calc(100vh - 24px);
      overflow: auto;
      background: #101418;
      border: 1px solid #2a3a40;
      border-radius: 12px;
      padding: 12px;
      box-shadow: 0 12px 40px rgba(0,0,0,.45);
    }
    .head { display: flex; justify-content: space-between; gap: 8px; align-items: flex-start; }
    h2 { margin: 0; font-size: 14px; font-weight: 750; }
    .meta, .note { color: #93a4ad; font-size: 12px; margin: 4px 0; word-break: break-word; }
    .note { font-size: 11px; }
    .kind { font-size: 18px; font-weight: 750; margin: 8px 0 2px; }
    .err { color: #fda4af; white-space: pre-wrap; word-break: break-word; margin: 8px 0; }
    .pending { color: #fde68a; margin: 8px 0; }
    .close {
      background: #243036; color: #fff; border: 0; border-radius: 6px;
      padding: 4px 8px; cursor: pointer; font: inherit;
    }
    details { margin-top: 8px; }
    summary { cursor: pointer; color: #99f6e4; }
    pre {
      white-space: pre-wrap; word-break: break-word; background: #0b0e11;
      border-radius: 8px; padding: 8px; max-height: 240px; overflow: auto;
      font: 11px/1.4 ui-monospace, monospace; color: #d7e0e4;
    }
  `;

  function elementTarget(event) {
    const node = event.target;
    if (node instanceof Element) return node;
    return node?.parentElement || null;
  }

  function isOurUi(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    return path.some((node) => node && node.id === ROOT_ID);
  }

  function ensureRoot() {
    if (root && root.isConnected) return root;
    root = document.getElementById(ROOT_ID);
    if (!root) {
      root = document.createElement('div');
      root.id = ROOT_ID;
      (document.documentElement || document.body).appendChild(root);
    }
    const important = [
      ['display', 'block'],
      ['position', 'fixed'],
      ['inset', '0'],
      ['z-index', '2147483647'],
      ['pointer-events', 'none'],
      ['background', 'transparent'],
      ['margin', '0'],
      ['padding', '0'],
      ['border', '0'],
      ['width', 'auto'],
      ['height', 'auto'],
    ];
    important.forEach(([prop, value]) => root.style.setProperty(prop, value, 'important'));
    const shadow = root.shadowRoot || root.attachShadow({ mode: 'open' });
    if (!shadow.querySelector('.box')) {
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(PANEL_CSS);
        shadow.adoptedStyleSheets = [sheet];
      } catch {
        const style = document.createElement('style');
        style.textContent = PANEL_CSS;
        shadow.appendChild(style);
      }
      box = document.createElement('div');
      box.className = 'box';
      badge = document.createElement('button');
      badge.type = 'button';
      badge.className = 'badge';
      badge.textContent = 'Pick ON · click an element · Esc or here to stop';
      badge.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        disablePick();
      });
      panel = document.createElement('div');
      panel.className = 'panel';
      panel.hidden = true;
      panel.addEventListener('mousedown', (event) => event.stopPropagation());
      panel.addEventListener('click', (event) => event.stopPropagation());
      shadow.append(box, badge, panel);
    } else {
      box = shadow.querySelector('.box');
      badge = shadow.querySelector('.badge');
      panel = shadow.querySelector('.panel');
    }
    return root;
  }

  function hideBox() {
    hovered = null;
    if (box) box.style.display = 'none';
  }

  function positionBox(el) {
    if (!box || !el || !el.isConnected) {
      hideBox();
      return;
    }
    const rect = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.top = `${rect.top}px`;
    box.style.left = `${rect.left}px`;
    box.style.width = `${Math.max(rect.width, 0)}px`;
    box.style.height = `${Math.max(rect.height, 0)}px`;
  }

  function setPick(on) {
    pickOn = on === true;
    if (pickOn || panelState) ensureRoot();
    if (badge) badge.hidden = !pickOn;
    if (!pickOn) hideBox();
  }

  function disablePick() {
    setPick(false);
    chrome.storage.sync.set({ pickEnabled: false }).catch(() => {});
  }

  function syncFromStorage() {
    chrome.storage.sync.get({ pickEnabled: false }, (data) => {
      if (chrome.runtime.lastError) return;
      setPick(data.pickEnabled === true);
    });
  }
  globalThis.__jevPickScoreSync = syncFromStorage;

  function onOver(event) {
    if (!pickOn) return;
    if (isOurUi(event)) {
      hideBox();
      return;
    }
    const el = elementTarget(event);
    if (!el || el === hovered) return;
    hovered = el;
    positionBox(el);
  }

  function swallow(event) {
    if (!pickOn || isOurUi(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.type === 'click') {
      event.stopImmediatePropagation();
      const el = elementTarget(event);
      if (el) scoreElement(el);
    }
  }

  function onKey(event) {
    if (!pickOn || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    disablePick();
  }

  function onScroll() {
    if (pickOn && hovered) positionBox(hovered);
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

  function line(parent, className, text) {
    const node = document.createElement('div');
    node.className = className;
    node.textContent = text;
    parent.appendChild(node);
    return node;
  }

  function jsonDetails(summary, value) {
    const details = document.createElement('details');
    const sum = document.createElement('summary');
    sum.textContent = summary;
    const pre = document.createElement('pre');
    try {
      pre.textContent = JSON.stringify(value, null, 2);
    } catch {
      pre.textContent = String(value);
    }
    details.append(sum, pre);
    return details;
  }

  function kindColor(kind) {
    if (kind === 'ad' || kind === 'tracking_chrome') return '#fb7185';
    if (kind === 'promo' || kind === 'unrelated_inject' || kind === 'donate_ask') return '#fdba74';
    if (kind === 'main_content') return '#86efac';
    if (kind === 'nav_chrome') return '#93c5fd';
    return '#e8eef2';
  }

  function formatNoul(noul) {
    const num = Number(noul);
    if (!Number.isFinite(num)) return '—';
    return `${num.toFixed(3)} (${Math.round(num * 100)}%)`;
  }

  function elementLabel(element) {
    if (!element) return '';
    const id = element.idAttr ? `#${element.idAttr}` : '';
    const classes = (element.classes || []).slice(0, 4).map((token) => `.${token}`).join('');
    return `${element.tag || '?'}${id}${classes}`;
  }

  function renderPanel() {
    ensureRoot();
    if (!panel) return;
    panel.replaceChildren();
    if (!panelState) {
      panel.hidden = true;
      panel.removeAttribute('data-jev-pick-status');
      return;
    }
    panel.hidden = false;
    const state = panelState;
    const head = document.createElement('div');
    head.className = 'head';
    const title = document.createElement('h2');
    title.textContent = 'JEV Pick Score';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'close';
    close.textContent = 'Close';
    close.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      panelState = null;
      renderPanel();
    });
    head.append(title, close);
    panel.appendChild(head);
    line(panel, 'note', 'Classify only. This click does not hide the element.');
    line(panel, 'meta', elementLabel(state.element));

    const response = state.result?.response;
    const judgment =
      (response?.elements || []).find((row) => row.id === (state.element?.id || 'e0')) ||
      response?.elements?.[0] ||
      null;

    if (state.pending) {
      panel.dataset.jevPickStatus = 'pending';
      line(panel, 'pending', 'Scoring with JEV…');
    } else if (state.error) {
      panel.dataset.jevPickStatus = 'error';
      line(panel, 'err', state.error);
    } else if (judgment) {
      panel.dataset.jevPickStatus = 'ok';
      const kind = document.createElement('div');
      kind.className = 'kind';
      kind.style.color = kindColor(judgment.kind);
      kind.dataset.jevKind = judgment.kind || '';
      kind.textContent = judgment.kind || 'unknown kind';
      panel.appendChild(kind);
      const noul = line(panel, 'meta', `noul ${formatNoul(judgment.noul)}`);
      noul.dataset.jevNoul = String(judgment.noul ?? '');
      const action = [judgment.action, judgment.reason].filter(Boolean).join(' · ');
      line(panel, 'meta', action || 'no action');
      if (judgment.kindModel) line(panel, 'note', `kindModel ${judgment.kindModel}`);
    } else {
      panel.dataset.jevPickStatus = 'ok';
      line(panel, 'meta', 'No element judgment in the response.');
    }

    if (response) {
      const site = response.site_type || 'unknown site';
      const conf = Number.isFinite(Number(response.site_type_confidence))
        ? ` · ${Number(response.site_type_confidence).toFixed(2)}`
        : '';
      line(panel, 'meta', `site_type ${site}${conf}`);
      const ms = response.ms == null ? '—' : response.ms;
      line(panel, 'note', `${response.requestId || '—'} · ${ms} ms${response.jev_model ? ` · ${response.jev_model}` : ''}`);
    }

    const subtree = state.element || {};
    const links = (subtree.linkHrefs || []).length;
    const imgs = (subtree.imgSrcs || []).length;
    const tags = (subtree.descendantTags || []).length;
    line(
      panel,
      'note',
      `${tags} descendant tag${tags === 1 ? '' : 's'} · ${links} link href${links === 1 ? '' : 's'} · ${imgs} img src${imgs === 1 ? '' : 's'}${subtree.subtreeTruncated ? ' · subtree truncated' : ''}`,
    );

    if (state.result?.request) panel.appendChild(jsonDetails('Request element + page', state.result.request));
    else if (state.element) panel.appendChild(jsonDetails('Request element', state.element));
    if (response) panel.appendChild(jsonDetails('Response JSON', response));
  }

  async function scoreElement(el) {
    if (!collect) {
      panelState = { pending: false, error: 'Collector missing. Reload the extension.', element: null, result: null };
      renderPanel();
      return;
    }
    const element = collect.serializeElement(el, {
      id: 'e0',
      scrollX: window.scrollX || 0,
      scrollY: window.scrollY || 0,
    });
    if (!element) return;
    const page = collect.collectPage(document, location);
    const gen = ++scoreGen;
    panelState = { pending: true, error: '', element, page, result: null };
    renderPanel();
    try {
      const result = await sendMessage({ type: 'JEV_PICK_SCORE', page, element });
      if (gen !== scoreGen) return;
      if (result?.superseded) return;
      panelState = {
        pending: false,
        error: result?.ok ? '' : result?.error || 'Score failed',
        element,
        page,
        result,
      };
      renderPanel();
    } catch (err) {
      if (gen !== scoreGen) return;
      panelState = {
        pending: false,
        error: String(err?.message || err),
        element,
        page,
        result: null,
      };
      renderPanel();
    }
  }

  document.addEventListener('mouseover', onOver, true);
  document.addEventListener('mousedown', swallow, true);
  document.addEventListener('mouseup', swallow, true);
  document.addEventListener('click', swallow, true);
  document.addEventListener('auxclick', swallow, true);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onScroll);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.pickEnabled) return;
    setPick(changes.pickEnabled.newValue === true);
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'JEV_PICK_SET') return false;
    setPick(message.pickEnabled === true);
    sendResponse({ ok: true, pickEnabled: pickOn });
    return true;
  });

  syncFromStorage();
})();
