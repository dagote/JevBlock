/**
 * Candidate discovery for the live page-judge path.
 * Selectors follow the canyoublockit Extreme Test DOM (Elementor widgets,
 * ad-host script src, direct-link href, VAST tags), not substring class matches.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AdgateCandidates = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const AD_HOST_RE =
    /doubleclick|googlesyndication|googletagservices|adservice\.google|amazon-adsystem|adnxs|taboola|outbrain|popads|propellerads|adsterra|clickadu|exoclick|juicyads|mgid|revcontent|12ezo5v60|ybs2ffs7v|fvcwqkkqmuv|bncloudfl|adsco\.re|antiadblocksystems|coosync\.com|displayendpointstarring|pagead2|(?:^|[^a-z0-9])ad\.com\b/i;
  const FORCED_HIDE = new Set([
    'ad_host_script',
    'ad_host_href',
    'ad_host_asset',
    'ad_label',
    'vast_player',
    'blank_html_widget',
    'role_advertisement',
    'iab_slot',
    'clb_slot',
    'adsense',
    'gpt_slot',
    'data_ad_row',
  ]);
  const IAB_SIZES = new Set([
    '300x250',
    '336x280',
    '728x90',
    '320x50',
    '320x100',
    '300x100',
    '160x600',
    '300x600',
    '970x90',
    '970x250',
    '468x60',
    '120x600',
    '250x250',
  ]);
  const OVERLAY_RE = /interstitial|special.?offer|click here/i;
  const PUSH_RE = /notification-permission|wants to\b.{0,80}?notifications/i;
  const EXTERNAL_URL_RE = /^(?:https?:)?\/\/[^\s/?#]+/i;
  const STOP_TAGS = new Set(['html', 'body', 'head', 'main', 'header', 'nav', 'footer']);
  const STOP_ROLES = new Set(['main', 'banner', 'navigation', 'contentinfo']);
  /** Hard cap so a mail page cannot stampede page-judge. */
  const CANDIDATE_CAP = 24;
  const REPEAT_GUARD_MS = 30000;
  const GAM_RE =
    /gampad|googletagservices|gpt\/pubads|gpt\.js|securepubads|doubleclick|googlesyndication|safeframe|pagead2|googleads\.g\.|adservice\.google|\/mail-us\//i;
  const ADISH_TEXT_RE = /\bsponsored\b|\bpromotion\b|special offer|limited[- ]time/i;
  const MAIL_CHROME_SELECTOR = [
    '[data-test-id="toolbar"]',
    '[data-test-id="compose"]',
    '[data-test-id="compose-button"]',
    '[data-test-id="folder-list"]',
    '[data-test-id="message-list"]',
    '[data-test-id="message-list-item"]',
    '[data-test-id="mail-search"]',
    '[aria-label="Folders"]',
    '[aria-label="Compose"]',
  ].join(',');
  const PRESERVE_DISCOVER = new Set([
    'ad_host_script',
    'ad_host_href',
    'vast_player',
    'ad_label',
    'blank_html_widget',
    'role_advertisement',
    'clb_slot',
    'iab_slot',
    'adsense',
    'fixed_overlay',
    'push_permission',
    'widget_embed',
  ]);
  const JUDGE_TEXT_MAX = 180;
  const JUDGE_HINT_MAX = 140;

  function classNameOf(el) {
    if (!el) return '';
    if (typeof el.className === 'string') return el.className;
    if (el.className && el.className.baseVal) return String(el.className.baseVal);
    return '';
  }

  function classTokens(el) {
    return classNameOf(el).split(/\s+/).filter(Boolean);
  }

  function isExternalUrl(url, pageHost) {
    const raw = (url || '').trim();
    if (!raw) return false;
    if (/^(?:https?:\/\/)?ad\.com\/?$/i.test(raw)) return true;
    if (!EXTERNAL_URL_RE.test(raw) && !/^\/\//.test(raw)) return false;
    const match = /^(?:https?:)?\/\/([^/?#]+)/i.exec(raw);
    if (!match) return false;
    const host = match[1].toLowerCase().replace(/^www\./, '');
    const page = String(pageHost || '')
      .toLowerCase()
      .replace(/^www\./, '');
    if (page && (host === page || host.endsWith(`.${page}`))) return false;
    return true;
  }

  function widgetHasEmbed(el) {
    if (!el || !el.querySelector) return false;
    return !!el.querySelector('script[src], iframe, ins, object, embed');
  }

  function firstEmbedUrl(el) {
    if (!el || !el.querySelector) return '';
    const node = el.querySelector('script[src], iframe[src], object[data], embed[src], img[src], a[href]');
    if (!node) return '';
    return node.getAttribute('src') || node.getAttribute('data') || node.getAttribute('href') || '';
  }

  function isLandmark(el) {
    if (!el || el.nodeType !== 1) return true;
    const tag = String(el.tagName || '').toLowerCase();
    if (STOP_TAGS.has(tag)) return true;
    const role = String((el.getAttribute && el.getAttribute('role')) || '').toLowerCase();
    return STOP_ROLES.has(role);
  }

  function visibleText(el) {
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

  function widgetBox(el) {
    const kids = el.children || [];
    for (let i = 0; i < kids.length; i++) {
      if (/\belementor-widget-container\b/.test(classNameOf(kids[i]))) return kids[i];
    }
    return el;
  }

  function isAdLabelShell(el) {
    const classes = classNameOf(el);
    if (!/\belementor-widget-html\b/.test(classes) && !/\bcode-block\b/.test(classes)) return false;
    if (/^advertisements?$/i.test(visibleText(widgetBox(el)))) return true;
    return hasAdLabel(el);
  }

  function hasAdLabel(el) {
    if (!el || !el.querySelectorAll) return false;
    const nodes = el.querySelectorAll('center, p, span, div, label, small, strong, h5, h6');
    for (let i = 0; i < nodes.length; i++) {
      const raw = nodes[i].textContent || '';
      if (raw.length > 40) continue;
      const text = raw.replace(/\s+/g, ' ').trim();
      if (/^advertisements?$/i.test(text) || /^caution!?$/i.test(text)) return true;
    }
    return false;
  }

  function isBlankHtmlWidget(el) {
    if (!/\belementor-widget-html\b/.test(classNameOf(el))) return false;
    const box = widgetBox(el);
    if (visibleText(box)) return false;
    if (box.querySelector && box.querySelector('img, video, audio, iframe, canvas, svg, object, embed, a[href]')) {
      return false;
    }
    const scripts = box.querySelectorAll ? box.querySelectorAll('script') : [];
    for (let i = 0; i < scripts.length; i++) {
      const script = scripts[i];
      if ((script.getAttribute('src') || '').trim()) return false;
      if ((script.textContent || '').trim()) return false;
    }
    return true;
  }

  /** Climb to the Elementor html/shortcode widget. Stop before columns, sections, and help editors. */
  function slotForAsset(el) {
    let best = el;
    let cur = el;
    while (cur && cur.nodeType === 1) {
      const tag = String(cur.tagName || '').toLowerCase();
      const classes = classNameOf(cur);
      if (cur !== el) {
        if (STOP_TAGS.has(tag)) break;
        const role = String((cur.getAttribute && cur.getAttribute('role')) || '').toLowerCase();
        if (STOP_ROLES.has(role)) break;
        if (/\belementor-widget-text-editor\b/.test(classes)) break;
        if (
          tag === 'section' ||
          /\belementor-section\b/.test(classes) ||
          /\belementor-column\b/.test(classes) ||
          /\belementor-widget-wrap\b/.test(classes)
        ) {
          break;
        }
      }
      if (/\belementor-widget-html\b/.test(classes) || /\belementor-widget-shortcode\b/.test(classes)) {
        return cur;
      }
      if (/\bcode-block\b/.test(classes)) best = cur;
      cur = cur.parentElement;
    }
    return best;
  }

  function adUrlsIn(el) {
    const urls = [];
    if (!el || !el.querySelectorAll) return urls;
    const nodes = el.querySelectorAll('script, iframe, img, object, embed, a[href], source');
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const attr = node.getAttribute('src') || node.getAttribute('href') || node.getAttribute('data') || '';
      if (attr && AD_HOST_RE.test(attr)) urls.push(attr);
      if (String(node.tagName || '').toLowerCase() !== 'script') continue;
      const text = (node.textContent || '').replace(/\\\//g, '/');
      const re = /https?:\/\/[^"'\s<>]+/gi;
      let match;
      while ((match = re.exec(text))) {
        if (AD_HOST_RE.test(match[0])) urls.push(match[0]);
      }
    }
    return urls;
  }

  function readStyle(el, getStyle) {
    if (getStyle) {
      try {
        return getStyle(el) || {};
      } catch {
        return {};
      }
    }
    const style = (el.getAttribute && el.getAttribute('style')) || '';
    const pos = /position\s*:\s*(fixed|sticky|absolute)/i.exec(style);
    const z = /z-index\s*:\s*(-?\d+)/i.exec(style);
    return { position: pos ? pos[1].toLowerCase() : '', zIndex: z ? z[1] : '0' };
  }

  function readRect(el, getRect) {
    if (getRect) {
      try {
        return getRect(el) || { width: 0, height: 0, top: 0, left: 0 };
      } catch {
        return { width: 0, height: 0, top: 0, left: 0 };
      }
    }
    if (el.getBoundingClientRect) {
      try {
        return el.getBoundingClientRect();
      } catch {
        /* ignore */
      }
    }
    return { width: 0, height: 0, top: 0, left: 0 };
  }

  function ignored(el) {
    return !!(el.closest && el.closest('[data-adgate-blocked],[data-adgate-ignore]'));
  }

  function boxSize(el, getRect) {
    const rect = readRect(el, getRect);
    let w = Number(rect.width) || 0;
    let h = Number(rect.height) || 0;
    if (w < 2 || h < 2) {
      const style = (el.getAttribute && el.getAttribute('style')) || '';
      const ws = /(?:^|;)\s*width\s*:\s*(\d+(?:\.\d+)?)px/i.exec(style);
      const hs = /(?:^|;)\s*height\s*:\s*(\d+(?:\.\d+)?)px/i.exec(style);
      if (ws) w = Number(ws[1]);
      if (hs) h = Number(hs[1]);
      const aw = Number(el.getAttribute && el.getAttribute('width'));
      const ah = Number(el.getAttribute && el.getAttribute('height'));
      if (aw) w = aw;
      if (ah) h = ah;
    }
    return { w: Math.round(w), h: Math.round(h) };
  }

  function isIabBox(el, getRect) {
    const box = boxSize(el, getRect);
    return IAB_SIZES.has(`${box.w}x${box.h}`);
  }

  function isClb(el) {
    const blob = `${el.id || ''} ${classNameOf(el)}`;
    return /__clb-|code-block-\d/i.test(blob);
  }

  function isJunkFrame(el) {
    const src = (el.getAttribute && (el.getAttribute('src') || '')) || '';
    const blob = `${el.id || ''} ${classNameOf(el)} ${el.getAttribute && (el.getAttribute('title') || '')} ${el.getAttribute && (el.getAttribute('name') || '')}`;
    if (/^javascript:/i.test(src)) return true;
    if (/^about:(?:blank|srcdoc)/i.test(src) && !isClb(el) && !elementHasDataAdAttr(el)) return true;
    if (/iubenda|privacy|recaptcha|cookiebot|cookie-law|consent/i.test(blob)) return true;
    if (!src && !isClb(el) && !isIabBox(el) && !AD_HOST_RE.test(src)) {
      const box = boxSize(el);
      if (box.w < 20 || box.h < 20) return true;
    }
    return false;
  }

  function isForcedHide(row) {
    if (!row) return false;
    if (FORCED_HIDE.has(row.discover || '')) return true;
    return AD_HOST_RE.test(row.src || '') || AD_HOST_RE.test(row.href || '');
  }

  function scopesOf(doc) {
    const root = doc.documentElement || doc.body || doc;
    const scopes = [root];
    if (!root.querySelectorAll) return scopes;
    const hosts = root.querySelectorAll('*');
    for (let i = 0; i < hosts.length; i++) {
      if (hosts[i].shadowRoot) scopes.push(hosts[i].shadowRoot);
    }
    return scopes;
  }

  function dedupe(items, max) {
    items.sort((a, b) => b.pri - a.pri);
    const picked = [];
    for (const item of items) {
      let skip = false;
      for (let i = 0; i < picked.length; i++) {
        const other = picked[i];
        const overlaps =
          other.el === item.el ||
          (other.el.contains && other.el.contains(item.el)) ||
          (item.el.contains && item.el.contains(other.el));
        if (overlaps) {
          skip = true;
          break;
        }
      }
      if (skip) continue;
      picked.push(item);
      if (picked.length >= max) break;
    }
    return picked;
  }

  function meaningfulUrl(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';
    if (/^(?:javascript:|about:blank|about:srcdoc|data:|blob:|#)/i.test(raw)) return '';
    return raw;
  }

  function hostOf(url) {
    const raw = meaningfulUrl(url);
    if (!raw) return null;
    const match = /^(?:https?:)?\/\/([^/?#]+)/i.exec(raw);
    if (match) return match[1].toLowerCase();
    if (/^(?:https?:\/\/)?ad\.com\/?$/i.test(raw)) return 'ad.com';
    return null;
  }

  function firstChildUrl(el, selector, attr) {
    if (!el || !el.querySelectorAll) return '';
    const nodes = el.querySelectorAll(selector);
    for (let i = 0; i < nodes.length; i++) {
      const url = meaningfulUrl(nodes[i].getAttribute(attr));
      if (url) return url;
    }
    return '';
  }

  /** Lift the first real child iframe src / anchor href onto the candidate. */
  function promoteAssets(el) {
    const tag = String((el && el.tagName) || '').toLowerCase();
    let href = meaningfulUrl(el && el.getAttribute && el.getAttribute('href'));
    let src = meaningfulUrl(el && el.getAttribute && (el.getAttribute('src') || el.getAttribute('data')));
    let promoted = '';
    if (!src) {
      const childSrc = firstChildUrl(el, 'iframe[src]', 'src');
      if (childSrc) {
        src = childSrc;
        promoted = 'iframe';
      }
    }
    if (!href) {
      const childHref = firstChildUrl(el, 'a[href]', 'href');
      if (childHref) {
        href = childHref;
        if (!promoted) promoted = 'a';
      }
    }
    if (tag === 'iframe' && src) promoted = promoted || 'iframe';
    return {
      href: href || null,
      src: src || null,
      hrefHost: hostOf(href),
      srcHost: hostOf(src),
      promoted,
    };
  }

  function elementHasDataAdAttr(el) {
    if (!el || !el.getAttribute) return false;
    if (el.hasAttribute) {
      if (
        el.hasAttribute('data-ad') ||
        el.hasAttribute('data-ad-client') ||
        el.hasAttribute('data-ad-slot') ||
        el.hasAttribute('data-ad-format') ||
        el.hasAttribute('data-google-query-id')
      ) {
        return true;
      }
    }
    const id = String(el.id || '');
    if (/div-gpt-ad|google_ads_iframe|google_ads/i.test(id)) return true;
    const classes = classNameOf(el);
    if (/\badsbygoogle\b|\bgoogle-auto-placed\b/.test(classes)) return true;
    return false;
  }

  function matchesSelector(el, selector) {
    if (!el || !selector) return false;
    try {
      if (el.matches && el.matches(selector)) return true;
    } catch {
      /* invalid selector in a stub DOM */
    }
    try {
      if (el.closest && el.closest(selector)) return true;
    } catch {
      /* ignore */
    }
    return false;
  }

  function isPrimaryMailChrome(el) {
    if (!el || el.nodeType !== 1) return false;
    if (matchesSelector(el, MAIL_CHROME_SELECTOR)) return true;
    const blob = `${el.id || ''} ${classNameOf(el)}`;
    return /\b(mail-toolbar|folder-list|message-list-item|compose-button)\b/i.test(blob);
  }

  function isEmptyPresentationSpacer(el) {
    if (!el || el.nodeType !== 1) return false;
    if (isBlankHtmlWidget(el) || elementHasDataAdAttr(el)) return false;
    const promoted = promoteAssets(el);
    if (promoted.src || promoted.href) return false;
    if (visibleText(el)) return false;
    const role = String((el.getAttribute && el.getAttribute('role')) || '').toLowerCase();
    const blob = `${el.id || ''} ${classNameOf(el)}`;
    if (role === 'presentation' || role === 'none' || role === 'separator') return true;
    if (/\b(spacer|rail-gap|layout-gap|divider|separator)\b/i.test(blob)) return true;
    const box = boxSize(el);
    if (box.h > 0 && box.h <= 12 && box.w >= 40) return true;
    return false;
  }

  function refineDiscover(el, discover, src, href) {
    const current = discover || '';
    const dataAd = elementHasDataAdAttr(el);
    const network = GAM_RE.test(src || '') || GAM_RE.test(href || '') || AD_HOST_RE.test(src || '') || AD_HOST_RE.test(href || '');
    const tag = String((el && el.tagName) || '').toLowerCase();
    const promotedFrame = !!(src && el && el.querySelector && el.querySelector('iframe[src]') && tag !== 'iframe');
    if (current === 'gpt_slot' || (dataAd && !PRESERVE_DISCOVER.has(current))) return 'data_ad_row';
    if (PRESERVE_DISCOVER.has(current)) return current;
    if (network) return 'ad_host_asset';
    if (tag === 'iframe' || promotedFrame) return 'iframe';
    return current;
  }

  function scoringHint(fields) {
    const discover = fields.discover || '';
    const src = fields.src || '';
    const href = fields.href || '';
    const text = fields.text || '';
    const nearby = fields.nearbyLabel || '';
    const parts = [];
    if (discover === 'data_ad_row') parts.push('data-ad row');
    if (discover === 'ad_host_asset' || GAM_RE.test(src) || GAM_RE.test(href) || AD_HOST_RE.test(src) || AD_HOST_RE.test(href)) {
      parts.push('ad-network asset');
    }
    if (discover === 'iframe') parts.push('iframe');
    if (/mail-us/i.test(src)) parts.push('AOL mail-us unit');
    if (/^advertisements?$/i.test(text) || /^advertisements?$/i.test(nearby)) parts.push('Advertisement label');
    if (!parts.length) return null;
    return parts.join('; ').slice(0, JUDGE_HINT_MAX);
  }

  /**
   * Fields that change hosted page-judge scoring.
   * classes, idAttr, ariaLabel, testId, and HTML dumps stay off this object.
   */
  function toJudgeElement(row) {
    const src = row || {};
    const out = {
      id: src.id,
      tag: src.tag || '',
      fixedOrSticky: !!src.fixedOrSticky,
    };
    if (src.role) out.role = src.role;
    if (src.text) out.text = String(src.text).slice(0, JUDGE_TEXT_MAX);
    if (src.nearbyLabel) out.nearbyLabel = String(src.nearbyLabel).slice(0, 80);
    if (src.href) out.href = src.href;
    if (src.src) out.src = src.src;
    if (src.hrefHost) out.hrefHost = src.hrefHost;
    if (src.srcHost) out.srcHost = src.srcHost;
    if (src.rect) out.rect = src.rect;
    if (src.discover) out.discover = src.discover;
    if (src.hint) out.hint = String(src.hint).slice(0, JUDGE_HINT_MAX);
    return out;
  }

  function judgeFingerprint(page, elements) {
    const info = page || {};
    const head = `${info.url || ''}|${info.title || ''}`;
    const body = (elements || []).map((el) =>
      [el.id, el.tag, el.discover || '', el.src || '', el.href || '', el.text || '', el.role || ''].join('\u001f'),
    );
    return `${head}\n${body.join('\n')}`;
  }

  /** Skip a repeat boot/mutation judge when the slim payload has not changed. Manual always runs. */
  function createRepeatGuard(ttlMs) {
    const ttl = Number(ttlMs) > 0 ? Number(ttlMs) : REPEAT_GUARD_MS;
    let lastKey = '';
    let lastAt = 0;
    return {
      duplicate(key, now, trigger) {
        if (trigger === 'manual') return false;
        if (!key || key !== lastKey) return false;
        return Number(now) - lastAt < ttl;
      },
      commit(key, now) {
        lastKey = key || '';
        lastAt = Number(now) || 0;
      },
    };
  }

  function collectCandidates(doc, hooks) {
    const options = hooks || {};
    const requested = Number(options.max) || CANDIDATE_CAP;
    const max = Math.min(Math.max(requested, 1), CANDIDATE_CAP);
    const found = new Map();

    function add(el, discover, pri, evidence) {
      if (!el || el.nodeType !== 1 || ignored(el)) return;
      const tag = String(el.tagName || '').toLowerCase();
      if (['style', 'link', 'meta', 'noscript', 'html', 'body', 'head'].includes(tag)) return;
      if (tag !== 'script' && isLandmark(el)) return;
      if (isEmptyPresentationSpacer(el)) return;
      // Prefer content boxes over primary nav CTAs / menu chrome.
      if (el.closest && el.closest('nav, header, .main-header-bar, #primary-site-navigation, .menu-link')) {
        if (!FORCED_HIDE.has(discover) && discover !== 'fixed_overlay' && discover !== 'push_permission') {
          return;
        }
      }
      if (isPrimaryMailChrome(el)) {
        const url = `${(el.getAttribute && (el.getAttribute('src') || el.getAttribute('href'))) || ''} ${evidence || ''}`;
        const strong =
          FORCED_HIDE.has(discover) ||
          discover === 'data_ad_row' ||
          discover === 'fixed_overlay' ||
          elementHasDataAdAttr(el) ||
          AD_HOST_RE.test(url) ||
          GAM_RE.test(url);
        if (!strong) return;
      }
      const prev = found.get(el);
      if (prev && FORCED_HIDE.has(prev.discover) && !FORCED_HIDE.has(discover)) return;
      if (!prev || pri > prev.pri) {
        found.set(el, { el, discover, pri, evidence: evidence || '' });
      }
    }

    for (const scope of scopesOf(doc)) {
      if (!scope.querySelectorAll) continue;

      scope.querySelectorAll('[role]').forEach((el) => {
        if ((el.getAttribute('role') || '').toLowerCase() === 'advertisement') {
          add(el, 'role_advertisement', 990000, '');
        }
      });

      scope.querySelectorAll('a[href]').forEach((anchor) => {
        const href = anchor.getAttribute('href') || '';
        if (AD_HOST_RE.test(href)) add(anchor, 'ad_host_href', 970000, href);
        else if (isExternalUrl(href, options.hostname)) {
          const text = visibleText(anchor);
          const prev = anchor.previousElementSibling;
          const prevLabel = prev && /^advertisements?$/i.test(visibleText(prev));
          if (prevLabel || ADISH_TEXT_RE.test(text) || elementHasDataAdAttr(anchor)) {
            add(anchor, prevLabel ? 'ad_label' : 'external_href', prevLabel ? 870000 : 860000, href);
          }
        }
      });

      scope.querySelectorAll('script[src], iframe, ins, object, embed, img[src]').forEach((el) => {
        const tag = el.tagName.toLowerCase();
        const url = el.getAttribute('src') || el.getAttribute('data') || '';
        const hostish = AD_HOST_RE.test(url) || GAM_RE.test(url);
        const external = isExternalUrl(url, options.hostname);
        if (tag === 'script') {
          if (!hostish && !external) return;
          add(slotForAsset(el), hostish ? 'ad_host_script' : 'external_script', hostish ? 980000 : 870000, url);
          return;
        }
        if (tag === 'img' && !hostish) return;
        if (tag === 'ins') {
          add(slotForAsset(el), 'adsense', 940000, url);
          return;
        }
        if (tag === 'iframe' && !hostish && isJunkFrame(el)) return;
        let discover = hostish ? 'ad_host_asset' : tag === 'iframe' ? 'iframe' : external ? 'external_asset' : tag;
        let pri = hostish ? 960000 : external ? 890000 : 900000;
        if (tag === 'iframe' && isClb(el)) {
          discover = 'clb_slot';
          pri = 955000;
        } else if (tag === 'iframe' && isIabBox(el, options.getRect)) {
          discover = 'iab_slot';
          pri = 945000;
        }
        add(slotForAsset(el), discover, pri, url);
      });

      scope.querySelectorAll('.elementor-widget-html, .elementor-widget-shortcode, .code-block').forEach((el) => {
        const urls = adUrlsIn(el);
        const slot = slotForAsset(el);
        const classes = `${classNameOf(el)} ${classNameOf(slot)}`;
        if (urls.length) {
          const vast = /\belementor-widget-shortcode\b/.test(classes);
          add(slot, vast ? 'vast_player' : 'ad_host_script', vast ? 965000 : 980000, urls[0]);
          return;
        }
        if (isAdLabelShell(el) || hasAdLabel(el)) {
          add(slot, 'ad_label', 940000, firstEmbedUrl(el));
          return;
        }
        if (widgetHasEmbed(el)) {
          const embedUrl = firstEmbedUrl(el);
          const vast =
            /\belementor-widget-shortcode\b/.test(classes) ||
            /vastTag|vast_options/i.test(el.textContent || '');
          add(slot, vast ? 'vast_player' : 'widget_embed', vast ? 930000 : 860000, embedUrl);
          return;
        }
        if (isBlankHtmlWidget(el)) add(el, 'blank_html_widget', 720000, '');
        else if (
          /\belementor-widget-shortcode\b/.test(classes) &&
          el.querySelector &&
          el.querySelector('.vast_video_loading, .fluid_video_wrapper, video[id^="fp-"]')
        ) {
          add(slot, 'vast_player', 930000, '');
        }
      });

      scope.querySelectorAll('center, p, span, div, label, small, strong').forEach((el) => {
        const raw = el.textContent || '';
        if (raw.length > 40) return;
        const text = raw.replace(/\s+/g, ' ').trim();
        if (!/^advertisements?$/i.test(text) && !/^caution!?$/i.test(text)) return;
        if (el.closest && el.closest('.elementor-widget-text-editor, .elementor-widget-image, nav, header')) return;
        const classes = classNameOf(el);
        if (/\belementor-(column|section|container|widget-wrap)\b/.test(classes)) return;
        if (
          el.querySelector &&
          el.querySelector('.elementor-widget-html, .elementor-widget-shortcode, .code-block') &&
          !/\belementor-widget-html\b|\belementor-widget-shortcode\b|\bcode-block\b/.test(classes)
        ) {
          return;
        }
        const slot = slotForAsset(el);
        if (/\belementor-widget-text-editor\b/.test(classNameOf(slot))) return;
        if (/\belementor-(column|section|container|widget-wrap)\b/.test(classNameOf(slot))) return;
        add(slot, 'ad_label', 940000, '');
      });

      scope
        .querySelectorAll(
          '[data-ad], [data-ad-client], [data-ad-slot], [data-ad-format], [data-google-query-id], ins.adsbygoogle, .google-auto-placed, [id*="google_ads"], [id*="div-gpt-ad"]',
        )
        .forEach((el) => {
          const child = firstChildUrl(el, 'iframe[src]', 'src');
          add(slotForAsset(el), 'data_ad_row', 968000, child || el.getAttribute('src') || '');
        });

      let checked = 0;
      scope.querySelectorAll('div, aside, section, iframe, a, dialog').forEach((el) => {
        if (checked++ > 500 || isLandmark(el)) return;
        const pos = String(readStyle(el, options.getStyle).position || '').toLowerCase();
        if (pos !== 'fixed' && pos !== 'sticky' && pos !== 'absolute') return;
        if (/\belementor-background-overlay\b/.test(classNameOf(el)) && !adUrlsIn(el).length) return;
        if (el.querySelector && el.querySelector('h1, h2, nav, .elementor-widget-text-editor')) return;
        const role = (el.getAttribute('role') || '').toLowerCase();
        const blob = `${classNameOf(el)} ${el.id || ''} ${visibleText(el)}`;
        const adishOverlay = OVERLAY_RE.test(blob) || ADISH_TEXT_RE.test(blob) || adUrlsIn(el).length > 0;
        if ((role === 'dialog' || role === 'alertdialog' || OVERLAY_RE.test(blob)) && adishOverlay) {
          add(el, 'fixed_overlay', 880000, '');
          return;
        }
        if (PUSH_RE.test(blob)) {
          add(el, 'push_permission', 880000, '');
          return;
        }
        const urls = adUrlsIn(el);
        if (urls.length && (pos === 'fixed' || pos === 'sticky')) {
          add(slotForAsset(el), 'ad_host_asset', 900000, urls[0]);
        }
      });
    }

    const frames = doc.querySelectorAll ? doc.querySelectorAll('iframe') : [];
    for (let i = 0; i < frames.length; i++) {
      let inner = null;
      try {
        inner = frames[i].contentDocument;
      } catch {
        inner = null;
      }
      if (!inner || !inner.querySelectorAll || inner === doc) continue;
      inner.querySelectorAll('img[src], iframe[src], a[href], script[src]').forEach((el) => {
        const url = el.getAttribute('src') || el.getAttribute('href') || '';
        if (!AD_HOST_RE.test(url)) return;
        add(slotForAsset(frames[i]), 'ad_host_asset', 960000, url);
      });
    }

    return dedupe([...found.values()], max);
  }

  /** Extra nodes sent through one follow-up page-judge after a rank hide. */
  const NEIGHBORHOOD_MAX = 10;
  const NEIGHBORHOOD_HARD_CAP = 12;

  function neighborhoodLimit(max) {
    const n = Number(max);
    if (!Number.isFinite(n) || n <= 0) return NEIGHBORHOOD_MAX;
    return Math.min(Math.floor(n), NEIGHBORHOOD_HARD_CAP);
  }

  function isBroadContainer(el) {
    if (!el || el.nodeType !== 1) return true;
    if (isLandmark(el)) return true;
    const tag = String(el.tagName || '').toLowerCase();
    if (tag === 'section' || tag === 'article') return true;
    const classes = classNameOf(el);
    if (/\belementor-(section|column|container|top-section|inner-section)\b/.test(classes)) return true;
    if (/\bh-full\b/.test(classes) && /\bw-full\b/.test(classes)) return true;
    if (/\b(site-content|site-main|hfeed)\b/.test(classes)) return true;
    return false;
  }

  function isWidgetWrap(el) {
    return /\belementor-widget-wrap\b/.test(classNameOf(el));
  }

  /** Widget chrome sits inside the wrap; climb through it to reach sibling widgets. */
  function isWidgetChrome(el) {
    const classes = classNameOf(el);
    if (isWidgetWrap(el)) return false;
    if (/\belementor-widget\b/.test(classes)) return true;
    if (/\belementor-widget-container\b/.test(classes)) return true;
    if (/\bcode-block\b/.test(classes)) return true;
    return false;
  }

  function isThinShell(el) {
    const tag = String(el.tagName || '').toLowerCase();
    if (/^(span|a|strong|em|small|label|p|center|font|b|i|h[1-6])$/.test(tag)) return true;
    const kids = el.children || [];
    let elements = 0;
    for (let i = 0; i < kids.length; i++) {
      if (kids[i].nodeType === 1) elements += 1;
    }
    return elements <= 1;
  }

  function isHiddenCandidate(el, getStyle) {
    if (!el || el.nodeType !== 1 || el.isConnected === false) return true;
    if (ignored(el)) return true;
    if (el.hasAttribute && el.hasAttribute('hidden')) return true;
    const aria = el.getAttribute && el.getAttribute('aria-hidden');
    if (aria === 'true') return true;
    const inline = (el.getAttribute && el.getAttribute('style')) || '';
    if (/display\s*:\s*none/i.test(inline) || /visibility\s*:\s*hidden/i.test(inline)) return true;
    if (getStyle) {
      try {
        const style = getStyle(el) || {};
        const display = String(style.display || '').toLowerCase();
        const visibility = String(style.visibility || '').toLowerCase();
        if (display === 'none' || visibility === 'hidden') return true;
      } catch {
        /* ignore */
      }
    }
    return false;
  }

  /**
   * Wrapper whose siblings should be re-scanned after `el` is hidden.
   * Prefers the Elementor widget-wrap. Landmarks, sections, and columns are not wrappers.
   */
  function neighborhoodWrapper(el) {
    let current = el && el.parentElement;
    let best = null;
    let depth = 0;
    while (current && depth < 8) {
      if (isBroadContainer(current)) break;
      best = current;
      if (isWidgetWrap(current)) return current;
      const up = current.parentElement;
      if (!up || isBroadContainer(up)) break;
      if (!isThinShell(current) && !isWidgetChrome(current)) break;
      current = up;
      depth += 1;
    }
    return best;
  }

  function excludedNeighbor(el, exclude) {
    if (!el) return true;
    if (exclude.has(el)) return true;
    for (const prev of exclude) {
      if (prev && prev.contains && prev.contains(el)) return true;
    }
    return false;
  }

  /**
   * Sibling / same-wrapper candidates that discovery would already keep.
   * Does not hide anything; callers send the list through page-judge + ranks.
   * `anchors` are `{ wrapper }` captured before the hide (the wrap may later collapse).
   */
  function collectNeighborhoodCandidates(doc, options) {
    const opts = options || {};
    const root = doc && (doc.nodeType === 9 || doc.nodeType === 1) ? doc : null;
    const limit = neighborhoodLimit(opts.max);
    const exclude = opts.exclude instanceof Set ? opts.exclude : new Set(opts.exclude || []);
    const wrappers = [];
    const seen = new Set();
    for (const anchor of opts.anchors || []) {
      const wrap =
        anchor && anchor.wrapper && anchor.wrapper.nodeType === 1
          ? anchor.wrapper
          : anchor && anchor.nodeType === 1
            ? anchor
            : null;
      if (!wrap || seen.has(wrap) || wrap.isConnected === false) continue;
      if (root && root.contains && wrap !== root && !root.contains(wrap)) continue;
      if (isBroadContainer(wrap)) continue;
      seen.add(wrap);
      wrappers.push(wrap);
    }
    if (!wrappers.length || limit <= 0) return [];

    const pool = [];
    const poolSet = new Set();
    for (const wrap of wrappers) {
      const local = collectCandidates(wrap, {
        max: limit + exclude.size + 8,
        hostname: opts.hostname,
        getRect: opts.getRect,
        getStyle: opts.getStyle,
        viewport: opts.viewport,
        scrollX: opts.scrollX,
        scrollY: opts.scrollY,
      });
      for (const item of local) {
        const el = item.el;
        if (!el || el === wrap || poolSet.has(el)) continue;
        if (!wrap.contains || !wrap.contains(el)) continue;
        if (isHiddenCandidate(el, opts.getStyle)) continue;
        if (excludedNeighbor(el, exclude)) continue;
        pool.push(item);
        poolSet.add(el);
      }
    }

    pool.sort((a, b) => b.pri - a.pri);
    const picked = [];
    for (const item of pool) {
      let overlap = false;
      for (let i = 0; i < picked.length; i++) {
        const other = picked[i].el;
        if (other === item.el || (other.contains && other.contains(item.el)) || (item.el.contains && item.el.contains(other))) {
          overlap = true;
          break;
        }
      }
      if (overlap) continue;
      picked.push(item);
      if (picked.length >= limit) break;
    }
    return picked;
  }

  /** One follow-up per judge. A neighborhood pass must not schedule another. */
  function shouldRunNeighborhoodFollowup({ pass, hiddenCount, neighborCount } = {}) {
    if (Number(pass) > 0) return false;
    if (!(Number(hiddenCount) > 0)) return false;
    if (!(Number(neighborCount) > 0)) return false;
    return true;
  }

  function serializeCandidate(item, id, hooks) {
    const el = item.el;
    const options = hooks || {};
    const rect = readRect(el, options.getRect);
    const pos = String(readStyle(el, options.getStyle).position || '').toLowerCase();
    let text = visibleText(el);
    if (text.length > 180) text = text.slice(0, 180);
    const tag = String(el.tagName || '').toLowerCase();
    const promoted = promoteAssets(el);
    let href = promoted.href;
    let src = promoted.src;
    const evidence = meaningfulUrl(item.evidence || '');
    const evidenceNetwork = !!(evidence && (AD_HOST_RE.test(evidence) || GAM_RE.test(evidence)));
    const preferEvidence =
      item.discover === 'ad_host_script' ||
      item.discover === 'ad_host_href' ||
      item.discover === 'vast_player' ||
      item.discover === 'data_ad_row';
    if (evidence && (preferEvidence || evidenceNetwork || (!src && !href))) {
      if (tag === 'a' || item.discover === 'ad_host_href') {
        if (preferEvidence || !href) href = evidence;
      } else if (preferEvidence || !src) {
        src = evidence;
      }
    }
    let nearbyLabel = null;
    const prev = el.previousElementSibling;
    if (prev) {
      const labelText = visibleText(prev);
      if (labelText && labelText.length <= 60) nearbyLabel = labelText;
    }
    if (!nearbyLabel && el.parentElement) {
      const parentText = visibleText(el.parentElement);
      if (parentText && parentText.length <= 40 && parentText !== text) nearbyLabel = parentText;
    }
    const role = el.getAttribute('role');
    const discover = refineDiscover(el, item.discover || '', src, href);
    const hint = scoringHint({ discover, src, href, text, nearbyLabel, role });
    return {
      id,
      tag,
      idAttr: el.id || null,
      classes: classTokens(el).slice(0, 16),
      role,
      ariaLabel: el.getAttribute('aria-label'),
      text,
      nearbyLabel,
      href: href || null,
      src: src || null,
      hrefHost: hostOf(href),
      srcHost: hostOf(src),
      testId: el.getAttribute('data-test-id'),
      rect: {
        w: Math.round(rect.width || 0),
        h: Math.round(rect.height || 0),
        y: Math.round((rect.top || 0) + (options.scrollY || 0)),
        x: Math.round((rect.left || 0) + (options.scrollX || 0)),
      },
      fixedOrSticky: pos === 'fixed' || pos === 'sticky' || pos === 'absolute',
      discover,
      hint,
    };
  }

  return {
    AD_HOST_RE,
    GAM_RE,
    FORCED_HIDE,
    CANDIDATE_CAP,
    REPEAT_GUARD_MS,
    NEIGHBORHOOD_MAX,
    collectCandidates,
    collectNeighborhoodCandidates,
    neighborhoodWrapper,
    shouldRunNeighborhoodFollowup,
    serializeCandidate,
    toJudgeElement,
    promoteAssets,
    hostOf,
    judgeFingerprint,
    createRepeatGuard,
    isForcedHide,
    isEmptyPresentationSpacer,
    isPrimaryMailChrome,
    slotForAsset,
    adUrlsIn,
    visibleText,
  };
});
