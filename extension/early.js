/**
 * document_start defenses for canyoublockit Extreme Test.
 * Registered in the page MAIN world only when "Extreme early defenses" is on.
 * Known ad hosts are blocked separately via declarativeNetRequest when Block is on.
 */
(function () {
  const AD_HOST =
    /(doubleclick|googlesyndication|googletagservices|adservice\.google|amazon-adsystem|adnxs|taboola|outbrain|popads|propellerads|adsterra|clickadu|exoclick|juicyads|mgid|revcontent|12ezo5v60|ybs2ffs7v|fvcwqkkqmuv|bncloudfl|adsco\.re|antiadblocksystems|coosync\.com|displayendpointstarring)/i;

  function elog(event, fields) {
    try {
      console.info('[adgate-early]', event, fields || {});
      window.dispatchEvent(new CustomEvent('adgate-early-log', { detail: { event, fields: fields || {} } }));
    } catch {
      /* ignore */
    }
  }
  elog('early_boot', { href: String(location.href || '') });

  // Push notification spam (Clickadu-style on Extreme Test)
  try {
    const desc = Object.getOwnPropertyDescriptor(Notification, 'requestPermission');
    if (desc && desc.configurable) {
      Object.defineProperty(Notification, 'requestPermission', {
        configurable: true,
        writable: true,
        value: function () {
          return Promise.resolve('denied');
        },
      });
    } else if (typeof Notification !== 'undefined') {
      Notification.requestPermission = function () {
        return Promise.resolve('denied');
      };
    }
  } catch {
    /* ignore */
  }

  // Pop-unders: allow window.open only with a fresh real user gesture
  let gestureAt = 0;
  const markGesture = () => {
    gestureAt = Date.now();
  };
  window.addEventListener('pointerdown', markGesture, true);
  window.addEventListener('keydown', markGesture, true);

  const nativeOpen = window.open;
  window.open = function (url, target, features) {
    const fresh = Date.now() - gestureAt < 1200;
    const href = String(url || '');
    if (!fresh) {
      elog('popunder_blocked', { href: href.slice(0, 180), why: 'no_gesture' });
      return null;
    }
    if (AD_HOST.test(href)) {
      elog('popunder_blocked', { href: href.slice(0, 180), why: 'ad_host' });
      return null;
    }
    return nativeOpen.apply(this, arguments);
  };

  // Strip known ad scripts that slipped past DNR (inline loaders)
  const killAdNode = (node) => {
    if (!(node instanceof HTMLElement)) return;
    const tag = node.tagName;
    if (tag === 'SCRIPT' || tag === 'IFRAME' || tag === 'IMG') {
      const src = node.src || node.getAttribute('src') || '';
      if (src && AD_HOST.test(src)) {
        elog('early_remove_node', { tag: node.tagName, src: src.slice(0, 180) });
        node.remove();
        return;
      }
    }
    if (tag === 'A') {
      const href = node.href || '';
      if (href && AD_HOST.test(href) && /^(ad|ads|sponsor)/i.test(node.id + node.className)) {
        node.remove();
      }
    }
  };

  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const n of m.addedNodes) {
        killAdNode(n);
        if (n.querySelectorAll) {
          n.querySelectorAll('script[src],iframe[src],img[src]').forEach(killAdNode);
        }
      }
    }
  });

  const start = () => {
    mo.observe(document.documentElement || document, { childList: true, subtree: true });
  };
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
