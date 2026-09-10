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

const CAPABILITIES = {
  inspector:  ['inspection.submit', 'alert.acknowledge'],
  safety:     ['inspection.submit', 'alert.acknowledge', 'alert.escalate', 'action.update', 'alert.simulate'],
  supervisor: ['alert.acknowledge', 'alert.escalate', 'alert.close', 'action.update', 'alert.simulate'],
  manager:    ['alert.acknowledge', 'alert.close', 'action.update', 'alert.simulate', 'equipment.manage'],
  admin:      ['inspection.submit', 'alert.acknowledge', 'alert.escalate', 'alert.close',
               'action.update', 'alert.simulate', 'equipment.manage', 'system.reset']
};

function capabilitiesFor(role) { return CAPABILITIES[role] || []; }
function can(user, capability) { return !!user && capabilitiesFor(user.role).includes(capability); }

function forbidden(code, message) { const err = new Error(message); err.code = code; err.status = 403; return err; }

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
function seedUsers() {
  const demoAccounts = [
    { name: 'กิตติยา พรหมดี', email: 'inspector@safecheck.demo', role: 'inspector', branch: 'BKK-CENTRAL', venues: ['VEN-001', 'VEN-004'] },
    { name: 'สมชาย รักษ์ดี', email: 'safety@safecheck.demo', role: 'safety', branch: 'BKK-EAST', venues: ['VEN-001', 'VEN-002', 'VEN-003'] },
    { name: 'ธนา โชติวัฒน์', email: 'supervisor@safecheck.demo', role: 'supervisor', branch: 'BKK-CENTRAL', venues: [] },
    { name: 'ณัฐภัทร แสงสันต์', email: 'manager@safecheck.demo', role: 'manager', branch: 'BKK-CENTRAL', venues: [] },
    { name: 'ผู้ดูแลระบบ', email: 'admin@safecheck.demo', role: 'admin', branch: 'BKK-CENTRAL', venues: [] }
  ];
  const insUser = db.prepare('INSERT INTO users (id, name, email, password_hash, password_salt, role, created_at, branch) VALUES (?,?,?,?,?,?,?,?)');
  demoAccounts.forEach(acc => {
    const { hash, salt } = hashPassword('Demo1234!');
    const id = genId('USR');
    insUser.run(id, acc.name, acc.email, hash, salt, acc.role, new Date().toISOString(), acc.branch);
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
  const insInspection = db.prepare('INSERT INTO inspections (id, venue_id, frequency, inspector_name, role, date, status, score, overall_note, items_json) VALUES (?,?,?,?,?,?,?,?,?,?)');

  const seedInspections = [
    { id: 'INS-2026-0007', venueId: 'VEN-001', frequency: 'daily', inspector: 'กิตติยา พรหมดี', role: 'Inspector', date: '2026-08-14T10:20:00', overallNote: 'ระบบโดยรวมอยู่ในเกณฑ์ดี ควรปรับปรุงไฟฉุกเฉินบริเวณทางออกด้านหลัง', items: buildItems(dailyItems, code => code === 'DLY-03' ? 'fail' : 'pass'), failNote: { 'DLY-03': 'ไฟฉุกเฉินหนึ่งจุดไม่ทำงาน' } },
    { id: 'INS-2026-0006', venueId: 'VEN-002', frequency: 'daily', inspector: 'สมชาย รักษ์ดี', role: 'Safety Officer', date: '2026-08-11T16:40:00', overallNote: 'พบสิ่งกีดขวางทางหนีไฟ', items: buildItems(dailyItems, code => code === 'DLY-01' ? 'fail' : 'pass'), failNote: { 'DLY-01': 'มีกล่องวางขวางประตูฉุกเฉิน' } },
    { id: 'INS-2026-0005', venueId: 'VEN-003', frequency: 'monthly', inspector: 'ธนา โชติวัฒน์', role: 'Supervisor', date: '2026-08-06T13:10:00', overallNote: 'ต้องติดตามหลายรายการก่อนอนุมัติผล', items: buildItems(items.filter(i => i[0] === 'monthly'), code => ['MON-02', 'MON-03'].includes(code) ? 'fail' : 'pass'), failNote: { 'MON-02': 'เข็มเกจตกโซนแดง 1 ถัง', 'MON-03': 'มีลังสินค้าวางบังหัวสปริงเกลอร์' } }
  ];
  seedInspections.forEach(ins => {
    const items = ins.items.map(item => ({ ...item, note: ins.failNote?.[item.id] || '', actionStatus: item.result === 'fail' ? 'open' : '' }));
    const score = Math.round((items.filter(i => i.result === 'pass').length / items.filter(i => i.result !== 'na').length) * 100);
    insInspection.run(ins.id, ins.venueId, ins.frequency, ins.inspector, ins.role, ins.date, 'submitted', score, ins.overallNote, JSON.stringify(items));
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
    if (u.role === 'inspector' || u.role === 'safety') {
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
      score: r.score, overallNote: r.overall_note, items: JSON.parse(r.items_json)
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

function bootstrap(user) {
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
  const existing = db.prepare('SELECT id FROM inspections WHERE id = ?').get(ins.id);
  const itemsJson = JSON.stringify(ins.items || []);
  if (existing) {
    db.prepare('UPDATE inspections SET venue_id=?, frequency=?, inspector_name=?, role=?, date=?, status=?, score=?, overall_note=?, items_json=? WHERE id=?')
      .run(ins.venueId, ins.frequency, ins.inspector, ins.role, ins.date, ins.status, ins.score, ins.overallNote || '', itemsJson, ins.id);
  } else {
    db.prepare('INSERT INTO inspections (id, venue_id, frequency, inspector_name, role, date, status, score, overall_note, items_json) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(ins.id, ins.venueId, ins.frequency, ins.inspector, ins.role, ins.date, ins.status, ins.score, ins.overallNote || '', itemsJson);
  }
  linkMediaToInspection(ins);
  if (ins.status === 'submitted') {
    db.prepare('UPDATE venues SET last_inspected_date = ? WHERE id = ? AND (last_inspected_date IS NULL OR last_inspected_date < ?)')
      .run(ins.date, ins.venueId, ins.date);
  }
}

function updateActionStatus(inspectionId, itemId, actionStatus, user) {
  assertCan(user, 'action.update');
  const row = db.prepare('SELECT venue_id, items_json FROM inspections WHERE id = ?').get(inspectionId);
  if (!row) throw new Error('ไม่พบรายการตรวจนี้');
  assertVenueVisible(user, row.venue_id);
  const items = JSON.parse(row.items_json).map(item => item.id === itemId ? { ...item, actionStatus } : item);
  db.prepare('UPDATE inspections SET items_json = ? WHERE id = ?').run(JSON.stringify(items), inspectionId);
}

function createAlert(alert, user) {
  assertCan(user, 'alert.simulate');
  assertVenueVisible(user, alert.venueId);
  const id = genId('ALT');
  db.prepare('INSERT INTO ai_alerts (id, venue_id, anomaly_type, level, confidence, created_at, status, acknowledged_at, escalated_at, closed_at, variant_index, obstruction_pct, zone_index, staff_index) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, alert.venueId, alert.anomalyType, alert.level, alert.confidence, new Date().toISOString(), 'notified', '', '', '',
      alert.variantIndex || 0, alert.obstructionPct ?? null, alert.zoneIndex || 0, alert.staffIndex || 0);
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
}

function updateEquipment(id, patch, user) {
  assertCan(user, 'equipment.manage');
  const existing = db.prepare('SELECT * FROM equipment WHERE id = ?').get(id);
  if (!existing) throw new Error('ไม่พบอุปกรณ์นี้');
  assertVenueVisible(user, existing.venue_id);
  db.prepare('UPDATE equipment SET expiry_date = ?, photo = ? WHERE id = ?')
    .run(patch.expiryDate ?? existing.expiry_date, patch.photo ?? existing.photo, id);
}

function addEquipment(eq, user) {
  assertCan(user, 'equipment.manage');
  assertVenueVisible(user, eq.venueId);
  const id = genId('EQ');
  db.prepare('INSERT INTO equipment (id, venue_id, type, label, label_en, install_date, expiry_date, photo) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, eq.venueId, eq.type, eq.label, eq.labelEn || eq.label, eq.installDate, eq.expiryDate, eq.photo || '');
  return getEquipment(user).find(e => e.id === id);
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
  const savedAssignments = db.prepare('SELECT user_id, venue_id FROM venue_assignments').all();
  db.exec('DELETE FROM venue_assignments; DELETE FROM media; DELETE FROM inspections; DELETE FROM ai_alerts; DELETE FROM equipment; DELETE FROM checklist_items; DELETE FROM venues;');
  seed();
  const liveVenues = new Set(db.prepare('SELECT id FROM venues').all().map(r => r.id));
  const restore = db.prepare('INSERT OR IGNORE INTO venue_assignments (user_id, venue_id) VALUES (?,?)');
  savedAssignments.filter(r => liveVenues.has(r.venue_id)).forEach(r => restore.run(r.user_id, r.venue_id));
}

// --- Auth operations -------------------------------------------------------------
// Auth errors carry a stable `code` as well as a Thai fallback message, so the
// bilingual frontend can translate them instead of always showing Thai.
function authError(code, message) { const err = new Error(message); err.code = code; return err; }

const ALLOWED_ROLES = ['inspector', 'safety', 'supervisor', 'manager', 'admin'];
// Public self-registration may only create field-level roles. Elevated roles
// (supervisor/manager/admin) are provisioned server-side — otherwise anyone hitting
// the public signup endpoint could grant themselves administrator access, which is
// privilege escalation regardless of what the UI dropdown happens to offer.
const SELF_SIGNUP_ROLES = ['inspector', 'safety'];

function createUser({ name, email, password, role, branch }) {
  name = (name || '').trim();
  email = (email || '').trim().toLowerCase();
  if (!name) throw authError('err.nameRequired', 'กรุณากรอกชื่อ');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw authError('err.invalidEmail', 'รูปแบบอีเมลไม่ถูกต้อง');
  if (!password || password.length < 6) throw authError('err.weakPassword', 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร');
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
  return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
}

function verifyLogin(email, password) {
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').trim().toLowerCase());
  // Same error for "no such account" and "wrong password" — telling an attacker
  // which emails exist is free reconnaissance (user enumeration).
  if (!row || !verifyPassword(password || '', row.password_hash, row.password_salt)) {
    throw authError('err.invalidCredentials', 'อีเมลหรือรหัสผ่านไม่ถูกต้อง');
  }
  return publicUser(row);
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(token, userId, now.toISOString(), new Date(now.getTime() + SESSION_TTL_MS).toISOString());
  return token;
}

function getSessionUser(token) {
  if (!token) return null;
  const row = db.prepare('SELECT sessions.expires_at AS expires_at, users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token = ?').get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) { deleteSession(token); return null; }
  return publicUser(row);
}

function deleteSession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

module.exports = {
  bootstrap, saveInspection, updateActionStatus, createAlert, updateAlert,
  updateEquipment, addEquipment, resetAll, requiredExtinguishers,
  createUser, verifyLogin, createSession, getSessionUser, deleteSession,
  addMedia, getMedia, deleteMedia, MEDIA_LIMITS,
  can, capabilitiesFor, visibleVenueIds, BRANCHES, CAPABILITIES, SELF_SIGNUP_ROLES
};
