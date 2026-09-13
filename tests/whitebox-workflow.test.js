'use strict';
// ============================================================================
//  White-box tests for workflow.js
//  Run with:  npm run test:whitebox
//
//  Like tests/whitebox.test.js, each case targets a named branch in the source.
//  workflow.js holds the approval rules shared by browser and server: the three
//  approval deadlines, when a record counts as overdue, and which decision moves
//  a record to which stage. Deadlines are asserted as exact UTC instants, because
//  "17:00 in Bangkok" is 10:00 UTC and an off-by-seven-hours bug is exactly the
//  kind of mistake a server running on UTC would make.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const Workflow = require('../workflow.js');

// ---------------------------------------------------------------------------
// approvalDeadline
//   D1: unparsable date                    -> null
//   D2: daily, submitted before 17:00 BKK  -> 17:00 the same day
//   D3: daily, submitted at/after 17:00    -> 17:00 the next day
//   D4: monthly                            -> 23:59:59 on (last day - 7)
//   D5: yearly                             -> 23:59:59 on 30 November
//   D6: unknown frequency                  -> null
// ---------------------------------------------------------------------------
test.describe('approvalDeadline — one branch per frequency', () => {
  test('D1 an unparsable date gives no deadline', () => {
    assert.equal(Workflow.approvalDeadline('not a date', 'daily'), null);
  });
  test('D2 daily before 17:00 Bangkok is due at 17:00 the same day (10:00 UTC)', () => {
    // 09:30 in Bangkok
    assert.equal(Workflow.approvalDeadline('2026-09-14T02:30:00Z', 'daily'), '2026-09-14T10:00:00.000Z');
  });
  test('D3 daily at or after 17:00 Bangkok is due at 17:00 the next day', () => {
    // exactly 17:00 in Bangkok, then 23:00 in Bangkok
    assert.equal(Workflow.approvalDeadline('2026-09-14T10:00:00Z', 'daily'), '2026-09-15T10:00:00.000Z');
    assert.equal(Workflow.approvalDeadline('2026-09-14T16:00:00Z', 'daily'), '2026-09-15T10:00:00.000Z');
  });
  test('D2 uses the Bangkok date, not the UTC date, around midnight', () => {
    // 20:30 UTC on the 13th is already 03:30 on the 14th in Bangkok
    assert.equal(Workflow.approvalDeadline('2026-09-13T20:30:00Z', 'daily'), '2026-09-14T10:00:00.000Z');
  });
  test('D4 monthly is due one week before the end of a 30-day month', () => {
    assert.equal(Workflow.approvalDeadline('2026-09-02T03:00:00Z', 'monthly'), '2026-09-23T16:59:59.000Z');
  });
  test('D4 monthly handles February in normal and leap years', () => {
    assert.equal(Workflow.approvalDeadline('2026-02-05T03:00:00Z', 'monthly'), '2026-02-21T16:59:59.000Z');
    assert.equal(Workflow.approvalDeadline('2028-02-05T03:00:00Z', 'monthly'), '2028-02-22T16:59:59.000Z');
  });
  test('D4 monthly takes the month as seen in Bangkok on the last evening of a month', () => {
    // 20:00 UTC on 30 Sep is 03:00 on 1 Oct in Bangkok -> October's deadline
    assert.equal(Workflow.approvalDeadline('2026-09-30T20:00:00Z', 'monthly'), '2026-10-24T16:59:59.000Z');
  });
  test('D5 yearly is due by the end of 30 November', () => {
    assert.equal(Workflow.approvalDeadline('2026-03-10T03:00:00Z', 'yearly'), '2026-11-30T16:59:59.000Z');
  });
  test('D6 an unknown frequency gives no deadline', () => {
    assert.equal(Workflow.approvalDeadline('2026-09-14T02:30:00Z', 'weekly'), null);
  });
});

// ---------------------------------------------------------------------------
// deadlineState
//   S1: no deadline / unparsable deadline      -> 'none'
//   S2: now after the deadline                 -> 'overdue'
//   S3: inside the frequency's due-soon window -> 'due_soon'
//   S4: outside the window                     -> 'on_track'
//   S5: unknown frequency                      -> one-day window
//   S6: `now` omitted                          -> uses the current clock
// ---------------------------------------------------------------------------
test.describe('deadlineState — overdue, due soon, on track', () => {
  const due = '2026-09-14T10:00:00.000Z';
  test('S1 a missing or unparsable deadline is "none"', () => {
    assert.equal(Workflow.deadlineState('', 'daily', due), 'none');
    assert.equal(Workflow.deadlineState('garbage', 'daily', due), 'none');
  });
  test('S2 one second past the deadline is overdue', () => {
    assert.equal(Workflow.deadlineState(due, 'daily', '2026-09-14T10:00:01Z'), 'overdue');
  });
  test('S3 daily within three hours of the deadline is due soon', () => {
    assert.equal(Workflow.deadlineState(due, 'daily', '2026-09-14T08:00:00Z'), 'due_soon');
    assert.equal(Workflow.deadlineState(due, 'daily', due), 'due_soon');
  });
  test('S4 daily more than three hours away is on track', () => {
    assert.equal(Workflow.deadlineState(due, 'daily', '2026-09-14T06:00:00Z'), 'on_track');
  });
  test('S3/S4 monthly uses a three-day window, yearly a fourteen-day window', () => {
    assert.equal(Workflow.deadlineState(due, 'monthly', '2026-09-12T10:00:00Z'), 'due_soon');
    assert.equal(Workflow.deadlineState(due, 'monthly', '2026-09-10T10:00:00Z'), 'on_track');
    assert.equal(Workflow.deadlineState(due, 'yearly', '2026-09-01T10:00:00Z'), 'due_soon');
    assert.equal(Workflow.deadlineState(due, 'yearly', '2026-08-01T10:00:00Z'), 'on_track');
  });
  test('S5 an unknown frequency falls back to a one-day window', () => {
    assert.equal(Workflow.deadlineState(due, 'weekly', '2026-09-13T12:00:00Z'), 'due_soon');
    assert.equal(Workflow.deadlineState(due, 'weekly', '2026-09-12T12:00:00Z'), 'on_track');
  });
  test('S6 without `now` the real clock is used', () => {
    assert.equal(Workflow.deadlineState('2999-01-01T00:00:00Z', 'yearly'), 'on_track');
    assert.equal(Workflow.deadlineState('2000-01-01T00:00:00Z', 'yearly'), 'overdue');
  });
});

// ---------------------------------------------------------------------------
// initialStage
//   I1: role 'user'      -> pending_review   (staff need an Inspector first)
//   I2: any other role   -> pending_approval
// ---------------------------------------------------------------------------
test.describe('initialStage — who needs an Inspector first', () => {
  test('I1 staff submissions start at the Inspector', () => {
    assert.equal(Workflow.initialStage('user'), 'pending_review');
  });
  test('I2 an Inspector’s own inspection goes straight to the Supervisor', () => {
    assert.equal(Workflow.initialStage('inspector'), 'pending_approval');
    assert.equal(Workflow.initialStage('admin'), 'pending_approval');
  });
});

// ---------------------------------------------------------------------------
// nextStage
//   N1: unknown step                         -> null
//   N2: record not at this step's stage      -> null (cannot skip or repeat a step)
//   N3: approve at review                    -> pending_approval
//   N4: approve at approval                  -> approved
//   N5: reject at either step                -> rejected
//   N6: any other decision                   -> null
// ---------------------------------------------------------------------------
test.describe('nextStage — the approval state machine', () => {
  test('N1 an unknown step is refused', () => {
    assert.equal(Workflow.nextStage('pending_review', 'publish', 'approve'), null);
  });
  test('N2 a Supervisor cannot approve a record the Inspector has not reviewed', () => {
    assert.equal(Workflow.nextStage('pending_review', 'approve', 'approve'), null);
    assert.equal(Workflow.nextStage('approved', 'approve', 'approve'), null);
    assert.equal(Workflow.nextStage('rejected', 'review', 'approve'), null);
  });
  test('N3 an Inspector’s approval forwards the record to the Supervisor', () => {
    assert.equal(Workflow.nextStage('pending_review', 'review', 'approve'), 'pending_approval');
  });
  test('N4 a Supervisor’s approval makes the record final', () => {
    assert.equal(Workflow.nextStage('pending_approval', 'approve', 'approve'), 'approved');
  });
  test('N5 rejecting at either step sends the record back', () => {
    assert.equal(Workflow.nextStage('pending_review', 'review', 'reject'), 'rejected');
    assert.equal(Workflow.nextStage('pending_approval', 'approve', 'reject'), 'rejected');
  });
  test('N6 a decision other than approve or reject is refused', () => {
    assert.equal(Workflow.nextStage('pending_review', 'review', 'maybe'), null);
  });
});
