'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('./src/db');
const { match, HttpError } = require('./src/api');
const { sessionUser, hasRole, SESSION_TTL_MS } = require('./src/auth');

const PUBLIC_DIR = path.join(__dirname, 'public');
const COOKIE = 'rcb_session';
const MAX_BODY = 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
};

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Request body too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) {
      // Unknown non-asset paths fall back to the SPA shell.
      if (!path.extname(rel)) return serveStatic(req, res, '/');
      return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    }
    send(res, 200, data, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  });
}

function createServer({ dbFile, secureCookies } = {}) {
  const db = openDatabase(dbFile || process.env.DB_FILE || path.join(__dirname, 'data', 'billing.db'));
  const secure = secureCookies ?? process.env.COOKIE_SECURE === '1';

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      return serveStatic(req, res, pathname);
    }

    const cookieHeaders = [];
    try {
      const m = match(req.method, pathname);
      if (!m) throw new HttpError(404, 'Not found.');
      if (m.methodNotAllowed) throw new HttpError(405, 'Method not allowed.');

      const token = parseCookies(req.headers.cookie)[COOKIE];
      const user = sessionUser(db, token);
      if (m.route.minRole && !user) throw new HttpError(401, 'Please sign in.');
      if (m.route.minRole && !hasRole(user, m.route.minRole)) throw new HttpError(403, 'Your role does not permit this action.');

      let body = {};
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        // Requiring JSON blocks cross-site form posts (CSRF) in addition to the SameSite cookie.
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
          throw new HttpError(415, 'Content-Type must be application/json.');
        }
        const raw = await readBody(req);
        try { body = raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, 'Malformed JSON.'); }
        if (typeof body !== 'object' || body === null) body = {};
      }

      const ctx = {
        db, user, token, body, params: m.params, query: Object.fromEntries(url.searchParams),
        ip: req.socket.remoteAddress,
        setCookie(value, maxAgeMs = SESSION_TTL_MS) {
          cookieHeaders.push(`${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure ? '; Secure' : ''}`);
        },
      };
      const result = await m.route.handler(ctx);
      const headers = cookieHeaders.length ? { 'Set-Cookie': cookieHeaders } : {};
      if (result && result.__file) {
        const safeName = result.__file.name.replace(/[^\w.-]/g, '_');
        return send(res, 200, result.__file.body, {
          ...headers, 'Content-Type': result.__file.type, 'Content-Disposition': `attachment; filename="${safeName}"`,
        });
      }
      sendJson(res, 200, result ?? { ok: true }, headers);
    } catch (err) {
      const headers = cookieHeaders.length ? { 'Set-Cookie': cookieHeaders } : {};
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message }, headers);
      if (err && /UNIQUE constraint failed/.test(err.message)) return sendJson(res, 409, { error: 'That record already exists.' }, headers);
      if (err && /FOREIGN KEY constraint failed/.test(err.message)) return sendJson(res, 409, { error: 'That record is in use by other records.' }, headers);
      console.error(err);
      sendJson(res, 500, { error: 'Unexpected server error.' }, headers);
    }
  });
  server.db = db;
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '127.0.0.1';
  createServer().listen(port, host, () => {
    console.log(`Regional Center Billing running at http://${host}:${port}`);
  });
}

module.exports = { createServer };
