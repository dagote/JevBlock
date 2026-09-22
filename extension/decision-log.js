/**
 * Per-run decision artifact. One JSON object, also serializable as one JSONL line.
 * Schema: adgate.decision_log.v1
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AdgateDecisionLog = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SCHEMA = 'adgate.decision_log.v1';
  const REVIEW_MIN = 0.45;

  function asClasses(value) {
    if (Array.isArray(value)) return value.filter(Boolean).slice(0, 16);
    if (typeof value === 'string' && value.trim()) return value.split(/\s+/).filter(Boolean).slice(0, 16);
    return [];
  }

  function normalizeParent(parent) {
    return {
      tag: parent.tag || '',
      idAttr: parent.idAttr || null,
      classes: asClasses(parent.classes),
      reason: parent.reason || 'empty_parent',
    };
  }

  function normalizeDecision(row) {
    return {
      id: row.id,
      tag: row.tag || '',
      src: row.src || null,
      href: row.href || null,
      classes: asClasses(row.classes),
      idAttr: row.idAttr || null,
      role: row.role || null,
      rect: row.rect || null,
      text: row.text || '',
      testId: row.testId || null,
      fixedOrSticky: !!row.fixedOrSticky,
      discover: row.discover || '',
      noul: row.noul,
      kind: row.kind || 'other',
      kindPolicy: row.kindPolicy || null,
      hostKind: row.hostKind == null || row.hostKind === '' ? null : row.hostKind,
      action: row.action,
      reason: row.reason || '',
      removed: !!row.removed,
      cascadeParents: (row.cascadeParents || []).map(normalizeParent),
      before: row.before || null,
      nearbyLabel: row.nearbyLabel || null,
    };
  }

  function summarize(decisions) {
    let removed = 0;
    let review = 0;
    let allowed = 0;
    let hideSuggested = 0;
    let cascadeRemoved = 0;
    for (const row of decisions) {
      if (row.removed) removed += 1;
      if (row.action === 'review') review += 1;
      if (row.action === 'allow') allowed += 1;
      if (row.action === 'hide') hideSuggested += 1;
      cascadeRemoved += (row.cascadeParents || []).length;
    }
    return {
      candidates: decisions.length,
      removed,
      review,
      allowed,
      hideSuggested,
      cascadeRemoved,
    };
  }

  function buildDecisionLog(input) {
    const page = input.page || {};
    const decisions = (input.decisions || []).map(normalizeDecision);
    return {
      schema: SCHEMA,
      dryRun: !!input.dryRun,
      ts: input.ts || new Date().toISOString(),
      requestId: input.requestId || null,
      page: {
        url: page.url || '',
        hostname: page.hostname || '',
        title: page.title || '',
      },
      site_type: input.site_type || 'other',
      site_type_confidence: input.site_type_confidence ?? null,
      site_type_probabilities: input.site_type_probabilities || {},
      hideMin: input.hideMin ?? 0.75,
      reviewMin: input.reviewMin ?? REVIEW_MIN,
      blockEnabled: !!input.blockEnabled,
      trigger: input.trigger || '',
      client: input.client || '',
      ms: input.ms ?? null,
      summary: summarize(decisions),
      decisions,
    };
  }

  function toJsonl(run) {
    return JSON.stringify(run);
  }

  function unwrapRun(obj) {
    if (obj && Array.isArray(obj.decisions)) return obj;
    if (obj && obj.run && Array.isArray(obj.run.decisions)) return obj.run;
    return null;
  }

  function parseRunText(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) throw new Error('Empty file');
    if (trimmed.startsWith('{')) {
      const run = unwrapRun(JSON.parse(trimmed));
      if (!run) throw new Error('No decision log in file');
      return run;
    }
    const lines = trimmed.split(/\n/).map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      const run = unwrapRun(JSON.parse(line));
      if (run) return run;
    }
    throw new Error('No decision log in file');
  }

  return {
    SCHEMA,
    REVIEW_MIN,
    buildDecisionLog,
    toJsonl,
    summarize,
    parseRunText,
  };
});
