(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SafetyCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function normalizeItems(items) {
    return Array.isArray(items) ? items : [];
  }

  function calculateScore(items) {
    const applicable = normalizeItems(items).filter(item => item && item.result !== 'na');
    if (applicable.length === 0) return 0;
    const passed = applicable.filter(item => item.result === 'pass').length;
    return Math.round((passed / applicable.length) * 100);
  }

  function validateInspection(items) {
    const list = normalizeItems(items);
    const missingIds = list
      .filter(item => !item || !['pass', 'fail', 'na'].includes(item.result))
      .map((item, index) => (item && item.id) || String(index + 1));

    // Evidence rule (required_on_fail / required_always / optional / none) — only
    // checked once an item has a result, so this never fights with missingIds above.
    // `photo` is the pre-media single-file field, still honoured for old records.
    const hasEvidence = item => (Array.isArray(item.media) && item.media.length > 0) || !!item.photo;
    const missingEvidenceIds = list
      .filter(item => item && ['pass', 'fail'].includes(item.result) && !hasEvidence(item))
      .filter(item => {
        const req = item.evidenceRequirement;
        if (req === 'required_always') return true;
        if (req === 'required_on_fail') return item.result === 'fail';
        return false;
      })
      .map(item => item.id);

    return { valid: missingIds.length === 0 && missingEvidenceIds.length === 0, missingIds, missingEvidenceIds };
  }

  function failedItems(items) {
    return normalizeItems(items).filter(item => item && item.result === 'fail');
  }

  function dashboardStats(inspections) {
    const rows = Array.isArray(inspections) ? inspections : [];
    const submittedRows = rows.filter(row => row && row.status === 'submitted');
    const scores = submittedRows.map(row => Number(row.score) || 0);
    const averageScore = scores.length
      ? Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length)
      : 0;
    const failCount = submittedRows.reduce(
      (sum, row) => sum + failedItems(row.items).length,
      0
    );
    const openActions = submittedRows.reduce(
      (sum, row) => sum + failedItems(row.items).filter(item => item.actionStatus !== 'closed').length,
      0
    );
    return {
      total: rows.length,
      submitted: submittedRows.length,
      averageScore,
      failedItems: failCount,
      openActions
    };
  }

  return { calculateScore, validateInspection, failedItems, dashboardStats };
});
