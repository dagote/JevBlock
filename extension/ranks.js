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

  /**
   * Decide whether Block should remove this judgment.
   * Prefer kind + per-class threshold; fall back to global hideMin on noul when kind missing.
   */
  function decideHide(settings, judgment) {
    const ranks = normalizeRanks(settings && settings.ranks);
    const globalMin = Number(settings && settings.hideMin) || 0.75;
    const noul = Number(judgment && judgment.noul) || 0;
    const kind = String((judgment && judgment.kind) || '').toLowerCase() || 'other';
    const rank = ranks[kind] || ranks.other;

    if (rank.enabled && noul >= (rank.hideMin || globalMin)) {
      return {
        hide: true,
        action: 'hide',
        reason: `rank_${kind}`,
        kind,
      };
    }

    if (!judgment?.kind && noul >= globalMin) {
      return {
        hide: true,
        action: 'hide',
        reason: (judgment && judgment.reason) || 'noul_hide',
        kind: kind || 'other',
      };
    }

    if (noul >= Math.min(0.45, globalMin) && noul < globalMin) {
      return { hide: false, action: 'review', reason: (judgment && judgment.reason) || 'review_band', kind };
    }

    return {
      hide: false,
      action: 'allow',
      reason: (judgment && judgment.reason) || 'allow',
      kind,
    };
  }

  return {
    ELEMENT_KINDS,
    DEFAULT_RANKS,
    normalizeRanks,
    decideHide,
  };
});
