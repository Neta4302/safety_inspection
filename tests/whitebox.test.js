'use strict';
// ============================================================================
//  White-box tests for core.js
//  Run with:  npm run test:whitebox
//
//  White-box means the cases below were designed by reading the source code,
//  not the requirements: each test targets a specific branch or condition in
//  core.js, named in the test title. Coverage is measured by Node's built-in
//  V8 coverage (--experimental-test-coverage), so the report proves which lines
//  and branches actually executed rather than claiming it.
//
//  core.js is chosen because it holds the pure business logic shared by the
//  browser and the server (scoring, validation, dashboard figures) and has no
//  I/O, so every path can be reached directly.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../core.js');

// ---------------------------------------------------------------------------
// normalizeItems (reached through every public function)
//   Branch 1: Array.isArray(items) -> true   (use the array)
//   Branch 2: Array.isArray(items) -> false  (fall back to [])
// ---------------------------------------------------------------------------
test.describe('normalizeItems — non-array input guard', () => {
  test('B1 array input is used as-is', () => {
    assert.equal(Core.failedItems([{ result: 'fail' }]).length, 1);
  });
  test('B2 null / undefined / object input falls back to an empty list', () => {
    assert.deepEqual(Core.failedItems(null), []);
    assert.deepEqual(Core.failedItems(undefined), []);
    assert.deepEqual(Core.failedItems({ result: 'fail' }), []);
  });
});

// ---------------------------------------------------------------------------
// calculateScore
//   C1: item is falsy                      -> excluded
//   C2: item.result === 'na'               -> excluded
//   B1: applicable.length === 0  -> true   -> return 0
//   B2: applicable.length === 0  -> false  -> compute percentage
// ---------------------------------------------------------------------------
test.describe('calculateScore — statement, branch and condition coverage', () => {
  test('B1 empty list returns 0 (no division by zero)', () => {
    assert.equal(Core.calculateScore([]), 0);
  });
  test('B1+C2 every item not-applicable returns 0', () => {
    assert.equal(Core.calculateScore([{ result: 'na' }, { result: 'na' }]), 0);
  });
  test('C1 null entries are ignored rather than crashing', () => {
    assert.equal(Core.calculateScore([null, { result: 'pass' }]), 100);
  });
  test('B2 all pass gives 100', () => {
    assert.equal(Core.calculateScore([{ result: 'pass' }, { result: 'pass' }]), 100);
  });
  test('B2 mixed results are rounded (2 of 3 -> 67)', () => {
    assert.equal(Core.calculateScore([{ result: 'pass' }, { result: 'pass' }, { result: 'fail' }]), 67);
  });
  test('B2+C2 not-applicable items do not count against the score', () => {
    assert.equal(Core.calculateScore([{ result: 'pass' }, { result: 'na' }, { result: 'fail' }]), 50);
  });
});

// ---------------------------------------------------------------------------
// validateInspection
//   missingIds filter
//     C1: !item                                   -> missing
//     C2: result not in pass/fail/na              -> missing
//     id fallback: (item && item.id) || index+1   -> both sides
//   hasEvidence
//     E1: media is a non-empty array              -> has evidence
//     E2: media is an empty array                 -> no evidence
//     E3: legacy `photo` field set                -> has evidence
//   evidence requirement
//     R1: 'required_always'                       -> missing when no evidence
//     R2: 'required_on_fail' and result 'fail'    -> missing
//     R3: 'required_on_fail' and result 'pass'    -> fine
//     R4: anything else ('optional' / 'none')     -> fine
// ---------------------------------------------------------------------------
test.describe('validateInspection — path coverage of the evidence rules', () => {
  test('C2 unanswered item is reported by its id', () => {
    const r = Core.validateInspection([{ id: 'DLY-01', result: 'pass' }, { id: 'DLY-02' }]);
    assert.equal(r.valid, false);
    assert.deepEqual(r.missingIds, ['DLY-02']);
  });
  test('C1 + id fallback: a null entry is reported by position', () => {
    const r = Core.validateInspection([{ id: 'A', result: 'pass' }, null]);
    assert.deepEqual(r.missingIds, ['2']);
  });
  test('id fallback: an item without an id is reported by position', () => {
    const r = Core.validateInspection([{ result: 'maybe' }]);
    assert.deepEqual(r.missingIds, ['1']);
  });
  test('R1 required_always with no evidence is invalid, even when passed', () => {
    const r = Core.validateInspection([{ id: 'YRL-01', result: 'pass', evidenceRequirement: 'required_always' }]);
    assert.equal(r.valid, false);
    assert.deepEqual(r.missingEvidenceIds, ['YRL-01']);
  });
  test('R2 required_on_fail with a failed item and no evidence is invalid', () => {
    const r = Core.validateInspection([{ id: 'DLY-03', result: 'fail', evidenceRequirement: 'required_on_fail' }]);
    assert.deepEqual(r.missingEvidenceIds, ['DLY-03']);
  });
  test('R3 required_on_fail with a passed item needs no evidence', () => {
    const r = Core.validateInspection([{ id: 'DLY-03', result: 'pass', evidenceRequirement: 'required_on_fail' }]);
    assert.equal(r.valid, true);
  });
  test('R4 optional evidence is never required', () => {
    const r = Core.validateInspection([{ id: 'MON-01', result: 'fail', evidenceRequirement: 'optional' }]);
    assert.equal(r.valid, true);
  });
  test('E1 a non-empty media array satisfies the requirement', () => {
    const r = Core.validateInspection([
      { id: 'DLY-03', result: 'fail', evidenceRequirement: 'required_on_fail', media: [{ id: 'MED-1' }] }
    ]);
    assert.equal(r.valid, true);
  });
  test('E2 an empty media array does NOT satisfy the requirement', () => {
    const r = Core.validateInspection([
      { id: 'DLY-03', result: 'fail', evidenceRequirement: 'required_on_fail', media: [] }
    ]);
    assert.equal(r.valid, false);
  });
  test('E3 the legacy single photo field still counts as evidence', () => {
    const r = Core.validateInspection([
      { id: 'DLY-03', result: 'fail', evidenceRequirement: 'required_on_fail', photo: 'data:image/png;base64,AA' }
    ]);
    assert.equal(r.valid, true);
  });
  test('not-applicable items are never asked for evidence', () => {
    const r = Core.validateInspection([{ id: 'YRL-02', result: 'na', evidenceRequirement: 'required_always' }]);
    assert.equal(r.valid, true);
  });
});

// ---------------------------------------------------------------------------
// failedItems
//   C1: item is falsy      -> excluded
//   C2: result === 'fail'  -> included / excluded
// ---------------------------------------------------------------------------
test.describe('failedItems — condition coverage', () => {
  test('C1+C2 keeps only real failed items', () => {
    const out = Core.failedItems([null, { id: 'A', result: 'fail' }, { id: 'B', result: 'pass' }]);
    assert.deepEqual(out.map(i => i.id), ['A']);
  });
});

// ---------------------------------------------------------------------------
// dashboardStats
//   B1: Array.isArray(inspections) -> false          -> treat as []
//   B2: scores.length -> 0 / >0                      -> average or 0
//   C1: row is falsy / status !== 'submitted'        -> excluded
//   C2: Number(score) is NaN                         -> counted as 0
//   C3: actionStatus === 'closed'                    -> not open
// ---------------------------------------------------------------------------
test.describe('dashboardStats — branch coverage', () => {
  test('B1 non-array input yields all-zero figures', () => {
    assert.deepEqual(Core.dashboardStats(null),
      { total: 0, submitted: 0, averageScore: 0, failedItems: 0, openActions: 0 });
  });
  test('B2 no submitted inspections gives an average of 0', () => {
    const s = Core.dashboardStats([{ status: 'draft', score: 90, items: [] }]);
    assert.equal(s.averageScore, 0);
    assert.equal(s.total, 1);
    assert.equal(s.submitted, 0);
  });
  test('C1 null rows and drafts are excluded from the average', () => {
    const s = Core.dashboardStats([null, { status: 'draft', score: 10, items: [] }, { status: 'submitted', score: 80, items: [] }]);
    assert.equal(s.averageScore, 80);
  });
  test('C2 a non-numeric score counts as 0 instead of producing NaN', () => {
    const s = Core.dashboardStats([
      { status: 'submitted', score: 'abc', items: [] },
      { status: 'submitted', score: 100, items: [] }
    ]);
    assert.equal(s.averageScore, 50);
  });
  test('C3 closed actions are not counted as open', () => {
    const s = Core.dashboardStats([{
      status: 'submitted', score: 0,
      items: [
        { result: 'fail', actionStatus: 'open' },
        { result: 'fail', actionStatus: 'in_progress' },
        { result: 'fail', actionStatus: 'closed' },
        { result: 'pass' }
      ]
    }]);
    assert.equal(s.failedItems, 3);
    assert.equal(s.openActions, 2);
  });
});
