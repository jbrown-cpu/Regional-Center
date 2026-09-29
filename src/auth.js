'use strict';

const crypto = require('node:crypto');

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // one working shift
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64, SCRYPT_PARAMS);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltB64, keyB64] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT_PARAMS);
  return crypto.timingSafeEqual(expected, actual);
}

function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < 10) return 'Password must be at least 10 characters.';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return 'Password must include letters and numbers.';
  return null;
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// Only the hash of the session token is stored, so a copied database cannot be used to hijack sessions.
function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), userId, Date.now() + SESSION_TTL_MS);
  return token;
}

function sessionUser(db, token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.username, u.full_name, u.role, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND u.active = 1`).get(sha256(token));
  if (!row || row.expires_at < Date.now()) return null;
  // Sliding expiration: activity keeps the session alive.
  db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(Date.now() + SESSION_TTL_MS, sha256(token));
  return { id: row.id, username: row.username, full_name: row.full_name, role: row.role };
}

function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

// Simple in-memory throttle against password guessing.
const attempts = new Map();
function loginThrottled(key) {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || now - rec.first > 15 * 60 * 1000) return false;
  return rec.count >= 8;
}
function recordFailedLogin(key) {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || now - rec.first > 15 * 60 * 1000) attempts.set(key, { first: now, count: 1 });
  else rec.count++;
}
function clearFailedLogins(key) {
  attempts.delete(key);
}

const ROLE_RANK = { viewer: 0, staff: 1, biller: 2, admin: 3 };
function hasRole(user, minRole) {
  return !!user && ROLE_RANK[user.role] >= ROLE_RANK[minRole];
}

module.exports = {
  SESSION_TTL_MS,
  hashPassword,
  verifyPassword,
  passwordProblem,
  createSession,
  sessionUser,
  destroySession,
  loginThrottled,
  recordFailedLogin,
  clearFailedLogins,
  hasRole,
};
