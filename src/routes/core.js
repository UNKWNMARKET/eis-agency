import { registerCrud } from '../crud.js';
import { idParam, notFound } from '../http.js';
import { clean, HttpError } from '../validate.js';
import { audit } from '../audit.js';
import { hashPassword, verifyPassword, createSession, destroySession, validPassword, throttle, recordFailure, clearFailures } from '../auth.js';
import * as C from '../constants.js';
import { documentFilesFor, removeFiles } from './work.js';

export const CLIENT_SPEC = {
  type: { t: 'enum', vals: C.CLIENT_TYPES, def: 'person' },
  first_name: { t: 'text', max: 80 }, last_name: { t: 'text', max: 80 },
  business_name: { t: 'text', max: 160 }, dba: { t: 'text', max: 160 },
  dob: { t: 'date' }, email: { t: 'email' }, phone: { t: 'text', max: 40 }, mobile: { t: 'text', max: 40 },
  address1: { t: 'text', max: 160 }, address2: { t: 'text', max: 160 }, city: { t: 'text', max: 80 },
  state: { t: 'text', max: 2 }, zip: { t: 'text', max: 10 },
  status: { t: 'enum', vals: C.CLIENT_STATUS, def: 'active' },
  industry: { t: 'text', max: 120 }, fein_last4: { t: 'text', max: 4 }, employees: { t: 'int', min: 0 },
  annual_revenue: { t: 'num', min: 0 }, source: { t: 'text', max: 80 },
  producer_id: { t: 'ref' }, csr_id: { t: 'ref' }, household: { t: 'text', max: 120 },
  preferred_contact: { t: 'text', max: 20 }, do_not_contact: { t: 'bool', def: 0 }, notes: { t: 'text' },
};

export function registerCore(r) {
  /* ---------- Auth ---------- */
  r.post('/api/auth/login', { public: true }, (ctx) => {
    const { email, password } = ctx.body || {};
    if (typeof email !== 'string' || typeof password !== 'string') throw new HttpError(400, 'Email and password are required');
    const key = `${ctx.ip}|${email.toLowerCase()}`;
    if (throttle(key)) throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
    const u = ctx.db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    // Always run a hash comparison so response timing does not reveal whether the account exists.
    const ok = u ? verifyPassword(password, u.password_hash) : verifyPassword(password, 'scrypt$00$00');
    if (!u || !u.active || !ok) {
      recordFailure(key);
      throw new HttpError(401, 'Invalid email or password');
    }
    clearFailures(key);
    const { token, maxAge } = createSession(ctx.db, u.id);
    ctx.setCookie = { token, maxAge };
    ctx.user = { id: u.id, name: u.name, role: u.role, email: u.email };
    audit(ctx, 'login', 'user', u.id);
    return { user: ctx.user };
  });

  r.post('/api/auth/logout', { public: true }, (ctx) => {
    destroySession(ctx.db, ctx.token);
    ctx.setCookie = { token: '', maxAge: 0 };
    return { ok: true };
  });

  r.get('/api/auth/me', { public: true }, (ctx) => ({ user: ctx.user }));

  r.post('/api/auth/password', {}, (ctx) => {
    const { current, next } = ctx.body || {};
    const u = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.user.id);
    if (!verifyPassword(String(current ?? ''), u.password_hash)) throw new HttpError(400, 'Current password is incorrect');
    if (!validPassword(next)) throw new HttpError(400, 'New password must be at least 10 characters');
    ctx.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), u.id);
    // Sign out every other session.
    ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    const { token, maxAge } = createSession(ctx.db, u.id);
    ctx.setCookie = { token, maxAge };
    audit(ctx, 'password_change', 'user', u.id);
    return { ok: true };
  });

  /* ---------- Meta (reference data for the UI) ---------- */
  r.get('/api/meta', (ctx) => ({
    lines: C.LINES, lineCategory: C.LINE_CATEGORY, roles: C.ROLES,
    enums: {
      clientStatus: C.CLIENT_STATUS, policyStatus: C.POLICY_STATUS, renewalStatus: C.RENEWAL_STATUS,
      billingMethods: C.BILLING_METHODS, paymentPlans: Object.keys(C.PAYMENT_PLANS), oppStages: C.OPP_STAGES,
      quoteStatus: C.QUOTE_STATUS, claimStatus: C.CLAIM_STATUS, invoiceStatus: C.INVOICE_STATUS,
      commissionTypes: C.COMMISSION_TYPES, commissionStatus: C.COMMISSION_STATUS, taskPriority: C.TASK_PRIORITY,
      activityKinds: C.ACTIVITY_KINDS.filter((k) => k !== 'system'), docCategories: C.DOC_CATEGORIES,
      paymentMethods: C.PAYMENT_METHODS, riskKinds: C.RISK_KINDS,
    },
    users: ctx.db.prepare('SELECT id, name, role, active FROM users ORDER BY name').all().map((u) => ({ ...u })),
    carriers: ctx.db.prepare('SELECT id, name, active FROM carriers ORDER BY name').all().map((c) => ({ ...c })),
    agency: Object.fromEntries(ctx.db.prepare("SELECT key, value FROM settings WHERE key LIKE 'agency_%'").all().map((s) => [s.key, s.value])),
  }));

  /* ---------- Users ---------- */
  const userSpec = {
    email: { t: 'email', req: true }, name: { t: 'text', req: true, max: 120 },
    role: { t: 'enum', vals: C.ROLES, req: true }, phone: { t: 'text', max: 40 }, license_no: { t: 'text', max: 60 },
    split_new_pct: { t: 'num', min: 0, max: 100, def: 0 }, split_renew_pct: { t: 'num', min: 0, max: 100, def: 0 },
    active: { t: 'bool', def: 1 },
  };
  const userCols = 'id, email, name, role, active, phone, license_no, split_new_pct, split_renew_pct, created_at';

  r.get('/api/users', { roles: C.MANAGE_ROLES }, (ctx) => ({
    rows: ctx.db.prepare(`SELECT ${userCols} FROM users ORDER BY name`).all().map((u) => ({ ...u })),
  }));

  r.post('/api/users', { roles: ['admin'] }, (ctx) => {
    const data = clean(userSpec, ctx.body);
    if (!validPassword(ctx.body.password)) throw new HttpError(400, 'Password must be at least 10 characters', { password: 'must be at least 10 characters' });
    if (ctx.db.prepare('SELECT 1 FROM users WHERE email = ?').get(data.email)) throw new HttpError(409, 'A user with that email already exists');
    const info = ctx.db.prepare(
      `INSERT INTO users (email, name, role, phone, license_no, split_new_pct, split_renew_pct, active, password_hash) VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(data.email, data.name, data.role, data.phone, data.license_no, data.split_new_pct, data.split_renew_pct, data.active, hashPassword(ctx.body.password));
    const id = Number(info.lastInsertRowid);
    audit(ctx, 'create', 'user', id, { email: data.email, role: data.role });
    ctx.status = 201;
    return { ...ctx.db.prepare(`SELECT ${userCols} FROM users WHERE id = ?`).get(id) };
  });

  r.put('/api/users/:id', { roles: ['admin'] }, (ctx) => {
    const id = idParam(ctx);
    const existing = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!existing) throw notFound('User');
    const data = clean(userSpec, ctx.body, { partial: true });
    if (id === ctx.user.id && (data.active === 0 || (data.role && data.role !== 'admin'))) {
      throw new HttpError(400, 'You cannot deactivate or demote your own account');
    }
    const cols = Object.keys(data);
    if (cols.length) ctx.db.prepare(`UPDATE users SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => data[c]), id);
    if (ctx.body.password) {
      if (!validPassword(ctx.body.password)) throw new HttpError(400, 'Password must be at least 10 characters');
      ctx.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(ctx.body.password), id);
      ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
    if (data.active === 0) ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    audit(ctx, 'update', 'user', id, { ...data, password: ctx.body.password ? '(reset)' : undefined });
    return { ...ctx.db.prepare(`SELECT ${userCols} FROM users WHERE id = ?`).get(id) };
  });

  /* ---------- Carriers ---------- */
  registerCrud(r, {
    name: 'carriers', table: 'carriers', alias: 'ca', entity: 'carrier',
    select: `ca.*, (SELECT COUNT(*) FROM policies p WHERE p.carrier_id = ca.id AND p.status = 'active') AS active_policies,
             (SELECT COALESCE(SUM(p.premium),0) FROM policies p WHERE p.carrier_id = ca.id AND p.status = 'active') AS premium_in_force`,
    spec: {
      name: { t: 'text', req: true, max: 120 }, naic: { t: 'text', max: 20 }, am_best: { t: 'text', max: 10 },
      phone: { t: 'text', max: 40 }, claims_phone: { t: 'text', max: 40 }, email: { t: 'email' }, website: { t: 'text', max: 200 },
      agency_code: { t: 'text', max: 60 },
      commission_new_pct: { t: 'num', min: 0, max: 100, def: 10 }, commission_renew_pct: { t: 'num', min: 0, max: 100, def: 10 },
      default_billing: { t: 'enum', vals: C.BILLING_METHODS, def: 'direct_bill' }, active: { t: 'bool', def: 1 }, notes: { t: 'text' },
    },
    search: ['ca.name', 'ca.naic', 'ca.agency_code'],
    filters: { active: 'ca.active' },
    sorts: { name: 'ca.name', premium: 'premium_in_force', policies: 'active_policies' },
    defaultSort: 'ca.name ASC',
    write: C.MANAGE_ROLES, touch: false,
  });

  /* ---------- Clients ---------- */

  registerCrud(r, {
    name: 'clients', table: 'clients', alias: 'c', entity: 'client',
    select: `c.*, pu.name AS producer_name, cu.name AS csr_name,
      (SELECT COUNT(*) FROM policies p WHERE p.client_id = c.id AND p.status = 'active') AS active_policies,
      (SELECT COALESCE(SUM(p.premium),0) FROM policies p WHERE p.client_id = c.id AND p.status = 'active') AS premium_in_force`,
    from: 'FROM clients c LEFT JOIN users pu ON pu.id = c.producer_id LEFT JOIN users cu ON cu.id = c.csr_id',
    spec: CLIENT_SPEC,
    search: ['c.display_name', 'c.business_name', 'c.dba', 'c.email', 'c.phone', 'c.mobile', 'c.city', 'c.zip', 'c.household'],
    filters: { status: 'c.status', type: 'c.type', producer_id: 'c.producer_id', csr_id: 'c.csr_id', state: 'c.state' },
    sorts: { name: 'c.display_name', created: 'c.created_at', premium: 'premium_in_force', policies: 'active_policies', city: 'c.city' },
    defaultSort: 'c.display_name COLLATE NOCASE ASC',
    csv: ['id', 'type', 'display_name', 'first_name', 'last_name', 'business_name', 'email', 'phone', 'mobile', 'address1', 'city', 'state', 'zip', 'status', 'producer_name', 'active_policies', 'premium_in_force'],
    beforeDelete(ctx, row) { ctx.pendingFiles = documentFilesFor(ctx.db, 'client_id', row.id); },
    afterDelete(ctx) { removeFiles(ctx.pendingFiles || []); },
    before(ctx, data, existing) {
      const t = data.type ?? existing?.type ?? 'person';
      const merged = { ...(existing || {}), ...data };
      if (t === 'business' && !merged.business_name) throw new HttpError(400, 'Business name is required for business clients', { business_name: 'is required' });
      if (t === 'person' && !merged.last_name) throw new HttpError(400, 'Last name is required for individual clients', { last_name: 'is required' });
      if (data.state) data.state = data.state.toUpperCase();
    },
  });

  /* ---------- Contacts (household members / business contacts) ---------- */
  registerCrud(r, {
    name: 'contacts', table: 'contacts', alias: 'ct', entity: 'contact',
    spec: {
      client_id: { t: 'ref', req: true }, name: { t: 'text', req: true, max: 120 }, relationship: { t: 'text', max: 60 },
      email: { t: 'email' }, phone: { t: 'text', max: 40 }, dob: { t: 'date' }, notes: { t: 'text' },
    },
    filters: { client_id: 'ct.client_id' }, defaultSort: 'ct.name ASC', remove: C.WRITE_ROLES,
  });

  /* ---------- Global search ---------- */
  r.get('/api/search', (ctx) => {
    const q = (ctx.query.q || '').trim();
    if (q.length < 2) return { results: [] };
    const like = '%' + q.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
    const out = [];
    const add = (type, rows) => rows.forEach((x) => out.push({ type, ...x }));
    add('client', ctx.db.prepare(
      `SELECT id, display_name AS title, COALESCE(email, phone, city) AS subtitle FROM clients
        WHERE display_name LIKE ?1 ESCAPE '\\' OR email LIKE ?1 ESCAPE '\\' OR phone LIKE ?1 ESCAPE '\\' OR mobile LIKE ?1 ESCAPE '\\' OR dba LIKE ?1 ESCAPE '\\'
        ORDER BY display_name LIMIT 8`).all(like));
    add('policy', ctx.db.prepare(
      `SELECT p.id, p.policy_number AS title, c.display_name || ' · ' || ca.name || ' · ' || p.status AS subtitle
         FROM policies p JOIN clients c ON c.id = p.client_id JOIN carriers ca ON ca.id = p.carrier_id
        WHERE p.policy_number LIKE ?1 ESCAPE '\\' ORDER BY p.effective_date DESC LIMIT 8`).all(like));
    add('claim', ctx.db.prepare(
      `SELECT cl.id, COALESCE(cl.claim_number, 'Claim #' || cl.id) AS title, c.display_name || ' · ' || cl.status AS subtitle
         FROM claims cl JOIN clients c ON c.id = cl.client_id
        WHERE cl.claim_number LIKE ?1 ESCAPE '\\' ORDER BY cl.loss_date DESC LIMIT 5`).all(like));
    add('opportunity', ctx.db.prepare(
      `SELECT id, name AS title, stage AS subtitle FROM opportunities WHERE name LIKE ?1 ESCAPE '\\' ORDER BY id DESC LIMIT 5`).all(like));
    return { results: out.map((x) => ({ ...x })) };
  });
}
