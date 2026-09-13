(function (root) {
  'use strict';
  // SafeCheck approval workflow — pure functions shared by the browser and the server,
  // kept separate from core.js so each module can be white-box tested on its own.
  //
  //   User (restaurant staff) submits ──► pending_review
  //   pending_review   ── Inspector approves ──► pending_approval
  //   anyone else submits ───────────────────► pending_approval
  //   pending_approval ── Supervisor approves ─► approved
  //   either reviewer rejects ─────────────────► rejected ──► submitter fixes and resubmits
  //
  // Approval deadlines (set by the business, not by this code's author):
  //   daily   — before 17:00, when the restaurant opens
  //   monthly — one week before the end of the month
  //   yearly  — within November, before the year ends
  //
  // All deadlines are Thailand time (UTC+7, no daylight saving) whatever timezone the
  // server runs in. The hosting server runs on UTC, so using its local clock would put
  // the daily 17:00 cut-off seven hours late.

  const TZ_OFFSET_MS = 7 * 60 * 60 * 1000;
  const HOUR_MS = 60 * 60 * 1000;
  const DAY_MS = 24 * HOUR_MS;

  const DAILY_CUTOFF_HOUR = 17;
  const MONTHLY_DAYS_BEFORE_END = 7;
  const YEARLY_DEADLINE_MONTH = 10; // November, 0-based like Date
  const YEARLY_DEADLINE_DAY = 30;

  const STAGES = ['pending_review', 'pending_approval', 'approved', 'rejected'];

  // How close to the deadline a record starts being flagged as "due soon".
  const DUE_SOON_MS = { daily: 3 * HOUR_MS, monthly: 3 * DAY_MS, yearly: 14 * DAY_MS };

  // Calendar date and hour as a clock in Bangkok would show them.
  function bangkokParts(ms) {
    const d = new Date(ms + TZ_OFFSET_MS);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate() };
  }

  // A Bangkok wall-clock time, converted to the real instant.
  function bangkokInstant(year, month, day, hour, minute, second) {
    return Date.UTC(year, month, day, hour, minute, second) - TZ_OFFSET_MS;
  }

  function approvalDeadline(submittedAt, frequency) {
    const ms = new Date(submittedAt).getTime();
    if (Number.isNaN(ms)) return null;
    const p = bangkokParts(ms);
    let deadline;
    if (frequency === 'daily') {
      deadline = bangkokInstant(p.year, p.month, p.day, DAILY_CUTOFF_HOUR, 0, 0);
      // Submitted after today's opening: the check can only protect the next opening.
      if (ms >= deadline) deadline += DAY_MS;
    } else if (frequency === 'monthly') {
      const lastDay = new Date(Date.UTC(p.year, p.month + 1, 0)).getUTCDate();
      deadline = bangkokInstant(p.year, p.month, lastDay - MONTHLY_DAYS_BEFORE_END, 23, 59, 59);
    } else if (frequency === 'yearly') {
      deadline = bangkokInstant(p.year, YEARLY_DEADLINE_MONTH, YEARLY_DEADLINE_DAY, 23, 59, 59);
    } else {
      return null;
    }
    return new Date(deadline).toISOString();
  }

  // 'overdue' | 'due_soon' | 'on_track' | 'none'
  function deadlineState(deadline, frequency, now) {
    const due = new Date(deadline).getTime();
    if (!deadline || Number.isNaN(due)) return 'none';
    const current = now === undefined ? Date.now() : new Date(now).getTime();
    if (current > due) return 'overdue';
    if (due - current <= (DUE_SOON_MS[frequency] || DAY_MS)) return 'due_soon';
    return 'on_track';
  }

  // Staff submissions need an Inspector first; an Inspector's own inspection has
  // already been done by an Inspector, so it goes straight to the Supervisor.
  function initialStage(role) {
    return role === 'user' ? 'pending_review' : 'pending_approval';
  }

  const STEPS = {
    review: { from: 'pending_review', onApprove: 'pending_approval' },
    approve: { from: 'pending_approval', onApprove: 'approved' }
  };

  // Returns the next stage, or null when this step cannot act on a record in `stage`
  // (for example a Supervisor trying to approve something an Inspector has not
  // reviewed yet) or the decision is not one of approve/reject.
  function nextStage(stage, step, decision) {
    const rule = STEPS[step];
    if (!rule || stage !== rule.from) return null;
    if (decision === 'approve') return rule.onApprove;
    if (decision === 'reject') return 'rejected';
    return null;
  }

  const Workflow = {
    approvalDeadline, deadlineState, initialStage, nextStage,
    STAGES, DAILY_CUTOFF_HOUR, MONTHLY_DAYS_BEFORE_END, YEARLY_DEADLINE_MONTH, YEARLY_DEADLINE_DAY
  };

  if (typeof module === 'object' && module.exports) module.exports = Workflow;
  if (root) root.SafeCheckWorkflow = Workflow;
})(typeof globalThis !== 'undefined' ? globalThis : this);
