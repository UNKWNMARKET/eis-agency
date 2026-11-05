import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';

const SESSION_DAYS = 7;

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

const sha = (t) => createHash('sha256').update(t).digest('hex');

export function createSession(db, userId) {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)').run(sha(token), userId, expires);
  return { token, maxAge: SESSION_DAYS * 86400 };
}

export function userFromToken(db, token) {
  if (!token) return null;
  const row = db.prepare(
    `SELECT u.id, u.email, u.name, u.role, u.active, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`
  ).get(sha(token));
  if (!row || !row.active) return null;
  if (row.expires_at < new Date().toISOString()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
    return null;
  }
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
}

export function purgeExpiredSessions(db) {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
}

export function validPassword(p) {
  return typeof p === 'string' && p.length >= 10 && p.length <= 200;
}

// Naive in-memory login throttle: 8 failures / 15 minutes per key.
const attempts = new Map();
export function throttle(key) {
  const now = Date.now();
  const rec = (attempts.get(key) || []).filter((t) => now - t < 15 * 60000);
  attempts.set(key, rec);
  return rec.length >= 8;
}
export function recordFailure(key) {
  const rec = attempts.get(key) || [];
  rec.push(Date.now());
  attempts.set(key, rec);
}
export function clearFailures(key) { attempts.delete(key); }
