/**
 * User rank controls: which element kinds Block may remove, and at what noul.
 * Extreme force_hide_* cheats are separate (forceHideCheats, default off).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AdgateRanks = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const ELEMENT_KINDS = [
    'main_content',
    'ad',
    'promo',
    'unrelated_inject',
    'donate_ask',
    'tracking_chrome',
    'nav_chrome',
    'other',
  ];

  const DEFAULT_RANKS = {
    ad: { enabled: true, hideMin: 0.75 },
    promo: { enabled: true, hideMin: 0.75 },
    unrelated_inject: { enabled: false, hideMin: 0.85 },
    donate_ask: { enabled: false, hideMin: 0.85 },
    tracking_chrome: { enabled: true, hideMin: 0.75 },
    main_content: { enabled: false, hideMin: 0.99 },
    nav_chrome: { enabled: false, hideMin: 0.99 },
    other: { enabled: false, hideMin: 0.9 },
  };

  function normalizeRanks(raw) {
    const out = {};
    for (const kind of ELEMENT_KINDS) {
      const base = DEFAULT_RANKS[kind] || { enabled: false, hideMin: 0.9 };
      const row = (raw && raw[kind]) || {};
      out[kind] = {
        enabled: row.enabled != null ? !!row.enabled : !!base.enabled,
        hideMin: Number(row.hideMin) > 0 ? Number(row.hideMin) : base.hideMin,
      };
    }
    return out;
  }

  function hostKindOf(judgment) {
    if (!judgment || judgment.kind == null) return '';
    const text = String(judgment.kind).trim().toLowerCase();
    if (!text || text === 'null' || text === 'undefined') return '';
    return text;
  }

  /**
   * Decide whether Block should remove this judgment.
   * Hosted page-judge often omits kind. Missing kind plus host action hide,
   * or noul at/above hideMin, is scored with the ad rank only. The review
   * label is kind_missing_host — the host did not return kind.
   */
  function decideHide(settings, judgment) {
    const ranks = normalizeRanks(settings && settings.ranks);
    const globalMin = Number(settings && settings.hideMin) || 0.75;
    const noul = Number(judgment && judgment.noul) || 0;
    const hostKind = hostKindOf(judgment);
    const hostAction = String((judgment && judgment.action) || '').toLowerCase();
    const reviewFloor = Math.min(0.45, globalMin);

    if (!hostKind && (hostAction === 'hide' || noul >= globalMin)) {
      const ad = ranks.ad;
      const threshold = Number(ad.hideMin) || globalMin;
      const hide = !!(ad.enabled && noul >= threshold);
      let action = 'allow';
      if (hide) action = 'hide';
      else if (noul >= reviewFloor) action = 'review';
      return {
        hide,
        action,
        reason: 'kind_missing_host',
        kind: 'ad',
        kindPolicy: 'ad',
        kindLabel: 'kind_missing_host',
        hostKind: null,
      };
    }

    const kind = hostKind || 'other';
    const rank = ranks[kind] || ranks.other;

    if (rank.enabled && noul >= (rank.hideMin || globalMin)) {
      return {
        hide: true,
        action: 'hide',
        reason: `rank_${kind}`,
        kind,
        kindPolicy: null,
        kindLabel: null,
        hostKind: hostKind || null,
      };
    }

    if (noul >= reviewFloor && noul < globalMin) {
      return {
        hide: false,
        action: 'review',
        reason: (judgment && judgment.reason) || 'review_band',
        kind,
        kindPolicy: null,
        kindLabel: null,
        hostKind: hostKind || null,
      };
    }

    return {
      hide: false,
      action: 'allow',
      reason: (judgment && judgment.reason) || 'allow',
      kind,
      kindPolicy: null,
      kindLabel: null,
      hostKind: hostKind || null,
    };
  }

  return {
    ELEMENT_KINDS,
    DEFAULT_RANKS,
    normalizeRanks,
    decideHide,
  };
});
