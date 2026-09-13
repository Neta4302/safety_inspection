'use strict';
// ============================================================================
//  SafeCheck automated test suite
//  Run with:  npm test        (or:  node tests/run-tests.js)
//
//  Organised by the four Levels of Testing, plus non-functional tests:
//     UT-xx   Unit          — individual pure functions, in isolation
//     IT-xx   Integration   — interaction between modules (auth, DB, media)
//     ST-xx   System        — complete workflows end to end
//     AT-xx   Acceptance    — traces each stated requirement to evidence
//     NFT-xx  Non-Functional— security, access control, performance, limits
//
//  Every test runs against a THROWAWAY COPY of the application with its own
//  fresh database in the system temp directory. The real data/safecheck.db is
//  never opened, so running the suite can never damage demo or presentation
//  data. The copy is deleted when the run finishes.
// ============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const APP_DIR = path.join(__dirname, '..');
const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'safecheck-test-'));
const PORT = 4321 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'Demo1234!';

// ---------------------------------------------------------------- reporting
const results = [];
let currentLevel = '';

function level(name) { currentLevel = name; }

async function test(id, description, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ id, description, level: currentLevel, status: 'PASS', ms: Date.now() - started, detail: '' });
  } catch (err) {
    results.push({ id, description, level: currentLevel, status: 'FAIL', ms: Date.now() - started, detail: err.message });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}
function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label || 'value'}: expected ${e}, got ${a}`);
}

// ------------------------------------------------------------- http helpers
function cookieFrom(res) {
  return (res.headers.getSetCookie() || []).map(c => c.split(';')[0]).join('; ');
}

async function login(email, password = PASSWORD) {
  const res = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  return { status: res.status, body: await res.json().catch(() => null), cookie: cookieFrom(res), raw: res };
}

async function api(cookie, pathname, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: {
      ...(body !== undefined && !(body instanceof Uint8Array) ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers
    },
    body: body === undefined ? undefined : (body instanceof Uint8Array ? body : JSON.stringify(body))
  });
  if (raw) return res;
  let parsed = null;
  try { parsed = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body: parsed, headers: res.headers };
}

// A 1x1 transparent PNG — a genuinely valid image file, not a fake buffer.
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

// Submits a checklist the way the browser does. The server decides who submitted it,
// the score and the approval deadline, so those fields are deliberately junk here.
async function submitInspection(cookie, { id, venueId = 'VEN-001', frequency = 'daily', status = 'submitted', items } = {}) {
  return api(cookie, '/api/inspections', {
    method: 'POST',
    body: {
      id: id || `INS-T-${Date.now()}-${Math.floor(Math.random() * 1000)}`, venueId, frequency,
      inspector: 'ignored', role: 'ignored', date: new Date().toISOString(), status, score: 0, overallNote: '',
      items: items || [{ id: 'DLY-01', result: 'pass' }, { id: 'DLY-02', result: 'pass' }]
    }
  });
}

async function inspectionById(cookie, id) {
  const boot = await api(cookie, '/api/bootstrap');
  return boot.body.inspections.find(i => i.id === id);
}

async function createAccount(adminCookie, overrides = {}) {
  const email = overrides.email || `acct-${Date.now()}-${Math.floor(Math.random() * 1000)}@safecheck.demo`;
  const r = await api(adminCookie, '/api/admin/users', {
    method: 'POST',
    body: { name: 'Test Account', email, password: PASSWORD, role: 'user', branch: 'BKK-CENTRAL', ...overrides }
  });
  return { ...r, email };
}

// ============================================================== test bodies
async function unitTests() {
  level('Unit');
  const Core = require(path.join(WORK_DIR, 'core.js'));
  const db = require(path.join(WORK_DIR, 'db.js'));

  await test('UT-01', 'calculateScore returns 100 when every item passes', () => {
    assertEqual(Core.calculateScore([{ result: 'pass' }, { result: 'pass' }]), 100, 'score');
  });
  await test('UT-02', 'calculateScore returns 50 when half the items fail', () => {
    assertEqual(Core.calculateScore([{ result: 'pass' }, { result: 'fail' }]), 50, 'score');
  });
  await test('UT-03', 'calculateScore excludes items marked not-applicable', () => {
    assertEqual(Core.calculateScore([{ result: 'pass' }, { result: 'na' }]), 100, 'score');
  });
  await test('UT-04', 'calculateScore returns 0 for an empty checklist', () => {
    assertEqual(Core.calculateScore([]), 0, 'score');
  });
  await test('UT-05', 'validateInspection rejects a checklist with an unanswered item', () => {
    const r = Core.validateInspection([{ id: 'A', result: 'pass' }, { id: 'B' }]);
    assert(r.valid === false, 'should be invalid');
    assertEqual(r.missingIds, ['B'], 'missingIds');
  });
  await test('UT-06', 'validateInspection rejects a failed item that requires evidence', () => {
    const r = Core.validateInspection([{ id: 'A', result: 'fail', evidenceRequirement: 'required_on_fail' }]);
    assert(r.valid === false, 'should be invalid');
    assertEqual(r.missingEvidenceIds, ['A'], 'missingEvidenceIds');
  });
  await test('UT-07', 'validateInspection accepts a failed item once media is attached', () => {
    const r = Core.validateInspection([
      { id: 'A', result: 'fail', evidenceRequirement: 'required_on_fail', media: [{ id: 'MED-1' }] }
    ]);
    assert(r.valid === true, 'should be valid');
  });
  await test('UT-08', 'validateInspection accepts a failed item when evidence is optional', () => {
    const r = Core.validateInspection([{ id: 'A', result: 'fail', evidenceRequirement: 'optional' }]);
    assert(r.valid === true, 'should be valid');
  });
  await test('UT-09', 'failedItems returns only items with result "fail"', () => {
    const out = Core.failedItems([{ id: 'A', result: 'fail' }, { id: 'B', result: 'pass' }]);
    assertEqual(out.map(i => i.id), ['A'], 'failed ids');
  });
  await test('UT-10', 'dashboardStats averages submitted inspections only', () => {
    const s = Core.dashboardStats([
      { status: 'submitted', score: 80, items: [] },
      { status: 'draft', score: 0, items: [] }
    ]);
    assertEqual(s.averageScore, 80, 'averageScore');
    assertEqual(s.submitted, 1, 'submitted');
  });
  await test('UT-11', 'dashboardStats counts open actions but not closed ones', () => {
    const s = Core.dashboardStats([{
      status: 'submitted', score: 50,
      items: [{ result: 'fail', actionStatus: 'open' }, { result: 'fail', actionStatus: 'closed' }]
    }]);
    assertEqual(s.openActions, 1, 'openActions');
    assertEqual(s.failedItems, 2, 'failedItems');
  });
  await test('UT-12', 'requiredExtinguishers enforces the minimum of 2 for small venues', () => {
    assertEqual(db.requiredExtinguishers(0), 2, '0 tables');
    assertEqual(db.requiredExtinguishers(10), 2, '10 tables');
  });
  await test('UT-13', 'requiredExtinguishers scales at 1 per 10 tables (24 tables -> 3)', () => {
    assertEqual(db.requiredExtinguishers(24), 3, '24 tables');
  });
  await test('UT-14', 'requiredExtinguishers scales for large venues (40 tables -> 4)', () => {
    assertEqual(db.requiredExtinguishers(40), 4, '40 tables');
  });
  await test('UT-15', 'capabilitiesFor returns exactly the inspector capability set', () => {
    assertEqual(db.capabilitiesFor('inspector').sort(), [
      'action.update', 'alert.acknowledge', 'alert.escalate', 'alert.simulate',
      'feedback.submit', 'inspection.review', 'inspection.submit', 'staff.notify'
    ], 'inspector caps');
  });
  await test('UT-16', 'capabilitiesFor returns an empty set for an unknown role', () => {
    assertEqual(db.capabilitiesFor('hacker'), [], 'unknown role');
  });
  await test('UT-17', 'Exactly five roles exist: user, inspector, supervisor, manager, admin', () => {
    assertEqual(db.ROLES, ['user', 'inspector', 'supervisor', 'manager', 'admin'], 'roles');
    assertEqual(db.capabilitiesFor('safety'), [], 'the retired Safety Officer role has no rights');
  });
  await test('UT-18', 'Manager is read-only: it holds no capability that changes inspection data', () => {
    assertEqual(db.capabilitiesFor('manager').filter(c => c !== 'feedback.submit'), [], 'manager write capabilities');
  });
  await test('UT-19', 'Approval deadlines: daily 17:00, monthly a week before month end, yearly 30 Nov', () => {
    const Workflow = require(path.join(WORK_DIR, 'workflow.js'));
    assertEqual(Workflow.approvalDeadline('2026-09-14T02:30:00Z', 'daily'), '2026-09-14T10:00:00.000Z', 'daily');
    assertEqual(Workflow.approvalDeadline('2026-09-14T02:30:00Z', 'monthly'), '2026-09-23T16:59:59.000Z', 'monthly');
    assertEqual(Workflow.approvalDeadline('2026-09-14T02:30:00Z', 'yearly'), '2026-11-30T16:59:59.000Z', 'yearly');
  });
}

async function integrationTests() {
  level('Integration');

  await test('IT-01', 'Successful login issues an HttpOnly session cookie', async () => {
    const r = await login('admin@safecheck.demo');
    assertEqual(r.status, 200, 'status');
    assert(/^sid=[0-9a-f]{64}$/.test(r.cookie), 'expected a 64-hex session cookie, got: ' + r.cookie);
    const setCookie = r.raw.headers.getSetCookie().join(';');
    assert(/HttpOnly/i.test(setCookie), 'cookie must be HttpOnly');
  });
  await test('IT-02', 'Bootstrap without a session is refused with 401', async () => {
    assertEqual((await api(null, '/api/bootstrap')).status, 401, 'status');
  });
  await test('IT-03', 'Bootstrap with a valid session returns data and scope', async () => {
    const { cookie } = await login('admin@safecheck.demo');
    const r = await api(cookie, '/api/bootstrap');
    assertEqual(r.status, 200, 'status');
    assert(Array.isArray(r.body.venues) && r.body.venues.length > 0, 'venues missing');
    assert(r.body.scope && typeof r.body.scope.role === 'string', 'scope missing');
  });
  await test('IT-04', 'Logout invalidates the session server-side, not just the cookie', async () => {
    const { cookie } = await login('admin@safecheck.demo');
    assertEqual((await api(cookie, '/api/bootstrap')).status, 200, 'before logout');
    await api(cookie, '/api/logout', { method: 'POST' });
    assertEqual((await api(cookie, '/api/bootstrap')).status, 401, 'reusing the old cookie must fail');
  });
  await test('IT-05', 'Wrong password is rejected and starts no session', async () => {
    const r = await login('admin@safecheck.demo', 'not-the-password');
    assertEqual(r.status, 400, 'status');
    assertEqual(r.cookie, '', 'no cookie should be set');
  });
  await test('IT-06', 'Uploaded evidence is stored and returned byte-identical', async () => {
    const { cookie } = await login('inspector@safecheck.demo');
    const up = await api(cookie, '/api/media', {
      method: 'POST', body: new Uint8Array(PNG_1PX),
      headers: { 'Content-Type': 'image/png', 'X-File-Name': 'evidence.png' }
    });
    assertEqual(up.status, 201, 'upload status');
    const res = await api(cookie, '/api/media/' + up.body.id, { raw: true });
    assertEqual(res.status, 200, 'download status');
    const got = Buffer.from(await res.arrayBuffer());
    assert(got.equals(PNG_1PX), 'downloaded bytes differ from what was uploaded');
  });
  await test('IT-07', 'A newly registered account can immediately log in', async () => {
    const email = `it07-${Date.now()}@safecheck.demo`;
    const s = await api(null, '/api/signup', {
      method: 'POST', body: { name: 'IT07 Tester', email, password: PASSWORD, role: 'user', branch: 'BKK-EAST' }
    });
    assertEqual(s.status, 201, 'signup status');
    assertEqual((await login(email)).status, 200, 'login status');
  });
  await test('IT-08', 'Signup assigns the venues of the branch that was chosen', async () => {
    const email = `it08-${Date.now()}@safecheck.demo`;
    await api(null, '/api/signup', {
      method: 'POST', body: { name: 'IT08 Tester', email, password: PASSWORD, role: 'user', branch: 'BKK-EAST' }
    });
    const { cookie } = await login(email);
    const boot = await api(cookie, '/api/bootstrap');
    assert(boot.body.venues.length > 0, 'a new user must not land on an empty dashboard');
    assert(boot.body.venues.every(v => v.branch === 'BKK-EAST'), 'should only see BKK-EAST venues');
  });
  await test('IT-09', 'A tester can submit UAT feedback and it is persisted', async () => {
    const { cookie } = await login('inspector@safecheck.demo');
    const before = (await api(cookie, '/api/bootstrap')).body.feedbackCount;
    const sent = await api(cookie, '/api/feedback', {
      method: 'POST',
      body: {
        testerName: 'IT-09 Tester', device: 'mobile', easeRating: 4,
        usefulness: 'very', confusing: 'หาเมนูรายงานไม่เจอตอนแรก',
        acceptance: 'accepted_with_fixes', acceptanceNote: 'ตัวหนังสือเล็กไปนิดหนึ่ง',
        scenarios: [{ id: 'UAT-01', status: 'pass', difficulty: 2, note: '' }]
      }
    });
    assertEqual(sent.status, 201, 'submit status');
    const after = (await api(cookie, '/api/bootstrap')).body.feedbackCount;
    assertEqual(after, before + 1, 'stored feedback count');
  });
  await test('IT-10', 'An account can log in with its username as well as its email', async () => {
    const r = await login('inspector');
    assertEqual(r.status, 200, 'status');
    assertEqual(r.body.user.email, 'inspector@safecheck.demo', 'resolved account');
  });
  await test('IT-11', 'Suspending an account ends its open session and blocks new logins', async () => {
    const admin = await login('admin@safecheck.demo');
    const created = await createAccount(admin.cookie);
    assertEqual(created.status, 201, 'create status');
    const member = await login(created.email);
    assertEqual((await api(member.cookie, '/api/bootstrap')).status, 200, 'works before suspension');
    const suspend = await api(admin.cookie, '/api/admin/users/' + created.body.id, { method: 'PATCH', body: { status: 'suspended' } });
    assertEqual(suspend.status, 200, 'suspend status');
    assertEqual((await api(member.cookie, '/api/bootstrap')).status, 401, 'the old session must stop working');
    const again = await login(created.email);
    assertEqual(again.status, 403, 'login status');
    assertEqual(again.body.code, 'err.accountSuspended', 'error code');
  });
  await test('IT-12', 'Failed and suspended logins are recorded in the security log', async () => {
    const admin = await login('admin@safecheck.demo');
    const r = await api(admin.cookie, '/api/admin/security');
    assertEqual(r.status, 200, 'status');
    assert(r.body.summary.failedLogins24h > 0, 'the wrong password from IT-05 should be counted');
    assert(r.body.loginEvents.some(e => e.reason === 'suspended'), 'the attempt from IT-11 should be logged');
  });
}

async function systemTests() {
  level('System');

  await test('ST-01', 'A submitted inspection is scored and appears in history', async () => {
    const { cookie } = await login('inspector@safecheck.demo');
    const id = 'INS-ST01-' + Date.now();
    const save = await api(cookie, '/api/inspections', {
      method: 'POST',
      body: {
        id, venueId: 'VEN-001', frequency: 'daily', inspector: 'ST01', role: 'Inspector',
        date: new Date().toISOString(), status: 'submitted', score: 50, overallNote: 'system test',
        items: [
          { id: 'DLY-01', result: 'pass' },
          { id: 'DLY-02', result: 'fail', note: 'blocked', actionStatus: 'open' }
        ]
      }
    });
    assertEqual(save.status, 200, 'save status');
    const boot = await api(cookie, '/api/bootstrap');
    const found = boot.body.inspections.find(i => i.id === id);
    assert(found, 'inspection not found in history');
    assertEqual(found.score, 50, 'stored score');
  });

  await test('ST-02', 'A failed item becomes a corrective action whose status can be updated', async () => {
    const { cookie } = await login('inspector@safecheck.demo');
    const id = 'INS-ST02-' + Date.now();
    await api(cookie, '/api/inspections', {
      method: 'POST',
      body: {
        id, venueId: 'VEN-001', frequency: 'daily', inspector: 'ST02', role: 'Inspector',
        date: new Date().toISOString(), status: 'submitted', score: 0,
        items: [{ id: 'DLY-01', result: 'fail', note: 'needs fixing', actionStatus: 'open' }]
      }
    });
    const sup = await login('supervisor@safecheck.demo');
    const patch = await api(sup.cookie, `/api/actions/${encodeURIComponent(id)}/DLY-01`, {
      method: 'PATCH', body: { actionStatus: 'in_progress' }
    });
    assertEqual(patch.status, 200, 'patch status');
    const boot = await api(sup.cookie, '/api/bootstrap');
    const item = boot.body.inspections.find(i => i.id === id).items.find(x => x.id === 'DLY-01');
    assertEqual(item.actionStatus, 'in_progress', 'persisted action status');
  });

  await test('ST-03', 'An alert runs the full notified -> acknowledged -> closed lifecycle', async () => {
    const sup = await login('supervisor@safecheck.demo');
    const created = await api(sup.cookie, '/api/alerts', {
      method: 'POST',
      body: { venueId: 'VEN-001', anomalyType: 'obstruction', level: 'danger', confidence: 92, obstructionPct: 60 }
    });
    assertEqual(created.status, 201, 'create status');
    assertEqual(created.body.status, 'notified', 'initial status');
    const alertId = created.body.id;

    const insp = await login('inspector@safecheck.demo');
    const ack = await api(insp.cookie, '/api/alerts/' + alertId, {
      method: 'PATCH', body: { status: 'acknowledged', acknowledgedAt: new Date().toISOString() }
    });
    assertEqual(ack.status, 200, 'acknowledge status');

    const close = await api(sup.cookie, '/api/alerts/' + alertId, {
      method: 'PATCH', body: { status: 'closed', closedAt: new Date().toISOString() }
    });
    assertEqual(close.status, 200, 'close status');

    const boot = await api(sup.cookie, '/api/bootstrap');
    assertEqual(boot.body.aiAlerts.find(a => a.id === alertId).status, 'closed', 'final status');
  });

  await test('ST-04', 'Purchasing equipment clears the venue shortfall', async () => {
    // Equipment is managed by the administrator; the manager role is read-only.
    const mgr = await login('admin@safecheck.demo');
    let boot = await api(mgr.cookie, '/api/bootstrap');
    const short = boot.body.equipmentCompliance.find(c => c.shortfall > 0);
    assert(short, 'expected at least one venue below the required quantity');
    for (let i = 0; i < short.shortfall; i++) {
      const add = await api(mgr.cookie, '/api/equipment', {
        method: 'POST',
        body: {
          venueId: short.venueId, type: 'fire_extinguisher', label: 'ST-04 test unit',
          installDate: '2026-01-01', expiryDate: '2031-01-01'
        }
      });
      assertEqual(add.status, 201, 'add status');
    }
    boot = await api(mgr.cookie, '/api/bootstrap');
    const after = boot.body.equipmentCompliance.find(c => c.venueId === short.venueId);
    assertEqual(after.shortfall, 0, 'shortfall after purchase');
  });

  await test('ST-05', 'Reset restores demo data without deleting user accounts', async () => {
    const admin = await login('admin@safecheck.demo');
    const email = `st05-${Date.now()}@safecheck.demo`;
    await api(null, '/api/signup', {
      method: 'POST', body: { name: 'ST05', email, password: PASSWORD, role: 'user', branch: 'BKK-CENTRAL' }
    });
    const reset = await api(admin.cookie, '/api/reset', { method: 'POST' });
    assertEqual(reset.status, 200, 'reset status');
    assertEqual((await login(email)).status, 200, 'account created before reset must still work');
    const boot = await api(admin.cookie, '/api/bootstrap');
    assertEqual(boot.body.venues.length, 6, 'seed venues restored');
  });
  await test('ST-06', 'Resetting demo data does not destroy collected UAT feedback', async () => {
    const insp = await login('inspector@safecheck.demo');
    await api(insp.cookie, '/api/feedback', {
      method: 'POST',
      body: { testerName: 'ST-06 Tester', device: 'desktop', acceptance: 'accepted', scenarios: [] }
    });
    const admin = await login('admin@safecheck.demo');
    const before = (await api(admin.cookie, '/api/bootstrap')).body.feedbackCount;
    assertEqual((await api(admin.cookie, '/api/reset', { method: 'POST' })).status, 200, 'reset status');
    const after = (await api(admin.cookie, '/api/bootstrap')).body.feedbackCount;
    assertEqual(after, before, 'feedback count must survive a reset');
  });

  await test('ST-07', 'Staff submission: Inspector reviews, Supervisor approves, record becomes final', async () => {
    const staff = await login('staff@safecheck.demo');
    const sent = await submitInspection(staff.cookie);
    assertEqual(sent.status, 200, 'submit status');
    assertEqual(sent.body.reviewStatus, 'pending_review', 'first stage');
    assert(sent.body.deadline, 'an approval deadline must be set');
    const id = sent.body.id;

    const sup = await login('supervisor@safecheck.demo');
    const early = await api(sup.cookie, `/api/inspections/${id}/approve`, { method: 'POST', body: { decision: 'approve' } });
    assertEqual(early.status, 409, 'the supervisor cannot skip the inspector');

    const insp = await login('inspector@safecheck.demo');
    const review = await api(insp.cookie, `/api/inspections/${id}/review`, { method: 'POST', body: { decision: 'approve' } });
    assertEqual(review.status, 200, 'review status');
    assertEqual(review.body.reviewStatus, 'pending_approval', 'after review');

    const approve = await api(sup.cookie, `/api/inspections/${id}/approve`, { method: 'POST', body: { decision: 'approve' } });
    assertEqual(approve.status, 200, 'approve status');
    const record = await inspectionById(sup.cookie, id);
    assertEqual(record.reviewStatus, 'approved', 'final stage');
    assertEqual(record.history.map(h => h.action), ['submitted', 'reviewed', 'approved'], 'timeline');
  });

  await test('ST-08', 'A rejection needs a reason, reaches the submitter, and the record can be resubmitted', async () => {
    const staff = await login('staff@safecheck.demo');
    const id = (await submitInspection(staff.cookie)).body.id;
    const insp = await login('inspector@safecheck.demo');
    const noReason = await api(insp.cookie, `/api/inspections/${id}/review`, { method: 'POST', body: { decision: 'reject', note: '  ' } });
    assertEqual(noReason.status, 400, 'reject without a reason');
    const reject = await api(insp.cookie, `/api/inspections/${id}/review`, { method: 'POST', body: { decision: 'reject', note: 'แนบรูปไม่ครบ' } });
    assertEqual(reject.body.reviewStatus, 'rejected', 'after rejection');

    const boot = await api(staff.cookie, '/api/bootstrap');
    const notice = boot.body.notifications.find(n => n.inspectionId === id && n.kind === 'inspection.rejected');
    assert(notice && notice.params.note === 'แนบรูปไม่ครบ', 'the submitter must be told why');

    const again = await submitInspection(staff.cookie, { id });
    assertEqual(again.status, 200, 'resubmit status');
    assertEqual(again.body.reviewStatus, 'pending_review', 'back to the inspector');
    const record = await inspectionById(staff.cookie, id);
    assertEqual(record.history.map(h => h.action), ['submitted', 'rejected', 'resubmitted'], 'timeline');
  });

  await test('ST-09', 'An Inspector can send a notice to the staff of a venue', async () => {
    const insp = await login('inspector@safecheck.demo');
    const r = await api(insp.cookie, '/api/notify', { method: 'POST', body: { venueId: 'VEN-001', message: 'ย้ายลังออกจากทางหนีไฟก่อนเปิดร้าน' } });
    assertEqual(r.status, 201, 'status');
    assert(r.body.sent >= 1, 'at least one staff member should receive it');
    const staff = await login('staff@safecheck.demo');
    const boot = await api(staff.cookie, '/api/bootstrap');
    assert(boot.body.notifications.some(n => n.kind === 'staff.message' && n.params.message.includes('ทางหนีไฟ')), 'staff did not receive the notice');
  });

  await test('ST-10', 'An administrator creates an account, changes its role, then deletes it', async () => {
    const admin = await login('admin@safecheck.demo');
    const created = await createAccount(admin.cookie, { username: `st10${Date.now() % 100000}` });
    assertEqual(created.status, 201, 'create');
    const promote = await api(admin.cookie, '/api/admin/users/' + created.body.id, { method: 'PATCH', body: { role: 'supervisor' } });
    assertEqual(promote.status, 200, 'role change');
    const member = await login(created.body.username);
    assertEqual(member.body.user.role, 'supervisor', 'the new role applies at login');
    assertEqual((await api(admin.cookie, '/api/admin/users/' + created.body.id, { method: 'DELETE' })).status, 200, 'delete');
    assertEqual((await login(created.email)).status, 400, 'a deleted account can no longer log in');
  });

  await test('ST-11', 'An administrator corrects a wrong result; the score is recomputed and the change is recorded', async () => {
    const admin = await login('admin@safecheck.demo');
    // Seed record INS-2026-0007 has DLY-03 marked as failed.
    const before = await inspectionById(admin.cookie, 'INS-2026-0007');
    assert(before && before.score < 100, 'the seed record should start below 100');
    const noReason = await api(admin.cookie, '/api/admin/inspections/INS-2026-0007', { method: 'PATCH', body: { items: [{ id: 'DLY-03', result: 'pass' }] } });
    assertEqual(noReason.status, 400, 'a correction needs a reason');
    const fix = await api(admin.cookie, '/api/admin/inspections/INS-2026-0007', {
      method: 'PATCH', body: { reason: 'ผู้ตรวจกดผิดช่อง ยืนยันจากรูปถ่ายแล้ว', items: [{ id: 'DLY-03', result: 'pass' }] }
    });
    assertEqual(fix.status, 200, 'correction status');
    assertEqual(fix.body.score, 100, 'recomputed score');
    const after = await inspectionById(admin.cookie, 'INS-2026-0007');
    assertEqual(after.history[after.history.length - 1].action, 'corrected', 'timeline entry');
    const security = await api(admin.cookie, '/api/admin/security');
    assert(security.body.audit.some(a => a.action === 'data.correct' && a.target === 'INS-2026-0007'), 'audit log entry missing');
  });

  await test('ST-12', 'An administrator manages venues and equipment; a venue with history cannot be deleted', async () => {
    const admin = await login('admin@safecheck.demo');
    const venue = await api(admin.cookie, '/api/admin/venues', {
      method: 'POST', body: { name: 'ST-12 Test Cafe', type: 'Restaurant', location: 'เขตบางรัก กรุงเทพฯ', branch: 'BKK-CENTRAL', tablesCount: 12 }
    });
    assertEqual(venue.status, 201, 'create venue');
    const edit = await api(admin.cookie, '/api/admin/venues/' + venue.body.id, { method: 'PATCH', body: { tablesCount: 25 } });
    assertEqual(edit.body.tablesCount, 25, 'edited table count');
    const eq = await api(admin.cookie, '/api/equipment', {
      method: 'POST', body: { venueId: venue.body.id, type: 'smoke_detector', label: 'ST-12 detector', installDate: '2026-01-01', expiryDate: '2030-01-01' }
    });
    assertEqual(eq.status, 201, 'add equipment');
    assertEqual((await api(admin.cookie, '/api/equipment/' + eq.body.id, { method: 'DELETE' })).status, 200, 'delete equipment');
    assertEqual((await api(admin.cookie, '/api/admin/venues/' + venue.body.id, { method: 'DELETE' })).status, 200, 'delete an unused venue');
    assertEqual((await api(admin.cookie, '/api/admin/venues/VEN-001', { method: 'DELETE' })).status, 409, 'a venue with inspection history');
  });

  await test('ST-13', 'Backup and restore return data to the backed-up state, with a safety backup taken first', async () => {
    const admin = await login('admin@safecheck.demo');
    const backup = await api(admin.cookie, '/api/admin/backups', { method: 'POST', body: { label: 'ST-13' } });
    assertEqual(backup.status, 201, 'backup status');
    const venue = await api(admin.cookie, '/api/admin/venues', {
      method: 'POST', body: { name: 'ST-13 Added After Backup', type: 'Bar & Pub', location: 'เขตบางรัก กรุงเทพฯ', branch: 'BKK-NORTH', tablesCount: 8 }
    });
    assertEqual(venue.status, 201, 'venue added after the backup');
    const restore = await api(admin.cookie, '/api/admin/restore', { method: 'POST', body: { backupId: backup.body.id } });
    assertEqual(restore.status, 200, 'restore status');
    assert(restore.body.safetyBackupId, 'a safety backup must be taken before restoring');
    const boot = await api(admin.cookie, '/api/bootstrap');
    assert(!boot.body.venues.some(v => v.id === venue.body.id), 'the venue added after the backup should be gone');
    const bad = await api(admin.cookie, '/api/admin/restore', { method: 'POST', body: { payload: '{"not":"a backup"}' } });
    assertEqual(bad.status, 400, 'an invalid file is refused');
    assertEqual((await api(admin.cookie, '/api/bootstrap')).body.venues.length, boot.body.venues.length, 'a refused restore changes nothing');
  });
}

async function acceptanceTests() {
  level('Acceptance');
  const I18n = require(path.join(WORK_DIR, 'i18n.js'));
  // content() resolves to the Thai catalogue by default, which is the authored one.
  const content = I18n.content();
  const html = fs.readFileSync(path.join(WORK_DIR, 'index.html'), 'utf8');

  await test('AT-01', 'REQ-1 Safety standards are documented with codes and sources', () => {
    assert(content && Array.isArray(content.standards) && content.standards.length >= 3,
      'expected a standards catalogue');
    assert(content.standards.every(s => s.code && s.source && s.relates),
      'every standard needs a code, a source and what it relates to');
  });
  await test('AT-02', 'REQ-2 AI detection criteria are defined and measurable', () => {
    assert(content && content.anomaly && Object.keys(content.anomaly).length >= 3,
      'expected an anomaly catalogue with at least 3 types');
  });
  await test('AT-03', 'REQ-3 Three alert levels exist and drive different handling', async () => {
    const sup = await login('supervisor@safecheck.demo');
    for (const lv of ['normal', 'caution', 'danger']) {
      const r = await api(sup.cookie, '/api/alerts', {
        method: 'POST', body: { venueId: 'VEN-001', anomalyType: 'obstruction', level: lv, confidence: 85 }
      });
      assertEqual(r.status, 201, `level ${lv} must be accepted`);
      assertEqual(r.body.level, lv, `stored level for ${lv}`);
    }
  });
  await test('AT-04', 'REQ-4 Sensor and equipment catalogue is documented', () => {
    assert(content && Array.isArray(content.devices) && content.devices.length >= 4,
      'expected a device comparison catalogue');
  });
  await test('AT-05', 'REQ-5 Test environments and pass criteria are documented', () => {
    assert(content && Array.isArray(content.testEnvironments) && content.testEnvironments.length > 0,
      'expected documented test environments');
    assert(Array.isArray(content.testCriteria) && content.testCriteria.length > 0,
      'expected documented pass/fail criteria');
  });
  await test('AT-06', 'REQ-6 All required screens are present in the interface', () => {
    const required = ['dashboard', 'venues', 'inspection', 'result', 'history', 'actions',
      'ai-monitor', 'alerts', 'sensors', 'equipment', 'standards', 'testing', 'report', 'approvals', 'admin'];
    const missing = required.filter(v => !html.includes(`id="view-${v}"`));
    assertEqual(missing, [], 'missing views');
  });
  await test('AT-07', 'REQ-7 CCTV is documented as a sensor feeding the AI pipeline', () => {
    assert(content && Array.isArray(content.aiScopeDetects) && content.aiScopeDetects.length > 0,
      'expected documented AI detection scope');
    assert(html.includes('id="view-ai-monitor"'), 'AI monitor screen missing');
  });
  await test('AT-08', 'REQ-8 Approval deadlines follow the business rule (daily: before 17:00 Bangkok time)', async () => {
    const staff = await login('staff@safecheck.demo');
    const sent = await submitInspection(staff.cookie);
    const deadline = new Date(sent.body.deadline);
    // 17:00 in Bangkok is 10:00 UTC
    assertEqual(deadline.getUTCHours(), 10, 'deadline hour (UTC)');
    assertEqual(deadline.getUTCMinutes(), 0, 'deadline minute');
    assert(deadline.getTime() > Date.now(), 'the deadline must be in the future when submitted');
  });
  await test('AT-09', 'REQ-9 The system has exactly five roles: Admin, Manager, Supervisor, Inspector, User', async () => {
    const admin = await login('admin@safecheck.demo');
    const perms = await api(admin.cookie, '/api/admin/permissions');
    assertEqual([...perms.body.roles].sort(), ['admin', 'inspector', 'manager', 'supervisor', 'user'], 'roles');
    const oldRole = await api(null, '/api/signup', {
      method: 'POST', body: { name: 'X', email: `at09-${Date.now()}@safecheck.demo`, password: PASSWORD, role: 'safety' }
    });
    assertEqual(oldRole.status, 400, 'the retired Safety Officer role cannot be used');
  });
}

async function nonFunctionalTests() {
  level('Non-Functional');
  const { DatabaseSync } = require('node:sqlite');

  await test('NFT-01', 'Bootstrap responds in under 500 ms', async () => {
    const { cookie } = await login('manager@safecheck.demo');
    const started = Date.now();
    await api(cookie, '/api/bootstrap');
    const elapsed = Date.now() - started;
    assert(elapsed < 500, `took ${elapsed} ms`);
  });
  await test('NFT-02', 'Passwords are stored hashed and salted, never in plain text', () => {
    const db = new DatabaseSync(path.join(WORK_DIR, 'data', 'safecheck.db'));
    const rows = db.prepare('SELECT password_hash, password_salt FROM users').all();
    db.close();
    assert(rows.length > 0, 'no users found');
    for (const r of rows) {
      assert(!String(r.password_hash).includes(PASSWORD), 'plain-text password found in the database');
      assert(/^[0-9a-f]{128}$/.test(r.password_hash), 'hash is not a 64-byte scrypt digest');
      assert(/^[0-9a-f]{32}$/.test(r.password_salt), 'salt is not 16 random bytes');
    }
    const salts = new Set(rows.map(r => r.password_salt));
    assertEqual(salts.size, rows.length, 'every user must have a unique salt');
  });
  await test('NFT-03', 'The API never returns password hashes or salts', async () => {
    const { cookie } = await login('admin@safecheck.demo');
    const me = await api(cookie, '/api/me');
    const serialised = JSON.stringify(me.body);
    assert(!/password/i.test(serialised), 'password field leaked in /api/me: ' + serialised);
  });
  await test('NFT-04', 'Repeated failed logins are throttled with HTTP 429', async () => {
    // A deliberately non-existent address: throttling counts failures the same way,
    // and this cannot lock out a real account that a later test needs to log into.
    const email = 'throttle-probe@safecheck.demo';
    const codes = [];
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`${BASE}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.7' },
        body: JSON.stringify({ email, password: 'wrong-' + i })
      });
      codes.push(res.status);
    }
    assert(codes.includes(429), 'expected a 429 after repeated failures, got ' + codes.join(','));
  });
  await test('NFT-05', 'Public signup cannot grant an elevated role', async () => {
    for (const role of ['admin', 'manager', 'supervisor', 'inspector']) {
      const r = await api(null, '/api/signup', {
        method: 'POST',
        body: { name: 'X', email: `esc-${role}-${Date.now()}@safecheck.demo`, password: PASSWORD, role }
      });
      assertEqual(r.status, 400, `signup as ${role} must be refused`);
      assertEqual(r.body.code, 'err.roleNotAllowed', `error code for ${role}`);
    }
  });
  await test('NFT-06', 'Out-of-scope venue data is never sent to the client', async () => {
    const insp = await login('inspector@safecheck.demo');
    const boot = await api(insp.cookie, '/api/bootstrap');
    const visible = new Set(boot.body.venues.map(v => v.id));
    assert(visible.size < boot.body.scope.totalVenueCount, 'inspector should see a subset');
    assert(boot.body.inspections.every(i => visible.has(i.venueId)), 'inspection from an unassigned venue leaked');
    assert(boot.body.equipment.every(e => visible.has(e.venueId)), 'equipment from an unassigned venue leaked');
    assert(boot.body.aiAlerts.every(a => visible.has(a.venueId)), 'alert from an unassigned venue leaked');
  });
  await test('NFT-07', 'A write to an out-of-scope venue is refused with 403', async () => {
    const insp = await login('inspector@safecheck.demo');
    const boot = await api(insp.cookie, '/api/bootstrap');
    const visible = new Set(boot.body.venues.map(v => v.id));
    const forbidden = ['VEN-001', 'VEN-002', 'VEN-003', 'VEN-004', 'VEN-005', 'VEN-006']
      .find(id => !visible.has(id));
    const r = await api(insp.cookie, '/api/inspections', {
      method: 'POST',
      body: {
        id: 'INS-NFT07-' + Date.now(), venueId: forbidden, frequency: 'daily', inspector: 'x',
        role: 'x', date: new Date().toISOString(), status: 'submitted', score: 0, items: []
      }
    });
    assertEqual(r.status, 403, 'status');
  });
  await test('NFT-08', 'An action the role lacks is refused even when called directly', async () => {
    const insp = await login('inspector@safecheck.demo');
    assertEqual((await api(insp.cookie, '/api/reset', { method: 'POST' })).status, 403, 'reset');
    const mgr = await login('manager@safecheck.demo');
    assertEqual((await api(mgr.cookie, '/api/reset', { method: 'POST' })).status, 403, 'manager reset');
  });
  await test('NFT-09', 'Disallowed file types are rejected on upload', async () => {
    const { cookie } = await login('inspector@safecheck.demo');
    const r = await api(cookie, '/api/media', {
      method: 'POST', body: new Uint8Array(Buffer.from('MZ executable')),
      headers: { 'Content-Type': 'application/x-msdownload', 'X-File-Name': 'virus.exe' }
    });
    assertEqual(r.status, 400, 'status');
  });
  await test('NFT-10', 'The per-item evidence cap is enforced by the server, not the UI', async () => {
    const { cookie } = await login('inspector@safecheck.demo');
    const r = await api(cookie, '/api/inspections', {
      method: 'POST',
      body: {
        id: 'INS-NFT10-' + Date.now(), venueId: 'VEN-001', frequency: 'daily', inspector: 'x',
        role: 'x', date: new Date().toISOString(), status: 'submitted', score: 0,
        items: [{ id: 'DLY-01', result: 'pass', media: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] }]
      }
    });
    assertEqual(r.status, 400, 'more than 3 files per item must be refused');
  });
  await test('NFT-11', 'A non-administrator cannot read other testers\u2019 feedback', async () => {
    for (const role of ['staff', 'inspector', 'supervisor', 'manager']) {
      const { cookie } = await login(role + '@safecheck.demo');
      const direct = await api(cookie, '/api/feedback');
      assertEqual(direct.status, 403, role + ' direct read');
      const boot = await api(cookie, '/api/bootstrap');
      assertEqual(boot.body.feedback, null, role + ' must not receive feedback in bootstrap');
    }
  });
  await test('NFT-12', 'An administrator can read the collected feedback', async () => {
    const { cookie } = await login('admin@safecheck.demo');
    const r = await api(cookie, '/api/feedback');
    assertEqual(r.status, 200, 'status');
    assert(Array.isArray(r.body.feedback), 'expected an array of responses');
    const boot = await api(cookie, '/api/bootstrap');
    assert(Array.isArray(boot.body.feedback), 'admin bootstrap should carry the responses');
  });
  await test('NFT-13', 'Feedback submission is rejected without a tester name', async () => {
    const { cookie } = await login('inspector@safecheck.demo');
    const r = await api(cookie, '/api/feedback', { method: 'POST', body: { testerName: '   ' } });
    assertEqual(r.status, 400, 'status');
  });
  await test('NFT-14', 'Manager is read-only: every write is refused by the server', async () => {
    const mgr = await login('manager@safecheck.demo');
    assertEqual((await submitInspection(mgr.cookie)).status, 403, 'submit inspection');
    assertEqual((await api(mgr.cookie, '/api/equipment', { method: 'POST', body: { venueId: 'VEN-001', type: 'fire_extinguisher', label: 'x' } })).status, 403, 'add equipment');
    assertEqual((await api(mgr.cookie, '/api/alerts', { method: 'POST', body: { venueId: 'VEN-001', anomalyType: 'smoke', level: 'danger', confidence: 90 } })).status, 403, 'raise alert');
    assertEqual((await api(mgr.cookie, '/api/actions/INS-2026-0007/DLY-03', { method: 'PATCH', body: { actionStatus: 'closed' } })).status, 403, 'update action');
    assertEqual((await api(mgr.cookie, '/api/inspections/INS-2026-0009/approve', { method: 'POST', body: { decision: 'approve' } })).status, 403, 'approve');
  });
  await test('NFT-15', 'Each approval step is limited to its own role', async () => {
    const staff = await login('staff@safecheck.demo');
    const id = (await submitInspection(staff.cookie)).body.id;
    const decide = (cookie, step) => api(cookie, `/api/inspections/${id}/${step}`, { method: 'POST', body: { decision: 'approve' } });
    assertEqual((await decide(staff.cookie, 'review')).status, 403, 'staff cannot review');
    const insp = await login('inspector@safecheck.demo');
    assertEqual((await decide(insp.cookie, 'review')).status, 200, 'inspector reviews');
    assertEqual((await decide(insp.cookie, 'approve')).status, 403, 'inspector cannot give final approval');
    const admin = await login('admin@safecheck.demo');
    assertEqual((await decide(admin.cookie, 'approve')).status, 403, 'the administrator does not approve inspections');
  });
  await test('NFT-16', 'Every administration endpoint refuses non-administrators', async () => {
    const endpoints = [
      ['GET', '/api/admin/users'], ['POST', '/api/admin/users'], ['GET', '/api/admin/permissions'],
      ['PUT', '/api/admin/permissions/user'], ['PATCH', '/api/admin/inspections/INS-2026-0007'],
      ['POST', '/api/admin/venues'], ['GET', '/api/admin/security'], ['GET', '/api/admin/backups'], ['POST', '/api/admin/restore']
    ];
    for (const who of ['staff', 'inspector', 'supervisor', 'manager']) {
      const { cookie } = await login(who + '@safecheck.demo');
      for (const [method, url] of endpoints) {
        const r = await api(cookie, url, { method, body: method === 'GET' ? undefined : {} });
        assertEqual(r.status, 403, `${who} ${method} ${url}`);
      }
    }
  });
  await test('NFT-17', 'Permission changes apply immediately; administrators cannot remove their own admin rights', async () => {
    const admin = await login('admin@safecheck.demo');
    const mgr = await login('manager@safecheck.demo');
    const alertBody = { venueId: 'VEN-001', anomalyType: 'smoke', level: 'caution', confidence: 85 };
    assertEqual((await api(mgr.cookie, '/api/alerts', { method: 'POST', body: alertBody })).status, 403, 'before the change');
    const grant = await api(admin.cookie, '/api/admin/permissions/manager', { method: 'PUT', body: { capabilities: ['feedback.submit', 'alert.simulate'] } });
    assertEqual(grant.status, 200, 'grant status');
    assertEqual((await api(mgr.cookie, '/api/alerts', { method: 'POST', body: alertBody })).status, 201, 'same session, after the change');
    const lockout = await api(admin.cookie, '/api/admin/permissions/admin', { method: 'PUT', body: { capabilities: ['feedback.read'] } });
    assertEqual(lockout.status, 400, 'removing admin rights from administrators');
    assertEqual(lockout.body.code, 'err.lockedCapability', 'error code');
    await api(admin.cookie, '/api/admin/permissions/reset', { method: 'POST' });
    assertEqual((await api(mgr.cookie, '/api/alerts', { method: 'POST', body: alertBody })).status, 403, 'after restoring defaults');
  });
  await test('NFT-18', 'Shared demo accounts and an administrator’s own account are protected', async () => {
    const admin = await login('admin@safecheck.demo');
    const users = (await api(admin.cookie, '/api/admin/users')).body.users;
    const staffDemo = users.find(u => u.email === 'staff@safecheck.demo');
    const self = users.find(u => u.email === 'admin@safecheck.demo');
    const del = await api(admin.cookie, '/api/admin/users/' + staffDemo.id, { method: 'DELETE' });
    assertEqual(del.status, 403, 'delete a shared demo account');
    assertEqual(del.body.code, 'err.demoProtected', 'error code');
    assertEqual((await api(admin.cookie, '/api/admin/users/' + self.id, { method: 'PATCH', body: { role: 'user' } })).status, 403, 'demote own account');
  });
  await test('NFT-19', 'Backup files contain no user accounts, passwords or password hashes', async () => {
    const admin = await login('admin@safecheck.demo');
    const backup = await api(admin.cookie, '/api/admin/backups', { method: 'POST', body: { label: 'NFT-19' } });
    const res = await api(admin.cookie, '/api/admin/backups/' + backup.body.id, { raw: true });
    assertEqual(res.status, 200, 'download status');
    assert(/attachment/.test(res.headers.get('content-disposition') || ''), 'should download as a file');
    const text = await res.text();
    assert(!/password/i.test(text), 'the backup mentions passwords');
    assert(!JSON.parse(text).tables.users, 'the backup must not include the users table');
  });
  await test('NFT-20', 'A record in review cannot be changed by its submitter or by anyone else', async () => {
    const staff = await login('staff@safecheck.demo');
    const id = (await submitInspection(staff.cookie)).body.id;
    assertEqual((await submitInspection(staff.cookie, { id, items: [{ id: 'DLY-01', result: 'fail' }] })).status, 409, 'submitter editing a record in review');
    const insp = await login('inspector@safecheck.demo');
    assertEqual((await submitInspection(insp.cookie, { id })).status, 403, 'another user overwriting the record');
  });
  await test('NFT-21', 'The security log masks the email and IP address of real people', async () => {
    await fetch(`${BASE}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'real.person@example.com', password: 'wrong' })
    });
    const admin = await login('admin@safecheck.demo');
    const serialised = JSON.stringify((await api(admin.cookie, '/api/admin/security')).body);
    assert(!serialised.includes('real.person@example.com'), 'a real email address was shown in full');
    assert(serialised.includes('re***@example.com'), 'expected the masked form of the address');
  });
}

// ==================================================================== runner
function copyApp() {
  fs.mkdirSync(path.join(WORK_DIR, 'data'), { recursive: true });
  for (const f of ['db.js', 'server.js', 'core.js', 'workflow.js', 'i18n.js', 'api.js', 'app.js', 'approvals.js', 'admin.js', 'index.html', 'styles.css', 'package.json']) {
    fs.copyFileSync(path.join(APP_DIR, f), path.join(WORK_DIR, f));
  }
}

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${BASE}/api/me`); return true; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  return false;
}

function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }

function buildReport() {
  const lines = [];
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  lines.push('='.repeat(96));
  lines.push('  SafeCheck — Test Result Report');
  lines.push(`  Generated: ${stamp}    Node: ${process.version}    Platform: ${process.platform}`);
  lines.push('='.repeat(96));

  const levels = ['Unit', 'Integration', 'System', 'Acceptance', 'Non-Functional'];
  for (const lv of levels) {
    const rows = results.filter(r => r.level === lv);
    if (!rows.length) continue;
    const passed = rows.filter(r => r.status === 'PASS').length;
    lines.push('');
    lines.push(`${lv} Testing  —  ${passed}/${rows.length} passed`);
    lines.push('-'.repeat(96));
    lines.push(`  ${pad('ID', 8)}${pad('Test Case', 68)}${pad('Result', 8)}Time`);
    lines.push('-'.repeat(96));
    for (const r of rows) {
      lines.push(`  ${pad(r.id, 8)}${pad(r.description.slice(0, 66), 68)}${pad(r.status, 8)}${r.ms} ms`);
      if (r.status === 'FAIL') lines.push(`  ${' '.repeat(8)}-> ${r.detail}`);
    }
  }

  const total = results.length;
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = total - passed;
  lines.push('');
  lines.push('='.repeat(96));
  lines.push(`  SUMMARY:  ${passed} passed, ${failed} failed, ${total} total` +
    `   (pass rate ${total ? Math.round((passed / total) * 100) : 0}%)`);
  lines.push('='.repeat(96));
  return lines.join('\n');
}

(async () => {
  copyApp();
  const server = spawn(process.execPath, ['server.js'], {
    cwd: WORK_DIR, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'pipe']
  });
  let serverErrors = '';
  server.stderr.on('data', d => { serverErrors += d; });

  try {
    if (!await waitForServer()) throw new Error('test server failed to start:\n' + serverErrors);

    await unitTests();
    await integrationTests();
    await systemTests();
    await acceptanceTests();
    await nonFunctionalTests();

    const report = buildReport();
    console.log(report);
    const out = path.join(__dirname, 'last-run-report.txt');
    fs.writeFileSync(out, report + '\n', 'utf8');
    console.log(`\nReport written to: ${path.relative(APP_DIR, out)}`);

    const failed = results.filter(r => r.status === 'FAIL').length;
    process.exitCode = failed ? 1 : 0;
  } finally {
    server.kill();
    try { fs.rmSync(WORK_DIR, { recursive: true, force: true }); } catch { /* Windows file locks */ }
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
