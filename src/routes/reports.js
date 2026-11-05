import { HttpError } from '../validate.js';
import { toCsv } from '../http.js';
import { audit } from '../audit.js';
import * as C from '../constants.js';

const rows = (db, sql, ...a) => db.prepare(sql).all(...a).map((x) => ({ ...x }));
const one = (db, sql, ...a) => ({ ...db.prepare(sql).get(...a) });

export function registerReports(r) {
  r.get('/api/dashboard', (ctx) => {
    const db = ctx.db;
    const me = ctx.user.id;
    const kpi = one(db, `
      SELECT
        (SELECT COUNT(*) FROM clients WHERE status = 'active') AS active_clients,
        (SELECT COUNT(*) FROM clients WHERE status = 'prospect') AS prospects,
        (SELECT COUNT(*) FROM policies WHERE status = 'active') AS active_policies,
        (SELECT COALESCE(SUM(premium),0) FROM policies WHERE status = 'active') AS premium_in_force,
        (SELECT COALESCE(SUM(p.premium * COALESCE(p.commission_pct, ca.commission_renew_pct) / 100.0),0)
           FROM policies p JOIN carriers ca ON ca.id = p.carrier_id WHERE p.status = 'active') AS annual_commission_est,
        (SELECT COUNT(*) FROM claims WHERE status IN ('open','in_review','approved')) AS open_claims,
        (SELECT COALESCE(SUM(reserve),0) FROM claims WHERE status IN ('open','in_review','approved')) AS open_reserves,
        (SELECT COUNT(*) FROM invoices WHERE status IN ('open','partial') AND due_date < date('now')) AS overdue_invoices,
        (SELECT COALESCE(SUM(amount - paid),0) FROM invoices WHERE status IN ('open','partial') AND due_date < date('now')) AS overdue_amount,
        (SELECT COALESCE(SUM(est_premium),0) FROM opportunities WHERE stage NOT IN ('won','lost')) AS pipeline_value,
        (SELECT COUNT(*) FROM opportunities WHERE stage NOT IN ('won','lost')) AS pipeline_count,
        (SELECT COUNT(*) FROM tasks WHERE status = 'open' AND assigned_to = ?1) AS my_open_tasks,
        (SELECT COUNT(*) FROM tasks WHERE status = 'open' AND assigned_to = ?1 AND due_date < date('now')) AS my_overdue_tasks,
        (SELECT COALESCE(SUM(premium_change),0) FROM policy_transactions WHERE type = 'new' AND substr(effective_date,1,7) = strftime('%Y-%m','now')) AS new_premium_mtd,
        (SELECT COALESCE(SUM(premium_change),0) FROM policy_transactions WHERE type = 'new' AND substr(effective_date,1,4) = strftime('%Y','now')) AS new_premium_ytd,
        (SELECT COALESCE(SUM(received_amount),0) FROM commissions WHERE status = 'received' AND substr(received_date,1,4) = strftime('%Y','now')) AS commission_received_ytd
    `, me);
    const renew = (d) => one(db, `SELECT COUNT(*) AS n, COALESCE(SUM(premium),0) AS premium FROM policies
        WHERE status = 'active' AND expiration_date BETWEEN date('now') AND date('now', '+${d} days')`);
    kpi.renewals_30 = renew(30); kpi.renewals_60 = renew(60); kpi.renewals_90 = renew(90);

    const monthly = rows(db, `
      SELECT substr(effective_date,1,7) AS month,
             COALESCE(SUM(CASE WHEN type='new' THEN premium_change END),0) AS new_premium,
             COALESCE(SUM(CASE WHEN type='renewal' THEN premium_change END),0) AS renewal_premium
        FROM policy_transactions
       WHERE type IN ('new','renewal') AND effective_date >= date('now','start of month','-11 months')
       GROUP BY month ORDER BY month`);
    const byLine = rows(db, `SELECT line, COUNT(*) AS policies, ROUND(SUM(premium),2) AS premium FROM policies WHERE status='active' GROUP BY line ORDER BY premium DESC`);
    const byCarrier = rows(db, `SELECT ca.name AS carrier, COUNT(*) AS policies, ROUND(SUM(p.premium),2) AS premium
        FROM policies p JOIN carriers ca ON ca.id = p.carrier_id WHERE p.status='active' GROUP BY ca.id ORDER BY premium DESC LIMIT 8`);
    const pipeline = rows(db, `SELECT stage, COUNT(*) AS n, COALESCE(SUM(est_premium),0) AS value FROM opportunities WHERE stage NOT IN ('won','lost') GROUP BY stage`);

    const upcomingRenewals = rows(db, `
      SELECT p.id, p.policy_number, p.line, p.expiration_date, p.premium, p.renewal_status, c.display_name AS client_name, c.id AS client_id,
             CAST(julianday(p.expiration_date) - julianday(date('now')) AS INTEGER) AS days_to_expiry
        FROM policies p JOIN clients c ON c.id = p.client_id
       WHERE p.status = 'active' AND p.expiration_date BETWEEN date('now') AND date('now','+60 days')
       ORDER BY p.expiration_date LIMIT 10`);
    const myTasks = rows(db, `
      SELECT t.id, t.title, t.due_date, t.priority, t.client_id, c.display_name AS client_name,
             CASE WHEN t.due_date < date('now') THEN 1 ELSE 0 END AS overdue
        FROM tasks t LEFT JOIN clients c ON c.id = t.client_id
       WHERE t.status = 'open' AND t.assigned_to = ? ORDER BY t.due_date IS NULL, t.due_date LIMIT 8`, me);
    const recentActivity = rows(db, `
      SELECT a.id, a.kind, a.subject, a.created_at, a.client_id, c.display_name AS client_name, u.name AS user_name
        FROM activities a LEFT JOIN clients c ON c.id = a.client_id LEFT JOIN users u ON u.id = a.user_id
       ORDER BY a.created_at DESC, a.id DESC LIMIT 8`);
    return { kpi, monthly, byLine, byCarrier, pipeline, upcomingRenewals, myTasks, recentActivity };
  });

  r.get('/api/renewals/summary', (ctx) => {
    const days = Math.min(Math.max(Number(ctx.query.days) || 90, 1), 365);
    const byStatus = rows(ctx.db, `
      SELECT renewal_status, COUNT(*) AS n, ROUND(SUM(premium),2) AS premium FROM policies
       WHERE status = 'active' AND expiration_date BETWEEN date('now') AND date('now', '+' || ? || ' days') GROUP BY renewal_status`, days);
    const overdue = one(ctx.db, `SELECT COUNT(*) AS n, COALESCE(SUM(premium),0) AS premium FROM policies WHERE status IN ('active','expired') AND expiration_date < date('now') AND renewal_status NOT IN ('renewed','lost')`);
    return { days, byStatus, overdue };
  });

  /* ---------- Reports ---------- */
  const money = 'money', int = 'int', pct = 'pct', text = 'text', date = 'date';
  const defs = {
    production: {
      title: 'Production by producer', needsRange: true,
      columns: [['producer', 'Producer', text], ['new_policies', 'New policies', int], ['new_premium', 'New premium', money], ['renewals', 'Renewals', int], ['renewal_premium', 'Renewal premium', money], ['endorsement_premium', 'Endorsement premium', money]],
      run: (db, { from, to }) => rows(db, `
        SELECT COALESCE(u.name, 'Unassigned') AS producer,
               SUM(t.type = 'new') AS new_policies, ROUND(COALESCE(SUM(CASE WHEN t.type='new' THEN t.premium_change END),0),2) AS new_premium,
               SUM(t.type = 'renewal') AS renewals, ROUND(COALESCE(SUM(CASE WHEN t.type='renewal' THEN t.premium_change END),0),2) AS renewal_premium,
               ROUND(COALESCE(SUM(CASE WHEN t.type='endorsement' THEN t.premium_change END),0),2) AS endorsement_premium
          FROM policy_transactions t JOIN policies p ON p.id = t.policy_id LEFT JOIN users u ON u.id = p.producer_id
         WHERE t.type IN ('new','renewal','endorsement') AND t.effective_date BETWEEN ? AND ?
         GROUP BY u.id ORDER BY new_premium DESC`, from, to),
    },
    carrier: {
      title: 'Book of business by carrier',
      columns: [['carrier', 'Carrier', text], ['policies', 'Active policies', int], ['premium', 'Premium in force', money], ['est_commission', 'Est. annual commission', money], ['share_pct', '% of book', pct]],
      run: (db) => {
        const out = rows(db, `
          SELECT ca.name AS carrier, COUNT(*) AS policies, ROUND(SUM(p.premium),2) AS premium,
                 ROUND(SUM(p.premium * COALESCE(p.commission_pct, ca.commission_renew_pct) / 100.0),2) AS est_commission
            FROM policies p JOIN carriers ca ON ca.id = p.carrier_id WHERE p.status = 'active' GROUP BY ca.id ORDER BY premium DESC`);
        const total = out.reduce((s, x) => s + x.premium, 0) || 1;
        return out.map((x) => ({ ...x, share_pct: Math.round((x.premium / total) * 1000) / 10 }));
      },
    },
    line: {
      title: 'Book of business by line',
      columns: [['line', 'Line', text], ['category', 'Category', text], ['policies', 'Active policies', int], ['premium', 'Premium in force', money], ['avg_premium', 'Avg premium', money]],
      run: (db) => rows(db, `SELECT line, COUNT(*) AS policies, ROUND(SUM(premium),2) AS premium, ROUND(AVG(premium),2) AS avg_premium FROM policies WHERE status='active' GROUP BY line ORDER BY premium DESC`)
        .map((x) => ({ ...x, category: C.LINE_CATEGORY[x.line], line: C.LINES[x.line] || x.line })),
    },
    retention: {
      title: 'Renewal retention', needsRange: true,
      columns: [['month', 'Expiration month', text], ['expiring', 'Policies expiring', int], ['renewed', 'Renewed', int], ['lost', 'Lost / non-renewed / cancelled', int], ['pending', 'Pending', int], ['retention_pct', 'Retention %', pct]],
      run: (db, { from, to }) => rows(db, `
        SELECT substr(expiration_date,1,7) AS month, COUNT(*) AS expiring,
               SUM(status = 'renewed') AS renewed,
               SUM(status IN ('non_renewed','cancelled') OR (status = 'expired' AND renewal_status = 'lost')) AS lost,
               SUM(status IN ('active','pending_cancel') OR (status = 'expired' AND renewal_status != 'lost')) AS pending,
               CASE WHEN SUM(status = 'renewed') + SUM(status IN ('non_renewed','cancelled') OR (status = 'expired' AND renewal_status = 'lost')) = 0 THEN NULL
                    ELSE ROUND(100.0 * SUM(status = 'renewed') / (SUM(status = 'renewed') + SUM(status IN ('non_renewed','cancelled') OR (status = 'expired' AND renewal_status = 'lost'))), 1) END AS retention_pct
          FROM policies WHERE status != 'quote' AND expiration_date BETWEEN ? AND ? GROUP BY month ORDER BY month`, from, to),
    },
    aging: {
      title: 'Accounts receivable aging',
      columns: [['client', 'Client', text], ['current', 'Current', money], ['d1_30', '1–30', money], ['d31_60', '31–60', money], ['d61_90', '61–90', money], ['d90_plus', '90+', money], ['total', 'Total', money]],
      run: (db) => rows(db, `
        SELECT c.display_name AS client,
          ROUND(SUM(CASE WHEN i.due_date >= date('now') THEN i.amount - i.paid ELSE 0 END),2) AS current,
          ROUND(SUM(CASE WHEN julianday('now') - julianday(i.due_date) BETWEEN 0.5 AND 30.5 THEN i.amount - i.paid ELSE 0 END),2) AS d1_30,
          ROUND(SUM(CASE WHEN julianday('now') - julianday(i.due_date) BETWEEN 30.5 AND 60.5 THEN i.amount - i.paid ELSE 0 END),2) AS d31_60,
          ROUND(SUM(CASE WHEN julianday('now') - julianday(i.due_date) BETWEEN 60.5 AND 90.5 THEN i.amount - i.paid ELSE 0 END),2) AS d61_90,
          ROUND(SUM(CASE WHEN julianday('now') - julianday(i.due_date) > 90.5 THEN i.amount - i.paid ELSE 0 END),2) AS d90_plus,
          ROUND(SUM(i.amount - i.paid),2) AS total
         FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.status IN ('open','partial')
         GROUP BY c.id HAVING ABS(total) > 0.004 ORDER BY total DESC`),
    },
    loss_ratio: {
      title: 'Loss ratio by carrier', needsRange: true,
      columns: [['carrier', 'Carrier', text], ['premium', 'Premium written', money], ['claims', 'Claims', int], ['incurred', 'Paid + open reserves', money], ['loss_ratio', 'Loss ratio %', pct]],
      run: (db, { from, to }) => rows(db, `
        SELECT ca.name AS carrier, ROUND(SUM(p.premium),2) AS premium,
               (SELECT COUNT(*) FROM claims cl JOIN policies p2 ON p2.id = cl.policy_id WHERE p2.carrier_id = ca.id AND cl.loss_date BETWEEN ?1 AND ?2) AS claims,
               (SELECT ROUND(COALESCE(SUM(cl.amount_paid + CASE WHEN cl.status IN ('open','in_review','approved') THEN cl.reserve ELSE 0 END),0),2)
                  FROM claims cl JOIN policies p2 ON p2.id = cl.policy_id WHERE p2.carrier_id = ca.id AND cl.loss_date BETWEEN ?1 AND ?2) AS incurred
          FROM policies p JOIN carriers ca ON ca.id = p.carrier_id WHERE p.status != 'quote' AND p.effective_date <= ?2 AND p.expiration_date >= ?1
         GROUP BY ca.id ORDER BY premium DESC`, from, to)
        .map((x) => ({ ...x, loss_ratio: x.premium ? Math.round((x.incurred / x.premium) * 1000) / 10 : null })),
    },
    commissions: {
      title: 'Commission summary by carrier', needsRange: true,
      columns: [['carrier', 'Carrier', text], ['expected', 'Expected', money], ['received', 'Received', money], ['outstanding', 'Outstanding', money], ['variance', 'Variance on received', money]],
      run: (db, { from, to }) => rows(db, `
        SELECT ca.name AS carrier, ROUND(SUM(cm.expected_amount),2) AS expected,
               ROUND(COALESCE(SUM(CASE WHEN cm.status='received' THEN cm.received_amount END),0),2) AS received,
               ROUND(COALESCE(SUM(CASE WHEN cm.status IN ('expected','disputed') THEN cm.expected_amount END),0),2) AS outstanding,
               ROUND(COALESCE(SUM(CASE WHEN cm.status='received' THEN cm.received_amount - cm.expected_amount END),0),2) AS variance
          FROM commissions cm JOIN carriers ca ON ca.id = cm.carrier_id WHERE cm.period BETWEEN substr(?,1,7) AND substr(?,1,7)
         GROUP BY ca.id ORDER BY expected DESC`, from, to),
      roles: C.MONEY_ROLES,
    },
    cross_sell: {
      title: 'Cross-sell opportunities (single-line clients)',
      columns: [['client', 'Client', text], ['type', 'Type', text], ['lines', 'Lines held', text], ['premium', 'Premium', money], ['producer', 'Producer', text], ['phone', 'Phone', text], ['email', 'Email', text]],
      run: (db) => rows(db, `
        SELECT c.display_name AS client, c.type, GROUP_CONCAT(DISTINCT p.line) AS lines, ROUND(SUM(p.premium),2) AS premium,
               u.name AS producer, c.phone, c.email
          FROM clients c JOIN policies p ON p.client_id = c.id AND p.status = 'active' LEFT JOIN users u ON u.id = c.producer_id
         WHERE c.status = 'active' GROUP BY c.id HAVING COUNT(DISTINCT p.line) = 1 ORDER BY premium DESC`)
        .map((x) => ({ ...x, lines: (x.lines || '').split(',').map((l) => C.LINES[l] || l).join(', ') })),
    },
    pipeline: {
      title: 'Sales pipeline by source', needsRange: true,
      columns: [['source', 'Source', text], ['opportunities', 'Opportunities', int], ['won', 'Won', int], ['lost', 'Lost', int], ['won_premium', 'Won premium', money], ['win_rate', 'Win rate %', pct]],
      run: (db, { from, to }) => rows(db, `
        SELECT COALESCE(source, 'Unknown') AS source, COUNT(*) AS opportunities, SUM(stage='won') AS won, SUM(stage='lost') AS lost,
               ROUND(COALESCE(SUM(CASE WHEN stage='won' THEN est_premium END),0),2) AS won_premium,
               CASE WHEN SUM(stage IN ('won','lost')) = 0 THEN NULL ELSE ROUND(100.0 * SUM(stage='won') / SUM(stage IN ('won','lost')), 1) END AS win_rate
          FROM opportunities WHERE substr(created_at,1,10) BETWEEN ? AND ? GROUP BY source ORDER BY opportunities DESC`, from, to),
    },
  };

  r.get('/api/reports', (ctx) => ({
    reports: Object.entries(defs)
      .filter(([, d]) => !d.roles || d.roles.includes(ctx.user.role))
      .map(([key, d]) => ({ key, title: d.title, needsRange: !!d.needsRange })),
  }));

  r.get('/api/reports/:name', (ctx) => {
    const def = defs[ctx.params.name];
    if (!def) throw new HttpError(404, 'Unknown report');
    if (def.roles && !def.roles.includes(ctx.user.role)) throw new HttpError(403, 'You do not have permission to view this report');
    const year = new Date().getUTCFullYear();
    const from = ctx.query.from || `${year}-01-01`;
    const to = ctx.query.to || `${year}-12-31`;
    for (const d of [from, to]) if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new HttpError(400, 'Dates must be YYYY-MM-DD');
    const data = def.run(ctx.db, { from, to });
    const columns = def.columns.map(([key, label, type]) => ({ key, label, type }));
    if (ctx.query.format === 'csv') {
      audit(ctx, 'export', 'report', null, ctx.params.name);
      return { csv: toCsv(data, columns.map((c) => c.key)), filename: `${ctx.params.name}.csv` };
    }
    const totals = {};
    for (const c of columns) if (c.type === 'money' || c.type === 'int') totals[c.key] = Math.round(data.reduce((s, x) => s + (Number(x[c.key]) || 0), 0) * 100) / 100;
    return { key: ctx.params.name, title: def.title, from, to, needsRange: !!def.needsRange, columns, rows: data, totals };
  });
}
