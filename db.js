'use strict';
// SafeCheck database layer — node:sqlite (built into Node 22.5+, no native build step,
// no external dependency). File lives at data/safecheck.db and is created + seeded
// automatically on first run. Restarting the server never wipes data (CREATE TABLE IF
// NOT EXISTS + seed-only-if-empty), which is what actually proves this is a real
// database rather than per-tab localStorage.
// node:sqlite ships with Node but is only importable without a flag from Node 23.4
// onwards (22.5-23.3 need --experimental-sqlite). A bare module-not-found error does
// not say that, so translate it into an instruction.
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  console.error('\n  SafeCheck could not load the built-in node:sqlite module.');
  console.error(`  You are running Node ${process.version}.`);
  console.error('  Fix: install Node 24 LTS from https://nodejs.org and run again,');
  console.error('       or start with:  node --experimental-sqlite server.js\n');
  process.exit(1);
}
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
// Shared with the browser: the server recomputes scores and deadlines itself rather
// than trusting the numbers a client sends.
const Core = require('./core');
const Workflow = require('./workflow');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'safecheck.db'));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS venues (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    location TEXT NOT NULL,
    tables_count INTEGER NOT NULL DEFAULT 10,
    last_inspected_date TEXT
  );

  CREATE TABLE IF NOT EXISTS checklist_items (
    id TEXT PRIMARY KEY,
    frequency TEXT NOT NULL,
    code TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    evidence_requirement TEXT NOT NULL DEFAULT 'optional'
  );

  CREATE TABLE IF NOT EXISTS inspections (
    id TEXT PRIMARY KEY,
    venue_id TEXT NOT NULL REFERENCES venues(id),
    frequency TEXT NOT NULL DEFAULT 'daily',
    inspector_name TEXT NOT NULL,
    role TEXT NOT NULL,
    date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    score INTEGER NOT NULL DEFAULT 0,
    overall_note TEXT DEFAULT '',
    items_json TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS ai_alerts (
    id TEXT PRIMARY KEY,
    venue_id TEXT REFERENCES venues(id),
    zone TEXT,
    anomaly_type TEXT,
    detected TEXT,
    level TEXT,
    confidence INTEGER,
    created_at TEXT,
    status TEXT,
    notified_employee TEXT,
    acknowledged_at TEXT DEFAULT '',
    escalated_at TEXT DEFAULT '',
    closed_at TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS equipment (
    id TEXT PRIMARY KEY,
    venue_id TEXT REFERENCES venues(id),
    type TEXT NOT NULL,
    label TEXT NOT NULL,
    install_date TEXT,
    expiry_date TEXT,
    photo TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    role TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  -- Which venues an individual field user is responsible for. Supervisors are scoped
  -- by branch and managers/admins see everything, so only inspector/safety accounts
  -- get rows here.
  -- User Acceptance Test responses, collected in the product itself rather than on
  -- paper. Storing tester name and device alongside a server-side timestamp is what
  -- makes a response auditable evidence rather than a file someone could have typed.
  CREATE TABLE IF NOT EXISTS uat_feedback (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    tester_name TEXT NOT NULL,
    role_used TEXT,
    device TEXT,
    scenarios_json TEXT NOT NULL DEFAULT '[]',
    ease_rating INTEGER,
    usefulness TEXT,
    confusing TEXT,
    missing TEXT,
    acceptance TEXT,
    acceptance_note TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS venue_assignments (
    user_id TEXT NOT NULL REFERENCES users(id),
    venue_id TEXT NOT NULL REFERENCES venues(id),
    PRIMARY KEY (user_id, venue_id)
  );

  -- Evidence media lives in its own table rather than inside items_json, so that
  -- /api/bootstrap stays small: it returns only media ids/metadata and the browser
  -- fetches the actual bytes lazily per file via GET /api/media/:id.
  CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY,
    inspection_id TEXT,
    item_id TEXT,
    kind TEXT NOT NULL,
    mime TEXT NOT NULL,
    filename TEXT DEFAULT '',
    size INTEGER NOT NULL,
    bytes BLOB NOT NULL,
    created_at TEXT NOT NULL
  );
`);

// Approval notifications, the editable permission matrix, the security and audit logs,
// and stored backups.
db.exec(`
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    params_json TEXT NOT NULL DEFAULT '{}',
    inspection_id TEXT DEFAULT '',
    from_name TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    read_at TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS role_permissions (
    role TEXT NOT NULL,
    capability TEXT NOT NULL,
    PRIMARY KEY (role, capability)
  );

  CREATE TABLE IF NOT EXISTS login_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT DEFAULT '',
    user_id TEXT DEFAULT '',
    ip TEXT DEFAULT '',
    success INTEGER NOT NULL,
    reason TEXT DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id TEXT DEFAULT '',
    actor_name TEXT DEFAULT '',
    action TEXT NOT NULL,
    target TEXT DEFAULT '',
    detail TEXT DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS backups (
    id TEXT PRIMARY KEY,
    label TEXT DEFAULT '',
    created_by TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    size INTEGER NOT NULL,
    payload TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Adds a column to an existing table if it isn't there yet, so an already-created
// safecheck.db picks up new fields instead of needing to be deleted.
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn('venues', 'location_en', "location_en TEXT DEFAULT ''");
ensureColumn('checklist_items', 'title_en', "title_en TEXT DEFAULT ''");
ensureColumn('checklist_items', 'description_en', "description_en TEXT DEFAULT ''");
ensureColumn('equipment', 'label_en', "label_en TEXT DEFAULT ''");
// Alerts store language-neutral coordinates (which anomaly, which phrasing variant,
// which zone/staff) so the sentence can be rendered in either language at read time.
ensureColumn('ai_alerts', 'variant_index', 'variant_index INTEGER DEFAULT 0');
ensureColumn('ai_alerts', 'obstruction_pct', 'obstruction_pct INTEGER');
ensureColumn('ai_alerts', 'zone_index', 'zone_index INTEGER DEFAULT 0');
ensureColumn('ai_alerts', 'staff_index', 'staff_index INTEGER DEFAULT 0');
// Data-scope columns: a venue belongs to a branch, a user belongs to a branch.
ensureColumn('venues', 'branch', "branch TEXT DEFAULT 'BKK-CENTRAL'");
ensureColumn('users', 'branch', "branch TEXT DEFAULT 'BKK-CENTRAL'");
// Lets an upload be tied to its uploader before it is linked to a saved inspection.
ensureColumn('media', 'uploaded_by', "uploaded_by TEXT DEFAULT ''");
// Accounts: an optional username an administrator can assign, and a status so an
// account can be suspended without deleting it or its history.
ensureColumn('users', 'username', "username TEXT DEFAULT ''");
ensureColumn('users', 'status', "status TEXT DEFAULT 'active'");
ensureColumn('users', 'last_login_at', "last_login_at TEXT DEFAULT ''");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE username <> ''");
// Approval workflow: the stage a record is in, who submitted it, when it has to be
// approved by, and a timeline of every decision taken on it.
ensureColumn('inspections', 'review_status', "review_status TEXT DEFAULT ''");
ensureColumn('inspections', 'submitted_by', "submitted_by TEXT DEFAULT ''");
ensureColumn('inspections', 'deadline', "deadline TEXT DEFAULT ''");
ensureColumn('inspections', 'history_json', "history_json TEXT NOT NULL DEFAULT '[]'");
// Sessions are ended rather than deleted, so an administrator can still see who was
// signed in, from which device, and how each session ended. session_id is a public
// handle for a session; the token is a secret that only ever travels as the cookie.
ensureColumn('sessions', 'session_id', "session_id TEXT DEFAULT ''");
ensureColumn('sessions', 'ip', "ip TEXT DEFAULT ''");
ensureColumn('sessions', 'user_agent', "user_agent TEXT DEFAULT ''");
ensureColumn('sessions', 'last_seen_at', "last_seen_at TEXT DEFAULT ''");
ensureColumn('sessions', 'ended_at', "ended_at TEXT DEFAULT ''");
ensureColumn('sessions', 'end_reason', "end_reason TEXT DEFAULT ''");
db.prepare("SELECT token FROM sessions WHERE session_id IS NULL OR session_id = ''").all()
  .forEach(r => db.prepare('UPDATE sessions SET session_id = ? WHERE token = ?').run(crypto.randomBytes(8).toString('hex'), r.token));
// Activity log: the role and login session each action was taken in.
ensureColumn('audit_log', 'actor_role', "actor_role TEXT DEFAULT ''");
ensureColumn('audit_log', 'session_id', "session_id TEXT DEFAULT ''");
ensureColumn('audit_log', 'ip', "ip TEXT DEFAULT ''");
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_sessions_session_id ON sessions(session_id);
  CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_log(session_id);
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
`);

// --- Evidence media rules ---------------------------------------------------------
const MEDIA_LIMITS = {
  maxPerItem: 3,
  image: { maxBytes: 5 * 1024 * 1024, mimes: ['image/png', 'image/jpeg', 'image/webp', 'image/heic'] },
  video: { maxBytes: 20 * 1024 * 1024, mimes: ['video/mp4', 'video/webm', 'video/quicktime'] }
};
function kindForMime(mime) {
  if (MEDIA_LIMITS.image.mimes.includes(mime)) return 'image';
  if (MEDIA_LIMITS.video.mimes.includes(mime)) return 'video';
  return null;
}

// --- Equipment quantity rule (item 4) -------------------------------------------
// Simplified, NFPA 10-style rule, documented on the Standards page: 1 portable fire
// extinguisher per 10 tables, minimum 2 per venue. Kept as one editable constant so
// the numbers can be tuned without touching query logic.
const EXTINGUISHER_PER_TABLES = 10;
const EXTINGUISHER_MIN = 2;
function requiredExtinguishers(tablesCount) {
  return Math.max(EXTINGUISHER_MIN, Math.ceil((tablesCount || 0) / EXTINGUISHER_PER_TABLES));
}

function equipmentStatus(expiryDate) {
  if (!expiryDate) return 'normal';
  const days = Math.floor((new Date(expiryDate).getTime() - Date.now()) / 86400000);
  if (Number.isNaN(days)) return 'normal';
  if (days < 0) return 'expired';
  if (days <= 30) return 'expiring_soon';
  return 'normal';
}

function genId(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 9000 + 1000)}`;
}

// --- Auth: password hashing (Node's built-in crypto, no external dependency) ----
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const check = crypto.scryptSync(password, salt, 64);
  const stored = Buffer.from(hash, 'hex');
  return check.length === stored.length && crypto.timingSafeEqual(check, stored);
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id, name: row.name, email: row.email, role: row.role,
    username: row.username || '', status: row.status || 'active',
    branch: row.branch || '',
    // Sent so the UI can hide what this user cannot do. The UI hiding it is a
    // convenience; the server re-checks every write regardless (see assertCan).
    capabilities: capabilitiesFor(row.role)
  };
}

// --- Access control ---------------------------------------------------------------
// Two independent layers, both enforced here on the server:
//   1. Data scope — which venues a user may see at all      (visibleVenueIds)
//   2. Capability — what a user may do with them            (can / assertCan)
// Hiding a button in the browser is not access control, so every read is filtered
// and every write is re-checked below. A logged-in inspector crafting a request by
// hand still cannot close an alert or reset the system.
const BRANCHES = ['BKK-CENTRAL', 'BKK-EAST', 'BKK-NORTH'];

// Exactly five roles. `user` is restaurant staff who fill in the checklists; the former
// Safety Officer role was merged into Inspector.
const ROLES = ['user', 'inspector', 'supervisor', 'manager', 'admin'];
const ROLE_LABELS = { user: 'User', inspector: 'Inspector', supervisor: 'Supervisor', manager: 'Manager', admin: 'Administrator' };

const ALL_CAPABILITIES = [
  'inspection.submit', 'inspection.review', 'inspection.approve', 'staff.notify',
  'alert.acknowledge', 'alert.escalate', 'alert.close', 'action.update', 'alert.simulate',
  'feedback.submit', 'feedback.read',
  'user.manage', 'role.manage', 'data.correct', 'venue.manage', 'equipment.manage',
  'security.view', 'activity.view', 'session.manage', 'system.backup', 'system.reset'
];

// Defaults only. The live matrix is stored in role_permissions so an administrator can
// change it; "restore defaults" and a demo reset write these values back.
const DEFAULT_CAPABILITIES = {
  user:       ['inspection.submit', 'alert.acknowledge', 'feedback.submit'],
  inspector:  ['inspection.submit', 'inspection.review', 'staff.notify', 'alert.acknowledge',
               'alert.escalate', 'action.update', 'alert.simulate', 'feedback.submit'],
  supervisor: ['inspection.approve', 'staff.notify', 'alert.acknowledge', 'alert.escalate',
               'alert.close', 'action.update', 'alert.simulate', 'feedback.submit'],
  // Checks data and reads reports only.
  manager:    ['feedback.submit'],
  // Runs the system but takes no part in approving inspections, so no single account
  // can both correct a record and sign it off.
  admin:      ['alert.acknowledge', 'alert.escalate', 'alert.close', 'action.update', 'alert.simulate',
               'feedback.submit', 'feedback.read', 'user.manage', 'role.manage', 'data.correct',
               'venue.manage', 'equipment.manage', 'security.view', 'activity.view', 'session.manage',
               'system.backup', 'system.reset']
};
const CAPABILITIES = DEFAULT_CAPABILITIES;
// Taking these away from administrators would lock everyone out of the screens
// needed to give them back.
const LOCKED_ADMIN_CAPABILITIES = ['user.manage', 'role.manage'];
const ADMIN_AREA_CAPABILITIES = ['user.manage', 'role.manage', 'data.correct', 'venue.manage', 'equipment.manage', 'security.view', 'activity.view', 'session.manage', 'system.backup'];

let permissionCache = null;

function writeDefaultPermissions() {
  db.exec('DELETE FROM role_permissions');
  const insert = db.prepare('INSERT INTO role_permissions (role, capability) VALUES (?,?)');
  Object.entries(DEFAULT_CAPABILITIES).forEach(([role, caps]) => caps.forEach(cap => insert.run(role, cap)));
  permissionCache = null;
}

// Read on every request (through getSessionUser), so a permission change takes effect
// immediately for everyone already signed in.
function capabilitiesFor(role) {
  if (!ROLES.includes(role)) return [];
  if (!permissionCache) {
    permissionCache = Object.fromEntries(ROLES.map(r => [r, []]));
    db.prepare('SELECT role, capability FROM role_permissions').all().forEach(r => {
      if (permissionCache[r.role] && ALL_CAPABILITIES.includes(r.capability)) permissionCache[r.role].push(r.capability);
    });
    ROLES.forEach(r => permissionCache[r].sort((a, b) => ALL_CAPABILITIES.indexOf(a) - ALL_CAPABILITIES.indexOf(b)));
  }
  return [...permissionCache[role]];
}
function can(user, capability) { return !!user && capabilitiesFor(user.role).includes(capability); }

if (db.prepare('SELECT COUNT(*) AS n FROM role_permissions').get().n === 0) writeDefaultPermissions();

// A capability added in a later version would otherwise be missing from a database whose
// permissions were saved earlier — administrators could never see the new screens. New
// capabilities are granted to the roles that have them by default, once; after that the
// administrator's own choices stand. Before this list was tracked, the two session
// capabilities were the only ones that did not exist yet.
(function grantNewCapabilities() {
  const stored = db.prepare("SELECT value FROM app_meta WHERE key = 'known_capabilities'").get();
  const known = stored ? JSON.parse(stored.value) : ALL_CAPABILITIES.filter(c => c !== 'activity.view' && c !== 'session.manage');
  const added = ALL_CAPABILITIES.filter(c => !known.includes(c));
  const grant = db.prepare('INSERT OR IGNORE INTO role_permissions (role, capability) VALUES (?,?)');
  added.forEach(cap => ROLES.filter(r => DEFAULT_CAPABILITIES[r].includes(cap)).forEach(r => grant.run(r, cap)));
  db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('known_capabilities', ?)").run(JSON.stringify(ALL_CAPABILITIES));
  if (added.length) permissionCache = null;
})();

function httpError(status, code, message) { const err = new Error(message); err.code = code; err.status = status; return err; }
function forbidden(code, message) { return httpError(403, code, message); }

function assertCan(user, capability) {
  if (!can(user, capability)) throw forbidden('err.forbidden', 'บทบาทของคุณไม่มีสิทธิ์ดำเนินการนี้');
}

// Returns null for "no restriction" (manager/admin), otherwise an explicit id list.
function visibleVenueIds(user) {
  if (!user) return [];
  if (user.role === 'manager' || user.role === 'admin') return null;
  if (user.role === 'supervisor') {
    return db.prepare('SELECT id FROM venues WHERE branch = ?').all(user.branch || '').map(r => r.id);
  }
  return db.prepare('SELECT venue_id FROM venue_assignments WHERE user_id = ?').all(user.id).map(r => r.venue_id);
}

function assertVenueVisible(user, venueId) {
  const ids = visibleVenueIds(user);
  if (ids === null) return;
  if (!ids.includes(venueId)) throw forbidden('err.venueForbidden', 'คุณไม่มีสิทธิ์เข้าถึงสถานประกอบการนี้');
}

function assignVenues(userId, venueIds) {
  const stmt = db.prepare('INSERT OR IGNORE INTO venue_assignments (user_id, venue_id) VALUES (?,?)');
  (venueIds || []).forEach(id => stmt.run(userId, id));
}

// --- Seed data -------------------------------------------------------------------
function isEmpty() {
  const row = db.prepare('SELECT COUNT(*) AS n FROM venues').get();
  return row.n === 0;
}

function isUsersEmpty() {
  const row = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  return row.n === 0;
}

// Demo accounts get deliberately different scopes, so logging in as each one shows a
// visibly different amount of data — that difference is the point of the demo.
// One account per role. The list doubles as a guard: these accounts are shared by every
// grader and tester, so an administrator cannot delete, suspend or re-role them.
const DEMO_ACCOUNTS = [
  { name: 'มานี มีสุข', email: 'staff@safecheck.demo', username: 'staff', role: 'user', branch: 'BKK-CENTRAL', venues: ['VEN-001'] },
  { name: 'กิตติยา พรหมดี', email: 'inspector@safecheck.demo', username: 'inspector', role: 'inspector', branch: 'BKK-CENTRAL', venues: ['VEN-001', 'VEN-004'] },
  { name: 'ธนา โชติวัฒน์', email: 'supervisor@safecheck.demo', username: 'supervisor', role: 'supervisor', branch: 'BKK-CENTRAL', venues: [] },
  { name: 'ณัฐภัทร แสงสันต์', email: 'manager@safecheck.demo', username: 'manager', role: 'manager', branch: 'BKK-CENTRAL', venues: [] },
  { name: 'ผู้ดูแลระบบ', email: 'admin@safecheck.demo', username: 'admin', role: 'admin', branch: 'BKK-CENTRAL', venues: [] }
];
const DEMO_EMAILS = DEMO_ACCOUNTS.map(a => a.email);

function seedUsers() {
  const insUser = db.prepare('INSERT INTO users (id, name, email, username, password_hash, password_salt, role, created_at, branch, status) VALUES (?,?,?,?,?,?,?,?,?,?)');
  DEMO_ACCOUNTS.forEach(acc => {
    const { hash, salt } = hashPassword('Demo1234!');
    const id = genId('USR');
    insUser.run(id, acc.name, acc.email, acc.username, hash, salt, acc.role, new Date().toISOString(), acc.branch, 'active');
    assignVenues(id, acc.venues);
  });
}

function seed() {
  const venues = [
    { id: 'VEN-001', name: 'Riverlight Bistro', type: 'Restaurant', location: 'เขตปทุมวัน กรุงเทพฯ', locationEn: 'Pathum Wan, Bangkok', branch: 'BKK-CENTRAL', tables: 24, last: '2026-08-14T10:20:00' },
    { id: 'VEN-002', name: 'Blue Moon Bar', type: 'Bar & Pub', location: 'เขตวัฒนา กรุงเทพฯ', locationEn: 'Watthana, Bangkok', branch: 'BKK-EAST', tables: 14, last: '2026-08-11T16:40:00' },
    { id: 'VEN-003', name: 'Neon Hall Entertainment', type: 'Entertainment', location: 'เขตห้วยขวาง กรุงเทพฯ', locationEn: 'Huai Khwang, Bangkok', branch: 'BKK-EAST', tables: 40, last: '2026-08-06T13:10:00' },
    { id: 'VEN-004', name: 'Garden Table', type: 'Restaurant', location: 'เขตสาทร กรุงเทพฯ', locationEn: 'Sathon, Bangkok', branch: 'BKK-CENTRAL', tables: 10, last: null },
    { id: 'VEN-005', name: 'Old Town Pub', type: 'Bar & Pub', location: 'เขตพระนคร กรุงเทพฯ', locationEn: 'Phra Nakhon, Bangkok', branch: 'BKK-NORTH', tables: 8, last: '2026-07-29T11:15:00' },
    { id: 'VEN-006', name: 'Skyline Club', type: 'Entertainment', location: 'เขตราชเทวี กรุงเทพฯ', locationEn: 'Ratchathewi, Bangkok', branch: 'BKK-CENTRAL', tables: 30, last: '2026-07-25T09:30:00' }
  ];
  const insVenue = db.prepare('INSERT INTO venues (id, name, type, location, location_en, branch, tables_count, last_inspected_date) VALUES (?,?,?,?,?,?,?,?)');
  venues.forEach(v => insVenue.run(v.id, v.name, v.type, v.location, v.locationEn, v.branch, v.tables, v.last));

  // Daily / Monthly / Yearly checklist templates — separate cadences (item 6), each
  // item tagged with an evidence rule (item 8): required_on_fail | required_always |
  // optional | none.
  // [frequency, code, title_th, desc_th, title_en, desc_en, sort_order, evidence_rule]
  const items = [
    // Daily — quick visual checks, evidence only needed when something's wrong
    ['daily', 'DLY-01', 'ทางออกฉุกเฉิน/ทางเดินหนีไฟไม่มีสิ่งกีดขวาง', 'ตรวจด้วยสายตาว่าเส้นทางอพยพโล่งตลอดแนว ไม่มีสิ่งของวางกีดขวาง', 'Emergency exits and fire escape routes are clear', 'Visually confirm the evacuation route is clear along its full length', 1, 'required_on_fail'],
    ['daily', 'DLY-02', 'ถังดับเพลิงมองเห็นชัดเจนและเข้าถึงได้ทันที', 'ไม่มีสิ่งของวางบังหรือปิดกั้นถังดับเพลิง', 'Fire extinguishers are visible and immediately accessible', 'Nothing is placed in front of or obscuring the extinguishers', 2, 'required_on_fail'],
    ['daily', 'DLY-03', 'ไฟฉุกเฉิน/ไฟส่องทางหนีไฟติดใช้งานได้', 'ทดสอบเปิดไฟฉุกเฉินเบื้องต้นหรือสังเกตไฟแสดงสถานะ', 'Emergency and escape-route lighting is working', 'Test the emergency lights or check their status indicators', 3, 'required_on_fail'],
    ['daily', 'DLY-04', 'ป้ายทางออกฉุกเฉินมองเห็นชัดและมีไฟส่องสว่าง', 'ป้ายไม่ถูกบดบัง ตัวอักษร/สัญลักษณ์ยังชัดเจน', 'Emergency exit signs are visible and illuminated', 'Signs are unobscured and the text/symbols remain legible', 4, 'required_on_fail'],
    ['daily', 'DLY-05', 'ไม่พบความเสี่ยงอัคคีภัยชัดเจนในครัว/บาร์', 'เช่น สายไฟชำรุด ท่อแก๊สรั่ว วัสดุไวไฟวางใกล้ความร้อน', 'No obvious fire hazard in the kitchen or bar', 'e.g. damaged wiring, gas leaks, flammable material near heat', 5, 'required_on_fail'],
    // Monthly — functional tests, some produce paper logs rather than photos
    ['monthly', 'MON-01', 'ทดสอบสัญญาณแจ้งเหตุเพลิงไหม้ (Fire Alarm Test)', 'กดทดสอบปุ่มแจ้งเหตุ/ฟังเสียงสัญญาณให้ครบทุกโซน', 'Fire alarm test performed', 'Press the test call point and confirm the sounder works in every zone', 1, 'optional'],
    ['monthly', 'MON-02', 'เกจวัดแรงดันถังดับเพลิงอยู่ในช่วงสีเขียว', 'ตรวจทุกถังในพื้นที่ ไม่มีถังที่เข็มตกอยู่โซนแดง', 'Extinguisher pressure gauges are in the green range', 'Check every extinguisher; none has a needle in the red zone', 2, 'required_on_fail'],
    ['monthly', 'MON-03', 'หัวกระจายน้ำดับเพลิง (Sprinkler) ไม่ถูกปิดบัง/ชำรุด', 'ตรวจสอบว่าไม่มีสิ่งของวางใกล้จนบังหัวฉีดน้ำ', 'Sprinkler heads are unobstructed and undamaged', 'Confirm nothing is stored close enough to obstruct the spray head', 3, 'required_on_fail'],
    ['monthly', 'MON-04', 'ทดสอบไฟฉุกเฉินสำรองแบตเตอรี่ของป้ายทางออก', 'ตัดไฟหลักชั่วครู่เพื่อยืนยันว่าป้าย/ไฟฉุกเฉินสลับมาใช้แบตเตอรี่ได้', 'Exit sign battery backup tested', 'Briefly cut mains power to confirm signs switch to battery', 4, 'optional'],
    ['monthly', 'MON-05', 'ปรับปรุงบันทึกซ้อมอพยพ/แผนอพยพประจำเดือน', 'มีการทบทวนแผนหรือบันทึกซ้อมอพยพให้เป็นปัจจุบัน', 'Evacuation plan / drill records updated this month', 'The evacuation plan has been reviewed or a drill has been logged', 5, 'none'],
    ['monthly', 'MON-06', 'พนักงานได้รับการทบทวนความรู้ด้านอัคคีภัย', 'มีการบรีฟพนักงานสั้น ๆ เรื่องจุดรวมพลและหน้าที่เบื้องต้น', 'Staff refreshed on fire safety knowledge', 'A short briefing on assembly points and basic responsibilities', 6, 'none'],
    // Yearly — certified/professional inspections, always need documentary evidence
    ['yearly', 'YRL-01', 'ใบรับรองการตรวจสภาพถังดับเพลิงจากผู้เชี่ยวชาญ', 'ถังดับเพลิงทุกถังผ่านการตรวจและมีใบรับรองปีล่าสุด', 'Certified extinguisher inspection certificate', 'Every extinguisher has passed inspection with a current certificate', 1, 'required_always'],
    ['yearly', 'YRL-02', 'ใบรับรองการตรวจระบบสัญญาณแจ้งเหตุเพลิงไหม้', 'ระบบสัญญาณและเครื่องตรวจจับควันผ่านการตรวจโดยผู้เชี่ยวชาญ', 'Certified fire alarm system inspection', 'The alarm system and smoke detectors were inspected by a specialist', 2, 'required_always'],
    ['yearly', 'YRL-03', 'ใบรับรองการทดสอบระบบสปริงเกลอร์', 'ระบบหัวกระจายน้ำผ่านการทดสอบแรงดัน/การทำงานประจำปี', 'Certified sprinkler system test', 'The sprinkler system passed its annual pressure/function test', 3, 'required_always'],
    ['yearly', 'YRL-04', 'ใบรับรองความปลอดภัยระบบไฟฟ้า (Electrical Safety)', 'ระบบไฟฟ้าในอาคารผ่านการตรวจสอบความปลอดภัยประจำปี', 'Electrical safety certificate', 'The building electrical system passed its annual safety inspection', 4, 'required_always'],
    ['yearly', 'YRL-05', 'เอกสาร/กรมธรรม์รับรองการปฏิบัติตามข้อกำหนดยังไม่หมดอายุ', 'ใบอนุญาต/กรมธรรม์ที่เกี่ยวข้องกับความปลอดภัยอัคคีภัยยังมีผล', 'Compliance documents / insurance still valid', 'Fire-safety related licences and policies remain in force', 5, 'required_always']
  ];
  const insItem = db.prepare('INSERT INTO checklist_items (id, frequency, code, title, description, title_en, description_en, sort_order, evidence_requirement) VALUES (?,?,?,?,?,?,?,?,?)');
  items.forEach(([frequency, code, title, description, titleEn, descEn, sort, evidence]) => insItem.run(`CHK-${code}`, frequency, code, title, description, titleEn, descEn, sort, evidence));

  // Seed inspections — items_json mirrors the checklist item shape the frontend uses.
  const dailyItems = items.filter(i => i[0] === 'daily');
  const buildItems = (rows, resultFor) => rows.map(([, code, title, , titleEn, , , evidence]) => ({
    id: code, title, titleEn, evidenceRequirement: evidence,
    result: resultFor(code), note: '', media: [], actionStatus: ''
  }));
  const insInspection = db.prepare('INSERT INTO inspections (id, venue_id, frequency, inspector_name, role, date, status, score, overall_note, items_json, review_status, submitted_by, deadline, history_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');

  const seedInspections = [
    { id: 'INS-2026-0007', venueId: 'VEN-001', frequency: 'daily', inspector: 'กิตติยา พรหมดี', role: 'Inspector', date: '2026-08-14T10:20:00', overallNote: 'ระบบโดยรวมอยู่ในเกณฑ์ดี ควรปรับปรุงไฟฉุกเฉินบริเวณทางออกด้านหลัง', items: buildItems(dailyItems, code => code === 'DLY-03' ? 'fail' : 'pass'), failNote: { 'DLY-03': 'ไฟฉุกเฉินหนึ่งจุดไม่ทำงาน' } },
    { id: 'INS-2026-0006', venueId: 'VEN-002', frequency: 'daily', inspector: 'สมชาย รักษ์ดี', role: 'Inspector', date: '2026-08-11T16:40:00', overallNote: 'พบสิ่งกีดขวางทางหนีไฟ', items: buildItems(dailyItems, code => code === 'DLY-01' ? 'fail' : 'pass'), failNote: { 'DLY-01': 'มีกล่องวางขวางประตูฉุกเฉิน' } },
    { id: 'INS-2026-0005', venueId: 'VEN-003', frequency: 'monthly', inspector: 'ธนา โชติวัฒน์', role: 'Supervisor', date: '2026-08-06T13:10:00', overallNote: 'ต้องติดตามหลายรายการก่อนอนุมัติผล', items: buildItems(items.filter(i => i[0] === 'monthly'), code => ['MON-02', 'MON-03'].includes(code) ? 'fail' : 'pass'), failNote: { 'MON-02': 'เข็มเกจตกโซนแดง 1 ถัง', 'MON-03': 'มีลังสินค้าวางบังหัวสปริงเกลอร์' } }
  ];
  seedInspections.forEach(ins => {
    const items = ins.items.map(item => ({ ...item, note: ins.failNote?.[item.id] || '', actionStatus: item.result === 'fail' ? 'open' : '' }));
    const score = Math.round((items.filter(i => i.result === 'pass').length / items.filter(i => i.result !== 'na').length) * 100);
    // Historic records are already signed off by the supervisor two hours after they
    // were submitted, so the history screen has a complete timeline to show. Whether
    // that was late is computed, not asserted.
    const submittedAt = new Date(ins.date).toISOString();
    const approvedAt = new Date(new Date(ins.date).getTime() + 2 * 3600000).toISOString();
    const deadline = Workflow.approvalDeadline(submittedAt, ins.frequency) || '';
    const history = [
      { action: 'submitted', at: submittedAt, byId: '', byName: ins.inspector, role: 'inspector' },
      { action: 'approved', at: approvedAt, byId: '', byName: 'ธนา โชติวัฒน์', role: 'supervisor', note: '', late: !!deadline && approvedAt > deadline }
    ];
    insInspection.run(ins.id, ins.venueId, ins.frequency, ins.inspector, ins.role, ins.date, 'submitted', score, ins.overallNote, JSON.stringify(items),
      'approved', '', deadline, JSON.stringify(history));
  });

  // ai_alerts — real Gregorian ISO timestamps so th-TH formatting (+543) is only
  // applied once by the frontend, unlike the earlier demo's double-converted dates.
  // zone_index / staff_index / variant_index point into the i18n content arrays so the
  // alert sentence can be rendered in whichever language the viewer has selected.
  const insAlert = db.prepare('INSERT INTO ai_alerts (id, venue_id, anomaly_type, level, confidence, created_at, status, acknowledged_at, escalated_at, closed_at, variant_index, obstruction_pct, zone_index, staff_index) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const alerts = [
    { id: 'ALT-2026-014', venueId: 'VEN-001', zoneIdx: 0, type: 'obstruction', variant: 0, pct: 62, level: 'danger', confidence: 92, createdAt: '2026-08-16T20:14:00', status: 'closed', staffIdx: 1, ack: '2026-08-16T20:16:00', esc: '', closed: '2026-08-16T20:22:00' },
    { id: 'ALT-2026-013', venueId: 'VEN-002', zoneIdx: 3, type: 'exit_sign_blocked', variant: 0, pct: null, level: 'caution', confidence: 84, createdAt: '2026-08-14T19:40:00', status: 'closed', staffIdx: 0, ack: '2026-08-14T19:44:00', esc: '', closed: '2026-08-14T19:50:00' },
    { id: 'ALT-2026-012', venueId: 'VEN-003', zoneIdx: 2, type: 'obstruction', variant: 1, pct: 78, level: 'danger', confidence: 95, createdAt: '2026-08-10T22:05:00', status: 'escalated', staffIdx: 2, ack: '', esc: '2026-08-10T22:06:00', closed: '' }
  ];
  alerts.forEach(a => insAlert.run(a.id, a.venueId, a.type, a.level, a.confidence, a.createdAt, a.status, a.ack, a.esc, a.closed, a.variant, a.pct, a.zoneIdx, a.staffIdx));

  // equipment — deliberately includes a shortfall venue (VEN-001, has 2 of 3
  // required extinguishers), an expired one (VEN-002), and an expiring-soon one
  // (VEN-003), so the demo has something to show on first load.
  const insEq = db.prepare('INSERT INTO equipment (id, venue_id, type, label, label_en, install_date, expiry_date, photo) VALUES (?,?,?,?,?,?,?,?)');
  const equipment = [
    ['EQ-001', 'VEN-001', 'fire_extinguisher', 'ถังดับเพลิง A1 (ทางเข้าหลัก)', 'Extinguisher A1 (main entrance)', '2023-01-10', '2026-09-05', ''],
    ['EQ-002', 'VEN-001', 'fire_extinguisher', 'ถังดับเพลิง A2 (ใกล้ครัว)', 'Extinguisher A2 (near kitchen)', '2024-02-01', '2027-02-01', ''],
    ['EQ-003', 'VEN-001', 'smoke_detector', 'เครื่องตรวจจับควัน ครัว', 'Smoke detector (kitchen)', '2023-01-10', '2027-01-10', ''],
    ['EQ-004', 'VEN-002', 'fire_extinguisher', 'ถังดับเพลิง B1', 'Extinguisher B1', '2022-05-01', '2025-05-01', ''],
    ['EQ-005', 'VEN-002', 'fire_extinguisher', 'ถังดับเพลิง B2', 'Extinguisher B2', '2024-06-01', '2027-06-01', ''],
    ['EQ-006', 'VEN-003', 'fire_extinguisher', 'ถังดับเพลิง C1', 'Extinguisher C1', '2024-01-01', '2027-01-01', ''],
    ['EQ-007', 'VEN-003', 'fire_extinguisher', 'ถังดับเพลิง C2', 'Extinguisher C2', '2023-09-10', '2026-09-10', ''],
    ['EQ-008', 'VEN-003', 'fire_extinguisher', 'ถังดับเพลิง C3', 'Extinguisher C3', '2024-03-01', '2027-03-01', ''],
    ['EQ-009', 'VEN-004', 'fire_extinguisher', 'ถังดับเพลิง D1', 'Extinguisher D1', '2024-04-01', '2027-04-01', ''],
    ['EQ-010', 'VEN-004', 'fire_extinguisher', 'ถังดับเพลิง D2', 'Extinguisher D2', '2024-04-01', '2027-04-01', ''],
    ['EQ-011', 'VEN-005', 'fire_extinguisher', 'ถังดับเพลิง E1', 'Extinguisher E1', '2024-05-01', '2027-05-01', ''],
    ['EQ-012', 'VEN-005', 'fire_extinguisher', 'ถังดับเพลิง E2', 'Extinguisher E2', '2024-05-01', '2027-05-01', ''],
    ['EQ-013', 'VEN-006', 'fire_extinguisher', 'ถังดับเพลิง F1', 'Extinguisher F1', '2024-06-01', '2027-06-01', ''],
    ['EQ-014', 'VEN-006', 'fire_extinguisher', 'ถังดับเพลิง F2', 'Extinguisher F2', '2024-06-01', '2027-06-01', ''],
    ['EQ-015', 'VEN-006', 'fire_extinguisher', 'ถังดับเพลิง F3', 'Extinguisher F3', '2024-06-01', '2027-06-01', '']
  ];
  equipment.forEach(row => insEq.run(...row));
}

if (isEmpty()) seed();
if (isUsersEmpty()) seedUsers();

// One-time backfill for a safecheck.db created before venue scoping existed. Without
// it, ensureColumn would put every venue in the default branch and leave the demo
// accounts with no assignments at all — i.e. everyone logging in to an empty
// dashboard. Runs only when there are users but no assignments yet, so it never
// overwrites scopes on a database that already has them.
function backfillScopes() {
  const hasUsers = db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
  const hasAssignments = db.prepare('SELECT COUNT(*) AS n FROM venue_assignments').get().n > 0;
  if (!hasUsers || hasAssignments) return;

  const venueBranch = {
    'VEN-001': 'BKK-CENTRAL', 'VEN-002': 'BKK-EAST', 'VEN-003': 'BKK-EAST',
    'VEN-004': 'BKK-CENTRAL', 'VEN-005': 'BKK-NORTH', 'VEN-006': 'BKK-CENTRAL'
  };
  const setVenueBranch = db.prepare('UPDATE venues SET branch = ? WHERE id = ?');
  Object.entries(venueBranch).forEach(([id, branch]) => setVenueBranch.run(branch, id));

  const userScope = {
    'inspector@safecheck.demo': { branch: 'BKK-CENTRAL', venues: ['VEN-001', 'VEN-004'] },
    'safety@safecheck.demo': { branch: 'BKK-EAST', venues: ['VEN-001', 'VEN-002', 'VEN-003'] },
    'supervisor@safecheck.demo': { branch: 'BKK-CENTRAL', venues: [] },
    'manager@safecheck.demo': { branch: 'BKK-CENTRAL', venues: [] },
    'admin@safecheck.demo': { branch: 'BKK-CENTRAL', venues: [] }
  };
  const setUserBranch = db.prepare('UPDATE users SET branch = ? WHERE id = ?');
  db.prepare('SELECT id, email, role FROM users').all().forEach(u => {
    const scope = userScope[u.email];
    if (scope) {
      setUserBranch.run(scope.branch, u.id);
      assignVenues(u.id, scope.venues);
      return;
    }
    // An account signed up before scoping existed keeps its branch and inherits the
    // venues of that branch, matching what signup does now.
    const branch = db.prepare('SELECT branch FROM users WHERE id = ?').get(u.id).branch || BRANCHES[0];
    if (u.role === 'inspector' || u.role === 'safety' || u.role === 'user') {
      assignVenues(u.id, db.prepare('SELECT id FROM venues WHERE branch = ?').all(branch).map(r => r.id));
    }
  });
}
backfillScopes();

// --- Read helpers ------------------------------------------------------------
function iconFor(name) { return (name || '?').trim().charAt(0).toUpperCase(); }

function allVenues() {
  return db.prepare('SELECT * FROM venues ORDER BY name').all().map(v => ({
    id: v.id, name: v.name, type: v.type, location: v.location, locationEn: v.location_en || v.location,
    branch: v.branch || '', tablesCount: v.tables_count, lastInspectedDate: v.last_inspected_date, icon: iconFor(v.name)
  }));
}

// Every read below is filtered by the caller's scope, so an out-of-scope venue is
// never sent to the browser at all — it is not merely hidden after the fact.
function getVenues(user) {
  const ids = visibleVenueIds(user);
  const list = allVenues();
  return ids === null ? list : list.filter(v => ids.includes(v.id));
}

function getChecklistItems() {
  const rows = db.prepare('SELECT * FROM checklist_items ORDER BY frequency, sort_order').all();
  const grouped = { daily: [], monthly: [], yearly: [] };
  rows.forEach(r => grouped[r.frequency]?.push({
    id: r.code, title: r.title, titleEn: r.title_en || r.title,
    desc: r.description, descEn: r.description_en || r.description,
    evidenceRequirement: r.evidence_requirement
  }));
  return grouped;
}

function getInspections(user) {
  const venues = new Map(allVenues().map(v => [v.id, v]));
  const ids = visibleVenueIds(user);
  return db.prepare('SELECT * FROM inspections ORDER BY date DESC').all()
    .filter(r => ids === null || ids.includes(r.venue_id))
    .map(r => {
    const venue = venues.get(r.venue_id);
    return {
      id: r.id, venueId: r.venue_id, venueName: venue?.name || r.venue_id, venueLocation: venue?.location || '',
      frequency: r.frequency, inspector: r.inspector_name, role: r.role, date: r.date, status: r.status,
      score: r.score, overallNote: r.overall_note, items: JSON.parse(r.items_json),
      reviewStatus: r.review_status || '', submittedBy: r.submitted_by || '', deadline: r.deadline || '',
      history: JSON.parse(r.history_json || '[]')
    };
  });
}

function getAlerts(user) {
  const venues = new Map(allVenues().map(v => [v.id, v]));
  const ids = visibleVenueIds(user);
  return db.prepare('SELECT * FROM ai_alerts ORDER BY created_at DESC').all()
    .filter(r => ids === null || ids.includes(r.venue_id))
    .map(r => ({
    id: r.id, venueId: r.venue_id, venue: venues.get(r.venue_id)?.name || r.venue_id,
    anomalyType: r.anomaly_type, level: r.level, confidence: r.confidence,
    variantIndex: r.variant_index || 0, obstructionPct: r.obstruction_pct,
    zoneIndex: r.zone_index || 0, staffIndex: r.staff_index || 0,
    createdAt: r.created_at, status: r.status,
    acknowledgedAt: r.acknowledged_at, escalatedAt: r.escalated_at, closedAt: r.closed_at
  }));
}

function getEquipment(user) {
  const venues = new Map(allVenues().map(v => [v.id, v]));
  const ids = visibleVenueIds(user);
  return db.prepare('SELECT * FROM equipment ORDER BY venue_id, type').all()
    .filter(r => ids === null || ids.includes(r.venue_id))
    .map(r => ({
    id: r.id, venueId: r.venue_id, venueName: venues.get(r.venue_id)?.name || r.venue_id, type: r.type,
    label: r.label, labelEn: r.label_en || r.label,
    installDate: r.install_date, expiryDate: r.expiry_date, photo: r.photo,
    status: equipmentStatus(r.expiry_date)
  }));
}

function getEquipmentCompliance(user) {
  const venues = getVenues(user);
  const equipment = getEquipment(user);
  return venues.map(v => {
    const current = equipment.filter(e => e.venueId === v.id && e.type === 'fire_extinguisher').length;
    const required = requiredExtinguishers(v.tablesCount);
    return { venueId: v.id, venueName: v.name, tablesCount: v.tablesCount, current, required, shortfall: Math.max(0, required - current) };
  });
}

async function bootstrap(user) {
  const venues = getVenues(user);
  const ids = visibleVenueIds(user);
  return {
    venues,
    inspections: getInspections(user),
    aiAlerts: getAlerts(user),
    equipment: getEquipment(user),
    equipmentCompliance: getEquipmentCompliance(user),
    checklistItems: getChecklistItems(),
    // Lets the UI explain *why* it is showing a subset and grey out actions this role
    // cannot perform — without the UI ever being the thing that enforces it.
    feedbackCount: await feedbackCount(),
    feedback: can(user, 'feedback.read') ? await getFeedback(user) : null,
    feedbackBackend: feedbackBackend(),
    notifications: getNotifications(user),
    adminSummary: ADMIN_AREA_CAPABILITIES.some(c => can(user, c)) ? adminSummary() : null,
    roles: ROLES,
    serverTime: new Date().toISOString(),
    scope: {
      role: user.role,
      branch: user.branch || '',
      capabilities: capabilitiesFor(user.role),
      venueCount: venues.length,
      totalVenueCount: allVenues().length,
      unrestricted: ids === null
    },
    equipmentRule: { perTables: EXTINGUISHER_PER_TABLES, minimum: EXTINGUISHER_MIN },
    mediaLimits: {
      maxPerItem: MEDIA_LIMITS.maxPerItem,
      imageMaxBytes: MEDIA_LIMITS.image.maxBytes,
      videoMaxBytes: MEDIA_LIMITS.video.maxBytes,
      accept: [...MEDIA_LIMITS.image.mimes, ...MEDIA_LIMITS.video.mimes].join(',')
    }
  };
}

// --- Evidence media ---------------------------------------------------------------
function addMedia({ mime, filename, bytes }, user) {
  assertCan(user, 'inspection.submit');
  const kind = kindForMime(mime);
  if (!kind) throw new Error('รองรับเฉพาะไฟล์ภาพ (JPG/PNG/WEBP) และวิดีโอ (MP4/WEBM/MOV)');
  const limit = MEDIA_LIMITS[kind].maxBytes;
  if (!bytes || !bytes.length) throw new Error('ไฟล์ว่างเปล่า');
  if (bytes.length > limit) throw new Error(`ไฟล์ใหญ่เกินกำหนด (สูงสุด ${Math.round(limit / 1024 / 1024)} MB)`);
  const id = genId('MED');
  db.prepare('INSERT INTO media (id, inspection_id, item_id, kind, mime, filename, size, bytes, created_at, uploaded_by) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, null, null, kind, mime, filename || '', bytes.length, bytes, new Date().toISOString(), user.id);
  audit(user, 'media.upload', id, `${kind} · ${filename || ''}`);
  return { id, kind, mime, name: filename || '', size: bytes.length };
}

// Evidence photos can show the inside of a venue, so they are scoped like any other
// venue data. An upload not yet attached to a saved inspection is readable only by
// the person who uploaded it.
function assertMediaVisible(row, user) {
  if (row.inspection_id) {
    const ins = db.prepare('SELECT venue_id FROM inspections WHERE id = ?').get(row.inspection_id);
    if (ins) assertVenueVisible(user, ins.venue_id);
    return;
  }
  if (row.uploaded_by && row.uploaded_by !== user.id) {
    throw forbidden('err.mediaForbidden', 'คุณไม่มีสิทธิ์เข้าถึงไฟล์นี้');
  }
}

function getMedia(id, user) {
  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(id);
  if (!row) return null;
  assertMediaVisible(row, user);
  return { id: row.id, kind: row.kind, mime: row.mime, name: row.filename, size: row.size, bytes: row.bytes };
}

// Internal, unchecked removal used by linkMediaToInspection when tidying up files the
// inspector attached and then removed before submitting.
function removeMediaRow(id) {
  db.prepare('DELETE FROM media WHERE id = ?').run(id);
}

function deleteMedia(id, user) {
  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(id);
  if (!row) return;
  assertMediaVisible(row, user);
  removeMediaRow(id);
  audit(user, 'media.delete', id, row.filename || '');
}

// Ties uploaded media to the inspection once it is saved, and clears out anything
// the inspector attached then removed before submitting.
function linkMediaToInspection(ins) {
  const keep = [];
  (ins.items || []).forEach(item => (item.media || []).forEach(m => keep.push({ id: m.id, itemId: item.id })));
  const link = db.prepare('UPDATE media SET inspection_id = ?, item_id = ? WHERE id = ?');
  keep.forEach(m => link.run(ins.id, m.itemId, m.id));
  const stale = db.prepare('SELECT id FROM media WHERE inspection_id = ?').all(ins.id)
    .filter(r => !keep.some(k => k.id === r.id));
  stale.forEach(r => removeMediaRow(r.id));
}

// --- Write operations ----------------------------------------------------------
function saveInspection(ins, user) {
  assertCan(user, 'inspection.submit');
  assertVenueVisible(user, ins.venueId);
  // The per-item media cap is enforced here as well as in the UI — a crafted
  // request must not be able to attach unlimited evidence files.
  (ins.items || []).forEach(item => {
    if ((item.media || []).length > MEDIA_LIMITS.maxPerItem) {
      throw new Error(`แนบไฟล์ได้สูงสุด ${MEDIA_LIMITS.maxPerItem} ไฟล์ต่อหนึ่งรายการตรวจ`);
    }
  });
  if (!ins.id || typeof ins.id !== 'string') throw new Error('ไม่มีรหัสรายการตรวจ');
  if (!['daily', 'monthly', 'yearly'].includes(ins.frequency)) throw new Error('รอบการตรวจไม่ถูกต้อง');
  const existing = db.prepare('SELECT * FROM inspections WHERE id = ?').get(ins.id);
  let history = [];
  if (existing) {
    // A record belongs to whoever made it, and can only change while it is still
    // theirs to change: a draft, or one a reviewer sent back. Anything already in the
    // approval chain is fixed through data correction instead, which is audited.
    if (existing.submitted_by !== user.id) {
      throw forbidden('err.notOwner', 'แก้ไขได้เฉพาะรายการที่คุณเป็นผู้บันทึกเท่านั้น');
    }
    if (existing.status !== 'draft' && existing.review_status !== 'rejected') {
      throw httpError(409, 'err.notEditable', 'รายการนี้ส่งเข้าสู่ขั้นตอนอนุมัติแล้ว จึงแก้ไขไม่ได้');
    }
    assertVenueVisible(user, existing.venue_id);
    history = JSON.parse(existing.history_json || '[]');
  }
  const items = Array.isArray(ins.items) ? ins.items : [];
  const status = ins.status === 'submitted' ? 'submitted' : 'draft';
  // Recomputed here rather than trusted from the browser.
  const score = Core.calculateScore(items);
  const now = new Date().toISOString();
  let reviewStatus = '';
  let deadline = '';
  if (status === 'submitted') {
    reviewStatus = Workflow.initialStage(user.role);
    // Server time, not the browser's, so a submitter cannot move their own deadline.
    deadline = Workflow.approvalDeadline(now, ins.frequency) || '';
    history.push({
      action: existing && existing.review_status === 'rejected' ? 'resubmitted' : 'submitted',
      at: now, byId: user.id, byName: user.name, role: user.role
    });
  }
  const values = [ins.venueId, ins.frequency, user.name, ROLE_LABELS[user.role] || user.role, ins.date || now, status, score,
    String(ins.overallNote || '').slice(0, 2000), JSON.stringify(items), reviewStatus, user.id, deadline, JSON.stringify(history)];
  if (existing) {
    db.prepare('UPDATE inspections SET venue_id=?, frequency=?, inspector_name=?, role=?, date=?, status=?, score=?, overall_note=?, items_json=?, review_status=?, submitted_by=?, deadline=?, history_json=? WHERE id=?')
      .run(...values, ins.id);
  } else {
    db.prepare('INSERT INTO inspections (venue_id, frequency, inspector_name, role, date, status, score, overall_note, items_json, review_status, submitted_by, deadline, history_json, id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(...values, ins.id);
  }
  linkMediaToInspection(ins);
  if (status === 'submitted') {
    db.prepare('UPDATE venues SET last_inspected_date = ? WHERE id = ? AND (last_inspected_date IS NULL OR last_inspected_date < ?)')
      .run(ins.date || now, ins.venueId, ins.date || now);
    notifyNextReviewers(ins.id);
  }
  const venue = venueRow(ins.venueId);
  const saveAction = status === 'draft' ? 'inspection.draft' : (existing && existing.review_status === 'rejected' ? 'inspection.resubmit' : 'inspection.submit');
  audit(user, saveAction, ins.id, `${venue ? venue.name : ins.venueId} · ${ins.frequency} · ${score}`);
  return { id: ins.id, status, reviewStatus, deadline, score };
}

function updateActionStatus(inspectionId, itemId, actionStatus, user) {
  assertCan(user, 'action.update');
  const row = db.prepare('SELECT venue_id, items_json FROM inspections WHERE id = ?').get(inspectionId);
  if (!row) throw new Error('ไม่พบรายการตรวจนี้');
  assertVenueVisible(user, row.venue_id);
  const items = JSON.parse(row.items_json).map(item => item.id === itemId ? { ...item, actionStatus } : item);
  db.prepare('UPDATE inspections SET items_json = ? WHERE id = ?').run(JSON.stringify(items), inspectionId);
  audit(user, 'action.update', `${inspectionId}/${itemId}`, actionStatus);
}

// --- Approval workflow -------------------------------------------------------------
function venueRow(venueId) { return db.prepare('SELECT * FROM venues WHERE id = ?').get(venueId); }

// Who acts next on a record: Inspectors responsible for the venue, or Supervisors of the
// venue's branch. Suspended accounts are skipped.
function reviewersFor(stage, venueId) {
  if (stage === 'pending_review') {
    return db.prepare("SELECT users.id FROM users JOIN venue_assignments va ON va.user_id = users.id WHERE va.venue_id = ? AND users.role = 'inspector' AND users.status = 'active'")
      .all(venueId).map(r => r.id);
  }
  if (stage === 'pending_approval') {
    const venue = venueRow(venueId);
    return db.prepare("SELECT id FROM users WHERE role = 'supervisor' AND status = 'active' AND branch = ?")
      .all(venue ? venue.branch : '').map(r => r.id);
  }
  return [];
}

function staffForVenue(venueId) {
  return db.prepare("SELECT users.id FROM users JOIN venue_assignments va ON va.user_id = users.id WHERE va.venue_id = ? AND users.role = 'user' AND users.status = 'active'")
    .all(venueId).map(r => r.id);
}

// Notifications store a kind plus parameters rather than a sentence, so the browser
// can word them in whichever language the reader has chosen.
function addNotification(userId, kind, params, fromName, inspectionId) {
  if (!userId) return;
  db.prepare('INSERT INTO notifications (id, user_id, kind, params_json, inspection_id, from_name, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(genId('NTF'), userId, kind, JSON.stringify(params || {}), inspectionId || '', fromName || '', new Date().toISOString());
}

function notificationParams(row, extra) {
  const venue = venueRow(row.venue_id);
  return { venueName: venue ? venue.name : row.venue_id, frequency: row.frequency, deadline: row.deadline, ...extra };
}

function notifyNextReviewers(inspectionId) {
  const row = db.prepare('SELECT * FROM inspections WHERE id = ?').get(inspectionId);
  if (!row) return;
  const kind = row.review_status === 'pending_review' ? 'inspection.awaitingReview' : 'inspection.awaitingApproval';
  reviewersFor(row.review_status, row.venue_id)
    .filter(id => id !== row.submitted_by)
    .forEach(id => addNotification(id, kind, notificationParams(row, { byName: row.inspector_name }), row.inspector_name, row.id));
}

// step 'review' is the Inspector's check, step 'approve' the Supervisor's sign-off.
function decideInspection(id, step, body, user) {
  if (step !== 'review' && step !== 'approve') throw new Error('ขั้นตอนไม่ถูกต้อง');
  assertCan(user, step === 'review' ? 'inspection.review' : 'inspection.approve');
  const row = db.prepare('SELECT * FROM inspections WHERE id = ?').get(id);
  if (!row) throw httpError(404, 'err.notFound', 'ไม่พบรายการตรวจนี้');
  assertVenueVisible(user, row.venue_id);
  const decision = body && body.decision;
  if (decision !== 'approve' && decision !== 'reject') throw httpError(400, 'err.decisionRequired', 'กรุณาเลือกอนุมัติหรือปฏิเสธ');
  const note = String((body && body.note) || '').trim().slice(0, 1000);
  // A rejection with no reason leaves the submitter guessing what to fix.
  if (decision === 'reject' && !note) throw httpError(400, 'err.reasonRequired', 'กรุณาระบุเหตุผลที่ปฏิเสธ เพื่อให้ผู้ส่งแก้ไขได้ถูกต้อง');
  if (row.submitted_by && row.submitted_by === user.id) {
    throw forbidden('err.ownRecord', 'ไม่สามารถตรวจสอบหรืออนุมัติรายการที่ตัวเองเป็นผู้ส่งได้');
  }
  const next = Workflow.nextStage(row.review_status, step, decision);
  if (!next) throw httpError(409, 'err.wrongStage', 'รายการนี้ไม่ได้อยู่ในขั้นตอนที่คุณดำเนินการได้');

  const now = new Date().toISOString();
  const late = step === 'approve' && !!row.deadline && now > row.deadline;
  const action = decision === 'reject' ? 'rejected' : (step === 'review' ? 'reviewed' : 'approved');
  const history = JSON.parse(row.history_json || '[]');
  history.push({ action, at: now, byId: user.id, byName: user.name, role: user.role, note, late });
  db.prepare('UPDATE inspections SET review_status = ?, history_json = ? WHERE id = ?').run(next, JSON.stringify(history), id);
  audit(user, `inspection.${action}`, id, note);

  const params = notificationParams({ ...row, review_status: next }, { byName: user.name, note, late });
  if (decision === 'reject') {
    addNotification(row.submitted_by, 'inspection.rejected', params, user.name, id);
  } else if (step === 'review') {
    addNotification(row.submitted_by, 'inspection.forwarded', params, user.name, id);
    notifyNextReviewers(id);
  } else {
    addNotification(row.submitted_by, 'inspection.approved', params, user.name, id);
  }
  return { id, reviewStatus: next, late };
}

function getNotifications(user) {
  return db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 40').all(user.id).map(r => ({
    id: r.id, kind: r.kind, params: JSON.parse(r.params_json || '{}'), inspectionId: r.inspection_id,
    fromName: r.from_name, createdAt: r.created_at, read: !!r.read_at
  }));
}

function markNotificationsRead(user, ids) {
  const now = new Date().toISOString();
  if (Array.isArray(ids) && ids.length) {
    const stmt = db.prepare("UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at = ''");
    ids.slice(0, 200).forEach(id => stmt.run(now, String(id), user.id));
  } else {
    db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at = ''").run(now, user.id);
  }
  return { unread: db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at = ''").get(user.id).n };
}

// Inspectors and Supervisors can message staff, either about one record (it goes to
// whoever submitted it) or about a venue (it goes to every staff account working there).
function notifyStaff(body, user) {
  assertCan(user, 'staff.notify');
  body = body || {};
  const message = String(body.message || '').trim().slice(0, 500);
  if (!message) throw httpError(400, 'err.messageRequired', 'กรุณาพิมพ์ข้อความที่จะแจ้งพนักงาน');
  let venueId = body.venueId;
  let recipients;
  if (body.inspectionId) {
    const row = db.prepare('SELECT * FROM inspections WHERE id = ?').get(body.inspectionId);
    if (!row) throw httpError(404, 'err.notFound', 'ไม่พบรายการตรวจนี้');
    assertVenueVisible(user, row.venue_id);
    venueId = row.venue_id;
    recipients = row.submitted_by ? [row.submitted_by] : [];
  } else {
    if (!venueId || !venueRow(venueId)) throw httpError(400, 'err.venueRequired', 'กรุณาเลือกสถานที่');
    assertVenueVisible(user, venueId);
    recipients = staffForVenue(venueId);
  }
  recipients = recipients.filter(id => id !== user.id);
  if (!recipients.length) throw httpError(400, 'err.noRecipients', 'ไม่พบพนักงานที่จะรับการแจ้งเตือนนี้');
  const venue = venueRow(venueId);
  recipients.forEach(id => addNotification(id, 'staff.message', { message, venueName: venue ? venue.name : venueId }, user.name, body.inspectionId || ''));
  audit(user, 'staff.notify', venueId, `${recipients.length}: ${message}`);
  return { sent: recipients.length };
}

function createAlert(alert, user) {
  assertCan(user, 'alert.simulate');
  assertVenueVisible(user, alert.venueId);
  const id = genId('ALT');
  db.prepare('INSERT INTO ai_alerts (id, venue_id, anomaly_type, level, confidence, created_at, status, acknowledged_at, escalated_at, closed_at, variant_index, obstruction_pct, zone_index, staff_index) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, alert.venueId, alert.anomalyType, alert.level, alert.confidence, new Date().toISOString(), 'notified', '', '', '',
      alert.variantIndex || 0, alert.obstructionPct ?? null, alert.zoneIndex || 0, alert.staffIndex || 0);
  audit(user, 'alert.create', id, `${alert.venueId} · ${alert.anomalyType} · ${alert.level}`);
  return getAlerts(user).find(a => a.id === id);
}

// Which capability a given alert transition needs. This is the requirement that an
// employee acknowledges but only a supervisor/manager may close, expressed in code.
const ALERT_STATUS_CAPABILITY = {
  acknowledged: 'alert.acknowledge',
  escalated: 'alert.escalate',
  closed: 'alert.close'
};

function updateAlert(id, patch, user) {
  const existing = db.prepare('SELECT * FROM ai_alerts WHERE id = ?').get(id);
  if (!existing) throw new Error('ไม่พบรายการแจ้งเตือนนี้');
  assertVenueVisible(user, existing.venue_id);
  const needed = ALERT_STATUS_CAPABILITY[patch.status];
  if (needed) assertCan(user, needed);
  const next = {
    status: patch.status ?? existing.status,
    acknowledged_at: patch.acknowledgedAt ?? existing.acknowledged_at,
    escalated_at: patch.escalatedAt ?? existing.escalated_at,
    closed_at: patch.closedAt ?? existing.closed_at
  };
  db.prepare('UPDATE ai_alerts SET status=?, acknowledged_at=?, escalated_at=?, closed_at=? WHERE id=?')
    .run(next.status, next.acknowledged_at, next.escalated_at, next.closed_at, id);
  if (patch.status && patch.status !== existing.status) audit(user, 'alert.' + patch.status, id, existing.venue_id);
}

const EQUIPMENT_TYPES = ['fire_extinguisher', 'smoke_detector', 'exit_sign', 'sprinkler_head', 'emergency_light'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertEquipmentDates(values) {
  ['installDate', 'expiryDate'].forEach(key => {
    if (values[key] && !ISO_DATE.test(values[key])) throw new Error('รูปแบบวันที่ไม่ถูกต้อง (ปปปป-ดด-วว)');
  });
}

function updateEquipment(id, patch, user) {
  assertCan(user, 'equipment.manage');
  patch = patch || {};
  const existing = db.prepare('SELECT * FROM equipment WHERE id = ?').get(id);
  if (!existing) throw new Error('ไม่พบอุปกรณ์นี้');
  assertVenueVisible(user, existing.venue_id);
  if (patch.type !== undefined && !EQUIPMENT_TYPES.includes(patch.type)) throw new Error('ประเภทอุปกรณ์ไม่ถูกต้อง');
  assertEquipmentDates(patch);
  const labelChanged = patch.label !== undefined;
  const label = labelChanged ? String(patch.label).trim().slice(0, 120) : existing.label;
  if (!label) throw new Error('กรุณาระบุชื่ออุปกรณ์');
  db.prepare('UPDATE equipment SET type = ?, label = ?, label_en = ?, install_date = ?, expiry_date = ?, photo = ? WHERE id = ?')
    .run(patch.type ?? existing.type, label, labelChanged ? label : existing.label_en,
      patch.installDate ?? existing.install_date, patch.expiryDate ?? existing.expiry_date, patch.photo ?? existing.photo, id);
  if (labelChanged || patch.type !== undefined || patch.installDate !== undefined) audit(user, 'equipment.update', id, label);
}

function addEquipment(eq, user) {
  assertCan(user, 'equipment.manage');
  eq = eq || {};
  assertVenueVisible(user, eq.venueId);
  if (!venueRow(eq.venueId)) throw new Error('ไม่พบสถานที่นี้');
  if (!EQUIPMENT_TYPES.includes(eq.type)) throw new Error('ประเภทอุปกรณ์ไม่ถูกต้อง');
  const label = String(eq.label || '').trim().slice(0, 120);
  if (!label) throw new Error('กรุณาระบุชื่ออุปกรณ์');
  assertEquipmentDates(eq);
  const id = genId('EQ');
  db.prepare('INSERT INTO equipment (id, venue_id, type, label, label_en, install_date, expiry_date, photo) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, eq.venueId, eq.type, label, eq.labelEn || label, eq.installDate || '', eq.expiryDate || '', eq.photo || '');
  audit(user, 'equipment.create', id, label);
  return getEquipment(user).find(e => e.id === id);
}

function deleteEquipment(id, user) {
  assertCan(user, 'equipment.manage');
  const existing = db.prepare('SELECT * FROM equipment WHERE id = ?').get(id);
  if (!existing) throw httpError(404, 'err.notFound', 'ไม่พบอุปกรณ์นี้');
  assertVenueVisible(user, existing.venue_id);
  db.prepare('DELETE FROM equipment WHERE id = ?').run(id);
  audit(user, 'equipment.delete', id, existing.label);
}

// resetAll() only wipes demo *data* (venues/inspections/alerts/equipment) — it
// deliberately never touches users/sessions, so resetting the demo can't delete
// accounts or log anyone out.
function resetAll(user) {
  assertCan(user, 'system.reset');
  // venue_assignments references venues(id), so those rows must be lifted out of the
  // way and put back. Simply deleting them would silently strip every field user's
  // scope, and leaving them in place trips the foreign key on DELETE FROM venues.
  // seed() recreates the venues under their original ids, so the mapping still holds.
  // uat_feedback is deliberately absent from the delete list below: resetting demo
  // data must never destroy real responses collected from testers.
  const savedAssignments = db.prepare('SELECT user_id, venue_id FROM venue_assignments').all();
  db.exec('DELETE FROM venue_assignments; DELETE FROM media; DELETE FROM notifications; DELETE FROM inspections; DELETE FROM ai_alerts; DELETE FROM equipment; DELETE FROM checklist_items; DELETE FROM venues;');
  seed();
  const liveVenues = new Set(db.prepare('SELECT id FROM venues').all().map(r => r.id));
  const restore = db.prepare('INSERT OR IGNORE INTO venue_assignments (user_id, venue_id) VALUES (?,?)');
  savedAssignments.filter(r => liveVenues.has(r.venue_id)).forEach(r => restore.run(r.user_id, r.venue_id));
  // A tester who experimented with the permission matrix must not leave the shared demo
  // broken for the next person. Login and audit logs and stored backups are kept.
  writeDefaultPermissions();
  seedWorkflowDemo();
  audit(user, 'system.reset', '', '');
}

// --- User Acceptance Test feedback ------------------------------------------------
// UAT responses are the one kind of data in this system that cannot be recreated: if
// they are lost, real people have to be asked to test all over again. Render's free
// tier has no persistent disk, so the SQLite file is rebuilt from seed whenever the
// instance restarts — which was observed happening in under an hour. Responses
// therefore go to PostgreSQL when DATABASE_URL is configured.
//
// Two backends behind one interface:
//   DATABASE_URL set    -> PostgreSQL (durable; used in production)
//   DATABASE_URL unset  -> SQLite     (used locally and by the test suite)
//
// `pg` is required lazily inside the Postgres branch only, so a machine with no
// node_modules can still run the whole system exactly as before.
const PG_URL = process.env.DATABASE_URL || '';
const USE_PG = !!PG_URL;

let pgPool = null;
let pgReady = null;

function getPool() {
  if (!pgPool) {
    const { Pool } = require('pg');
    pgPool = new Pool({
      connectionString: PG_URL,
      // Full certificate verification, confirmed working against Neon. Passing an
      // ssl object here also overrides whatever sslmode= happens to be in the URL,
      // so the transport cannot be silently downgraded by editing the connection
      // string.
      ssl: true,
      max: 3,
      idleTimeoutMillis: 30000
    });
  }
  return pgPool;
}

// Creates the table once per process, not once per query.
function ensureFeedbackSchema() {
  if (!pgReady) {
    pgReady = getPool().query(`
      CREATE TABLE IF NOT EXISTS uat_feedback (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        tester_name TEXT NOT NULL,
        role_used TEXT,
        device TEXT,
        scenarios_json TEXT NOT NULL DEFAULT '[]',
        ease_rating INTEGER,
        usefulness TEXT,
        confusing TEXT,
        missing TEXT,
        acceptance TEXT,
        acceptance_note TEXT,
        created_at TEXT NOT NULL
      )
    `).catch(err => { pgReady = null; throw err; });
  }
  return pgReady;
}

function feedbackRow(r) {
  return {
    id: r.id, testerName: r.tester_name, roleUsed: r.role_used, device: r.device,
    scenarios: JSON.parse(r.scenarios_json || '[]'), easeRating: r.ease_rating,
    usefulness: r.usefulness, confusing: r.confusing, missing: r.missing,
    acceptance: r.acceptance, acceptanceNote: r.acceptance_note, createdAt: r.created_at
  };
}

async function addFeedback(body, user) {
  assertCan(user, 'feedback.submit');
  const name = (body.testerName || '').trim();
  if (!name) throw new Error('กรุณากรอกชื่อผู้ทดสอบ');
  const values = [
    genId('UAT'), user.id, name.slice(0, 120), user.role, (body.device || '').slice(0, 40),
    JSON.stringify(Array.isArray(body.scenarios) ? body.scenarios : []),
    Number(body.easeRating) || null, (body.usefulness || '').slice(0, 40),
    (body.confusing || '').slice(0, 2000), (body.missing || '').slice(0, 2000),
    (body.acceptance || '').slice(0, 40), (body.acceptanceNote || '').slice(0, 2000),
    new Date().toISOString()
  ];
  const columns = '(id, user_id, tester_name, role_used, device, scenarios_json, ease_rating, usefulness, confusing, missing, acceptance, acceptance_note, created_at)';
  if (USE_PG) {
    await ensureFeedbackSchema();
    await getPool().query('INSERT INTO uat_feedback ' + columns + ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)', values);
  } else {
    db.prepare('INSERT INTO uat_feedback ' + columns + ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...values);
  }
  audit(user, 'feedback.submit', values[0], values[2]);
  return { id: values[0], storedIn: USE_PG ? 'postgres' : 'sqlite' };
}

async function getFeedback(user) {
  assertCan(user, 'feedback.read');
  if (USE_PG) {
    await ensureFeedbackSchema();
    const res = await getPool().query('SELECT * FROM uat_feedback ORDER BY created_at DESC');
    return res.rows.map(feedbackRow);
  }
  return db.prepare('SELECT * FROM uat_feedback ORDER BY created_at DESC').all().map(feedbackRow);
}

// The count is visible to every signed-in user so a tester can confirm their own
// submission landed, without being able to read anyone else's answers.
async function feedbackCount() {
  if (USE_PG) {
    try {
      await ensureFeedbackSchema();
      const res = await getPool().query('SELECT COUNT(*) AS n FROM uat_feedback');
      return Number(res.rows[0].n);
    } catch (err) {
      // A database hiccup must not take down the whole dashboard, which is what
      // returning a count from bootstrap would otherwise do.
      console.error('feedbackCount failed:', err.message);
      return 0;
    }
  }
  return db.prepare('SELECT COUNT(*) AS n FROM uat_feedback').get().n;
}

// Reports which backend is actually in use, so the UI can say so honestly rather
// than the deployment silently falling back to a store that loses data.
function feedbackBackend() {
  return USE_PG ? 'postgres' : 'sqlite';
}

// --- Auth operations -------------------------------------------------------------
// Auth errors carry a stable `code` as well as a Thai fallback message, so the
// bilingual frontend can translate them instead of always showing Thai.
function authError(code, message) { const err = new Error(message); err.code = code; return err; }

const ALLOWED_ROLES = ROLES;
// Public self-registration only ever creates restaurant staff (`user`). Every other role
// is given by an administrator — otherwise anyone hitting the public signup endpoint
// could grant themselves inspector or administrator rights, which is privilege
// escalation regardless of what the signup form happens to offer.
const SELF_SIGNUP_ROLES = ['user'];

function createUser({ name, email, password, role, branch }) {
  name = (name || '').trim();
  email = (email || '').trim().toLowerCase();
  if (!name) throw authError('err.nameRequired', 'กรุณากรอกชื่อ');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw authError('err.invalidEmail', 'รูปแบบอีเมลไม่ถูกต้อง');
  if (!password || password.length < 6) throw authError('err.weakPassword', 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร');
  role = role || 'user';
  if (!SELF_SIGNUP_ROLES.includes(role)) throw authError('err.roleNotAllowed', 'บทบาทนี้ต้องให้ผู้ดูแลระบบเป็นผู้กำหนดให้เท่านั้น');
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) throw authError('err.emailTaken', 'มีบัญชีที่ใช้อีเมลนี้อยู่แล้ว');
  // An unknown branch falls back to the first rather than erroring — the branch only
  // decides which venues you start with, so it is not worth failing a signup over.
  const safeBranch = BRANCHES.includes(branch) ? branch : BRANCHES[0];
  const { hash, salt } = hashPassword(password);
  const id = genId('USR');
  db.prepare('INSERT INTO users (id, name, email, password_hash, password_salt, role, created_at, branch) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, name, email, hash, salt, role, new Date().toISOString(), safeBranch);
  // A new field account becomes responsible for the venues of the branch it joined.
  // Without this a new inspector would log in to a completely empty dashboard.
  assignVenues(id, db.prepare('SELECT id FROM venues WHERE branch = ?').all(safeBranch).map(r => r.id));
  audit({ id, name, role }, 'user.signup', maskEmail(email), safeBranch);
  return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
}

function verifyLogin(identifier, password) {
  const key = String(identifier || '').trim().toLowerCase();
  // An administrator may give an account a username; anything containing @ is an email.
  const row = key.includes('@')
    ? db.prepare('SELECT * FROM users WHERE email = ?').get(key)
    : (key ? db.prepare("SELECT * FROM users WHERE username = ? AND username <> ''").get(key) : null);
  // Same error for "no such account" and "wrong password" — telling an attacker
  // which accounts exist is free reconnaissance (user enumeration).
  if (!row || !verifyPassword(String(password || ''), row.password_hash, row.password_salt)) {
    throw authError('err.invalidCredentials', 'อีเมล/ชื่อผู้ใช้ หรือรหัสผ่านไม่ถูกต้อง');
  }
  // Checked only after the password, so an account's status is never revealed to
  // someone who does not already know its password.
  if (row.status === 'suspended') {
    const err = authError('err.accountSuspended', 'บัญชีนี้ถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ');
    err.status = 403;
    err.userId = row.id;
    throw err;
  }
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
  return publicUser(row);
}

// --- Sessions ------------------------------------------------------------------------
// A session ends when the person logs out, after SESSION_IDLE_MINUTES without any
// request, 7 days after login, when an administrator revokes it, or when the account is
// suspended or its password changes. An open, visible tab keeps its session alive
// because the app checks for updates every minute.
const SESSION_IDLE_MS = (Number(process.env.SESSION_IDLE_MINUTES) || 120) * 60 * 1000;
const LAST_SEEN_WRITE_MS = 60 * 1000;   // one write a minute is plenty for "last active"
const SESSION_HISTORY_MS = 30 * 24 * 60 * 60 * 1000;

function describeDevice(userAgent) {
  const ua = String(userAgent || '');
  if (!ua) return '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : /node|undici|curl/i.test(ua) ? 'Script' : 'Browser';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Macintosh|Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} · ${os}` : browser;
}

function createSession(user, meta = {}) {
  const userId = typeof user === 'string' ? user : user.id;
  const token = crypto.randomBytes(32).toString('hex');
  const sessionId = crypto.randomBytes(8).toString('hex');
  const now = new Date();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at, session_id, ip, user_agent, last_seen_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(token, userId, now.toISOString(), new Date(now.getTime() + SESSION_TTL_MS).toISOString(), sessionId,
      String(meta.ip || '').slice(0, 80), String(meta.userAgent || '').slice(0, 300), now.toISOString());
  // Ended sessions are kept as history for 30 days.
  const cutoff = new Date(now.getTime() - SESSION_HISTORY_MS).toISOString();
  db.prepare("DELETE FROM sessions WHERE (ended_at <> '' AND ended_at < ?) OR expires_at < ?").run(cutoff, cutoff);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (row) audit({ id: row.id, name: row.name, role: row.role, sessionId, ip: meta.ip }, 'session.login', maskEmail(row.email), describeDevice(meta.userAgent));
  return token;
}

function getSessionUser(token) {
  if (!token) return null;
  const row = db.prepare(`SELECT sessions.expires_at AS s_expires_at, sessions.session_id AS s_session_id, sessions.created_at AS s_created_at,
      sessions.last_seen_at AS s_last_seen_at, sessions.ended_at AS s_ended_at, sessions.ip AS s_ip, users.*
    FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token = ?`).get(token);
  if (!row || row.s_ended_at) return null;
  const now = Date.now();
  const end = reason => {
    db.prepare("UPDATE sessions SET ended_at = ?, end_reason = ? WHERE token = ? AND ended_at = ''").run(new Date(now).toISOString(), reason, token);
    return null;
  };
  if (new Date(row.s_expires_at).getTime() < now) return end('expired');
  const lastSeen = new Date(row.s_last_seen_at || row.s_created_at).getTime();
  if (now - lastSeen > SESSION_IDLE_MS) return end('idle');
  // Suspension takes effect on the very next request, not when the session expires.
  if (row.status === 'suspended') return end('suspended');
  if (now - lastSeen > LAST_SEEN_WRITE_MS) db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token = ?').run(new Date(now).toISOString(), token);
  const user = publicUser(row);
  user.sessionId = row.s_session_id;
  // Kept off the JSON sent to the browser, but available for the activity log.
  Object.defineProperty(user, 'ip', { value: row.s_ip, enumerable: false });
  return user;
}

// Logging out ends the session; the row stays as history.
function deleteSession(token) {
  if (!token) return;
  const user = getSessionUser(token);
  db.prepare("UPDATE sessions SET ended_at = ?, end_reason = 'logout' WHERE token = ? AND ended_at = ''").run(new Date().toISOString(), token);
  if (user) audit(user, 'session.logout', '', '');
}

function endUserSessions(userId, reason) {
  db.prepare("UPDATE sessions SET ended_at = ?, end_reason = ? WHERE user_id = ? AND ended_at = ''").run(new Date().toISOString(), reason, userId);
}

// Sessions that went idle or expired without another request are closed off here, with
// the time they actually ended, so lists never show someone as signed in who is not.
function sweepSessions() {
  const now = Date.now();
  db.prepare("SELECT token, created_at, expires_at, last_seen_at FROM sessions WHERE ended_at = ''").all().forEach(r => {
    const expires = new Date(r.expires_at).getTime();
    const lastSeen = new Date(r.last_seen_at || r.created_at).getTime();
    if (expires < now) {
      db.prepare("UPDATE sessions SET ended_at = ?, end_reason = 'expired' WHERE token = ?").run(new Date(expires).toISOString(), r.token);
    } else if (now - lastSeen > SESSION_IDLE_MS) {
      db.prepare("UPDATE sessions SET ended_at = ?, end_reason = 'idle' WHERE token = ?").run(new Date(lastSeen + SESSION_IDLE_MS).toISOString(), r.token);
    }
  });
}

const SESSION_SELECT = 'SELECT sessions.*, users.name AS user_name, users.role AS user_role, users.email AS user_email FROM sessions JOIN users ON users.id = sessions.user_id';

// Never includes the token.
function sessionView(row, currentSessionId) {
  return {
    sessionId: row.session_id, userId: row.user_id, userName: row.user_name, role: row.user_role,
    device: describeDevice(row.user_agent), ip: maskIp(row.ip), startedAt: row.created_at,
    lastSeenAt: row.last_seen_at || row.created_at, endedAt: row.ended_at || '', endReason: row.end_reason || '',
    current: !!currentSessionId && row.session_id === currentSessionId
  };
}

const idleMinutes = () => Math.round(SESSION_IDLE_MS / 60000);

function listMySessions(user) {
  sweepSessions();
  const sessions = db.prepare(`${SESSION_SELECT} WHERE sessions.user_id = ? AND sessions.ended_at = '' ORDER BY sessions.last_seen_at DESC`)
    .all(user.id).map(r => sessionView(r, user.sessionId));
  return { sessions, idleMinutes: idleMinutes() };
}

function endMySession(user, sessionId) {
  const row = db.prepare("SELECT * FROM sessions WHERE session_id = ? AND user_id = ? AND ended_at = ''").get(String(sessionId), user.id);
  if (!row) throw httpError(404, 'err.sessionNotFound', 'ไม่พบเซสชันนี้ หรือสิ้นสุดไปแล้ว');
  if (row.session_id === user.sessionId) throw httpError(400, 'err.revokeOwn', 'ถ้าต้องการออกจากเซสชันนี้ ให้ใช้เมนูออกจากระบบ');
  db.prepare("UPDATE sessions SET ended_at = ?, end_reason = 'signed_out_elsewhere' WHERE token = ?").run(new Date().toISOString(), row.token);
  audit(user, 'session.end_other', row.session_id, describeDevice(row.user_agent));
}

function endOtherSessions(user) {
  const result = db.prepare("UPDATE sessions SET ended_at = ?, end_reason = 'signed_out_elsewhere' WHERE user_id = ? AND session_id <> ? AND ended_at = ''")
    .run(new Date().toISOString(), user.id, user.sessionId || '');
  if (result.changes) audit(user, 'session.end_other', 'all', String(result.changes));
  return { ended: Number(result.changes) };
}

function listSessions(actor) {
  assertCan(actor, 'activity.view');
  sweepSessions();
  const active = db.prepare(`${SESSION_SELECT} WHERE sessions.ended_at = '' ORDER BY sessions.last_seen_at DESC LIMIT 200`).all().map(r => sessionView(r, actor.sessionId));
  const recent = db.prepare(`${SESSION_SELECT} WHERE sessions.ended_at <> '' ORDER BY sessions.ended_at DESC LIMIT 50`).all().map(r => sessionView(r, actor.sessionId));
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60000).toISOString();
  return {
    active, recent, idleMinutes: idleMinutes(),
    summary: { active: active.length, onlineNow: active.filter(s => s.lastSeenAt >= fiveMinutesAgo).length, users: new Set(active.map(s => s.userId)).size }
  };
}

function revokeSession(sessionId, actor) {
  assertCan(actor, 'session.manage');
  const row = db.prepare(`${SESSION_SELECT} WHERE sessions.session_id = ? AND sessions.ended_at = ''`).get(String(sessionId));
  if (!row) throw httpError(404, 'err.sessionNotFound', 'ไม่พบเซสชันนี้ หรือสิ้นสุดไปแล้ว');
  if (row.session_id === actor.sessionId) throw httpError(400, 'err.revokeOwn', 'ถ้าต้องการออกจากเซสชันของตัวเอง ให้ใช้เมนูออกจากระบบ');
  db.prepare("UPDATE sessions SET ended_at = ?, end_reason = 'revoked' WHERE token = ?").run(new Date().toISOString(), row.token);
  audit(actor, 'session.revoke', maskEmail(row.user_email), `${row.user_name} · ${describeDevice(row.user_agent)}`);
}

// --- Activity log ----------------------------------------------------------------------
// Everything a person does while signed in is written through audit(); page views come
// from the browser. These are fixed SQL fragments, never built from request input.
const ACTIVITY_CATEGORY_SQL = {
  session: "action LIKE 'session.%'",
  inspection: "(action LIKE 'inspection.%' OR action LIKE 'media.%' OR action IN ('data.correct', 'staff.notify', 'action.update'))",
  alert: "action LIKE 'alert.%'",
  admin: "(action LIKE 'user.%' OR action LIKE 'role.%' OR action LIKE 'venue.%' OR action LIKE 'equipment.%' OR action LIKE 'system.%')",
  page: "action = 'page.view'",
  other: "action LIKE 'feedback.%'"
};
const TRACKED_VIEWS = ['dashboard', 'venues', 'inspection', 'result', 'approvals', 'history', 'actions', 'ai-monitor',
  'alerts', 'sensors', 'equipment', 'standards', 'testing', 'feedback', 'report', 'admin'];

function recordPageView(user, view) {
  if (!TRACKED_VIEWS.includes(view)) throw httpError(400, 'err.unknownView', 'ไม่รู้จักหน้านี้');
  const last = db.prepare("SELECT target, created_at FROM audit_log WHERE session_id = ? AND action = 'page.view' ORDER BY id DESC LIMIT 1").get(user.sessionId || '');
  // Opening the same page again within half a minute is one visit, not several.
  if (last && last.target === view && Date.now() - new Date(last.created_at).getTime() < 30000) return { recorded: false };
  audit(user, 'page.view', view, '');
  db.prepare("DELETE FROM audit_log WHERE action = 'page.view' AND id <= (SELECT MAX(id) FROM audit_log) - 20000").run();
  return { recorded: true };
}

function getActivity(actor, query = {}) {
  assertCan(actor, 'activity.view');
  const hours = [24, 168, 720].includes(Number(query.hours)) ? Number(query.hours) : 168;
  const where = ['created_at >= ?'];
  const args = [new Date(Date.now() - hours * 3600000).toISOString()];
  if (query.userId) { where.push('actor_id = ?'); args.push(String(query.userId)); }
  if (query.sessionId) { where.push('session_id = ?'); args.push(String(query.sessionId)); }
  if (ACTIVITY_CATEGORY_SQL[query.category]) where.push(ACTIVITY_CATEGORY_SQL[query.category]);
  if (query.hidePages === '1') where.push("action <> 'page.view'");
  if (query.q) {
    where.push('(actor_name LIKE ? OR action LIKE ? OR target LIKE ? OR detail LIKE ?)');
    const like = '%' + String(query.q).slice(0, 80) + '%';
    args.push(like, like, like, like);
  }
  const rows = db.prepare(`SELECT * FROM audit_log WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 300`).all(...args).map(r => ({
    id: r.id, actorId: r.actor_id, actorName: r.actor_name, role: r.actor_role, action: r.action,
    target: r.target, detail: r.detail, sessionId: r.session_id, ip: maskIp(r.ip), createdAt: r.created_at
  }));
  const users = db.prepare('SELECT id, name, role FROM users ORDER BY name').all().map(u => ({ id: u.id, name: u.name, role: u.role }));
  return { rows, users, hours };
}

// --- Audit trail and login log -------------------------------------------------------
function audit(actor, action, target, detail) {
  const a = actor || {};
  db.prepare('INSERT INTO audit_log (actor_id, actor_name, actor_role, session_id, ip, action, target, detail, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(a.id || '', a.name || '', a.role || '', a.sessionId || '', String(a.ip || '').slice(0, 80), action,
      String(target || '').slice(0, 200), String(detail || '').slice(0, 1000), new Date().toISOString());
}

function recordLoginEvent({ email, userId, ip, success, reason }) {
  db.prepare('INSERT INTO login_events (email, user_id, ip, success, reason, created_at) VALUES (?,?,?,?,?,?)')
    .run(String(email || '').trim().toLowerCase().slice(0, 200), userId || '', String(ip || '').slice(0, 80),
      success ? 1 : 0, reason || '', new Date().toISOString());
  // Bounded, so a flood of failed logins cannot grow the database without limit.
  db.prepare('DELETE FROM login_events WHERE id <= (SELECT MAX(id) FROM login_events) - 5000').run();
}

// The administrator password of this demo is public so that it can be graded, which
// means anyone can open these screens. Real testers' email and IP addresses are
// therefore shown masked; the shared demo accounts are shown in full.
function maskEmail(value) {
  const text = String(value || '');
  if (!text || text.endsWith('@safecheck.demo')) return text;
  const at = text.indexOf('@');
  if (at === -1) return text.length > 3 ? text.slice(0, 2) + '***' : text;
  return text.slice(0, Math.min(2, at)) + '***' + text.slice(at);
}

function maskIp(value) {
  const ip = String(value || '').replace(/^::ffff:/, '');
  if (ip === '127.0.0.1' || ip === '::1' || ip === 'unknown') return ip;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip.split('.').slice(0, 3).join('.') + '.x';
  const groups = ip.split(':').filter(Boolean);
  return groups.length ? groups.slice(0, 2).join(':') + ':…' : ip;
}

// --- Administration: user accounts -------------------------------------------------
const USERNAME_PATTERN = /^[a-z0-9._-]{3,30}$/;
const ACCOUNT_STATUSES = ['active', 'suspended'];

function adminUserView(row) {
  return {
    id: row.id, name: row.name, email: maskEmail(row.email), username: row.username || '', role: row.role,
    branch: row.branch || '', status: row.status || 'active', createdAt: row.created_at, lastLoginAt: row.last_login_at || '',
    venues: db.prepare('SELECT venue_id FROM venue_assignments WHERE user_id = ? ORDER BY venue_id').all(row.id).map(r => r.venue_id),
    activeSessions: db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND ended_at = '' AND expires_at > ?").get(row.id, new Date().toISOString()).n,
    isDemo: DEMO_EMAILS.includes(row.email)
  };
}

function listUsers(actor) {
  assertCan(actor, 'user.manage');
  return db.prepare('SELECT * FROM users ORDER BY created_at').all().map(adminUserView);
}

function activeAdminCount(excludingId) {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active' AND id <> ?").get(excludingId || '').n;
}

// Creates an account when id is null, otherwise updates it. Fields left out of `body`
// keep their current value; an empty email or password also means "unchanged".
function adminSaveUser(id, body, actor) {
  assertCan(actor, 'user.manage');
  body = body || {};
  const existing = id ? db.prepare('SELECT * FROM users WHERE id = ?').get(id) : null;
  if (id && !existing) throw httpError(404, 'err.notFound', 'ไม่พบผู้ใช้นี้');
  const keep = (key, current) => (body[key] !== undefined ? body[key] : current);

  const name = String(keep('name', existing ? existing.name : '')).trim().slice(0, 120);
  const email = String(body.email || (existing ? existing.email : '')).trim().toLowerCase();
  const username = String(keep('username', existing ? existing.username || '' : '')).trim().toLowerCase();
  const role = keep('role', existing ? existing.role : 'user');
  const status = keep('status', existing ? existing.status || 'active' : 'active');
  const branch = body.branch !== undefined ? body.branch : (existing ? existing.branch : BRANCHES[0]);
  const password = body.password ? String(body.password) : '';

  if (!name) throw authError('err.nameRequired', 'กรุณากรอกชื่อ');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw authError('err.invalidEmail', 'รูปแบบอีเมลไม่ถูกต้อง');
  if (username && !USERNAME_PATTERN.test(username)) throw httpError(400, 'err.invalidUsername', 'ชื่อผู้ใช้ใช้ได้เฉพาะ a-z 0-9 จุด ขีด และขีดล่าง ยาว 3-30 ตัวอักษร');
  if (!ROLES.includes(role)) throw httpError(400, 'err.unknownRole', 'ไม่รู้จักบทบาทนี้');
  if (!ACCOUNT_STATUSES.includes(status)) throw httpError(400, 'err.invalidStatus', 'สถานะบัญชีไม่ถูกต้อง');
  if (!BRANCHES.includes(branch)) throw httpError(400, 'err.venueBranch', 'สาขาไม่ถูกต้อง');
  if ((!existing || password) && password.length < 6) throw authError('err.weakPassword', 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร');
  const emailOwner = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (emailOwner && (!existing || emailOwner.id !== existing.id)) throw authError('err.emailTaken', 'มีบัญชีที่ใช้อีเมลนี้อยู่แล้ว');
  if (username) {
    const usernameOwner = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (usernameOwner && (!existing || usernameOwner.id !== existing.id)) throw httpError(400, 'err.usernameTaken', 'ชื่อผู้ใช้นี้ถูกใช้แล้ว');
  }

  if (existing) {
    const currentVenues = db.prepare('SELECT venue_id FROM venue_assignments WHERE user_id = ? ORDER BY venue_id').all(existing.id).map(r => r.venue_id);
    const venuesChanged = Array.isArray(body.venues) && [...body.venues].sort().join(',') !== currentVenues.join(',');
    if (DEMO_EMAILS.includes(existing.email) && (email !== existing.email || username !== (existing.username || '') ||
        role !== existing.role || status !== 'active' || branch !== existing.branch || venuesChanged || password)) {
      throw forbidden('err.demoProtected', 'บัญชีสาธิตใช้ร่วมกันทุกคน จึงแก้ไขได้เฉพาะชื่อ หากต้องการทดลองให้สร้างบัญชีใหม่');
    }
    if (existing.id === actor.id && (role !== existing.role || status !== 'active')) {
      throw forbidden('err.selfLockout', 'ไม่สามารถเปลี่ยนบทบาทหรือระงับบัญชีของตัวเองได้');
    }
    if (existing.role === 'admin' && (role !== 'admin' || status !== 'active') && activeAdminCount(existing.id) === 0) {
      throw forbidden('err.lastAdmin', 'ต้องมีผู้ดูแลระบบที่ใช้งานได้อย่างน้อย 1 คน');
    }
  }

  const userId = existing ? existing.id : genId('USR');
  if (existing) {
    db.prepare('UPDATE users SET name = ?, email = ?, username = ?, role = ?, status = ?, branch = ? WHERE id = ?')
      .run(name, email, username, role, status, branch, userId);
    if (password) {
      const { hash, salt } = hashPassword(password);
      db.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').run(hash, salt, userId);
    }
    // Suspending an account, or giving it a new password, signs it out everywhere.
    if (status === 'suspended') endUserSessions(userId, 'suspended');
    else if (password) endUserSessions(userId, 'password_changed');
  } else {
    const { hash, salt } = hashPassword(password);
    db.prepare('INSERT INTO users (id, name, email, username, password_hash, password_salt, role, created_at, branch, status) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(userId, name, email, username, hash, salt, role, new Date().toISOString(), branch, status);
  }

  // Venue responsibility only means something for staff and inspectors: supervisors
  // are scoped by branch, and managers and administrators see everything.
  if (Array.isArray(body.venues) || !existing || role !== existing.role) {
    db.prepare('DELETE FROM venue_assignments WHERE user_id = ?').run(userId);
    if (role === 'user' || role === 'inspector') {
      const valid = new Set(db.prepare('SELECT id FROM venues').all().map(r => r.id));
      assignVenues(userId, Array.isArray(body.venues)
        ? body.venues.filter(v => valid.has(v))
        : db.prepare('SELECT id FROM venues WHERE branch = ?').all(branch).map(r => r.id));
    }
  }

  let action = 'user.create';
  let detail = `role=${role}`;
  if (existing) {
    const after = { name, email, username, role, status, branch };
    detail = Object.keys(after).filter(k => String(existing[k] || '') !== String(after[k])).join(', ') + (password ? ' password' : '');
    action = status !== existing.status ? (status === 'suspended' ? 'user.suspend' : 'user.reactivate') : 'user.update';
  }
  audit(actor, action, maskEmail(email), detail);
  return adminUserView(db.prepare('SELECT * FROM users WHERE id = ?').get(userId));
}

function adminDeleteUser(id, actor) {
  assertCan(actor, 'user.manage');
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!row) throw httpError(404, 'err.notFound', 'ไม่พบผู้ใช้นี้');
  if (row.id === actor.id) throw forbidden('err.selfLockout', 'ไม่สามารถลบบัญชีของตัวเองได้');
  if (DEMO_EMAILS.includes(row.email)) throw forbidden('err.demoProtected', 'บัญชีสาธิตใช้ร่วมกันทุกคน จึงลบไม่ได้');
  if (row.role === 'admin' && activeAdminCount(row.id) === 0) throw forbidden('err.lastAdmin', 'ต้องมีผู้ดูแลระบบที่ใช้งานได้อย่างน้อย 1 คน');
  // Inspection records keep the person's name, so history stays readable afterwards.
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM venue_assignments WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM notifications WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  audit(actor, 'user.delete', maskEmail(row.email), row.role);
}

// --- Administration: role permissions ----------------------------------------------
function permissionMatrix() {
  return {
    roles: ROLES, capabilities: ALL_CAPABILITIES,
    matrix: Object.fromEntries(ROLES.map(r => [r, capabilitiesFor(r)])),
    defaults: DEFAULT_CAPABILITIES, locked: { admin: LOCKED_ADMIN_CAPABILITIES }
  };
}

function getPermissionMatrix(actor) {
  assertCan(actor, 'role.manage');
  return permissionMatrix();
}

function setRolePermissions(role, capabilities, actor) {
  assertCan(actor, 'role.manage');
  if (!ROLES.includes(role)) throw httpError(400, 'err.unknownRole', 'ไม่รู้จักบทบาทนี้');
  if (!Array.isArray(capabilities)) throw httpError(400, 'err.invalidCapabilities', 'รูปแบบสิทธิ์ไม่ถูกต้อง');
  const unknown = capabilities.filter(c => !ALL_CAPABILITIES.includes(c));
  if (unknown.length) throw httpError(400, 'err.invalidCapabilities', 'ไม่รู้จักสิทธิ์: ' + unknown.join(', '));
  const next = [...new Set(capabilities)];
  if (role === 'admin' && !LOCKED_ADMIN_CAPABILITIES.every(c => next.includes(c))) {
    throw httpError(400, 'err.lockedCapability', 'ผู้ดูแลระบบต้องมีสิทธิ์จัดการผู้ใช้และจัดการสิทธิ์เสมอ มิฉะนั้นจะไม่มีใครแก้กลับได้');
  }
  const before = capabilitiesFor(role);
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM role_permissions WHERE role = ?').run(role);
    const insert = db.prepare('INSERT INTO role_permissions (role, capability) VALUES (?,?)');
    next.forEach(c => insert.run(role, c));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  permissionCache = null;
  const added = next.filter(c => !before.includes(c));
  const removed = before.filter(c => !next.includes(c));
  audit(actor, 'role.update', role, `+ ${added.join(', ') || '-'} / - ${removed.join(', ') || '-'}`);
  return permissionMatrix();
}

function resetPermissions(actor) {
  assertCan(actor, 'role.manage');
  writeDefaultPermissions();
  audit(actor, 'role.reset', 'all', '');
  return permissionMatrix();
}

// --- Administration: correcting wrong data ------------------------------------------
// Changes results, notes or names on any record, whatever its stage. A reason is
// required and every change is written to the record's own timeline and the audit log,
// so a correction can always be told apart from what was originally submitted.
function correctInspection(id, body, actor) {
  assertCan(actor, 'data.correct');
  body = body || {};
  const row = db.prepare('SELECT * FROM inspections WHERE id = ?').get(id);
  if (!row) throw httpError(404, 'err.notFound', 'ไม่พบรายการตรวจนี้');
  const reason = String(body.reason || '').trim().slice(0, 500);
  if (!reason) throw httpError(400, 'err.reasonRequired', 'กรุณาระบุเหตุผลของการแก้ไข');

  const items = JSON.parse(row.items_json || '[]');
  const changes = [];
  (Array.isArray(body.items) ? body.items : []).forEach(patch => {
    const item = items.find(i => i.id === patch.id);
    if (!item) return;
    if (['pass', 'fail', 'na'].includes(patch.result) && patch.result !== item.result) {
      changes.push(`${item.id}: ${item.result || '-'} → ${patch.result}`);
      item.result = patch.result;
      // Keeps the corrective-action list consistent with the corrected result.
      item.actionStatus = patch.result === 'fail' ? (item.actionStatus || 'open') : '';
    }
    if (typeof patch.note === 'string' && patch.note.trim() !== (item.note || '')) {
      changes.push(`${item.id}: note`);
      item.note = patch.note.trim().slice(0, 1000);
    }
  });
  let inspectorName = row.inspector_name;
  if (typeof body.inspectorName === 'string' && body.inspectorName.trim() && body.inspectorName.trim() !== row.inspector_name) {
    changes.push(`inspector: ${row.inspector_name} → ${body.inspectorName.trim()}`);
    inspectorName = body.inspectorName.trim().slice(0, 120);
  }
  let overallNote = row.overall_note || '';
  if (typeof body.overallNote === 'string' && body.overallNote.trim() !== overallNote) {
    changes.push('overall note');
    overallNote = body.overallNote.trim().slice(0, 2000);
  }
  if (!changes.length) throw httpError(400, 'err.noChanges', 'ไม่มีข้อมูลที่เปลี่ยนแปลง');

  const score = Core.calculateScore(items);
  const history = JSON.parse(row.history_json || '[]');
  history.push({ action: 'corrected', at: new Date().toISOString(), byId: actor.id, byName: actor.name, role: actor.role, note: reason, changes });
  db.prepare('UPDATE inspections SET inspector_name = ?, overall_note = ?, items_json = ?, score = ?, history_json = ? WHERE id = ?')
    .run(inspectorName, overallNote, JSON.stringify(items), score, JSON.stringify(history), id);
  audit(actor, 'data.correct', id, `${reason} | ${changes.join('; ')}`);
  return { id, score, changes };
}

// --- Administration: venues -----------------------------------------------------------
const VENUE_TYPES = ['Restaurant', 'Bar & Pub', 'Entertainment'];

function saveVenue(id, body, actor) {
  assertCan(actor, 'venue.manage');
  body = body || {};
  const existing = id ? venueRow(id) : null;
  if (id && !existing) throw httpError(404, 'err.notFound', 'ไม่พบสถานที่นี้');
  const keep = (key, current) => (body[key] !== undefined ? body[key] : current);
  const name = String(keep('name', existing ? existing.name : '')).trim().slice(0, 120);
  const type = keep('type', existing ? existing.type : 'Restaurant');
  const location = String(keep('location', existing ? existing.location : '')).trim().slice(0, 200);
  const locationEn = String(keep('locationEn', existing ? existing.location_en : '') || location).trim().slice(0, 200);
  const branch = keep('branch', existing ? existing.branch : BRANCHES[0]);
  const tables = Number(keep('tablesCount', existing ? existing.tables_count : 10));
  if (!name) throw httpError(400, 'err.venueName', 'กรุณาระบุชื่อสถานที่');
  if (!VENUE_TYPES.includes(type)) throw httpError(400, 'err.venueType', 'ประเภทสถานที่ไม่ถูกต้อง');
  if (!location) throw httpError(400, 'err.venueLocation', 'กรุณาระบุที่ตั้ง');
  if (!BRANCHES.includes(branch)) throw httpError(400, 'err.venueBranch', 'สาขาไม่ถูกต้อง');
  if (!Number.isInteger(tables) || tables < 1 || tables > 500) throw httpError(400, 'err.venueTables', 'จำนวนโต๊ะต้องเป็นจำนวนเต็ม 1-500');
  // Choosing who is responsible for a place decides who can inspect it, which is an
  // account decision, so it also needs user-management rights.
  if (Array.isArray(body.assignees)) assertCan(actor, 'user.manage');

  let venueId = id;
  if (existing) {
    db.prepare('UPDATE venues SET name = ?, type = ?, location = ?, location_en = ?, branch = ?, tables_count = ? WHERE id = ?')
      .run(name, type, location, locationEn, branch, tables, id);
  } else {
    const highest = db.prepare("SELECT id FROM venues WHERE id LIKE 'VEN-%'").all()
      .map(r => parseInt(r.id.slice(4), 10)).filter(n => !Number.isNaN(n)).reduce((a, b) => Math.max(a, b), 0);
    venueId = 'VEN-' + String(highest + 1).padStart(3, '0');
    db.prepare('INSERT INTO venues (id, name, type, location, location_en, branch, tables_count, last_inspected_date) VALUES (?,?,?,?,?,?,?,NULL)')
      .run(venueId, name, type, location, locationEn, branch, tables);
  }
  if (Array.isArray(body.assignees)) {
    // Staff and inspectors only: supervisors see their whole branch already. The shared
    // demo accounts can be given a new place but never lose one, so the demo keeps working.
    const eligible = new Set(db.prepare("SELECT id FROM users WHERE role IN ('user', 'inspector')").all().map(r => r.id));
    const demoIds = db.prepare(`SELECT id FROM users WHERE email IN (${DEMO_EMAILS.map(() => '?').join(',')})`).all(...DEMO_EMAILS).map(r => r.id);
    db.prepare(`DELETE FROM venue_assignments WHERE venue_id = ? AND user_id NOT IN (${demoIds.map(() => '?').join(',') || "''"})`).run(venueId, ...demoIds);
    const assign = db.prepare('INSERT OR IGNORE INTO venue_assignments (user_id, venue_id) VALUES (?,?)');
    body.assignees.filter(id => eligible.has(id)).forEach(id => assign.run(id, venueId));
  }
  audit(actor, existing ? 'venue.update' : 'venue.create', venueId, name);
  return allVenues().find(v => v.id === venueId);
}

function deleteVenue(id, actor) {
  assertCan(actor, 'venue.manage');
  const venue = venueRow(id);
  if (!venue) throw httpError(404, 'err.notFound', 'ไม่พบสถานที่นี้');
  // Inspection records are evidence and must outlive a venue being closed.
  const used = db.prepare('SELECT COUNT(*) AS n FROM inspections WHERE venue_id = ?').get(id).n;
  if (used) throw httpError(409, 'err.venueInUse', `ลบไม่ได้ เพราะมีประวัติการตรวจ ${used} รายการที่ต้องเก็บไว้เป็นหลักฐาน`);
  db.prepare('DELETE FROM venue_assignments WHERE venue_id = ?').run(id);
  db.prepare('DELETE FROM equipment WHERE venue_id = ?').run(id);
  db.prepare('DELETE FROM ai_alerts WHERE venue_id = ?').run(id);
  db.prepare('DELETE FROM venues WHERE id = ?').run(id);
  audit(actor, 'venue.delete', id, venue.name);
}

// --- Administration: security --------------------------------------------------------
// "Suspicious" means three or more failed logins in 24 hours from one address or
// against one account, or any attempt to use a suspended account.
function suspiciousLogins(since) {
  const group = (column, where) => db.prepare(
    `SELECT ${column} AS value, COUNT(*) AS count, MAX(created_at) AS last FROM login_events
     WHERE ${where} AND created_at >= ? GROUP BY ${column} HAVING COUNT(*) >= ? ORDER BY count DESC LIMIT 20`);
  return [
    ...group('ip', 'success = 0').all(since, 3).map(r => ({ kind: 'ip', ...r, value: maskIp(r.value) })),
    ...group('email', "success = 0 AND email <> ''").all(since, 3).map(r => ({ kind: 'account', ...r, value: maskEmail(r.value) })),
    ...group('email', "reason = 'suspended'").all(since, 1).map(r => ({ kind: 'suspended', ...r, value: maskEmail(r.value) }))
  ];
}

function adminSummary() {
  const since = new Date(Date.now() - 86400000).toISOString();
  return {
    users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
    suspended: db.prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'suspended'").get().n,
    failedLogins24h: db.prepare('SELECT COUNT(*) AS n FROM login_events WHERE success = 0 AND created_at >= ?').get(since).n,
    suspicious: suspiciousLogins(since).length
  };
}

function getSecurityOverview(actor) {
  assertCan(actor, 'security.view');
  const now = new Date().toISOString();
  const since = new Date(Date.now() - 86400000).toISOString();
  const count = (sql, ...args) => db.prepare(sql).get(...args).n;
  return {
    summary: {
      failedLogins24h: count('SELECT COUNT(*) AS n FROM login_events WHERE success = 0 AND created_at >= ?', since),
      successfulLogins24h: count('SELECT COUNT(*) AS n FROM login_events WHERE success = 1 AND created_at >= ?', since),
      lockouts24h: count("SELECT COUNT(*) AS n FROM login_events WHERE reason = 'locked' AND created_at >= ?", since),
      suspendedAttempts24h: count("SELECT COUNT(*) AS n FROM login_events WHERE reason = 'suspended' AND created_at >= ?", since),
      activeSessions: count("SELECT COUNT(*) AS n FROM sessions WHERE ended_at = '' AND expires_at > ?", now),
      suspendedAccounts: count("SELECT COUNT(*) AS n FROM users WHERE status = 'suspended'")
    },
    suspicious: suspiciousLogins(since),
    loginEvents: db.prepare('SELECT * FROM login_events ORDER BY id DESC LIMIT 50').all().map(r => ({
      id: r.id, email: maskEmail(r.email), ip: maskIp(r.ip), success: !!r.success, reason: r.reason, createdAt: r.created_at
    })),
    // Changes only; routine logins and page views live in the activity log.
    audit: db.prepare("SELECT * FROM audit_log WHERE action NOT IN ('page.view', 'session.login', 'session.logout') ORDER BY id DESC LIMIT 50").all().map(r => ({
      id: r.id, actorName: r.actor_name, action: r.action, target: r.target, detail: r.detail, createdAt: r.created_at
    }))
  };
}

// --- Administration: backup and restore ------------------------------------------------
// Accounts and passwords are deliberately not part of a backup: a backup can be
// downloaded as a file, and a file of password hashes is a liability wherever it ends up.
// Evidence photos are left out to keep backups small; their links stay valid.
const BACKUP_TABLES = ['venues', 'checklist_items', 'inspections', 'equipment', 'ai_alerts', 'venue_assignments', 'role_permissions'];
const MAX_STORED_BACKUPS = 10;

function createBackup(label, actor) {
  assertCan(actor, 'system.backup');
  const tables = Object.fromEntries(BACKUP_TABLES.map(t => [t, db.prepare(`SELECT * FROM ${t}`).all()]));
  const createdAt = new Date().toISOString();
  const payload = JSON.stringify({ app: 'SafeCheck', format: 1, createdAt, tables });
  const id = genId('BAK');
  const cleanLabel = String(label || '').trim().slice(0, 80);
  const size = Buffer.byteLength(payload);
  db.prepare('INSERT INTO backups (id, label, created_by, created_at, size, payload) VALUES (?,?,?,?,?,?)')
    .run(id, cleanLabel, actor.name, createdAt, size, payload);
  db.prepare('DELETE FROM backups WHERE id NOT IN (SELECT id FROM backups ORDER BY created_at DESC LIMIT ?)').run(MAX_STORED_BACKUPS);
  audit(actor, 'system.backup', id, cleanLabel);
  return { id, label: cleanLabel, createdBy: actor.name, createdAt, size, counts: Object.fromEntries(BACKUP_TABLES.map(t => [t, tables[t].length])) };
}

function listBackups(actor) {
  assertCan(actor, 'system.backup');
  return db.prepare('SELECT id, label, created_by, created_at, size FROM backups ORDER BY created_at DESC').all()
    .map(r => ({ id: r.id, label: r.label, createdBy: r.created_by, createdAt: r.created_at, size: r.size }));
}

function getBackup(id, actor) {
  assertCan(actor, 'system.backup');
  const row = db.prepare('SELECT id, created_at, payload FROM backups WHERE id = ?').get(id);
  return row ? { id: row.id, createdAt: row.created_at, payload: row.payload } : null;
}

// Restores from a stored backup ({ backupId }) or an uploaded file ({ payload }). All or
// nothing: a bad file leaves the current data exactly as it was.
function restoreBackup(body, actor) {
  assertCan(actor, 'system.backup');
  body = body || {};
  let data;
  if (body.backupId) {
    const row = db.prepare('SELECT payload FROM backups WHERE id = ?').get(body.backupId);
    if (!row) throw httpError(404, 'err.notFound', 'ไม่พบไฟล์สำรองข้อมูล');
    data = JSON.parse(row.payload);
  } else {
    try {
      data = typeof body.payload === 'string' ? JSON.parse(body.payload) : body.payload;
    } catch (err) {
      throw httpError(400, 'err.backupInvalid', 'ไฟล์สำรองข้อมูลไม่ใช่ JSON ที่ถูกต้อง');
    }
  }
  const tables = data && data.app === 'SafeCheck' && data.format === 1 && data.tables;
  if (!tables || !['venues', 'checklist_items', 'inspections'].every(t => Array.isArray(tables[t]))) {
    throw httpError(400, 'err.backupInvalid', 'ไฟล์นี้ไม่ใช่ไฟล์สำรองข้อมูลของ SafeCheck');
  }

  // A restore can itself be undone: snapshot the current state first.
  const safetyNet = createBackup('อัตโนมัติ: ก่อนกู้คืนข้อมูล', actor);
  const counts = {};
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM venue_assignments; DELETE FROM ai_alerts; DELETE FROM equipment; DELETE FROM inspections; DELETE FROM checklist_items; DELETE FROM venues;');
    if (Array.isArray(tables.role_permissions)) db.exec('DELETE FROM role_permissions');
    const userIds = new Set(db.prepare('SELECT id FROM users').all().map(r => r.id));
    BACKUP_TABLES.forEach(table => {
      let rows = tables[table];
      if (!Array.isArray(rows)) return;
      if (table === 'venue_assignments') rows = rows.filter(r => r && userIds.has(r.user_id));
      if (table === 'role_permissions') rows = rows.filter(r => r && ROLES.includes(r.role) && ALL_CAPABILITIES.includes(r.capability));
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
      rows.forEach(row => {
        const keys = columns.filter(c => row[c] !== undefined);
        db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map(k => row[k]));
      });
      counts[table] = rows.length;
    });
    // Whatever the file says, administrators keep the rights needed to repair permissions.
    const keepAdmin = db.prepare("INSERT OR IGNORE INTO role_permissions (role, capability) VALUES ('admin', ?)");
    LOCKED_ADMIN_CAPABILITIES.forEach(c => keepAdmin.run(c));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw httpError(400, 'err.restoreFailed', 'กู้คืนไม่สำเร็จ ข้อมูลเดิมยังอยู่ครบ (' + err.message + ')');
  }
  permissionCache = null;
  audit(actor, 'system.restore', body.backupId || 'uploaded file', JSON.stringify(counts));
  return { restored: counts, safetyBackupId: safetyNet.id };
}

// --- Demo workflow data ----------------------------------------------------------------
// Records waiting at every stage, dated relative to now so the deadline badges show
// something meaningful whenever the demo database happens to be created.
function seedWorkflowDemo() {
  const byEmail = email => db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const staff = byEmail('staff@safecheck.demo');
  const inspector = byEmail('inspector@safecheck.demo');
  const supervisor = byEmail('supervisor@safecheck.demo');
  const person = (row, fallbackName, role) => ({ id: row ? row.id : '', name: row ? row.name : fallbackName, role });
  const s = person(staff, 'มานี มีสุข', 'user');
  const i = person(inspector, 'กิตติยา พรหมดี', 'inspector');
  const other = person(null, 'วีระ ใจกล้า', 'inspector');

  const templates = getChecklistItems();
  const itemsFor = (frequency, results, notes) => templates[frequency].map(t => ({
    id: t.id, title: t.title, titleEn: t.titleEn, evidenceRequirement: t.evidenceRequirement,
    result: results[t.id] || 'pass', note: notes[t.id] || '', media: [],
    actionStatus: results[t.id] === 'fail' ? 'open' : ''
  }));
  const hoursAgo = h => new Date(Date.now() - h * 3600000).toISOString();
  const rejectNote = 'DLY-03 ไม่ผ่านแต่ยังไม่ได้แนบรูปถ่าย กรุณาถ่ายรูปไฟฉุกเฉินจุดที่เสียแล้วส่งใหม่';

  const records = [
    { id: 'INS-2026-0008', venueId: 'VEN-001', frequency: 'daily', by: s, at: hoursAgo(1), stage: 'pending_review', note: 'ตรวจก่อนเปิดร้านรอบเย็น',
      items: itemsFor('daily', {}, { 'DLY-05': 'สายแก๊สและปลั๊กไฟในครัวอยู่ในสภาพปกติ' }), extra: [] },
    { id: 'INS-2026-0009', venueId: 'VEN-004', frequency: 'monthly', by: i, at: hoursAgo(26), stage: 'pending_approval', note: 'ระบบโดยรวมพร้อมใช้งาน',
      items: itemsFor('monthly', { 'MON-04': 'na' }, { 'MON-04': 'ป้ายทางออกรุ่นใหม่ไม่มีแบตเตอรี่สำรองแยก' }), extra: [] },
    { id: 'INS-2026-0010', venueId: 'VEN-006', frequency: 'daily', by: other, at: hoursAgo(30), stage: 'pending_approval', note: '',
      items: itemsFor('daily', {}, {}), extra: [] },
    { id: 'INS-2026-0011', venueId: 'VEN-001', frequency: 'daily', by: s, at: hoursAgo(22), stage: 'rejected', note: '',
      items: itemsFor('daily', { 'DLY-03': 'fail' }, { 'DLY-03': 'ไฟฉุกเฉินทางออกด้านหลังไม่ติด 1 จุด' }),
      extra: [{ action: 'rejected', at: hoursAgo(20), byId: i.id, byName: i.name, role: 'inspector', note: rejectNote, late: false }] }
  ];
  const insert = db.prepare('INSERT OR IGNORE INTO inspections (id, venue_id, frequency, inspector_name, role, date, status, score, overall_note, items_json, review_status, submitted_by, deadline, history_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  records.forEach(r => {
    const history = [{ action: 'submitted', at: r.at, byId: r.by.id, byName: r.by.name, role: r.by.role }, ...r.extra];
    insert.run(r.id, r.venueId, r.frequency, r.by.name, ROLE_LABELS[r.by.role], r.at, 'submitted', Core.calculateScore(r.items),
      r.note, JSON.stringify(r.items), r.stage, r.by.id, Workflow.approvalDeadline(r.at, r.frequency) || '', JSON.stringify(history));
  });

  const notify = (recipient, kind, recordId, fromName, extra) => {
    const row = db.prepare('SELECT * FROM inspections WHERE id = ?').get(recordId);
    if (recipient && row) addNotification(recipient.id, kind, notificationParams(row, { byName: fromName, ...extra }), fromName, recordId);
  };
  notify(inspector, 'inspection.awaitingReview', 'INS-2026-0008', s.name);
  notify(supervisor, 'inspection.awaitingApproval', 'INS-2026-0009', i.name);
  notify(supervisor, 'inspection.awaitingApproval', 'INS-2026-0010', other.name);
  notify(staff, 'inspection.rejected', 'INS-2026-0011', i.name, { note: rejectNote });
  db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('workflow_demo_seeded', ?)").run(new Date().toISOString());
}

// --- Start-up migration to the five-role model ----------------------------------------
function migrateToFiveRoles() {
  const safetyDemo = db.prepare("SELECT id FROM users WHERE email = 'safety@safecheck.demo'").get();
  const staffDemo = db.prepare("SELECT id FROM users WHERE email = 'staff@safecheck.demo'").get();
  if (safetyDemo && !staffDemo) {
    const staff = DEMO_ACCOUNTS[0];
    db.prepare("UPDATE users SET email = ?, name = ?, role = 'user', branch = ? WHERE id = ?").run(staff.email, staff.name, staff.branch, safetyDemo.id);
    db.prepare('DELETE FROM venue_assignments WHERE user_id = ?').run(safetyDemo.id);
    assignVenues(safetyDemo.id, staff.venues);
  }
  db.exec("UPDATE users SET role = 'inspector' WHERE role = 'safety'");
  db.exec("UPDATE users SET status = 'active' WHERE status IS NULL OR status = ''");
  const setUsername = db.prepare("UPDATE users SET username = ? WHERE email = ? AND (username IS NULL OR username = '') AND NOT EXISTS (SELECT 1 FROM users other WHERE other.username = ?)");
  DEMO_ACCOUNTS.forEach(a => setUsername.run(a.username, a.email, a.username));
  // Records saved before the approval workflow existed were already final.
  db.exec("UPDATE inspections SET review_status = 'approved' WHERE status = 'submitted' AND (review_status IS NULL OR review_status = '')");
}

migrateToFiveRoles();
if (!db.prepare("SELECT value FROM app_meta WHERE key = 'workflow_demo_seeded'").get()) seedWorkflowDemo();

module.exports = {
  bootstrap, saveInspection, updateActionStatus, createAlert, updateAlert,
  updateEquipment, addEquipment, deleteEquipment, resetAll, requiredExtinguishers,
  createUser, verifyLogin, createSession, getSessionUser, deleteSession,
  addMedia, getMedia, deleteMedia, MEDIA_LIMITS,
  addFeedback, getFeedback, feedbackCount, feedbackBackend,
  decideInspection, notifyStaff, getNotifications, markNotificationsRead,
  listUsers, adminSaveUser, adminDeleteUser,
  getPermissionMatrix, setRolePermissions, resetPermissions,
  correctInspection, saveVenue, deleteVenue,
  recordLoginEvent, getSecurityOverview, createBackup, listBackups, getBackup, restoreBackup,
  listMySessions, endMySession, endOtherSessions, listSessions, revokeSession, recordPageView, getActivity,
  can, capabilitiesFor, visibleVenueIds, BRANCHES, CAPABILITIES, DEFAULT_CAPABILITIES, ALL_CAPABILITIES,
  ROLES, SELF_SIGNUP_ROLES
};
