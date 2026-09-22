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
   * Hosted Dagote page-judge returns noul/action/reason and often omits kind.
   * Missing or blank kind becomes `ad` only when the host said hide or noul is
   * at least hideMin. Allow + low noul stays unlabeled. A literal kind, including
   * "unknown", is kept and is not this fallback.
   */
  function resolveHostKind(judgment, hideMin) {
    const raw = judgment && judgment.kind != null ? String(judgment.kind).trim() : '';
    if (raw) return { kind: raw.toLowerCase(), hostOmittedKind: false };
    const action = String((judgment && judgment.action) || '').toLowerCase();
    const noul = Number(judgment && judgment.noul);
    const min = Number(hideMin) > 0 ? Number(hideMin) : 0.75;
    const high = Number.isFinite(noul) && noul >= min;
    if (action === 'hide' || high) return { kind: 'ad', hostOmittedKind: true };
    return { kind: '', hostOmittedKind: true };
  }

  function omissionReason(reason, omitted) {
    if (!omitted) return reason || '';
    const base = reason || 'host omitted kind';
    if (String(base).includes('host omitted kind')) return base;
    return `${base} · host omitted kind`;
  }

  /**
   * Decide whether Block should remove this judgment.
   * Prefer kind + per-class threshold. When the host omitted kind, use resolveHostKind.
   */
  function decideHide(settings, judgment) {
    const ranks = normalizeRanks(settings && settings.ranks);
    const globalMin = Number(settings && settings.hideMin) || 0.75;
    const noul = Number(judgment && judgment.noul) || 0;
    const resolved = resolveHostKind(judgment, globalMin);
    const kind = resolved.kind;
    const rank = kind ? ranks[kind] || ranks.other : null;

    if (rank && rank.enabled && noul >= (rank.hideMin || globalMin)) {
      return {
        hide: true,
        action: 'hide',
        reason: omissionReason(`rank_${kind}`, resolved.hostOmittedKind),
        kind,
        hostOmittedKind: resolved.hostOmittedKind,
      };
    }

    if (noul >= Math.min(0.45, globalMin) && noul < globalMin) {
      return {
        hide: false,
        action: 'review',
        reason: omissionReason((judgment && judgment.reason) || 'review_band', resolved.hostOmittedKind),
        kind,
        hostOmittedKind: resolved.hostOmittedKind,
      };
    }

    return {
      hide: false,
      action: 'allow',
      reason: omissionReason((judgment && judgment.reason) || 'allow', resolved.hostOmittedKind),
      kind,
      hostOmittedKind: resolved.hostOmittedKind,
    };
  }

  return {
    ELEMENT_KINDS,
    DEFAULT_RANKS,
    normalizeRanks,
    resolveHostKind,
    decideHide,
  };
});
