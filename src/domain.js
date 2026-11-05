import { round2 } from './db.js';
import { PAYMENT_PLANS, TODAY } from './constants.js';
import { addDays, addMonths, daysBetween, HttpError } from './validate.js';

/** Sequential human-readable numbers (INV-000001, COI-000001). Must be called inside a transaction. */
export function nextNumber(db, kind, prefix) {
  const key = `seq_${kind}`;
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  const n = (row ? Number(row.value) : 0) + 1;
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(n));
  return `${prefix}-${String(n).padStart(6, '0')}`;
}

export function termMonths(policy) {
  return Math.max(1, Math.round(daysBetween(policy.effective_date, policy.expiration_date) / 30.4375));
}

/**
 * Record an expected commission line.
 * type: new | renewal | endorsement | chargeback. `basis` may be negative (chargebacks / return premium).
 */
export function addCommission(db, policy, { type, basis, period, notes = null }) {
  const carrier = db.prepare('SELECT * FROM carriers WHERE id = ?').get(policy.carrier_id);
  const rate = policy.commission_pct ?? (type === 'renewal' ? carrier.commission_renew_pct : carrier.commission_new_pct);
  const producer = policy.producer_id ? db.prepare('SELECT * FROM users WHERE id = ?').get(policy.producer_id) : null;
  const split = producer ? (type === 'renewal' ? producer.split_renew_pct : producer.split_new_pct) : 0;
  const expected = round2((basis * rate) / 100);
  const info = db.prepare(
    `INSERT INTO commissions (policy_id, carrier_id, producer_id, type, period, premium_basis, rate_pct, expected_amount, producer_split_pct, notes)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(policy.id, policy.carrier_id, policy.producer_id, type, period.slice(0, 7), round2(basis), rate, expected, split, notes);
  return Number(info.lastInsertRowid);
}

export function createInvoice(db, { client_id, policy_id = null, kind = 'premium', description, issue_date, due_date, amount }) {
  const number = nextNumber(db, 'invoice', 'INV');
  const info = db.prepare(
    `INSERT INTO invoices (number, client_id, policy_id, kind, description, issue_date, due_date, amount, status)
     VALUES (?,?,?,?,?,?,?,?, 'open')`
  ).run(number, client_id, policy_id, kind, description, issue_date, due_date, round2(amount));
  return Number(info.lastInsertRowid);
}

/** Split premium + fees across the policy's payment plan and create agency-bill invoices. */
export function generatePolicyInvoices(db, policy) {
  if (policy.billing_method !== 'agency_bill') return [];
  const n = PAYMENT_PLANS[policy.payment_plan] || 1;
  const total = round2((policy.premium || 0) + (policy.fees || 0));
  if (total <= 0) return [];
  const step = Math.max(1, Math.round(termMonths(policy) / n));
  const each = round2(total / n);
  const ids = [];
  let allocated = 0;
  for (let i = 0; i < n; i++) {
    const amount = i === n - 1 ? round2(total - allocated) : each;
    allocated = round2(allocated + amount);
    const due = addMonths(policy.effective_date, i * step);
    const issue = i === 0 ? TODAY() : addDays(due, -20);
    ids.push(createInvoice(db, {
      client_id: policy.client_id, policy_id: policy.id, kind: 'premium',
      description: `${policy.policy_number} — installment ${i + 1} of ${n}`,
      issue_date: issue > due ? due : issue, due_date: due, amount,
    }));
  }
  return ids;
}

export function recalcInvoice(db, invoiceId) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  if (!inv || inv.status === 'void') return inv;
  const paid = round2(db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE invoice_id = ?').get(invoiceId).s);
  const settled = inv.amount >= 0 ? paid >= inv.amount : paid <= inv.amount;
  const status = settled ? 'paid' : paid !== 0 ? 'partial' : 'open';
  db.prepare('UPDATE invoices SET paid = ?, status = ? WHERE id = ?').run(paid, status, invoiceId);
  return db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
}

export function logTransaction(ctx, policyId, { type, effective_date, premium_change = 0, description = null }) {
  ctx.db.prepare(
    'INSERT INTO policy_transactions (policy_id, type, effective_date, premium_change, description, user_id) VALUES (?,?,?,?,?,?)'
  ).run(policyId, type, effective_date, round2(premium_change), description, ctx.user?.id ?? null);
}

export function systemNote(ctx, { client_id = null, policy_id = null, claim_id = null, opportunity_id = null, subject, body = null }) {
  ctx.db.prepare(
    `INSERT INTO activities (kind, subject, body, client_id, policy_id, claim_id, opportunity_id, user_id)
     VALUES ('system', ?, ?, ?, ?, ?, ?, ?)`
  ).run(subject, body, client_id, policy_id, claim_id, opportunity_id, ctx.user?.id ?? null);
}

/** Expire policies whose term has ended. Safe to call repeatedly. */
export function refreshStatuses(db) {
  const today = TODAY();
  const r = db.prepare(
    `UPDATE policies SET status = 'expired', updated_at = datetime('now')
      WHERE status IN ('active','pending_cancel') AND expiration_date < ?`
  ).run(today);
  // Late renewals are common: only treat an expired policy as lost after a 30-day grace period.
  db.prepare(
    `UPDATE policies SET renewal_status = 'lost'
      WHERE status = 'expired' AND renewal_status NOT IN ('renewed','lost') AND expiration_date < ?`
  ).run(addDays(today, -30));
  return Number(r.changes);
}

export function getPolicy(db, id) {
  const p = db.prepare('SELECT * FROM policies WHERE id = ?').get(id);
  if (!p) throw new HttpError(404, 'Policy not found');
  return p;
}

/** Pro-rata unearned premium as of a date (flat days method). */
export function unearnedPremium(policy, asOf) {
  const total = daysBetween(policy.effective_date, policy.expiration_date);
  if (total <= 0) return 0;
  const remaining = Math.max(0, Math.min(total, daysBetween(asOf, policy.expiration_date)));
  return round2((policy.premium * remaining) / total);
}
