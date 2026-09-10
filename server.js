'use strict';
// SafeCheck server — plain Node http + node:sqlite, zero external dependencies on
// purpose: `node server.js` (or `npm start`) is all that's needed, no `npm install`,
// no internet access required. Serves the static frontend and a small JSON REST API.
const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const PORT = process.env.PORT || 4173;
const ROOT = __dirname;
const STATIC_FILES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/styles.css': 'styles.css',
  '/core.js': 'core.js',
  '/i18n.js': 'i18n.js',
  '/api.js': 'api.js',
  '/app.js': 'app.js'
};
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

// --- Cookie-based sessions (no dependency — Cookie/Set-Cookie are one-liners) ----
const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // seconds

// Hosting platforms terminate TLS at a proxy, so the request that reaches this
// process is plain HTTP and req.socket.encrypted is false even though the user is
// on https. The proxy reports the truth in x-forwarded-*, but a client can send
// those headers too — so they are only believed when TRUST_PROXY is set, which we
// set in the deployment config and never locally.
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';

function forwardedHeader(req, name) {
  return (req.headers[name] || '').split(',')[0].trim();
}

function isSecureRequest(req) {
  if (TRUST_PROXY && forwardedHeader(req, 'x-forwarded-proto') === 'https') return true;
  return !!req.socket.encrypted;
}

// Without this every visitor behind the proxy shares one IP, so the login throttle
// would count unrelated people's failures against each other.
function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = forwardedHeader(req, 'x-forwarded-for');
    if (forwarded) return forwarded;
  }
  return req.socket?.remoteAddress || 'unknown';
}
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}
// Secure is added only on https, so the cookie still works on http://localhost.
function sessionCookie(req, value, maxAge) {
  const secure = isSecureRequest(req) ? ' Secure;' : '';
  return `sid=${value}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}
function setSessionCookie(req, res, token) {
  res.setHeader('Set-Cookie', sessionCookie(req, token, SESSION_MAX_AGE));
}
function clearSessionCookie(req, res) {
  res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
}
function currentUser(req) {
  const { sid } = parseCookies(req);
  return db.getSessionUser(sid);
}

// --- Login throttling --------------------------------------------------------------
// In-memory per (ip + email) limit. Adequate for this single-process demo; a real
// deployment would keep this in a shared store so it survives restarts and scales.
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_LOCK_MS = 10 * 60 * 1000;
const loginAttempts = new Map();

function attemptKey(req, email) {
  const ip = clientIp(req);
  return `${ip}|${(email || '').trim().toLowerCase()}`;
}
function loginLockRemainingMs(key) {
  const rec = loginAttempts.get(key);
  if (!rec || !rec.lockedUntil) return 0;
  const left = rec.lockedUntil - Date.now();
  if (left <= 0) { loginAttempts.delete(key); return 0; }
  return left;
}
function noteLoginFailure(key) {
  const now = Date.now();
  const rec = loginAttempts.get(key) || { count: 0, firstAt: now };
  if (now - rec.firstAt > LOGIN_WINDOW_MS) { rec.count = 0; rec.firstAt = now; }
  rec.count += 1;
  if (rec.count >= LOGIN_MAX_ATTEMPTS) rec.lockedUntil = now + LOGIN_LOCK_MS;
  loginAttempts.set(key, rec);
  return rec;
}
// Keeps the map from growing without bound on a long-running server.
setInterval(() => {
  const now = Date.now();
  for (const [key, rec] of loginAttempts) {
    const expired = (!rec.lockedUntil || rec.lockedUntil < now) && (now - rec.firstAt > LOGIN_WINDOW_MS);
    if (expired) loginAttempts.delete(key);
  }
}, 5 * 60 * 1000).unref();

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > 5 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (err) { reject(new Error('รูปแบบข้อมูล JSON ไม่ถูกต้อง')); }
    });
    req.on('error', reject);
  });
}

// Media is uploaded as a raw binary body rather than base64 JSON — base64 would
// inflate every file by ~33% and a 20MB video is already the largest thing here.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
function readBinary(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let aborted = false;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > MAX_UPLOAD_BYTES) { aborted = true; req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', err => reject(aborted ? new Error('ไฟล์ใหญ่เกินกำหนด') : err));
  });
}

function serveStatic(req, res, pathname) {
  const rel = STATIC_FILES[pathname];
  if (!rel) return false;
  const filePath = path.join(ROOT, rel);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
  return true;
}

// Serves an evidence file. Range support matters here: <video> in Safari (and
// seeking in every browser) relies on 206 partial responses.
function sendMedia(req, res, media) {
  const buf = Buffer.isBuffer(media.bytes) ? media.bytes : Buffer.from(media.bytes);
  const range = req.headers.range;
  const baseHeaders = { 'Content-Type': media.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=300' };
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? parseInt(m[2], 10) : buf.length - 1;
      if (start >= buf.length || end >= buf.length || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${buf.length}` });
        return res.end();
      }
      const slice = buf.subarray(start, end + 1);
      res.writeHead(206, { ...baseHeaders, 'Content-Range': `bytes ${start}-${end}/${buf.length}`, 'Content-Length': slice.length });
      return res.end(slice);
    }
  }
  res.writeHead(200, { ...baseHeaders, 'Content-Length': buf.length });
  res.end(buf);
}

async function handleApi(req, res, pathname, method) {
  try {
    // --- Auth routes (public) ---
    // Signup deliberately does NOT start a session — the new account has to be used
    // to log in, which is both the requested flow and the safer default.
    if (pathname === '/api/signup' && method === 'POST') {
      const body = await readBody(req);
      const user = db.createUser(body);
      return sendJson(res, 201, { user });
    }
    if (pathname === '/api/login' && method === 'POST') {
      const body = await readBody(req);
      const key = attemptKey(req, body.email);
      const lockedMs = loginLockRemainingMs(key);
      if (lockedMs > 0) {
        const minutes = Math.max(1, Math.ceil(lockedMs / 60000));
        res.setHeader('Retry-After', String(Math.ceil(lockedMs / 1000)));
        return sendJson(res, 429, { code: 'err.tooManyAttempts', minutes, error: `พยายามเข้าสู่ระบบผิดหลายครั้งเกินไป กรุณาลองใหม่ในอีก ${minutes} นาที` });
      }
      try {
        const user = db.verifyLogin(body.email, body.password);
        loginAttempts.delete(key);
        const token = db.createSession(user.id);
        setSessionCookie(req, res, token);
        return sendJson(res, 200, { user });
      } catch (err) {
        const rec = noteLoginFailure(key);
        if (rec.lockedUntil) {
          const minutes = Math.ceil(LOGIN_LOCK_MS / 60000);
          res.setHeader('Retry-After', String(Math.ceil(LOGIN_LOCK_MS / 1000)));
          return sendJson(res, 429, { code: 'err.tooManyAttempts', minutes, error: `พยายามเข้าสู่ระบบผิดหลายครั้งเกินไป กรุณาลองใหม่ในอีก ${minutes} นาที` });
        }
        const remaining = Math.max(0, LOGIN_MAX_ATTEMPTS - rec.count);
        return sendJson(res, 400, { code: err.code || 'err.invalidCredentials', remaining, error: err.message });
      }
    }
    if (pathname === '/api/me' && method === 'GET') {
      return sendJson(res, 200, { user: currentUser(req) });
    }
    if (pathname === '/api/logout' && method === 'POST') {
      const { sid } = parseCookies(req);
      db.deleteSession(sid);
      clearSessionCookie(req, res);
      return sendJson(res, 200, { ok: true });
    }

    // --- Everything else requires a valid session ---
    // Note the two distinct layers: 401 means "not signed in", 403 (thrown from the
    // db layer) means "signed in, but your role or venue scope does not allow this".
    const user = currentUser(req);
    if (!user) return sendJson(res, 401, { error: 'กรุณาเข้าสู่ระบบ' });

    if (pathname === '/api/bootstrap' && method === 'GET') {
      return sendJson(res, 200, db.bootstrap(user));
    }
    if (pathname === '/api/inspections' && method === 'POST') {
      const body = await readBody(req);
      db.saveInspection(body, user);
      return sendJson(res, 200, { ok: true });
    }
    const actionMatch = pathname.match(/^\/api\/actions\/([^/]+)\/([^/]+)$/);
    if (actionMatch && method === 'PATCH') {
      const body = await readBody(req);
      db.updateActionStatus(decodeURIComponent(actionMatch[1]), decodeURIComponent(actionMatch[2]), body.actionStatus, user);
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === '/api/alerts' && method === 'POST') {
      const body = await readBody(req);
      const alert = db.createAlert(body, user);
      return sendJson(res, 201, alert);
    }
    const alertMatch = pathname.match(/^\/api\/alerts\/([^/]+)$/);
    if (alertMatch && method === 'PATCH') {
      const body = await readBody(req);
      db.updateAlert(decodeURIComponent(alertMatch[1]), body, user);
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === '/api/equipment' && method === 'POST') {
      const body = await readBody(req);
      const equipment = db.addEquipment(body, user);
      return sendJson(res, 201, equipment);
    }
    const equipmentMatch = pathname.match(/^\/api\/equipment\/([^/]+)$/);
    if (equipmentMatch && method === 'PATCH') {
      const body = await readBody(req);
      db.updateEquipment(decodeURIComponent(equipmentMatch[1]), body, user);
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === '/api/media' && method === 'POST') {
      const mime = (req.headers['content-type'] || '').split(';')[0].trim();
      const filename = decodeURIComponent(req.headers['x-file-name'] || '');
      const bytes = await readBinary(req);
      const media = db.addMedia({ mime, filename, bytes }, user);
      return sendJson(res, 201, media);
    }
    const mediaMatch = pathname.match(/^\/api\/media\/([^/]+)$/);
    if (mediaMatch && method === 'GET') {
      const media = db.getMedia(decodeURIComponent(mediaMatch[1]), user);
      if (!media) return sendJson(res, 404, { error: 'ไม่พบไฟล์' });
      return sendMedia(req, res, media);
    }
    if (mediaMatch && method === 'DELETE') {
      db.deleteMedia(decodeURIComponent(mediaMatch[1]), user);
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === '/api/reset' && method === 'POST') {
      db.resetAll(user);
      return sendJson(res, 200, { ok: true });
    }
    sendJson(res, 404, { error: 'ไม่พบ endpoint นี้' });
  } catch (err) {
    console.error(err);
    sendJson(res, err.status || 400, { code: err.code, error: err.message || 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  if (pathname.startsWith('/api/')) { handleApi(req, res, pathname, req.method); return; }
  if (serveStatic(req, res, pathname)) return;
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`SafeCheck server running at http://localhost:${PORT}`);
  // listen() with no host binds every interface, so the same server is already
  // reachable from a phone or tablet on the same Wi-Fi — print the address to use.
  const nets = require('os').networkInterfaces();
  Object.values(nets).flat()
    .filter(net => net && net.family === 'IPv4' && !net.internal)
    .forEach(net => console.log(`  on this network:      http://${net.address}:${PORT}`));
  console.log('Database: data/safecheck.db (created automatically, persists across restarts)');

  // Started from the desktop launcher rather than a terminal: open the browser too,
  // so running the demo is a double-click. Opt-in, so a plain `node server.js` still
  // behaves exactly as before.
  if (process.argv.includes('--open')) {
    const url = `http://localhost:${PORT}`;
    const opener = process.platform === 'win32' ? `start "" "${url}"`
      : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    require('child_process').exec(opener, () => { /* a failed open is not fatal */ });
  }
});

// A leftover server from a previous run is the most likely reason this port is taken,
// and a raw EADDRINUSE stack trace does not say that.
server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use — SafeCheck may already be running.`);
    console.error(`  Try opening http://localhost:${PORT} first.`);
    console.error(`  If it is not running, close the other window (or run: taskkill /F /IM node.exe) and start again.\n`);
    process.exit(1);
  }
  throw err;
});
