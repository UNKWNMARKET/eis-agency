import { registerCrud } from '../crud.js';
import { idParam, notFound } from '../http.js';
import { clean, HttpError, addMonths } from '../validate.js';
import { audit } from '../audit.js';
import { tx } from '../db.js';
import * as C from '../constants.js';
import { systemNote, getPolicy } from '../domain.js';
import { onBound, assertTerm } from './policies.js';
import { CLIENT_SPEC } from './core.js';

export function registerSales(r) {
  registerCrud(r, {
    name: 'opportunities', table: 'opportunities', alias: 'o', entity: 'opportunity',
    select: `o.*, c.display_name AS client_name, u.name AS producer_name,
             (SELECT COUNT(*) FROM quotes q WHERE q.opportunity_id = o.id) AS quote_count,
             (SELECT MIN(q.premium) FROM quotes q WHERE q.opportunity_id = o.id AND q.premium > 0) AS best_quote`,
    from: 'FROM opportunities o LEFT JOIN clients c ON c.id = o.client_id LEFT JOIN users u ON u.id = o.producer_id',
    spec: {
      client_id: { t: 'ref' }, name: { t: 'text', req: true, max: 160 }, contact_email: { t: 'email' }, contact_phone: { t: 'text', max: 40 },
      line: { t: 'enum', vals: Object.keys(C.LINES) }, stage: { t: 'enum', vals: C.OPP_STAGES, def: 'new' },
      est_premium: { t: 'num', min: 0, def: 0 }, expected_close: { t: 'date' }, source: { t: 'text', max: 80 },
      producer_id: { t: 'ref' }, lost_reason: { t: 'text', max: 300 }, notes: { t: 'text' },
    },
    search: ['o.name', 'c.display_name', 'o.contact_email', 'o.contact_phone'],
    filters: { stage: 'o.stage', producer_id: 'o.producer_id', client_id: 'o.client_id', line: 'o.line', open: { sql: "(? = '1' AND o.stage NOT IN ('won','lost'))" } },
    sorts: { name: 'o.name', stage: 'o.stage', premium: 'o.est_premium', close: 'o.expected_close', created: 'o.created_at' },
    defaultSort: 'o.expected_close IS NULL, o.expected_close ASC',
    csv: ['id', 'name', 'client_name', 'line', 'stage', 'est_premium', 'expected_close', 'source', 'producer_name'],
    before(ctx, data, existing) {
      const m = { ...(existing || {}), ...data };
      if (!existing) data.producer_id ??= ctx.user.role === 'producer' ? ctx.user.id : null;
      if (m.stage === 'lost' && !m.lost_reason) throw new HttpError(400, 'Please record why this opportunity was lost', { lost_reason: 'is required when lost' });
      if (data.stage && data.stage !== 'lost') data.lost_reason = data.lost_reason ?? null;
    },
    after(ctx, row, existing) {
      if (existing && existing.stage !== row.stage) {
        systemNote(ctx, { client_id: row.client_id, opportunity_id: row.id, subject: `Stage: ${existing.stage} → ${row.stage}` });
      }
    },
  });

  registerCrud(r, {
    name: 'quotes', table: 'quotes', alias: 'q', entity: 'quote',
    select: 'q.*, ca.name AS carrier_name',
    from: 'FROM quotes q JOIN carriers ca ON ca.id = q.carrier_id',
    spec: {
      opportunity_id: { t: 'ref', req: true }, carrier_id: { t: 'ref', req: true }, line: { t: 'enum', vals: Object.keys(C.LINES) },
      premium: { t: 'num', min: 0, req: true }, status: { t: 'enum', vals: C.QUOTE_STATUS, def: 'pending' },
      quote_ref: { t: 'text', max: 80 }, valid_until: { t: 'date' }, notes: { t: 'text' },
    },
    filters: { opportunity_id: 'q.opportunity_id', status: 'q.status' }, defaultSort: 'q.premium ASC', touch: false, remove: C.WRITE_ROLES,
    before(ctx, data) {
      if (data.opportunity_id && !ctx.db.prepare('SELECT 1 FROM opportunities WHERE id = ?').get(data.opportunity_id)) {
        throw new HttpError(400, 'Opportunity not found', { opportunity_id: 'not found' });
      }
    },
  });

  /**
   * Win an opportunity: optionally create the client, bind the policy, and link everything together.
   */
  r.post('/api/opportunities/:id/convert', { roles: C.WRITE_ROLES }, (ctx) => {
    const id = idParam(ctx);
    const b = ctx.body || {};
    const pol = clean({
      carrier_id: { t: 'ref', req: true }, policy_number: { t: 'text', req: true, max: 60 }, line: { t: 'enum', vals: Object.keys(C.LINES) },
      effective_date: { t: 'date', req: true }, expiration_date: { t: 'date' }, premium: { t: 'num', req: true, min: 0 }, fees: { t: 'num', min: 0, def: 0 },
      billing_method: { t: 'enum', vals: C.BILLING_METHODS }, payment_plan: { t: 'enum', vals: Object.keys(C.PAYMENT_PLANS), def: 'full' },
      client_id: { t: 'ref' }, quote_id: { t: 'ref' },
    }, b);
    return tx(ctx.db, () => {
      const opp = ctx.db.prepare('SELECT * FROM opportunities WHERE id = ?').get(id);
      if (!opp) throw notFound('Opportunity');
      if (opp.stage === 'won' && opp.converted_policy_id) throw new HttpError(409, 'This opportunity has already been converted');
      let clientId = pol.client_id || opp.client_id;
      if (!clientId) {
        // Create the client inline from the supplied details.
        const nc = clean(CLIENT_SPEC, b.new_client || {});
        if (nc.type === 'business' ? !nc.business_name : !nc.last_name) throw new HttpError(400, 'Provide an existing client or new client details (name)');
        nc.status = 'active';
        nc.producer_id ??= opp.producer_id;
        nc.email ??= opp.contact_email;
        nc.phone ??= opp.contact_phone;
        nc.source ??= opp.source;
        const cols = Object.keys(nc);
        clientId = Number(ctx.db.prepare(`INSERT INTO clients (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => nc[c])).lastInsertRowid);
        audit(ctx, 'create', 'client', clientId, { via: 'opportunity', opportunity_id: id });
      }
      const client = ctx.db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
      if (!client) throw new HttpError(400, 'Client not found', { client_id: 'not found' });
      const carrier = ctx.db.prepare('SELECT * FROM carriers WHERE id = ? AND active = 1').get(pol.carrier_id);
      if (!carrier) throw new HttpError(400, 'Carrier not found or inactive', { carrier_id: 'not found' });
      const exp = pol.expiration_date || addMonths(pol.effective_date, 12);
      assertTerm(pol.effective_date, exp);
      const line = pol.line || opp.line;
      if (!line) throw new HttpError(400, 'Line of business is required', { line: 'is required' });
      if (ctx.db.prepare('SELECT 1 FROM policies WHERE carrier_id = ? AND policy_number = ? AND effective_date = ?').get(pol.carrier_id, pol.policy_number, pol.effective_date)) {
        throw new HttpError(409, 'A policy with this carrier, number and effective date already exists');
      }
      const info = ctx.db.prepare(
        `INSERT INTO policies (client_id, carrier_id, policy_number, line, status, effective_date, expiration_date, premium, fees, billing_method, payment_plan, producer_id, csr_id)
         VALUES (?,?,?,?, 'active', ?,?,?,?,?,?,?,?)`
      ).run(clientId, pol.carrier_id, pol.policy_number, line, pol.effective_date, exp, pol.premium, pol.fees,
        pol.billing_method || carrier.default_billing, pol.payment_plan, opp.producer_id ?? client.producer_id, client.csr_id);
      const policyId = Number(info.lastInsertRowid);
      onBound(ctx, getPolicy(ctx.db, policyId), 'new');
      ctx.db.prepare("UPDATE opportunities SET stage = 'won', client_id = ?, converted_policy_id = ?, lost_reason = NULL, updated_at = datetime('now') WHERE id = ?").run(clientId, policyId, id);
      if (pol.quote_id) ctx.db.prepare("UPDATE quotes SET status = 'accepted' WHERE id = ? AND opportunity_id = ?").run(pol.quote_id, id);
      systemNote(ctx, { client_id: clientId, policy_id: policyId, opportunity_id: id, subject: `Won: ${opp.name}`, body: `Policy ${pol.policy_number} bound with ${carrier.name}` });
      audit(ctx, 'convert', 'opportunity', id, { client_id: clientId, policy_id: policyId });
      ctx.status = 201;
      return { client_id: clientId, policy_id: policyId };
    });
  });
}
