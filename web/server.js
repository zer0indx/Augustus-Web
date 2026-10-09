'use strict';
/*
 * Augustus Web — minimal backend (no npm dependencies).
 *
 *  GET    /healthz                    -> 200 OK
 *  GET    /login                      -> login page (or redirect to / if authed)
 *  GET    /logout                     -> clear session and redirect to /login
 *  GET    /api/auth/status            -> { authEnabled, requiresUser, user }
 *  POST   /api/auth/login             -> { username, password } -> sets session cookie
 *  POST   /api/auth/logout            -> clears session cookie
 *  GET    /api/config                 -> { mode, version, authEnabled, user }
 *  GET    /api/gamedata/manifest      -> { files: [{ path, size, mtime }], totalBytes, count }
 *  GET    /gamedata/<path>            -> raw game file (server mode)
 *  GET    /api/saves                  -> [{ path, size, mtime }]
 *  GET    /api/saves/<path>           -> raw save file
 *  PUT    /api/saves/<path>           -> store save file (body = bytes)
 *  DELETE /api/saves/<path>           -> delete save file
 *  everything else                    -> static files from PUBLIC_DIR
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '8080', 10);
const MODE = (process.env.GAME_DATA_MODE || 'server').toLowerCase() === 'upload' ? 'upload' : 'server';
const PUBLIC_DIR = path.resolve(process.env.PUBLIC_DIR || path.join(__dirname, 'public'));
const GAMEDATA_DIR = path.resolve(process.env.GAMEDATA_DIR || '/gamedata');
const SAVES_DIR = path.resolve(process.env.SAVES_DIR || '/saves');
const AUTH_USER = process.env.AUTH_USER || '';
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || '';
const MAX_SAVE_SIZE = parseInt(process.env.MAX_SAVE_SIZE_MB || '64', 10) * 1024 * 1024;
const EXCLUDE = (process.env.GAME_DATA_EXCLUDE ||
  '*.exe,*.dll,*.pdf,*.lnk,*.url,*.ico,*.sav,*.svx,*.log,unins*,goggame*,__support/*,__redist/*,*.tmp')
  .split(',').map((s) => s.trim()).filter(Boolean).map(globToRegExp);

let VERSION = 'unknown';
try { VERSION = fs.readFileSync(path.join(PUBLIC_DIR, 'version.txt'), 'utf8').trim(); } catch (e) { /* ignore */ }

// Persistent session secret
let SESSION_SECRET = '';
try {
  const secretPath = path.join(SAVES_DIR, '.session_secret');
  if (fs.existsSync(secretPath)) {
    SESSION_SECRET = fs.readFileSync(secretPath, 'utf8').trim();
  } else {
    SESSION_SECRET = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(secretPath, SESSION_SECRET, { mode: 0o600 });
  }
} catch (e) {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.wasm', '.json', '.txt', '.svg']);

function globToRegExp(glob) {
  const re = glob.toLowerCase().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + re + '$');
}

function isExcluded(relPath) {
  const lower = relPath.toLowerCase();
  const base = path.posix.basename(lower);
  return EXCLUDE.some((re) => re.test(lower) || re.test(base));
}

function safeJoin(root, urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch (e) { return null; }
  if (decoded.includes('\0')) return null;
  const parts = decoded.split('/').filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..' || p.includes('\\'))) return null;
  if (parts.length === 0) return null;
  const full = path.resolve(root, ...parts);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return { full, rel: parts.join('/') };
}

async function walk(root, rel = '', out = []) {
  let entries;
  try { entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true }); } catch (e) { return out; }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const childRel = rel ? rel + '/' + entry.name : entry.name;
    if (entry.isDirectory()) {
      await walk(root, childRel, out);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      try {
        const st = await fsp.stat(path.join(root, childRel));
        if (st.isFile()) out.push({ path: childRel, size: st.size, mtime: Math.floor(st.mtimeMs) });
      } catch (e) { /* broken symlink */ }
    }
  }
  return out;
}

function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, Object.assign({
    'Content-Length': buf.length,
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
  }, headers));
  res.end(buf);
}

function sendJson(res, obj, status = 200, headers = {}) {
  send(res, status, Buffer.from(JSON.stringify(obj)), Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  }, headers));
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function sendFile(req, res, full, cacheControl) {
  let st;
  try { st = await fsp.stat(full); } catch (e) { return send(res, 404, 'Not found'); }
  if (!st.isFile()) return send(res, 404, 'Not found');
  const etag = '"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
  const headers = {
    'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
    'Last-Modified': st.mtime.toUTCString(),
    'ETag': etag,
    'Cache-Control': cacheControl,
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  headers['Content-Length'] = st.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(full).on('error', () => res.destroy()).pipe(res);
}

const staticCache = new Map();
async function serveStatic(req, res, pathname) {
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  const target = safeJoin(PUBLIC_DIR, pathname);
  if (!target) return send(res, 404, 'Not found');
  const ext = path.extname(target.full).toLowerCase();
  let st;
  try { st = await fsp.stat(target.full); } catch (e) { return send(res, 404, 'Not found'); }
  if (!st.isFile()) return send(res, 404, 'Not found');
  const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  if (!COMPRESSIBLE.has(ext) || !acceptsGzip) {
    return sendFile(req, res, target.full, 'no-cache');
  }
  let entry = staticCache.get(target.full);
  if (!entry || entry.mtime !== st.mtimeMs) {
    const raw = await fsp.readFile(target.full);
    entry = {
      mtime: st.mtimeMs,
      gz: zlib.gzipSync(raw, { level: 9 }),
      etag: '"' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16) + '-gz"',
    };
    staticCache.set(target.full, entry);
  }
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Encoding': 'gzip',
    'Vary': 'Accept-Encoding',
    'ETag': entry.etag,
    'Cache-Control': 'no-cache',
  };
  if (req.headers['if-none-match'] === entry.etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  headers['Content-Length'] = entry.gz.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : entry.gz);
}

// ---- Session auth ------------------------------------------------------------------------
const isAuthEnabled = () => !!(AUTH_PASSWORD || AUTH_USER);

function makeSessionToken(username) {
  const expires = Date.now() + 30 * 86400 * 1000;
  const payload = Buffer.from(JSON.stringify({ u: username || 'admin', exp: expires })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (sig !== expectedSig) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.exp || data.exp < Date.now()) return null;
    return data.u;
  } catch (e) {
    return null;
  }
}

function getAuthenticatedUser(req) {
  if (!isAuthEnabled()) return 'guest';
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/(?:^|;\s*)augustus_session=([^;]+)/);
  if (!match) return null;
  return verifySessionToken(decodeURIComponent(match[1]));
}

// ---- saves --------------------------------------------------------------------------------
async function putSave(req, res, target) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_SAVE_SIZE) return send(res, 413, 'File too large');
    chunks.push(chunk);
  }
  await fsp.mkdir(path.dirname(target.full), { recursive: true });
  const tmp = target.full + '.' + process.pid + '.' + Date.now() + '.tmp';
  await fsp.writeFile(tmp, Buffer.concat(chunks));
  await fsp.rename(tmp, target.full);
  const st = await fsp.stat(target.full);
  log('saved', target.rel, st.size + ' bytes');
  sendJson(res, { path: target.rel, size: st.size, mtime: Math.floor(st.mtimeMs) });
}

async function deleteSave(res, target) {
  try {
    await fsp.unlink(target.full);
    log('deleted', target.rel);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  sendJson(res, { ok: true });
}

async function seedSaves() {
  if (MODE !== 'server') return;
  let entries = [];
  try { entries = await fsp.readdir(GAMEDATA_DIR, { withFileTypes: true }); } catch (e) { return; }
  for (const entry of entries) {
    const lower = entry.name.toLowerCase();
    if (!entry.isFile() || (!lower.endsWith('.sav') && !lower.endsWith('.svx') && !lower.endsWith('.mapx'))) continue;
    const dst = path.join(SAVES_DIR, entry.name);
    try {
      await fsp.access(dst);
    } catch (e) {
      await fsp.copyFile(path.join(GAMEDATA_DIR, entry.name), dst);
      log('seeded save from game folder:', entry.name);
    }
  }
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// ---- router -------------------------------------------------------------------------------
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const method = req.method;

  if (p === '/healthz') return send(res, 200, 'ok');

  // Auth endpoints
  if (p === '/api/auth/status' && method === 'GET') {
    const user = getAuthenticatedUser(req);
    return sendJson(res, {
      authEnabled: isAuthEnabled(),
      requiresUser: !!AUTH_USER,
      authenticated: !!user,
      user: user || null
    });
  }

  if (p === '/api/auth/login' && method === 'POST') {
    let body = {};
    try {
      const raw = await readRequestBody(req);
      body = JSON.parse(raw);
    } catch (e) {}

    const reqUser = (body.username || '').trim();
    const reqPass = body.password || '';

    const userMatches = !AUTH_USER || reqUser === AUTH_USER;
    const passMatches = !AUTH_PASSWORD || reqPass === AUTH_PASSWORD;

    if (!userMatches || !passMatches) {
      log('login failed for user:', reqUser || '(none)');
      return sendJson(res, { error: 'Wrong user name or password' }, 401);
    }

    const username = AUTH_USER || reqUser || 'admin';
    const token = makeSessionToken(username);
    log('login successful for user:', username);
    return sendJson(res, { ok: true, user: username }, 200, {
      'Set-Cookie': `augustus_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
    });
  }

  if ((p === '/api/auth/logout' && method === 'POST') || (p === '/logout' && method === 'GET')) {
    log('logout');
    res.writeHead(302, {
      'Set-Cookie': 'augustus_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
      'Location': '/login',
    });
    return res.end();
  }

  if (p === '/login') {
    if (getAuthenticatedUser(req)) {
      res.writeHead(302, { 'Location': '/' });
      return res.end();
    }
    const loginFile = path.join(PUBLIC_DIR, 'login.html');
    if (fs.existsSync(loginFile)) return sendFile(req, res, loginFile, 'no-cache');
    return send(res, 404, 'Login page missing');
  }

  // Check auth for all other routes
  const currentUser = getAuthenticatedUser(req);
  if (isAuthEnabled() && !currentUser) {
    // Allow public assets needed for login page
    if (['/launcher.css', '/augustus_256.png','/favicon.ico', '/background.jpg', '/pattern.webp'].includes(p)) {
      return serveStatic(req, res, p);
    }
    if (p.startsWith('/api/')) {
      return sendJson(res, { error: 'Authentication required' }, 401);
    }
    // Redirect browser to login page
    res.writeHead(302, { 'Location': '/login' });
    return res.end();
  }

  if (p === '/api/config' && method === 'GET') {
    return sendJson(res, {
      mode: MODE,
      version: VERSION,
      authEnabled: isAuthEnabled(),
      user: currentUser || null,
    });
  }

  if (p === '/api/gamedata/manifest' && method === 'GET') {
    if (MODE !== 'server') return send(res, 404, 'Game data mode is "upload"');
    const files = (await walk(GAMEDATA_DIR)).filter((f) => !isExcluded(f.path));
    if (files.length === 0) {
      return send(res, 503, 'Game data folder ' + GAMEDATA_DIR + ' is empty or not mounted');
    }
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    return sendJson(res, {
      files,
      count: files.length,
      totalBytes,
      version: files.length + ':' + totalBytes,
    });
  }

  if (p.startsWith('/gamedata/') && (method === 'GET' || method === 'HEAD')) {
    if (MODE !== 'server') return send(res, 404, 'Not found');
    const target = safeJoin(GAMEDATA_DIR, p.slice('/gamedata/'.length));
    if (!target || isExcluded(target.rel)) return send(res, 404, 'Not found');
    return sendFile(req, res, target.full, 'no-cache');
  }

  if (p === '/api/saves' && method === 'GET') {
    const files = (await walk(SAVES_DIR)).filter((f) => !f.path.endsWith('.tmp') && !f.path.startsWith('.'));
    return sendJson(res, files);
  }

  if (p.startsWith('/api/saves/')) {
    const target = safeJoin(SAVES_DIR, p.slice('/api/saves/'.length));
    if (!target) return send(res, 400, 'Bad path');
    if (method === 'GET' || method === 'HEAD') return sendFile(req, res, target.full, 'no-store');
    if (method === 'PUT') return putSave(req, res, target);
    if (method === 'DELETE') return deleteSave(res, target);
    return send(res, 405, 'Method not allowed');
  }

  if (p.startsWith('/api/')) return send(res, 404, 'Not found');

  if (method === 'GET' || method === 'HEAD') return serveStatic(req, res, p);
  return send(res, 405, 'Method not allowed');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    log('error', req.method, req.url, err && err.stack || err);
    if (!res.headersSent) send(res, 500, 'Internal error: ' + (err && err.message));
    else res.destroy();
  });
});

(async () => {
  await fsp.mkdir(SAVES_DIR, { recursive: true });
  await seedSaves().catch((e) => log('seed failed', e.message));
  server.listen(PORT, () => {
    log(`Augustus Web ${VERSION} listening on :${PORT}`);
    log(`mode=${MODE} gamedata=${MODE === 'server' ? GAMEDATA_DIR : '(browser upload)'} saves=${SAVES_DIR}` +
      (isAuthEnabled() ? ` auth=on (${AUTH_USER ? 'user+pass' : 'password-only'})` : ' auth=off'));
  });
})();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
