import { registerCrud } from '../crud.js';
import { idParam, notFound } from '../http.js';
import { clean, HttpError, addDays, addMonths, daysBetween } from '../validate.js';
import { audit } from '../audit.js';
import { tx, round2 } from '../db.js';
import * as C from '../constants.js';
import { documentFilesFor, removeFiles } from './work.js';
import {
  addCommission, createInvoice, generatePolicyInvoices, logTransaction, systemNote, getPolicy, termMonths, unearnedPremium,
} from '../domain.js';

const POLICY_SPEC = {
  client_id: { t: 'ref', req: true },
  carrier_id: { t: 'ref', req: true },
  mga: { t: 'text', max: 120 },
  policy_number: { t: 'text', req: true, max: 60 },
  line: { t: 'enum', vals: Object.keys(C.LINES), req: true },
  status: { t: 'enum', vals: C.POLICY_STATUS, def: 'active' },
  renewal_status: { t: 'enum', vals: C.RENEWAL_STATUS, def: 'not_started' },
  effective_date: { t: 'date', req: true },
  expiration_date: { t: 'date', req: true },
  premium: { t: 'num', min: 0, def: 0 },
  fees: { t: 'num', min: 0, def: 0 },
  billing_method: { t: 'enum', vals: C.BILLING_METHODS },
  payment_plan: { t: 'enum', vals: Object.keys(C.PAYMENT_PLANS), def: 'full' },
  commission_pct: { t: 'num', min: 0, max: 100 },
  producer_id: { t: 'ref' },
  csr_id: { t: 'ref' },
  notes: { t: 'text' },
};

// Financially significant fields can only be edited directly by managers; everyone else uses endorse/cancel/renew.
const PROTECTED = ['premium', 'fees', 'status', 'effective_date', 'expiration_date', 'client_id', 'carrier_id', 'billing_method', 'payment_plan', 'commission_pct'];

export function onBound(ctx, policy, type) {
  logTransaction(ctx, policy.id, {
    type, effective_date: policy.effective_date, premium_change: policy.premium,
    description: type === 'renewal' ? 'Renewal term issued' : 'New policy bound',
  });
  addCommission(ctx.db, policy, { type, basis: policy.premium, period: policy.effective_date });
  generatePolicyInvoices(ctx.db, policy);
  ctx.db.prepare("UPDATE clients SET status = 'active' WHERE id = ? AND status = 'prospect'").run(policy.client_id);
}

export function assertTerm(effective, expiration) {
  if (expiration <= effective) throw new HttpError(400, 'Expiration date must be after the effective date', { expiration_date: 'must be after the effective date' });
  if (daysBetween(effective, expiration) > 800) throw new HttpError(400, 'Policy term cannot exceed ~2 years', { expiration_date: 'term too long' });
}

export function registerPolicies(r) {
  registerCrud(r, {
    name: 'policies', table: 'policies', alias: 'p', entity: 'policy',
    select: `p.*, c.display_name AS client_name, ca.name AS carrier_name, pu.name AS producer_name, cu.name AS csr_name,
             CAST(julianday(p.expiration_date) - julianday(date('now')) AS INTEGER) AS days_to_expiry,
             (SELECT COALESCE(SUM(i.amount - i.paid),0) FROM invoices i WHERE i.policy_id = p.id AND i.status IN ('open','partial')) AS balance_due`,
    from: `FROM policies p JOIN clients c ON c.id = p.client_id JOIN carriers ca ON ca.id = p.carrier_id
           LEFT JOIN users pu ON pu.id = p.producer_id LEFT JOIN users cu ON cu.id = p.csr_id`,
    spec: POLICY_SPEC,
    search: ['p.policy_number', 'c.display_name', 'ca.name', 'p.mga'],
    filters: {
      client_id: 'p.client_id', carrier_id: 'p.carrier_id', line: 'p.line', status: 'p.status',
      renewal_status: 'p.renewal_status', producer_id: 'p.producer_id', csr_id: 'p.csr_id', billing_method: 'p.billing_method',
      exp_from: { sql: 'p.expiration_date >= ?' }, exp_to: { sql: 'p.expiration_date <= ?' },
      eff_from: { sql: 'p.effective_date >= ?' }, eff_to: { sql: 'p.effective_date <= ?' },
      expiring_within: { sql: "p.expiration_date BETWEEN date('now') AND date('now', '+' || CAST(? AS INTEGER) || ' days')" },
    },
    sorts: {
      policy_number: 'p.policy_number', client: 'c.display_name', carrier: 'ca.name', line: 'p.line', premium: 'p.premium',
      effective: 'p.effective_date', expiration: 'p.expiration_date', status: 'p.status', renewal_status: 'p.renewal_status',
    },
    defaultSort: 'p.expiration_date ASC',
    csv: ['id', 'policy_number', 'client_name', 'carrier_name', 'line', 'status', 'effective_date', 'expiration_date', 'premium', 'fees', 'billing_method', 'producer_name', 'renewal_status'],
    before(ctx, data, existing) {
      const m = { ...(existing || {}), ...data };
      if (!existing) {
        if (!['active', 'quote'].includes(m.status)) throw new HttpError(400, 'New policies must be created as active or quote', { status: 'invalid for a new policy' });
        const client = ctx.db.prepare('SELECT * FROM clients WHERE id = ?').get(m.client_id);
        if (!client) throw new HttpError(400, 'Client not found', { client_id: 'not found' });
        data.producer_id ??= client.producer_id;
        data.csr_id ??= client.csr_id;
      }
      const carrier = ctx.db.prepare('SELECT * FROM carriers WHERE id = ?').get(m.carrier_id);
      if (!carrier) throw new HttpError(400, 'Carrier not found', { carrier_id: 'not found' });
      if (!existing && !carrier.active) throw new HttpError(400, 'Carrier is inactive', { carrier_id: 'is inactive' });
      if (!existing) data.billing_method ??= carrier.default_billing;
      assertTerm(m.effective_date, m.expiration_date);
      const dup = ctx.db.prepare(
        'SELECT id FROM policies WHERE carrier_id = ? AND policy_number = ? AND effective_date = ? AND id != ?'
      ).get(m.carrier_id, m.policy_number, m.effective_date, existing?.id ?? 0);
      if (dup) throw new HttpError(409, 'A policy with this carrier, number and effective date already exists');
      if (existing && !C_isManager(ctx)) {
        const touched = PROTECTED.filter((k) => k in data && data[k] !== existing[k]);
        if (touched.length) throw new HttpError(403, `Use Endorse / Cancel / Renew to change: ${touched.join(', ')}. Only managers can edit these directly.`);
      }
    },
    after(ctx, row, existing) {
      if (!existing && row.status === 'active') onBound(ctx, row, 'new');
    },
    beforeDelete(ctx, row) {
      if (!C_isManager(ctx)) throw new HttpError(403, 'Only managers can delete policies');
      if (ctx.db.prepare('SELECT 1 FROM claims WHERE policy_id = ?').get(row.id)) {
        throw new HttpError(409, 'This policy has claims on file and cannot be deleted');
      }
      ctx.pendingFiles = documentFilesFor(ctx.db, 'policy_id', row.id);
    },
    afterDelete(ctx) { removeFiles(ctx.pendingFiles || []); },
  });

  registerCrud(r, {
    name: 'coverages', table: 'coverages', alias: 'cv', entity: 'coverage',
    spec: {
      policy_id: { t: 'ref', req: true }, coverage: { t: 'text', req: true, max: 120 },
      limit_text: { t: 'text', max: 120 }, deductible: { t: 'text', max: 60 }, premium: { t: 'num', min: 0 },
    },
    filters: { policy_id: 'cv.policy_id' }, defaultSort: 'cv.id ASC', remove: C.WRITE_ROLES,
  });

  registerCrud(r, {
    name: 'risk-items', table: 'risk_items', alias: 'ri', entity: 'risk item',
    spec: {
      policy_id: { t: 'ref', req: true }, kind: { t: 'enum', vals: C.RISK_KINDS, def: 'other' },
      description: { t: 'text', req: true, max: 200 }, identifier: { t: 'text', max: 80 }, value: { t: 'num', min: 0 }, details: { t: 'text' },
    },
    filters: { policy_id: 'ri.policy_id' }, defaultSort: 'ri.kind, ri.id', remove: C.WRITE_ROLES,
  });

  /** Everything needed to render a policy page in one round-trip. */
  r.get('/api/policies/:id/full', (ctx) => {
    const id = idParam(ctx);
    const policy = ctx.db.prepare(
      `SELECT p.*, c.display_name AS client_name, ca.name AS carrier_name, ca.phone AS carrier_phone, ca.claims_phone AS carrier_claims_phone,
              pu.name AS producer_name, cu.name AS csr_name,
              prior.policy_number AS prior_policy_number
         FROM policies p JOIN clients c ON c.id = p.client_id JOIN carriers ca ON ca.id = p.carrier_id
         LEFT JOIN users pu ON pu.id = p.producer_id LEFT JOIN users cu ON cu.id = p.csr_id
         LEFT JOIN policies prior ON prior.id = p.prior_policy_id
        WHERE p.id = ?`).get(id);
    if (!policy) throw notFound('Policy');
    const all = (sql, ...a) => ctx.db.prepare(sql).all(...a).map((x) => ({ ...x }));
    const next = ctx.db.prepare('SELECT id, policy_number, effective_date FROM policies WHERE prior_policy_id = ?').get(id);
    return {
      policy: { ...policy },
      renewal_of: policy.prior_policy_id ? { id: policy.prior_policy_id, policy_number: policy.prior_policy_number } : null,
      renewed_by: next ? { ...next } : null,
      coverages: all('SELECT * FROM coverages WHERE policy_id = ? ORDER BY id', id),
      risk_items: all('SELECT * FROM risk_items WHERE policy_id = ? ORDER BY kind, id', id),
      transactions: all(
        `SELECT t.*, u.name AS user_name FROM policy_transactions t LEFT JOIN users u ON u.id = t.user_id
          WHERE t.policy_id = ? ORDER BY t.effective_date DESC, t.id DESC`, id),
      invoices: all('SELECT * FROM invoices WHERE policy_id = ? ORDER BY due_date, id', id),
      commissions: all('SELECT cm.*, u.name AS producer_name FROM commissions cm LEFT JOIN users u ON u.id = cm.producer_id WHERE cm.policy_id = ? ORDER BY cm.period, cm.id', id),
      claims: all('SELECT * FROM claims WHERE policy_id = ? ORDER BY loss_date DESC', id),
      unearned_premium: ['active', 'pending_cancel'].includes(policy.status) ? unearnedPremium(policy, C.TODAY() < policy.effective_date ? policy.effective_date : C.TODAY()) : 0,
    };
  });

  /* ---------- Lifecycle actions ---------- */
  r.post('/api/policies/:id/endorse', { roles: C.WRITE_ROLES }, (ctx) => {
    const id = idParam(ctx);
    const body = clean({
      effective_date: { t: 'date', req: true }, premium_change: { t: 'num', req: true },
      description: { t: 'text', req: true, max: 500 }, fee: { t: 'num', min: 0, def: 0 },
    }, ctx.body);
    return tx(ctx.db, () => {
      const p = getPolicy(ctx.db, id);
      if (!['active', 'pending_cancel'].includes(p.status)) throw new HttpError(409, `Cannot endorse a ${p.status} policy`);
      if (body.effective_date < p.effective_date || body.effective_date > p.expiration_date) {
        throw new HttpError(400, 'Endorsement effective date must fall within the policy term', { effective_date: 'outside policy term' });
      }
      const newPremium = round2(p.premium + body.premium_change);
      if (newPremium < 0) throw new HttpError(400, 'Endorsement would make premium negative', { premium_change: 'too negative' });
      ctx.db.prepare("UPDATE policies SET premium = ?, updated_at = datetime('now') WHERE id = ?").run(newPremium, id);
      logTransaction(ctx, id, { type: 'endorsement', effective_date: body.effective_date, premium_change: body.premium_change, description: body.description });
      if (body.premium_change !== 0) {
        addCommission(ctx.db, p, { type: 'endorsement', basis: body.premium_change, period: body.effective_date, notes: body.description });
      }
      if (p.billing_method === 'agency_bill' && (body.premium_change !== 0 || body.fee > 0)) {
        const amount = round2(body.premium_change + body.fee);
        createInvoice(ctx.db, {
          client_id: p.client_id, policy_id: id, kind: amount < 0 ? 'credit' : 'endorsement',
          description: `${p.policy_number} — endorsement: ${body.description}`.slice(0, 200),
          issue_date: C.TODAY(), due_date: body.effective_date > C.TODAY() ? body.effective_date : addDays(C.TODAY(), 15), amount,
        });
      }
      systemNote(ctx, { client_id: p.client_id, policy_id: id, subject: `Endorsement: ${body.description}`, body: `Premium ${fmt(p.premium)} → ${fmt(newPremium)}` });
      audit(ctx, 'endorse', 'policy', id, body);
      return { ...getPolicy(ctx.db, id) };
    });
  });

  r.post('/api/policies/:id/cancel', { roles: C.WRITE_ROLES }, (ctx) => {
    const id = idParam(ctx);
    const body = clean({
      effective_date: { t: 'date', req: true }, reason: { t: 'text', req: true, max: 300 },
      return_premium: { t: 'num', min: 0 }, // optional override of pro-rata calculation
    }, ctx.body);
    return tx(ctx.db, () => {
      const p = getPolicy(ctx.db, id);
      if (!['active', 'pending_cancel'].includes(p.status)) throw new HttpError(409, `Cannot cancel a ${p.status} policy`);
      if (body.effective_date < p.effective_date || body.effective_date > p.expiration_date) {
        throw new HttpError(400, 'Cancellation date must fall within the policy term', { effective_date: 'outside policy term' });
      }
      const flat = body.effective_date === p.effective_date;
      const ret = round2(Math.min(p.premium, body.return_premium ?? (flat ? p.premium : unearnedPremium(p, body.effective_date))));
      ctx.db.prepare(
        "UPDATE policies SET status = 'cancelled', cancelled_date = ?, cancel_reason = ?, renewal_status = 'lost', updated_at = datetime('now') WHERE id = ?"
      ).run(body.effective_date, body.reason, id);
      logTransaction(ctx, id, { type: 'cancellation', effective_date: body.effective_date, premium_change: -ret, description: body.reason });
      if (ret > 0) addCommission(ctx.db, p, { type: 'chargeback', basis: -ret, period: body.effective_date, notes: `Cancellation: ${body.reason}` });
      if (p.billing_method === 'agency_bill') {
        // Void installments not yet billed/paid after the cancel date, then credit whatever return premium remains.
        const future = ctx.db.prepare("SELECT id, amount FROM invoices WHERE policy_id = ? AND status = 'open' AND paid = 0 AND due_date > ?").all(id, body.effective_date);
        let voided = 0;
        for (const inv of future) { ctx.db.prepare("UPDATE invoices SET status = 'void' WHERE id = ?").run(inv.id); voided = round2(voided + inv.amount); }
        const credit = round2(ret - voided);
        if (credit > 0) {
          createInvoice(ctx.db, {
            client_id: p.client_id, policy_id: id, kind: 'credit', description: `${p.policy_number} — return premium on cancellation`,
            issue_date: C.TODAY(), due_date: C.TODAY(), amount: -credit,
          });
        }
      }
      systemNote(ctx, { client_id: p.client_id, policy_id: id, subject: `Policy cancelled effective ${body.effective_date}`, body: `${body.reason}. Return premium ${fmt(ret)}.` });
      audit(ctx, 'cancel', 'policy', id, { ...body, return_premium: ret });
      return { ...getPolicy(ctx.db, id), return_premium: ret };
    });
  });

  r.post('/api/policies/:id/reinstate', { roles: C.WRITE_ROLES }, (ctx) => {
    const id = idParam(ctx);
    const body = clean({ effective_date: { t: 'date' }, notes: { t: 'text', max: 500 } }, ctx.body);
    return tx(ctx.db, () => {
      const p = getPolicy(ctx.db, id);
      if (p.status !== 'cancelled') throw new HttpError(409, 'Only cancelled policies can be reinstated');
      if (p.expiration_date < C.TODAY()) throw new HttpError(409, 'Policy term has already ended; write a new policy instead');
      const eff = body.effective_date || C.TODAY();
      const cx = ctx.db.prepare("SELECT premium_change FROM policy_transactions WHERE policy_id = ? AND type = 'cancellation' ORDER BY id DESC LIMIT 1").get(id);
      const restored = cx ? Math.abs(cx.premium_change) : 0;
      ctx.db.prepare("UPDATE policies SET status = 'active', cancelled_date = NULL, cancel_reason = NULL, renewal_status = 'not_started', updated_at = datetime('now') WHERE id = ?").run(id);
      logTransaction(ctx, id, { type: 'reinstatement', effective_date: eff, premium_change: restored, description: body.notes || 'Policy reinstated' });
      if (restored > 0) {
        addCommission(ctx.db, p, { type: 'endorsement', basis: restored, period: eff, notes: 'Reinstatement' });
        if (p.billing_method === 'agency_bill') {
          createInvoice(ctx.db, {
            client_id: p.client_id, policy_id: id, kind: 'endorsement', description: `${p.policy_number} — reinstatement premium`,
            issue_date: C.TODAY(), due_date: addDays(C.TODAY(), 10), amount: restored,
          });
        }
      }
      systemNote(ctx, { client_id: p.client_id, policy_id: id, subject: 'Policy reinstated', body: body.notes });
      audit(ctx, 'reinstate', 'policy', id, body);
      return { ...getPolicy(ctx.db, id) };
    });
  });

  r.post('/api/policies/:id/non-renew', { roles: C.WRITE_ROLES }, (ctx) => {
    const id = idParam(ctx);
    const body = clean({ reason: { t: 'text', req: true, max: 300 } }, ctx.body);
    const p = getPolicy(ctx.db, id);
    if (!['active', 'expired'].includes(p.status)) throw new HttpError(409, `Cannot mark a ${p.status} policy as non-renewed`);
    ctx.db.prepare("UPDATE policies SET status = 'non_renewed', renewal_status = 'lost', cancel_reason = ?, updated_at = datetime('now') WHERE id = ?").run(body.reason, id);
    systemNote(ctx, { client_id: p.client_id, policy_id: id, subject: 'Policy will not be renewed', body: body.reason });
    audit(ctx, 'non_renew', 'policy', id, body);
    return { ...getPolicy(ctx.db, id) };
  });

  r.post('/api/policies/:id/renew', { roles: C.WRITE_ROLES }, (ctx) => {
    const id = idParam(ctx);
    const body = clean({
      premium: { t: 'num', req: true, min: 0 }, fees: { t: 'num', min: 0 }, policy_number: { t: 'text', max: 60 },
      carrier_id: { t: 'ref' }, effective_date: { t: 'date' }, expiration_date: { t: 'date' },
      billing_method: { t: 'enum', vals: C.BILLING_METHODS }, payment_plan: { t: 'enum', vals: Object.keys(C.PAYMENT_PLANS) },
      notes: { t: 'text' },
    }, ctx.body);
    return tx(ctx.db, () => {
      const old = getPolicy(ctx.db, id);
      if (!['active', 'expired'].includes(old.status)) throw new HttpError(409, `Cannot renew a ${old.status} policy`);
      if (ctx.db.prepare('SELECT 1 FROM policies WHERE prior_policy_id = ?').get(id)) throw new HttpError(409, 'This policy has already been renewed');
      const eff = body.effective_date || old.expiration_date;
      const exp = body.expiration_date || addMonths(eff, termMonths(old));
      assertTerm(eff, exp);
      const carrierId = body.carrier_id || old.carrier_id;
      const carrier = ctx.db.prepare('SELECT * FROM carriers WHERE id = ?').get(carrierId);
      if (!carrier) throw new HttpError(400, 'Carrier not found', { carrier_id: 'not found' });
      const number = body.policy_number || old.policy_number;
      if (ctx.db.prepare('SELECT 1 FROM policies WHERE carrier_id = ? AND policy_number = ? AND effective_date = ?').get(carrierId, number, eff)) {
        throw new HttpError(409, 'A policy with this carrier, number and effective date already exists');
      }
      const info = ctx.db.prepare(
        `INSERT INTO policies (client_id, carrier_id, mga, policy_number, line, status, renewal_status, effective_date, expiration_date,
           premium, fees, billing_method, payment_plan, commission_pct, producer_id, csr_id, prior_policy_id, notes)
         VALUES (?,?,?,?,?, 'active', 'not_started', ?,?, ?,?,?,?,?,?,?,?,?)`
      ).run(old.client_id, carrierId, old.mga, number, old.line, eff, exp, body.premium, body.fees ?? old.fees,
        body.billing_method || old.billing_method, body.payment_plan || old.payment_plan, old.commission_pct, old.producer_id, old.csr_id, id, body.notes);
      const newId = Number(info.lastInsertRowid);
      ctx.db.prepare("UPDATE policies SET status = 'renewed', renewal_status = 'renewed', updated_at = datetime('now') WHERE id = ?").run(id);
      ctx.db.prepare('INSERT INTO coverages (policy_id, coverage, limit_text, deductible, premium) SELECT ?, coverage, limit_text, deductible, premium FROM coverages WHERE policy_id = ?').run(newId, id);
      ctx.db.prepare('INSERT INTO risk_items (policy_id, kind, description, identifier, value, details) SELECT ?, kind, description, identifier, value, details FROM risk_items WHERE policy_id = ?').run(newId, id);
      const created = getPolicy(ctx.db, newId);
      onBound(ctx, created, 'renewal');
      const change = old.premium ? Math.round(((body.premium - old.premium) / old.premium) * 1000) / 10 : 0;
      systemNote(ctx, { client_id: old.client_id, policy_id: newId, subject: `Renewed from ${old.policy_number}`, body: `Premium ${fmt(old.premium)} → ${fmt(body.premium)} (${change >= 0 ? '+' : ''}${change}%)` });
      audit(ctx, 'renew', 'policy', id, { new_policy_id: newId, premium: body.premium });
      ctx.status = 201;
      return { ...created };
    });
  });

  /** Create follow-up tasks for every active policy expiring in N days that has none yet. */
  r.post('/api/renewals/generate-tasks', { roles: C.MANAGE_ROLES }, (ctx) => {
    const days = Math.min(Math.max(Number(ctx.body?.days) || 60, 1), 180);
    const rows = ctx.db.prepare(
      `SELECT p.*, c.display_name FROM policies p JOIN clients c ON c.id = p.client_id
        WHERE p.status = 'active' AND p.renewal_status = 'not_started'
          AND p.expiration_date BETWEEN date('now') AND date('now', '+' || ? || ' days')
          AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.policy_id = p.id AND t.title LIKE 'Renewal review:%' AND t.status = 'open')`
    ).all(days);
    let created = 0;
    tx(ctx.db, () => {
      for (const p of rows) {
        const due = addDays(p.expiration_date, -45) < C.TODAY() ? C.TODAY() : addDays(p.expiration_date, -45);
        ctx.db.prepare(
          `INSERT INTO tasks (title, description, due_date, priority, assigned_to, client_id, policy_id, created_by)
           VALUES (?,?,?,?,?,?,?,?)`
        ).run(`Renewal review: ${p.display_name} — ${C.LINES[p.line] || p.line} (${p.policy_number})`,
          `Expires ${p.expiration_date}. Review coverage, request renewal terms, and remarket if needed.`,
          due, daysBetween(C.TODAY(), p.expiration_date) <= 30 ? 'high' : 'normal',
          p.csr_id ?? p.producer_id ?? ctx.user.id, p.client_id, p.id, ctx.user.id);
        ctx.db.prepare("UPDATE policies SET renewal_status = 'in_review' WHERE id = ?").run(p.id);
        created++;
      }
    });
    audit(ctx, 'generate_renewal_tasks', 'policy', null, { days, created });
    return { created };
  });
}

function C_isManager(ctx) { return C.MANAGE_ROLES.includes(ctx.user.role); }
function fmt(n) { return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
