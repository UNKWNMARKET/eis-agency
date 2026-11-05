import './env.js';
import http from 'node:http';
import { openDb } from '../src/db.js';
import { bootstrap, createApp } from '../src/server.js';
import { hashPassword } from '../src/auth.js';

export const PASSWORD = 'correct-horse-battery';

/** Boot an isolated app on an ephemeral port with an in-memory DB. */
export async function setup() {
  process.env.ADMIN_PASSWORD = PASSWORD;
  process.env.ADMIN_EMAIL = 'admin@test.local';
  const db = openDb(':memory:');
  bootstrap(db, () => {});
  const server = http.createServer(createApp(db, { log: () => {} }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  function client() {
    let cookie = '';
    const call = async (method, path, body, extraHeaders = {}) => {
      const headers = { 'X-Requested-With': 'ams', ...extraHeaders };
      if (cookie) headers.Cookie = cookie;
      let payload;
      if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
      const res = await fetch(base + path, { method, headers, body: payload, redirect: 'manual' });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
      const type = res.headers.get('content-type') || '';
      const data = type.includes('json') ? await res.json() : await res.text();
      return { status: res.status, data, headers: res.headers };
    };
    return {
      get: (p) => call('GET', p), post: (p, b = {}) => call('POST', p, b), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p),
      raw: call,
      login: async (email, password) => call('POST', '/api/auth/login', { email, password }),
    };
  }

  const admin = client();
  const res = await admin.login('admin@test.local', PASSWORD);
  if (res.status !== 200) throw new Error('admin login failed: ' + JSON.stringify(res.data));

  const addUser = (email, role, extra = {}) => {
    const info = db.prepare('INSERT INTO users (email, name, role, password_hash, split_new_pct, split_renew_pct) VALUES (?,?,?,?,?,?)')
      .run(email, email.split('@')[0], role, hashPassword(PASSWORD), extra.split_new_pct ?? 0, extra.split_renew_pct ?? 0);
    return Number(info.lastInsertRowid);
  };
  const as = async (role) => {
    const email = `${role}-${Math.random().toString(36).slice(2, 7)}@test.local`;
    const id = addUser(email, role);
    const c = client();
    await c.login(email, PASSWORD);
    c.id = id;
    return c;
  };

  const close = () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); });
  return { db, base, admin, client, as, addUser, close };
}

export async function seedBasics(t) {
  const carrier = (await t.admin.post('/api/carriers', { name: 'Test Mutual ' + Math.random().toString(36).slice(2, 6), commission_new_pct: 12, commission_renew_pct: 10 })).data;
  const client = (await t.admin.post('/api/clients', { type: 'person', first_name: 'Jane', last_name: 'Doe', email: 'jane@example.com' })).data;
  return { carrier, client };
}

export function isoDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}
