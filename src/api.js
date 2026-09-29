'use strict';

const B = require('./billing');
const A = require('./auth');
const { transaction, UNIT_TYPES } = require('./db');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (msg) => new HttpError(400, msg);
const notFound = (what) => new HttpError(404, `${what} not found.`);
const conflict = (msg) => new HttpError(409, msg);

// ---------- input helpers ----------

function str(v, { max = 200, required = false, name = 'Field' } = {}) {
  const s = v === null || v === undefined ? '' : String(v).trim();
  if (required && !s) throw bad(`${name} is required.`);
  if (s.length > max) throw bad(`${name} is too long (max ${max} characters).`);
  return s || null;
}

function oneOf(v, allowed, name) {
  if (!allowed.includes(v)) throw bad(`${name} must be one of: ${allowed.join(', ')}.`);
  return v;
}

function date(v, name, required = true) {
  if (!v && !required) return null;
  if (!B.isValidDate(v)) throw bad(`${name} must be a valid date (YYYY-MM-DD).`);
  return v;
}

function month(v) {
  if (!B.isValidMonth(v)) throw bad('Month must be in YYYY-MM format.');
  return v;
}

function num(v, name, { min = 0, max = 1e9, required = true } = {}) {
  if ((v === '' || v === null || v === undefined) && !required) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw bad(`${name} must be a number between ${min} and ${max}.`);
  return n;
}

function cents(v, name, { required = true, allowZero = false } = {}) {
  const c = B.dollarsToCents(v);
  if (c === null) {
    if (!required) return null;
    throw bad(`${name} must be a dollar amount.`);
  }
  if (c < 0 || (!allowZero && c === 0)) throw bad(`${name} must be greater than zero.`);
  if (c > 1e11) throw bad(`${name} is too large.`);
  return c;
}

function id(v, name = 'ID') {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw bad(`${name} is invalid.`);
  return n;
}

function bool(v) {
  return v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0;
}

function today() {
  const tz = process.env.BILLING_TZ || 'America/Los_Angeles';
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function audit(ctx, action, entity, entityId, detail) {
  ctx.db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?)')
    .run(ctx.user ? ctx.user.id : null, action, entity, entityId ?? null, detail ? JSON.stringify(detail) : null);
}

function get(db, sql, ...args) {
  return db.prepare(sql).get(...args);
}
function all(db, sql, ...args) {
  return db.prepare(sql).all(...args);
}

// ---------- routing ----------

const routes = [];
function route(method, pattern, minRole, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, minRole, handler });
}

function match(method, pathname) {
  let allowed = false;
  for (const r of routes) {
    const m = r.re.exec(pathname);
    if (!m) continue;
    if (r.method !== method) { allowed = true; continue; }
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    return { route: r, params };
  }
  return allowed ? { methodNotAllowed: true } : null;
}

// ---------- auth & setup ----------

route('GET', '/api/setup-status', null, ({ db }) => ({
  needsSetup: get(db, 'SELECT COUNT(*) AS n FROM users').n === 0,
}));

route('POST', '/api/setup', null, (ctx) => {
  const { db, body } = ctx;
  if (get(db, 'SELECT COUNT(*) AS n FROM users').n > 0) throw conflict('Setup has already been completed.');
  const username = str(body.username, { required: true, max: 60, name: 'Username' });
  const full_name = str(body.full_name, { required: true, max: 120, name: 'Full name' });
  const problem = A.passwordProblem(body.password);
  if (problem) throw bad(problem);
  const orgName = str(body.organization_name, { max: 200, name: 'Organization name' });
  const r = db.prepare("INSERT INTO users (username, full_name, password_hash, role) VALUES (?, ?, ?, 'admin')")
    .run(username, full_name, A.hashPassword(body.password));
  if (orgName) db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('organization_name', ?)").run(orgName);
  ctx.user = { id: Number(r.lastInsertRowid) };
  audit(ctx, 'setup', 'user', ctx.user.id);
  const token = A.createSession(db, ctx.user.id);
  ctx.setCookie(token);
  return { ok: true };
});

route('POST', '/api/login', null, (ctx) => {
  const { db, body } = ctx;
  const username = String(body.username || '').trim();
  const key = `${ctx.ip}|${username.toLowerCase()}`;
  if (A.loginThrottled(key)) throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
  const u = get(db, 'SELECT * FROM users WHERE username = ? AND active = 1', username);
  if (!u || !A.verifyPassword(String(body.password || ''), u.password_hash)) {
    A.recordFailedLogin(key);
    ctx.user = null;
    audit(ctx, 'login_failed', 'user', u ? u.id : null, { username });
    throw new HttpError(401, 'Invalid username or password.');
  }
  A.clearFailedLogins(key);
  ctx.setCookie(A.createSession(db, u.id));
  ctx.user = u;
  audit(ctx, 'login', 'user', u.id);
  return { ok: true };
});

route('POST', '/api/logout', null, (ctx) => {
  A.destroySession(ctx.db, ctx.token);
  ctx.setCookie('', 0);
  return { ok: true };
});

route('GET', '/api/me', 'viewer', (ctx) => ({
  user: ctx.user,
  organization_name: (get(ctx.db, "SELECT value FROM settings WHERE key = 'organization_name'") || {}).value || null,
  today: today(),
}));

route('POST', '/api/me/password', 'viewer', (ctx) => {
  const { db, body, user } = ctx;
  const u = get(db, 'SELECT password_hash FROM users WHERE id = ?', user.id);
  if (!A.verifyPassword(String(body.current_password || ''), u.password_hash)) throw bad('Current password is incorrect.');
  const problem = A.passwordProblem(body.new_password);
  if (problem) throw bad(problem);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(A.hashPassword(body.new_password), user.id);
  audit(ctx, 'password_change', 'user', user.id);
  return { ok: true };
});

// ---------- reference data ----------

route('GET', '/api/meta', 'viewer', ({ db }) => ({
  regional_centers: all(db, 'SELECT * FROM regional_centers ORDER BY name'),
  service_codes: all(db, 'SELECT * FROM service_codes ORDER BY code'),
  programs: all(db, `SELECT p.*, rc.name AS regional_center_name, rc.abbreviation AS rc_abbr, sc.description AS service_description
    FROM programs p JOIN regional_centers rc ON rc.id = p.regional_center_id
    JOIN service_codes sc ON sc.code = p.service_code ORDER BY p.name`),
  unit_types: UNIT_TYPES,
}));

function rcInput(body) {
  return [
    str(body.name, { required: true, max: 120, name: 'Name' }),
    str(body.abbreviation, { max: 20, name: 'Abbreviation' }),
    str(body.address, { max: 300, name: 'Address' }),
    str(body.phone, { max: 40, name: 'Phone' }),
    str(body.billing_contact, { max: 120, name: 'Billing contact' }),
    str(body.billing_email, { max: 200, name: 'Billing email' }),
    body.active === undefined ? 1 : bool(body.active),
  ];
}

route('POST', '/api/regional-centers', 'admin', (ctx) => {
  const r = ctx.db.prepare(`INSERT INTO regional_centers (name, abbreviation, address, phone, billing_contact, billing_email, active)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(...rcInput(ctx.body));
  audit(ctx, 'create', 'regional_center', Number(r.lastInsertRowid));
  return { id: Number(r.lastInsertRowid) };
});

route('PUT', '/api/regional-centers/:id', 'admin', (ctx) => {
  const rid = id(ctx.params.id);
  const r = ctx.db.prepare(`UPDATE regional_centers SET name=?, abbreviation=?, address=?, phone=?, billing_contact=?, billing_email=?, active=?
    WHERE id = ?`).run(...rcInput(ctx.body), rid);
  if (!r.changes) throw notFound('Regional center');
  audit(ctx, 'update', 'regional_center', rid);
  return { ok: true };
});

route('POST', '/api/service-codes', 'admin', (ctx) => {
  const { body, db } = ctx;
  const code = str(body.code, { required: true, max: 10, name: 'Code' });
  if (!/^[0-9A-Za-z]+$/.test(code)) throw bad('Code must be alphanumeric.');
  db.prepare(`INSERT INTO service_codes (code, description, default_unit_type) VALUES (?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET description = excluded.description, default_unit_type = excluded.default_unit_type`)
    .run(code, str(body.description, { required: true, max: 200, name: 'Description' }),
      oneOf(body.default_unit_type, UNIT_TYPES, 'Unit type'));
  audit(ctx, 'upsert', 'service_code', null, { code });
  return { ok: true };
});

function programInput(db, body) {
  const rcId = id(body.regional_center_id, 'Regional center');
  if (!get(db, 'SELECT id FROM regional_centers WHERE id = ?', rcId)) throw bad('Regional center not found.');
  const code = str(body.service_code, { required: true, max: 10, name: 'Service code' });
  if (!get(db, 'SELECT code FROM service_codes WHERE code = ?', code)) throw bad('Unknown service code. Add it under Settings first.');
  return [
    str(body.name, { required: true, max: 120, name: 'Program name' }),
    str(body.vendor_number, { required: true, max: 20, name: 'Vendor number' }).toUpperCase(),
    rcId,
    code,
    str(body.subcode, { max: 10, name: 'Subcode' }),
    oneOf(body.unit_type, UNIT_TYPES, 'Unit type'),
    cents(body.default_rate, 'Default rate', { required: false }),
    num(body.full_day_min_hours, 'Full-day minimum hours', { max: 24, required: false }),
    bool(body.bills_weekends),
    body.active === undefined ? 1 : bool(body.active),
  ];
}

route('POST', '/api/programs', 'admin', (ctx) => {
  const r = ctx.db.prepare(`INSERT INTO programs (name, vendor_number, regional_center_id, service_code, subcode, unit_type,
    default_rate_cents, full_day_min_hours, bills_weekends, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(...programInput(ctx.db, ctx.body));
  audit(ctx, 'create', 'program', Number(r.lastInsertRowid));
  return { id: Number(r.lastInsertRowid) };
});

route('PUT', '/api/programs/:id', 'admin', (ctx) => {
  const pid = id(ctx.params.id);
  const r = ctx.db.prepare(`UPDATE programs SET name=?, vendor_number=?, regional_center_id=?, service_code=?, subcode=?, unit_type=?,
    default_rate_cents=?, full_day_min_hours=?, bills_weekends=?, active=? WHERE id = ?`)
    .run(...programInput(ctx.db, ctx.body), pid);
  if (!r.changes) throw notFound('Program');
  audit(ctx, 'update', 'program', pid);
  return { ok: true };
});

// ---------- users ----------

route('GET', '/api/users', 'admin', ({ db }) => ({
  users: all(db, 'SELECT id, username, full_name, role, active, created_at FROM users ORDER BY full_name'),
}));

route('POST', '/api/users', 'admin', (ctx) => {
  const { db, body } = ctx;
  const problem = A.passwordProblem(body.password);
  if (problem) throw bad(problem);
  const username = str(body.username, { required: true, max: 60, name: 'Username' });
  if (get(db, 'SELECT id FROM users WHERE username = ?', username)) throw conflict('That username is taken.');
  const r = db.prepare('INSERT INTO users (username, full_name, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(username, str(body.full_name, { required: true, max: 120, name: 'Full name' }),
      A.hashPassword(body.password), oneOf(body.role, ['admin', 'biller', 'staff', 'viewer'], 'Role'));
  audit(ctx, 'create', 'user', Number(r.lastInsertRowid), { username, role: body.role });
  return { id: Number(r.lastInsertRowid) };
});

route('PUT', '/api/users/:id', 'admin', (ctx) => {
  const { db, body } = ctx;
  const uid = id(ctx.params.id);
  const u = get(db, 'SELECT * FROM users WHERE id = ?', uid);
  if (!u) throw notFound('User');
  const role = oneOf(body.role, ['admin', 'biller', 'staff', 'viewer'], 'Role');
  const active = bool(body.active);
  if (uid === ctx.user.id && (role !== 'admin' || !active)) throw bad('You cannot remove your own admin access.');
  transaction(db, () => {
    db.prepare('UPDATE users SET full_name = ?, role = ?, active = ? WHERE id = ?')
      .run(str(body.full_name, { required: true, max: 120, name: 'Full name' }), role, active, uid);
    if (body.password) {
      const problem = A.passwordProblem(body.password);
      if (problem) throw bad(problem);
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(A.hashPassword(body.password), uid);
    }
    if (!active || body.password) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(uid);
  });
  audit(ctx, 'update', 'user', uid, { role, active, password_reset: !!body.password });
  return { ok: true };
});

route('GET', '/api/audit', 'admin', ({ db, query }) => ({
  entries: all(db, `SELECT a.*, u.full_name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    ORDER BY a.id DESC LIMIT ?`, Math.min(Number(query.limit) || 200, 1000)),
}));

// ---------- consumers ----------

function consumerInput(db, body) {
  const uci = str(body.uci, { required: true, max: 7, name: 'UCI' });
  if (!B.isValidUci(uci)) throw bad('UCI must be exactly 7 digits.');
  const rcId = id(body.regional_center_id, 'Regional center');
  if (!get(db, 'SELECT id FROM regional_centers WHERE id = ?', rcId)) throw bad('Regional center not found.');
  return [
    uci,
    str(body.first_name, { required: true, max: 80, name: 'First name' }),
    str(body.last_name, { required: true, max: 80, name: 'Last name' }),
    date(body.dob, 'Date of birth', false),
    rcId,
    str(body.service_coordinator, { max: 120, name: 'Service coordinator' }),
    str(body.sc_phone, { max: 40, name: 'SC phone' }),
    str(body.sc_email, { max: 200, name: 'SC email' }),
    oneOf(body.status || 'active', ['active', 'inactive', 'pending'], 'Status'),
    str(body.notes, { max: 2000, name: 'Notes' }),
  ];
}

route('GET', '/api/consumers', 'viewer', ({ db, query }) => {
  const where = [];
  const args = [];
  if (query.q) {
    where.push("(c.uci LIKE ? OR c.first_name LIKE ? OR c.last_name LIKE ? OR (c.first_name || ' ' || c.last_name) LIKE ?)");
    const q = `%${query.q}%`;
    args.push(q, q, q, q);
  }
  if (query.status) { where.push('c.status = ?'); args.push(query.status); }
  if (query.regional_center_id) { where.push('c.regional_center_id = ?'); args.push(Number(query.regional_center_id)); }
  const t = today();
  return {
    consumers: all(db, `SELECT c.*, rc.abbreviation AS rc_abbr, rc.name AS regional_center_name,
        (SELECT COUNT(*) FROM authorizations a WHERE a.consumer_id = c.id AND a.status = 'active' AND a.end_date >= ?) AS active_auths
      FROM consumers c JOIN regional_centers rc ON rc.id = c.regional_center_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY c.last_name, c.first_name`, t, ...args),
  };
});

route('GET', '/api/consumers/:id', 'viewer', (ctx) => {
  const { db } = ctx;
  const cid = id(ctx.params.id);
  const consumer = get(db, `SELECT c.*, rc.name AS regional_center_name FROM consumers c
    JOIN regional_centers rc ON rc.id = c.regional_center_id WHERE c.id = ?`, cid);
  if (!consumer) throw notFound('Consumer');
  audit(ctx, 'view', 'consumer', cid);
  return {
    consumer,
    authorizations: authQuery(db, 'a.consumer_id = ?', [cid]),
  };
});

route('POST', '/api/consumers', 'biller', (ctx) => {
  const vals = consumerInput(ctx.db, ctx.body);
  if (get(ctx.db, 'SELECT id FROM consumers WHERE uci = ?', vals[0])) throw conflict('A consumer with that UCI already exists.');
  const r = ctx.db.prepare(`INSERT INTO consumers (uci, first_name, last_name, dob, regional_center_id, service_coordinator,
    sc_phone, sc_email, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...vals);
  audit(ctx, 'create', 'consumer', Number(r.lastInsertRowid));
  return { id: Number(r.lastInsertRowid) };
});

route('PUT', '/api/consumers/:id', 'biller', (ctx) => {
  const cid = id(ctx.params.id);
  const vals = consumerInput(ctx.db, ctx.body);
  const dupe = get(ctx.db, 'SELECT id FROM consumers WHERE uci = ? AND id <> ?', vals[0], cid);
  if (dupe) throw conflict('Another consumer already has that UCI.');
  const r = ctx.db.prepare(`UPDATE consumers SET uci=?, first_name=?, last_name=?, dob=?, regional_center_id=?, service_coordinator=?,
    sc_phone=?, sc_email=?, status=?, notes=? WHERE id = ?`).run(...vals, cid);
  if (!r.changes) throw notFound('Consumer');
  audit(ctx, 'update', 'consumer', cid);
  return { ok: true };
});

// ---------- authorizations ----------

function authQuery(db, whereSql, args) {
  const t = today();
  const m = t.slice(0, 7);
  return all(db, `SELECT a.*, c.first_name, c.last_name, c.uci, p.name AS program_name, p.vendor_number, p.service_code, p.subcode,
      (SELECT COALESCE(SUM(l.units), 0) FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
         WHERE l.authorization_id = a.id AND i.status <> 'void') AS units_billed_total,
      (SELECT COALESCE(SUM(l.units), 0) FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
         WHERE l.authorization_id = a.id AND i.status <> 'void' AND i.service_month = ?) AS units_billed_this_month,
      (SELECT COALESCE(SUM(t.units), 0) FROM attendance t WHERE t.authorization_id = a.id
         AND t.status IN ('present','partial') AND substr(t.service_date, 1, 7) = ?) AS units_recorded_this_month,
      CAST(julianday(a.end_date) - julianday(?) AS INTEGER) AS days_to_expiration
    FROM authorizations a JOIN consumers c ON c.id = a.consumer_id JOIN programs p ON p.id = a.program_id
    WHERE ${whereSql} ORDER BY a.end_date DESC, c.last_name`, m, m, t, ...args);
}

function authInput(db, body) {
  const consumerId = id(body.consumer_id, 'Consumer');
  if (!get(db, 'SELECT id FROM consumers WHERE id = ?', consumerId)) throw bad('Consumer not found.');
  const programId = id(body.program_id, 'Program');
  if (!get(db, 'SELECT id FROM programs WHERE id = ?', programId)) throw bad('Program not found.');
  const start = date(body.start_date, 'Start date');
  const end = date(body.end_date, 'End date');
  if (end < start) throw bad('End date must be on or after the start date.');
  return [
    str(body.auth_number, { required: true, max: 40, name: 'Authorization number' }),
    consumerId,
    programId,
    oneOf(body.unit_type, UNIT_TYPES, 'Unit type'),
    cents(body.rate, 'Rate'),
    num(body.units_authorized, 'Units authorized', { max: 100000 }),
    oneOf(body.units_period || 'month', ['month', 'total'], 'Units period'),
    start,
    end,
    oneOf(body.status || 'active', ['active', 'pending', 'expired', 'terminated'], 'Status'),
    str(body.notes, { max: 2000, name: 'Notes' }),
  ];
}

route('GET', '/api/authorizations', 'viewer', ({ db, query }) => {
  const where = ['1 = 1'];
  const args = [];
  if (query.program_id) { where.push('a.program_id = ?'); args.push(Number(query.program_id)); }
  if (query.consumer_id) { where.push('a.consumer_id = ?'); args.push(Number(query.consumer_id)); }
  if (query.status) { where.push('a.status = ?'); args.push(query.status); }
  if (query.expiring_days) {
    where.push("a.status = 'active' AND a.end_date BETWEEN ? AND ?");
    const t = today();
    args.push(t, B.addDays(t, Number(query.expiring_days) || 30));
  }
  if (query.q) {
    where.push("(a.auth_number LIKE ? OR c.uci LIKE ? OR c.last_name LIKE ? OR c.first_name LIKE ?)");
    const q = `%${query.q}%`;
    args.push(q, q, q, q);
  }
  return { authorizations: authQuery(db, where.join(' AND '), args) };
});

route('POST', '/api/authorizations', 'biller', (ctx) => {
  const vals = authInput(ctx.db, ctx.body);
  if (get(ctx.db, 'SELECT id FROM authorizations WHERE auth_number = ? AND program_id = ?', vals[0], vals[2])) {
    throw conflict('That authorization number already exists for this program.');
  }
  const r = ctx.db.prepare(`INSERT INTO authorizations (auth_number, consumer_id, program_id, unit_type, rate_cents, units_authorized,
    units_period, start_date, end_date, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...vals);
  audit(ctx, 'create', 'authorization', Number(r.lastInsertRowid), { auth_number: vals[0] });
  return { id: Number(r.lastInsertRowid) };
});

route('PUT', '/api/authorizations/:id', 'biller', (ctx) => {
  const aid = id(ctx.params.id);
  const vals = authInput(ctx.db, ctx.body);
  const r = ctx.db.prepare(`UPDATE authorizations SET auth_number=?, consumer_id=?, program_id=?, unit_type=?, rate_cents=?,
    units_authorized=?, units_period=?, start_date=?, end_date=?, status=?, notes=? WHERE id = ?`).run(...vals, aid);
  if (!r.changes) throw notFound('Authorization');
  audit(ctx, 'update', 'authorization', aid);
  return { ok: true };
});

// ---------- attendance ----------

function lockedInvoice(db, authId, m) {
  return get(db, `SELECT i.invoice_number FROM invoices i JOIN invoice_lines l ON l.invoice_id = i.id
    WHERE l.authorization_id = ? AND i.service_month = ? AND i.status NOT IN ('draft','void') LIMIT 1`, authId, m);
}

route('GET', '/api/attendance', 'viewer', ({ db, query }) => {
  const programId = id(query.program_id, 'Program');
  const m = month(query.month);
  const { start, end, days } = B.monthBounds(m);
  const program = get(db, 'SELECT * FROM programs WHERE id = ?', programId);
  if (!program) throw notFound('Program');
  const auths = all(db, `SELECT a.id, a.auth_number, a.start_date, a.end_date, a.status, a.unit_type, a.units_authorized,
      a.units_period, c.id AS consumer_id, c.first_name, c.last_name, c.uci
    FROM authorizations a JOIN consumers c ON c.id = a.consumer_id
    WHERE a.program_id = ? AND a.start_date <= ? AND a.end_date >= ? AND a.status IN ('active','pending')
    ORDER BY c.last_name, c.first_name`, programId, end, start);
  const recs = all(db, `SELECT t.authorization_id, t.service_date, t.status, t.units, t.hours, t.note
    FROM attendance t JOIN authorizations a ON a.id = t.authorization_id
    WHERE a.program_id = ? AND t.service_date BETWEEN ? AND ?`, programId, start, end);
  const byAuth = {};
  for (const r of recs) (byAuth[r.authorization_id] ||= {})[r.service_date] = r;
  return {
    program,
    month: m,
    days,
    rows: auths.map((a) => ({ ...a, locked: lockedInvoice(db, a.id, m)?.invoice_number || null, records: byAuth[a.id] || {} })),
  };
});

route('PUT', '/api/attendance', 'staff', (ctx) => {
  const { db, body } = ctx;
  if (!Array.isArray(body.entries) || body.entries.length === 0) throw bad('No attendance entries supplied.');
  if (body.entries.length > 5000) throw bad('Too many entries in one save.');
  const upsert = db.prepare(`INSERT INTO attendance (authorization_id, service_date, status, units, hours, note, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(authorization_id, service_date) DO UPDATE SET status = excluded.status, units = excluded.units,
      hours = excluded.hours, note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`);
  const del = db.prepare('DELETE FROM attendance WHERE authorization_id = ? AND service_date = ?');
  const authCache = new Map();
  let saved = 0;
  transaction(db, () => {
    for (const e of body.entries) {
      const aid = id(e.authorization_id, 'Authorization');
      const d = date(e.service_date, 'Service date');
      if (!authCache.has(aid)) {
        const a = get(db, 'SELECT id, start_date, end_date FROM authorizations WHERE id = ?', aid);
        if (!a) throw bad(`Authorization ${aid} not found.`);
        authCache.set(aid, a);
      }
      const locked = lockedInvoice(db, aid, d.slice(0, 7));
      if (locked) throw conflict(`Attendance for ${d.slice(0, 7)} is locked by submitted invoice ${locked.invoice_number}. Void the invoice to make changes.`);
      if (!e.status) { del.run(aid, d); saved++; continue; }
      const status = oneOf(e.status, ['present', 'partial', 'absent', 'excused', 'holiday'], 'Attendance status');
      const billable = status === 'present' || status === 'partial';
      const defaultUnits = status === 'present' ? 1 : 0.5;
      const given = e.units === undefined || e.units === null || e.units === '' ? defaultUnits : e.units;
      const units = billable ? num(given, 'Units', { max: 24 }) : 0;
      upsert.run(aid, d, status, units, num(e.hours, 'Hours', { max: 24, required: false }),
        str(e.note, { max: 500, name: 'Note' }), ctx.user.id);
      saved++;
    }
  });
  audit(ctx, 'save', 'attendance', null, { entries: saved });
  return { saved };
});

// ---------- invoices ----------

function priorBilledUnits(db, authId, excludeInvoiceId) {
  return get(db, `SELECT COALESCE(SUM(l.units), 0) AS u FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
    WHERE l.authorization_id = ? AND i.status <> 'void' AND i.id <> ?`, authId, excludeInvoiceId || 0).u;
}

function generateInvoice(ctx, programId, m) {
  const { db } = ctx;
  const program = get(db, 'SELECT * FROM programs WHERE id = ?', programId);
  if (!program) throw notFound('Program');
  const existing = all(db, "SELECT * FROM invoices WHERE program_id = ? AND service_month = ? AND status <> 'void'", programId, m);
  const finalized = existing.find((i) => i.status !== 'draft');
  if (finalized) throw conflict(`Invoice ${finalized.invoice_number} for this program and month has already been submitted. Void it first to rebill.`);
  const { start, end } = B.monthBounds(m);
  const auths = all(db, `SELECT a.* FROM authorizations a WHERE a.program_id = ? AND a.start_date <= ? AND a.end_date >= ?
    AND a.status IN ('active','pending')`, programId, end, start);
  const attStmt = db.prepare(`SELECT service_date, status, units, hours FROM attendance
    WHERE authorization_id = ? AND service_date BETWEEN ? AND ?`);
  const t = today();

  return transaction(db, () => {
    let inv = existing[0];
    if (inv) {
      db.prepare('DELETE FROM invoice_lines WHERE invoice_id = ?').run(inv.id);
    } else {
      const r = db.prepare(`INSERT INTO invoices (invoice_number, program_id, regional_center_id, service_month, created_by)
        VALUES (?, ?, ?, ?, ?)`).run(`TMP-${Date.now()}-${Math.random()}`, programId, program.regional_center_id, m, ctx.user.id);
      const newId = Number(r.lastInsertRowid);
      const number = `${m.replace('-', '')}-${program.vendor_number}-${String(newId).padStart(5, '0')}`;
      db.prepare('UPDATE invoices SET invoice_number = ? WHERE id = ?').run(number, newId);
      inv = get(db, 'SELECT * FROM invoices WHERE id = ?', newId);
    }
    const ins = db.prepare(`INSERT INTO invoice_lines (invoice_id, authorization_id, consumer_id, units, rate_cents, amount_cents,
      unbilled_units, daily_units, flags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let total = 0;
    for (const a of auths) {
      const records = attStmt.all(a.id, start, end);
      if (records.length === 0) continue;
      const line = B.buildInvoiceLine(a, records, m, {
        program, today: t, priorBilledUnits: a.units_period === 'total' ? priorBilledUnits(db, a.id, inv.id) : 0,
      });
      if (line.units === 0 && line.unbilled_units === 0) continue;
      ins.run(inv.id, a.id, a.consumer_id, line.units, line.rate_cents, line.amount_cents, line.unbilled_units,
        JSON.stringify(line.daily_units), JSON.stringify(line.flags));
      total += line.amount_cents;
    }
    db.prepare('UPDATE invoices SET total_cents = ? WHERE id = ?').run(total, inv.id);
    audit(ctx, existing[0] ? 'regenerate' : 'create', 'invoice', inv.id, { service_month: m, total_cents: total });
    return inv.id;
  });
}

route('POST', '/api/invoices/generate', 'biller', (ctx) => {
  const m = month(ctx.body.month);
  const ids = ctx.body.program_id === 'all'
    ? all(ctx.db, 'SELECT id FROM programs WHERE active = 1').map((p) => p.id)
    : [id(ctx.body.program_id, 'Program')];
  const results = [];
  for (const pid of ids) {
    try {
      results.push({ program_id: pid, invoice_id: generateInvoice(ctx, pid, m) });
    } catch (err) {
      if (ids.length === 1 || !(err instanceof HttpError)) throw err;
      results.push({ program_id: pid, error: err.message });
    }
  }
  return { results };
});

function invoiceSummarySql(where) {
  return `SELECT i.*, p.name AS program_name, p.vendor_number, p.service_code, rc.name AS regional_center_name,
      rc.abbreviation AS rc_abbr,
      (SELECT COUNT(*) FROM invoice_lines l WHERE l.invoice_id = i.id) AS line_count,
      (SELECT COALESCE(SUM(pa.amount_cents), 0) FROM payment_allocations pa JOIN invoice_lines l ON l.id = pa.invoice_line_id
         WHERE l.invoice_id = i.id) AS paid_cents
    FROM invoices i JOIN programs p ON p.id = i.program_id JOIN regional_centers rc ON rc.id = i.regional_center_id
    ${where} ORDER BY i.service_month DESC, p.name`;
}

route('GET', '/api/invoices', 'viewer', ({ db, query }) => {
  const where = ['1 = 1'];
  const args = [];
  if (query.month) { where.push('i.service_month = ?'); args.push(query.month); }
  if (query.status) { where.push('i.status = ?'); args.push(query.status); }
  if (query.regional_center_id) { where.push('i.regional_center_id = ?'); args.push(Number(query.regional_center_id)); }
  if (query.program_id) { where.push('i.program_id = ?'); args.push(Number(query.program_id)); }
  return { invoices: all(db, invoiceSummarySql('WHERE ' + where.join(' AND ')), ...args) };
});

function loadInvoice(db, invId) {
  const invoice = get(db, invoiceSummarySql('WHERE i.id = ?'), invId);
  if (!invoice) throw notFound('Invoice');
  const lines = all(db, `SELECT l.*, c.first_name, c.last_name, c.uci, a.auth_number, a.unit_type, a.units_authorized, a.units_period,
      a.start_date AS auth_start, a.end_date AS auth_end,
      (SELECT COALESCE(SUM(pa.amount_cents), 0) FROM payment_allocations pa WHERE pa.invoice_line_id = l.id) AS paid_cents
    FROM invoice_lines l JOIN consumers c ON c.id = l.consumer_id JOIN authorizations a ON a.id = l.authorization_id
    WHERE l.invoice_id = ? ORDER BY c.last_name, c.first_name`, invId)
    .map((l) => ({ ...l, daily_units: JSON.parse(l.daily_units), flags: JSON.parse(l.flags) }));
  const program = get(db, `SELECT p.*, sc.description AS service_description FROM programs p
    JOIN service_codes sc ON sc.code = p.service_code WHERE p.id = ?`, invoice.program_id);
  const rc = get(db, 'SELECT * FROM regional_centers WHERE id = ?', invoice.regional_center_id);
  return { invoice, lines, program, regional_center: rc };
}

route('GET', '/api/invoices/:id', 'viewer', (ctx) => {
  const data = loadInvoice(ctx.db, id(ctx.params.id));
  data.organization_name = (get(ctx.db, "SELECT value FROM settings WHERE key = 'organization_name'") || {}).value || null;
  audit(ctx, 'view', 'invoice', data.invoice.id);
  return data;
});

route('POST', '/api/invoices/:id/submit', 'biller', (ctx) => {
  const { db } = ctx;
  const invId = id(ctx.params.id);
  const inv = get(db, 'SELECT * FROM invoices WHERE id = ?', invId);
  if (!inv) throw notFound('Invoice');
  if (inv.status !== 'draft') throw conflict('Only draft invoices can be submitted.');
  const lines = get(db, 'SELECT COUNT(*) AS n FROM invoice_lines WHERE invoice_id = ? AND units > 0', invId).n;
  if (!lines) throw bad('This invoice has no billable lines.');
  db.prepare("UPDATE invoices SET status = 'submitted', submitted_at = datetime('now'), submitted_by = ? WHERE id = ?")
    .run(ctx.user.id, invId);
  audit(ctx, 'submit', 'invoice', invId, { total_cents: inv.total_cents });
  return { ok: true };
});

route('POST', '/api/invoices/:id/void', 'biller', (ctx) => {
  const { db } = ctx;
  const invId = id(ctx.params.id);
  const inv = get(db, 'SELECT * FROM invoices WHERE id = ?', invId);
  if (!inv) throw notFound('Invoice');
  if (inv.status === 'void') throw conflict('Invoice is already void.');
  const paid = get(db, `SELECT COUNT(*) AS n FROM payment_allocations pa JOIN invoice_lines l ON l.id = pa.invoice_line_id
    WHERE l.invoice_id = ?`, invId).n;
  if (paid) throw conflict('This invoice has payments applied. Remove the payments before voiding.');
  const reason = str(ctx.body.reason, { required: true, max: 500, name: 'Void reason' });
  db.prepare("UPDATE invoices SET status = 'void', notes = COALESCE(notes || char(10), '') || ? WHERE id = ?")
    .run(`Voided: ${reason}`, invId);
  audit(ctx, 'void', 'invoice', invId, { reason });
  return { ok: true };
});

route('DELETE', '/api/invoices/:id', 'biller', (ctx) => {
  const invId = id(ctx.params.id);
  const inv = get(ctx.db, 'SELECT * FROM invoices WHERE id = ?', invId);
  if (!inv) throw notFound('Invoice');
  if (inv.status !== 'draft') throw conflict('Only draft invoices can be deleted. Void submitted invoices instead.');
  ctx.db.prepare('DELETE FROM invoices WHERE id = ?').run(invId);
  audit(ctx, 'delete', 'invoice', invId, { invoice_number: inv.invoice_number });
  return { ok: true };
});

// eBilling worksheet: one row per consumer authorization with a per-day unit grid, matching
// the layout used when keying or uploading monthly invoices to the regional center.
route('GET', '/api/invoices/:id/export.csv', 'biller', (ctx) => {
  const { invoice, lines, program } = loadInvoice(ctx.db, id(ctx.params.id));
  const days = B.daysInMonth(invoice.service_month);
  const [y, mo] = invoice.service_month.split('-');
  const header = ['Vendor Number', 'Service Code', 'Subcode', 'Service Month', 'UCI', 'Last Name', 'First Name',
    'Authorization Number', 'Unit Type'];
  for (let d = 1; d <= days; d++) header.push(`Day ${d}`);
  header.push('Total Units', 'Rate', 'Amount');
  const rows = [header];
  for (const l of lines) {
    rows.push([program.vendor_number, program.service_code, program.subcode || '', `${mo}/${y}`, l.uci, l.last_name, l.first_name,
      l.auth_number, l.unit_type, ...l.daily_units.map((u) => (u ? u : '')), l.units, B.centsToDollars(l.rate_cents),
      B.centsToDollars(l.amount_cents)]);
  }
  audit(ctx, 'export', 'invoice', invoice.id);
  return { __file: { type: 'text/csv; charset=utf-8', name: `${invoice.invoice_number}.csv`, body: B.toCsv(rows) } };
});

// ---------- payments ----------

function refreshInvoiceStatuses(db, invoiceIds) {
  for (const invId of new Set(invoiceIds)) {
    const inv = get(db, 'SELECT * FROM invoices WHERE id = ?', invId);
    if (!inv || inv.status === 'draft' || inv.status === 'void') continue;
    const paid = get(db, `SELECT COALESCE(SUM(pa.amount_cents), 0) AS p FROM payment_allocations pa
      JOIN invoice_lines l ON l.id = pa.invoice_line_id WHERE l.invoice_id = ?`, invId).p;
    db.prepare('UPDATE invoices SET status = ? WHERE id = ?').run(B.deriveInvoiceStatus(inv, paid), invId);
  }
}

function openLines(db, rcId, invoiceIds) {
  const args = [rcId];
  let extra = '';
  if (invoiceIds && invoiceIds.length) {
    extra = ` AND i.id IN (${invoiceIds.map(() => '?').join(',')})`;
    args.push(...invoiceIds);
  }
  return all(db, `SELECT l.id, l.invoice_id, i.invoice_number, i.service_month, c.uci, c.first_name, c.last_name, a.auth_number,
      l.amount_cents, l.amount_cents - COALESCE((SELECT SUM(pa.amount_cents) FROM payment_allocations pa
        WHERE pa.invoice_line_id = l.id), 0) AS open_cents
    FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id JOIN consumers c ON c.id = l.consumer_id
    JOIN authorizations a ON a.id = l.authorization_id
    WHERE i.regional_center_id = ? AND i.status IN ('submitted','partial')${extra}
    ORDER BY i.service_month, i.id, c.last_name`, ...args).filter((l) => l.open_cents > 0);
}

route('GET', '/api/open-lines', 'viewer', ({ db, query }) => ({
  lines: openLines(db, id(query.regional_center_id, 'Regional center')),
}));

route('GET', '/api/payments', 'viewer', ({ db }) => ({
  payments: all(db, `SELECT pmt.*, rc.name AS regional_center_name, rc.abbreviation AS rc_abbr,
      (SELECT COALESCE(SUM(amount_cents), 0) FROM payment_allocations WHERE payment_id = pmt.id) AS applied_cents
    FROM payments pmt JOIN regional_centers rc ON rc.id = pmt.regional_center_id ORDER BY pmt.payment_date DESC, pmt.id DESC`),
}));

route('GET', '/api/payments/:id', 'viewer', ({ db, params }) => {
  const pid = id(params.id);
  const payment = get(db, `SELECT pmt.*, rc.name AS regional_center_name FROM payments pmt
    JOIN regional_centers rc ON rc.id = pmt.regional_center_id WHERE pmt.id = ?`, pid);
  if (!payment) throw notFound('Payment');
  const allocations = all(db, `SELECT pa.*, i.invoice_number, i.id AS invoice_id, i.service_month, c.uci, c.first_name, c.last_name,
      a.auth_number, l.amount_cents AS line_amount_cents
    FROM payment_allocations pa JOIN invoice_lines l ON l.id = pa.invoice_line_id JOIN invoices i ON i.id = l.invoice_id
    JOIN consumers c ON c.id = l.consumer_id JOIN authorizations a ON a.id = l.authorization_id
    WHERE pa.payment_id = ? ORDER BY i.service_month, c.last_name`, pid);
  return { payment, allocations };
});

route('POST', '/api/payments', 'biller', (ctx) => {
  const { db, body } = ctx;
  const rcId = id(body.regional_center_id, 'Regional center');
  if (!get(db, 'SELECT id FROM regional_centers WHERE id = ?', rcId)) throw bad('Regional center not found.');
  const amount = cents(body.amount, 'Payment amount');
  const paymentDate = date(body.payment_date, 'Payment date');
  const method = oneOf(body.method || 'eft', ['eft', 'check', 'other'], 'Method');
  const invoiceIds = Array.isArray(body.invoice_ids) ? body.invoice_ids.map((v) => id(v, 'Invoice')) : null;

  return transaction(db, () => {
    const lines = openLines(db, rcId, invoiceIds);
    let allocations;
    if (Array.isArray(body.allocations)) {
      const byId = new Map(lines.map((l) => [l.id, l]));
      allocations = body.allocations.filter((a) => B.dollarsToCents(a.amount) > 0).map((a) => {
        const line = byId.get(Number(a.invoice_line_id));
        if (!line) throw bad('An allocation references an invoice line that is not open for this regional center.');
        const c = cents(a.amount, 'Allocation amount');
        if (c > line.open_cents) throw bad(`Allocation for ${line.last_name}, ${line.first_name} exceeds the open balance.`);
        return { invoice_line_id: line.id, invoice_id: line.invoice_id, amount_cents: c };
      });
      const sum = allocations.reduce((s, a) => s + a.amount_cents, 0);
      if (sum > amount) throw bad('Allocations exceed the payment amount.');
    } else {
      allocations = B.autoAllocate(amount, lines).allocations;
    }
    const r = db.prepare(`INSERT INTO payments (regional_center_id, payment_date, reference, method, amount_cents, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(rcId, paymentDate, str(body.reference, { max: 60, name: 'Reference' }), method, amount,
      str(body.notes, { max: 2000, name: 'Notes' }), ctx.user.id);
    const pid = Number(r.lastInsertRowid);
    const ins = db.prepare('INSERT INTO payment_allocations (payment_id, invoice_line_id, amount_cents) VALUES (?, ?, ?)');
    for (const a of allocations) ins.run(pid, a.invoice_line_id, a.amount_cents);
    refreshInvoiceStatuses(db, allocations.map((a) => a.invoice_id));
    const applied = allocations.reduce((s, a) => s + a.amount_cents, 0);
    audit(ctx, 'create', 'payment', pid, { amount_cents: amount, applied_cents: applied });
    return { id: pid, applied_cents: applied, unapplied_cents: amount - applied };
  });
});

route('DELETE', '/api/payments/:id', 'biller', (ctx) => {
  const { db } = ctx;
  const pid = id(ctx.params.id);
  if (!get(db, 'SELECT id FROM payments WHERE id = ?', pid)) throw notFound('Payment');
  transaction(db, () => {
    const invIds = all(db, `SELECT DISTINCT l.invoice_id FROM payment_allocations pa JOIN invoice_lines l ON l.id = pa.invoice_line_id
      WHERE pa.payment_id = ?`, pid).map((r) => r.invoice_id);
    db.prepare('DELETE FROM payments WHERE id = ?').run(pid);
    refreshInvoiceStatuses(db, invIds);
  });
  audit(ctx, 'delete', 'payment', pid);
  return { ok: true };
});

// ---------- dashboard & reports ----------

function agingReport(db) {
  const t = today();
  const rows = all(db, `SELECT i.id, i.invoice_number, i.service_month, i.submitted_at, i.total_cents, i.regional_center_id,
      rc.name AS regional_center_name, rc.abbreviation AS rc_abbr,
      i.total_cents - COALESCE((SELECT SUM(pa.amount_cents) FROM payment_allocations pa JOIN invoice_lines l ON l.id = pa.invoice_line_id
        WHERE l.invoice_id = i.id), 0) AS open_cents
    FROM invoices i JOIN regional_centers rc ON rc.id = i.regional_center_id
    WHERE i.status IN ('submitted','partial')`);
  const byRc = new Map();
  const totals = { total: 0 };
  for (const b of B.AGING_BUCKETS) totals[b.key] = 0;
  for (const r of rows) {
    if (r.open_cents <= 0) continue;
    const bucket = B.agingBucket((r.submitted_at || `${r.service_month}-01`).slice(0, 10), t);
    if (!byRc.has(r.regional_center_id)) {
      const e = { regional_center_id: r.regional_center_id, name: r.regional_center_name, abbr: r.rc_abbr, total: 0, invoices: [] };
      for (const b of B.AGING_BUCKETS) e[b.key] = 0;
      byRc.set(r.regional_center_id, e);
    }
    const e = byRc.get(r.regional_center_id);
    e[bucket] += r.open_cents;
    e.total += r.open_cents;
    e.invoices.push({ ...r, bucket });
    totals[bucket] += r.open_cents;
    totals.total += r.open_cents;
  }
  return { buckets: B.AGING_BUCKETS.map(({ key, label }) => ({ key, label })), rows: [...byRc.values()].sort((a, b) => b.total - a.total), totals };
}

route('GET', '/api/reports/aging', 'viewer', ({ db }) => agingReport(db));

route('GET', '/api/reports/revenue', 'viewer', ({ db, query }) => {
  const from = query.from && B.isValidMonth(query.from) ? query.from : null;
  const to = query.to && B.isValidMonth(query.to) ? query.to : null;
  const where = ["i.status NOT IN ('draft','void')"];
  const args = [];
  if (from) { where.push('i.service_month >= ?'); args.push(from); }
  if (to) { where.push('i.service_month <= ?'); args.push(to); }
  const w = where.join(' AND ');
  return {
    by_month: all(db, `SELECT i.service_month, SUM(i.total_cents) AS billed_cents,
        SUM((SELECT COALESCE(SUM(pa.amount_cents), 0) FROM payment_allocations pa JOIN invoice_lines l ON l.id = pa.invoice_line_id
          WHERE l.invoice_id = i.id)) AS collected_cents
      FROM invoices i WHERE ${w} GROUP BY i.service_month ORDER BY i.service_month`, ...args),
    by_service: all(db, `SELECT p.service_code, sc.description, SUM(l.units) AS units, SUM(l.amount_cents) AS billed_cents,
        COUNT(DISTINCT l.consumer_id) AS consumers
      FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id JOIN programs p ON p.id = i.program_id
      JOIN service_codes sc ON sc.code = p.service_code WHERE ${w} GROUP BY p.service_code ORDER BY billed_cents DESC`, ...args),
    by_regional_center: all(db, `SELECT rc.name, rc.abbreviation, SUM(i.total_cents) AS billed_cents, COUNT(*) AS invoices
      FROM invoices i JOIN regional_centers rc ON rc.id = i.regional_center_id WHERE ${w}
      GROUP BY rc.id ORDER BY billed_cents DESC`, ...args),
  };
});

route('GET', '/api/reports/utilization', 'viewer', ({ db, query }) => {
  const m = month(query.month || today().slice(0, 7));
  const { start, end } = B.monthBounds(m);
  const rows = all(db, `SELECT a.id, a.auth_number, a.units_authorized, a.units_period, a.unit_type, a.rate_cents, a.end_date,
      c.first_name, c.last_name, c.uci, p.name AS program_name, p.service_code,
      (SELECT COALESCE(SUM(t.units), 0) FROM attendance t WHERE t.authorization_id = a.id AND t.status IN ('present','partial')
         AND t.service_date BETWEEN ? AND ?) AS units_used
    FROM authorizations a JOIN consumers c ON c.id = a.consumer_id JOIN programs p ON p.id = a.program_id
    WHERE a.start_date <= ? AND a.end_date >= ? AND a.status = 'active' ORDER BY p.name, c.last_name`, start, end, end, start);
  return {
    month: m,
    rows: rows.map((r) => ({
      ...r,
      utilization: r.units_period === 'month' && r.units_authorized ? r.units_used / r.units_authorized : null,
      unused_value_cents: r.units_period === 'month' ? Math.max(0, B.lineAmountCents(r.units_authorized - r.units_used, r.rate_cents)) : null,
    })),
  };
});

route('GET', '/api/dashboard', 'viewer', ({ db }) => {
  const t = today();
  const m = t.slice(0, 7);
  const prevMonth = B.addDays(`${m}-01`, -1).slice(0, 7);
  const aging = agingReport(db);
  const first12 = (() => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 12, 1)); return d.toISOString().slice(0, 7); })();
  const trend = all(db, `SELECT i.service_month, SUM(i.total_cents) AS billed_cents FROM invoices i
    WHERE i.status NOT IN ('draft','void') AND i.service_month >= ? GROUP BY i.service_month ORDER BY i.service_month`, first12);
  const collected = get(db, 'SELECT COALESCE(SUM(amount_cents), 0) AS c FROM payments WHERE substr(payment_date, 1, 7) = ?', m).c;
  const expiring = all(db, `SELECT a.id, a.auth_number, a.end_date, c.id AS consumer_id, c.first_name, c.last_name, c.uci,
      p.name AS program_name, CAST(julianday(a.end_date) - julianday(?) AS INTEGER) AS days_left
    FROM authorizations a JOIN consumers c ON c.id = a.consumer_id JOIN programs p ON p.id = a.program_id
    WHERE a.status = 'active' AND a.end_date BETWEEN ? AND ? ORDER BY a.end_date`, t, t, B.addDays(t, 45));
  const drafts = all(db, invoiceSummarySql("WHERE i.status = 'draft'"));
  const unbilled = all(db, `SELECT p.id AS program_id, p.name AS program_name, substr(t.service_date, 1, 7) AS service_month,
      SUM(t.units) AS units
    FROM attendance t JOIN authorizations a ON a.id = t.authorization_id JOIN programs p ON p.id = a.program_id
    WHERE t.status IN ('present','partial') AND t.units > 0 AND substr(t.service_date, 1, 7) < ?
      AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.program_id = p.id AND i.service_month = substr(t.service_date, 1, 7)
        AND i.status <> 'void')
    GROUP BY p.id, service_month ORDER BY service_month DESC LIMIT 20`, m);
  const overAuth = all(db, `SELECT l.invoice_id, i.invoice_number, c.first_name, c.last_name, c.uci, l.unbilled_units
    FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id JOIN consumers c ON c.id = l.consumer_id
    WHERE l.unbilled_units > 0 AND i.status <> 'void' AND i.service_month >= ? ORDER BY i.service_month DESC LIMIT 20`, first12);
  return {
    today: t,
    month: m,
    previous_month: prevMonth,
    kpis: {
      active_consumers: get(db, "SELECT COUNT(*) AS n FROM consumers WHERE status = 'active'").n,
      active_authorizations: get(db, "SELECT COUNT(*) AS n FROM authorizations WHERE status = 'active' AND start_date <= ? AND end_date >= ?", t, t).n,
      outstanding_cents: aging.totals.total,
      over_90_cents: aging.totals.d91 + aging.totals.d120,
      collected_this_month_cents: collected,
      billed_last_month_cents: (trend.find((r) => r.service_month === prevMonth) || {}).billed_cents || 0,
      draft_invoices: drafts.length,
    },
    aging,
    trend,
    expiring,
    drafts,
    unbilled,
    over_authorization: overAuth,
  };
});

module.exports = { match, HttpError, today, audit };
