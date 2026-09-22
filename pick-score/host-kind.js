/**
 * Same rule as extension/ranks.js resolveHostKind.
 * Hosted Dagote page-judge often omits kind. Missing/blank kind becomes `ad`
 * only when action is hide or noul is at least hideMin. Allow + low noul stays
 * unlabeled. A literal kind string, including "unknown", is not this fallback.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.JevPickHostKind = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
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

  return { resolveHostKind };
});
