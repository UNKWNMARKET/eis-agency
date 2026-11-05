import { registerCrud } from '../crud.js';
import { idParam, notFound } from '../http.js';
import { clean, HttpError } from '../validate.js';
import { audit } from '../audit.js';
import { tx, round2 } from '../db.js';
import * as C from '../constants.js';
import { createInvoice, recalcInvoice } from '../domain.js';

const BILLING_WRITE = ['admin', 'manager', 'accounting', 'csr'];

export function registerBilling(r) {
  /* ---------- Invoices ---------- */
  registerCrud(r, {
    name: 'invoices', table: 'invoices', alias: 'i', entity: 'invoice', only: ['list', 'get'],
    select: `i.*, c.display_name AS client_name, p.policy_number, ROUND(i.amount - i.paid, 2) AS balance,
             CASE WHEN i.status IN ('open','partial') AND i.due_date < date('now')
                  THEN CAST(julianday(date('now')) - julianday(i.due_date) AS INTEGER) ELSE 0 END AS days_overdue`,
    from: 'FROM invoices i JOIN clients c ON c.id = i.client_id LEFT JOIN policies p ON p.id = i.policy_id',
    search: ['i.number', 'c.display_name', 'p.policy_number', 'i.description'],
    filters: {
      status: 'i.status', client_id: 'i.client_id', policy_id: 'i.policy_id', kind: 'i.kind',
      overdue: { sql: "(? = '1' AND i.status IN ('open','partial') AND i.due_date < date('now'))" },
      unpaid: { sql: "(? = '1' AND i.status IN ('open','partial'))" },
      due_from: { sql: 'i.due_date >= ?' }, due_to: { sql: 'i.due_date <= ?' },
    },
    sorts: { number: 'i.number', client: 'c.display_name', due: 'i.due_date', amount: 'i.amount', status: 'i.status', balance: 'balance' },
    defaultSort: 'i.due_date DESC',
    csv: ['number', 'client_name', 'policy_number', 'kind', 'description', 'issue_date', 'due_date', 'amount', 'paid', 'balance', 'status'],
  });

  r.post('/api/invoices', { roles: BILLING_WRITE }, (ctx) => {
    const b = clean({
      client_id: { t: 'ref', req: true }, policy_id: { t: 'ref' }, kind: { t: 'enum', vals: ['premium', 'fee', 'endorsement', 'credit'], def: 'premium' },
      description: { t: 'text', req: true, max: 200 }, issue_date: { t: 'date', def: C.TODAY() }, due_date: { t: 'date', req: true },
      amount: { t: 'num', req: true },
    }, ctx.body);
    if (b.amount === 0) throw new HttpError(400, 'Amount cannot be zero', { amount: 'cannot be zero' });
    if (b.kind === 'credit' && b.amount > 0) b.amount = -b.amount;
    if (b.kind !== 'credit' && b.amount < 0) throw new HttpError(400, 'Only credit memos can be negative', { amount: 'must be positive' });
    return tx(ctx.db, () => {
      if (!ctx.db.prepare('SELECT 1 FROM clients WHERE id = ?').get(b.client_id)) throw new HttpError(400, 'Client not found', { client_id: 'not found' });
      if (b.policy_id && !ctx.db.prepare('SELECT 1 FROM policies WHERE id = ? AND client_id = ?').get(b.policy_id, b.client_id)) {
        throw new HttpError(400, 'Policy does not belong to this client', { policy_id: 'invalid' });
      }
      const id = createInvoice(ctx.db, b);
      audit(ctx, 'create', 'invoice', id, b);
      ctx.status = 201;
      return { ...ctx.db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) };
    });
  });

  r.post('/api/invoices/:id/void', { roles: C.MONEY_ROLES }, (ctx) => {
    const id = idParam(ctx);
    const inv = ctx.db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    if (!inv) throw notFound('Invoice');
    if (inv.status === 'void') throw new HttpError(409, 'Invoice is already void');
    if (inv.paid !== 0) throw new HttpError(409, 'Remove payments before voiding an invoice');
    ctx.db.prepare("UPDATE invoices SET status = 'void' WHERE id = ?").run(id);
    audit(ctx, 'void', 'invoice', id);
    return { ...ctx.db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) };
  });

  /* ---------- Payments ---------- */
  registerCrud(r, {
    name: 'payments', table: 'payments', alias: 'pm', entity: 'payment', only: ['list'],
    select: 'pm.*, i.number AS invoice_number, c.display_name AS client_name, u.name AS user_name',
    from: 'FROM payments pm JOIN invoices i ON i.id = pm.invoice_id JOIN clients c ON c.id = pm.client_id LEFT JOIN users u ON u.id = pm.user_id',
    search: ['i.number', 'c.display_name', 'pm.reference'],
    filters: { client_id: 'pm.client_id', invoice_id: 'pm.invoice_id', method: 'pm.method', from: { sql: 'pm.paid_date >= ?' }, to: { sql: 'pm.paid_date <= ?' } },
    sorts: { date: 'pm.paid_date', amount: 'pm.amount', client: 'c.display_name' }, defaultSort: 'pm.paid_date DESC, pm.id DESC',
    csv: ['paid_date', 'invoice_number', 'client_name', 'amount', 'method', 'reference', 'user_name'],
  });

  r.post('/api/invoices/:id/payments', { roles: BILLING_WRITE }, (ctx) => {
    const id = idParam(ctx);
    const b = clean({
      amount: { t: 'num', req: true }, method: { t: 'enum', vals: C.PAYMENT_METHODS, def: 'check' },
      paid_date: { t: 'date', def: C.TODAY() }, reference: { t: 'text', max: 80 },
    }, ctx.body);
    if (b.amount === 0) throw new HttpError(400, 'Amount cannot be zero', { amount: 'cannot be zero' });
    return tx(ctx.db, () => {
      const inv = ctx.db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
      if (!inv) throw notFound('Invoice');
      if (inv.status === 'void') throw new HttpError(409, 'Cannot apply a payment to a void invoice');
      const balance = round2(inv.amount - inv.paid);
      // Credit memos are settled by a negative payment (a refund); positive invoices by positive payments.
      if (inv.amount >= 0 ? b.amount < 0 || b.amount > balance : b.amount > 0 || b.amount < balance) {
        throw new HttpError(400, `Payment must be ${inv.amount >= 0 ? 'between 0.01 and' : 'between'} ${balance} for this invoice (balance ${balance})`, { amount: 'invalid for this balance' });
      }
      const info = ctx.db.prepare('INSERT INTO payments (invoice_id, client_id, amount, method, paid_date, reference, user_id) VALUES (?,?,?,?,?,?,?)')
        .run(id, inv.client_id, b.amount, b.method, b.paid_date, b.reference, ctx.user.id);
      const updated = recalcInvoice(ctx.db, id);
      audit(ctx, 'payment', 'invoice', id, b);
      ctx.status = 201;
      return { payment_id: Number(info.lastInsertRowid), invoice: { ...updated } };
    });
  });

  r.delete('/api/payments/:id', { roles: C.MONEY_ROLES }, (ctx) => {
    const id = idParam(ctx);
    return tx(ctx.db, () => {
      const p = ctx.db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
      if (!p) throw notFound('Payment');
      ctx.db.prepare('DELETE FROM payments WHERE id = ?').run(id);
      recalcInvoice(ctx.db, p.invoice_id);
      audit(ctx, 'delete', 'payment', id, p);
      return { ok: true };
    });
  });

  /** Client ledger: running balance across all invoices and payments. */
  r.get('/api/clients/:id/ledger', (ctx) => {
    const id = idParam(ctx);
    const inv = ctx.db.prepare("SELECT * FROM invoices WHERE client_id = ? AND status != 'void'").all(id);
    const pay = ctx.db.prepare('SELECT pm.*, i.number AS invoice_number FROM payments pm JOIN invoices i ON i.id = pm.invoice_id WHERE pm.client_id = ?').all(id);
    const entries = [
      ...inv.map((i) => ({ date: i.issue_date, type: 'invoice', ref: i.number, description: i.description, charge: i.amount, payment: 0, id: i.id })),
      ...pay.map((p) => ({ date: p.paid_date, type: 'payment', ref: p.invoice_number, description: `${p.method}${p.reference ? ' · ' + p.reference : ''}`, charge: 0, payment: p.amount, id: p.id })),
    ].sort((a, b) => (a.date === b.date ? (a.type === 'invoice' ? -1 : 1) : a.date < b.date ? -1 : 1));
    let bal = 0;
    for (const e of entries) { bal = round2(bal + e.charge - e.payment); e.balance = bal; }
    // balance = everything unpaid (incl. future installments); due_now = only what is already due.
    const dueNow = round2(inv.filter((i) => i.due_date <= C.TODAY()).reduce((s, i) => s + i.amount - i.paid, 0));
    return { entries, balance: bal, due_now: dueNow };
  });

  /* ---------- Commissions ---------- */
  registerCrud(r, {
    name: 'commissions', table: 'commissions', alias: 'cm', entity: 'commission',
    select: `cm.*, p.policy_number, p.line, c.display_name AS client_name, ca.name AS carrier_name, u.name AS producer_name,
             CASE WHEN cm.received_amount IS NULL THEN NULL ELSE ROUND(cm.received_amount - cm.expected_amount, 2) END AS variance,
             ROUND(COALESCE(cm.received_amount, 0) * cm.producer_split_pct / 100.0, 2) AS producer_amount`,
    from: `FROM commissions cm LEFT JOIN policies p ON p.id = cm.policy_id LEFT JOIN clients c ON c.id = p.client_id
           JOIN carriers ca ON ca.id = cm.carrier_id LEFT JOIN users u ON u.id = cm.producer_id`,
    spec: {
      policy_id: { t: 'ref' }, carrier_id: { t: 'ref', req: true }, producer_id: { t: 'ref' },
      type: { t: 'enum', vals: C.COMMISSION_TYPES, def: 'new' }, period: { t: 'text', req: true, max: 7 },
      premium_basis: { t: 'num', def: 0 }, rate_pct: { t: 'num', min: 0, max: 100, def: 0 }, expected_amount: { t: 'num', req: true },
      status: { t: 'enum', vals: C.COMMISSION_STATUS, def: 'expected' }, producer_split_pct: { t: 'num', min: 0, max: 100, def: 0 },
      notes: { t: 'text' },
    },
    search: ['p.policy_number', 'c.display_name', 'ca.name', 'cm.statement_ref'],
    filters: {
      status: 'cm.status', carrier_id: 'cm.carrier_id', producer_id: 'cm.producer_id', policy_id: 'cm.policy_id', type: 'cm.type',
      period_from: { sql: 'cm.period >= ?' }, period_to: { sql: 'cm.period <= ?' }, period: 'cm.period',
      unpaid_producer: { sql: "(? = '1' AND cm.status = 'received' AND cm.producer_paid = 0 AND cm.producer_split_pct > 0)" },
    },
    sorts: { period: 'cm.period', carrier: 'ca.name', client: 'c.display_name', expected: 'cm.expected_amount', received: 'cm.received_amount', status: 'cm.status' },
    defaultSort: 'cm.period DESC, cm.id DESC',
    read: C.MONEY_ROLES, write: C.MONEY_ROLES, remove: C.MANAGE_ROLES, touch: false,
    csv: ['id', 'period', 'client_name', 'policy_number', 'carrier_name', 'producer_name', 'type', 'premium_basis', 'rate_pct', 'expected_amount', 'received_amount', 'variance', 'received_date', 'statement_ref', 'status', 'producer_split_pct', 'producer_amount', 'producer_paid'],
    before(ctx, data) {
      if (data.period && !/^\d{4}-(0[1-9]|1[0-2])$/.test(data.period)) throw new HttpError(400, 'Period must be YYYY-MM', { period: 'must be YYYY-MM' });
    },
  });

  r.post('/api/commissions/:id/receive', { roles: C.MONEY_ROLES }, (ctx) => {
    const id = idParam(ctx);
    const b = clean({ received_amount: { t: 'num', req: true }, received_date: { t: 'date', def: C.TODAY() }, statement_ref: { t: 'text', max: 80 } }, ctx.body);
    const cm = ctx.db.prepare('SELECT * FROM commissions WHERE id = ?').get(id);
    if (!cm) throw notFound('Commission');
    ctx.db.prepare("UPDATE commissions SET received_amount = ?, received_date = ?, statement_ref = ?, status = 'received' WHERE id = ?")
      .run(b.received_amount, b.received_date, b.statement_ref, id);
    audit(ctx, 'receive', 'commission', id, b);
    return { ...ctx.db.prepare('SELECT * FROM commissions WHERE id = ?').get(id) };
  });

  /**
   * Reconcile a carrier commission statement against expected commissions.
   * rows: [{ policy_number, amount }]. Each row is applied to the oldest still-expected line for that
   * carrier + policy number. With dry_run=true nothing is written.
   */
  r.post('/api/commissions/statement', { roles: C.MONEY_ROLES }, (ctx) => {
    const b = clean({
      carrier_id: { t: 'ref', req: true }, statement_ref: { t: 'text', req: true, max: 80 },
      received_date: { t: 'date', def: C.TODAY() }, dry_run: { t: 'bool', def: 0 },
    }, ctx.body);
    const rows = ctx.body.rows;
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > 5000) throw new HttpError(400, 'Provide 1–5000 statement rows');
    if (!ctx.db.prepare('SELECT 1 FROM carriers WHERE id = ?').get(b.carrier_id)) throw new HttpError(400, 'Carrier not found');
    const matched = [], unmatched = [];
    const used = new Set();
    const run = () => {
      for (const [i, row] of rows.entries()) {
        const pn = String(row.policy_number ?? '').trim();
        const amount = Number(row.amount);
        if (!pn || !Number.isFinite(amount)) { unmatched.push({ row: i + 1, policy_number: pn, amount: row.amount, reason: 'Invalid row' }); continue; }
        const lines = ctx.db.prepare(
          `SELECT cm.* FROM commissions cm JOIN policies p ON p.id = cm.policy_id
            WHERE cm.carrier_id = ? AND p.policy_number = ? AND cm.status = 'expected' ORDER BY cm.period, cm.id`).all(b.carrier_id, pn);
        const line = lines.find((l) => !used.has(l.id));
        if (!line) { unmatched.push({ row: i + 1, policy_number: pn, amount, reason: 'No expected commission found' }); continue; }
        used.add(line.id);
        matched.push({ id: line.id, policy_number: pn, expected: line.expected_amount, received: round2(amount), variance: round2(amount - line.expected_amount) });
        if (!b.dry_run) {
          ctx.db.prepare("UPDATE commissions SET received_amount = ?, received_date = ?, statement_ref = ?, status = 'received' WHERE id = ?")
            .run(round2(amount), b.received_date, b.statement_ref, line.id);
        }
      }
    };
    b.dry_run ? run() : tx(ctx.db, run);
    if (!b.dry_run) audit(ctx, 'statement', 'commission', null, { carrier_id: b.carrier_id, ref: b.statement_ref, matched: matched.length, unmatched: unmatched.length });
    return {
      dry_run: !!b.dry_run, matched, unmatched,
      total_received: round2(matched.reduce((s, m) => s + m.received, 0)),
      total_expected: round2(matched.reduce((s, m) => s + m.expected, 0)),
    };
  });

  r.get('/api/commissions/payouts', { roles: C.MONEY_ROLES }, (ctx) => {
    const rows = ctx.db.prepare(
      `SELECT u.id AS producer_id, u.name AS producer_name,
              COUNT(*) AS lines, ROUND(SUM(cm.received_amount), 2) AS commission_received,
              ROUND(SUM(cm.received_amount * cm.producer_split_pct / 100.0), 2) AS payout_due, MAX(cm.period) AS through_period
         FROM commissions cm JOIN users u ON u.id = cm.producer_id
        WHERE cm.status = 'received' AND cm.producer_paid = 0 AND cm.producer_split_pct > 0
        GROUP BY u.id ORDER BY u.name`).all();
    return { rows: rows.map((x) => ({ ...x })) };
  });

  r.post('/api/commissions/payouts/pay', { roles: C.MONEY_ROLES }, (ctx) => {
    const b = clean({ producer_id: { t: 'ref', req: true }, paid_date: { t: 'date', def: C.TODAY() } }, ctx.body);
    const info = ctx.db.prepare(
      `UPDATE commissions SET producer_paid = 1, producer_paid_date = ?
        WHERE producer_id = ? AND status = 'received' AND producer_paid = 0 AND producer_split_pct > 0`).run(b.paid_date, b.producer_id);
    audit(ctx, 'producer_payout', 'commission', null, { ...b, lines: Number(info.changes) });
    return { paid_lines: Number(info.changes) };
  });
}
