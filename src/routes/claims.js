import { registerCrud } from '../crud.js';
import { HttpError } from '../validate.js';
import * as C from '../constants.js';
import { systemNote } from '../domain.js';
import { documentFilesFor, removeFiles } from './work.js';

export function registerClaims(r) {
  registerCrud(r, {
    name: 'claims', table: 'claims', alias: 'cl', entity: 'claim',
    select: `cl.*, c.display_name AS client_name, p.policy_number, p.line, ca.name AS carrier_name, ca.claims_phone AS carrier_claims_phone`,
    from: `FROM claims cl JOIN clients c ON c.id = cl.client_id JOIN policies p ON p.id = cl.policy_id JOIN carriers ca ON ca.id = p.carrier_id`,
    spec: {
      policy_id: { t: 'ref', req: true }, claim_number: { t: 'text', max: 60 }, loss_date: { t: 'date', req: true },
      reported_date: { t: 'date' }, loss_type: { t: 'text', max: 80 }, status: { t: 'enum', vals: C.CLAIM_STATUS, def: 'open' },
      description: { t: 'text' }, loss_location: { t: 'text', max: 200 },
      amount_claimed: { t: 'num', min: 0, def: 0 }, reserve: { t: 'num', min: 0, def: 0 }, amount_paid: { t: 'num', min: 0, def: 0 },
      deductible: { t: 'num', min: 0, def: 0 }, adjuster_name: { t: 'text', max: 120 }, adjuster_phone: { t: 'text', max: 40 },
      adjuster_email: { t: 'email' }, closed_date: { t: 'date' }, notes: { t: 'text' },
    },
    search: ['cl.claim_number', 'c.display_name', 'p.policy_number', 'cl.loss_type', 'cl.adjuster_name'],
    filters: {
      status: 'cl.status', client_id: 'cl.client_id', policy_id: 'cl.policy_id', carrier_id: 'p.carrier_id',
      open: { sql: "(? = '1' AND cl.status IN ('open','in_review','approved'))" },
    },
    sorts: { loss_date: 'cl.loss_date', status: 'cl.status', client: 'c.display_name', paid: 'cl.amount_paid', claimed: 'cl.amount_claimed' },
    defaultSort: 'cl.loss_date DESC',
    csv: ['id', 'claim_number', 'client_name', 'policy_number', 'carrier_name', 'line', 'loss_date', 'reported_date', 'loss_type', 'status', 'amount_claimed', 'reserve', 'amount_paid', 'adjuster_name'],
    beforeDelete(ctx, row) { ctx.pendingFiles = documentFilesFor(ctx.db, 'claim_id', row.id); },
    afterDelete(ctx) { removeFiles(ctx.pendingFiles || []); },
    before(ctx, data, existing) {
      const policyId = data.policy_id ?? existing?.policy_id;
      if (existing && data.policy_id && data.policy_id !== existing.policy_id) throw new HttpError(400, 'A claim cannot be moved to a different policy');
      const pol = ctx.db.prepare('SELECT * FROM policies WHERE id = ?').get(policyId);
      if (!pol) throw new HttpError(400, 'Policy not found', { policy_id: 'not found' });
      if (!existing) data.client_id = pol.client_id;
      const loss = data.loss_date ?? existing?.loss_date;
      if (loss < pol.effective_date || loss > pol.expiration_date) {
        throw new HttpError(400, `Date of loss (${loss}) falls outside the policy term ${pol.effective_date} to ${pol.expiration_date}`, { loss_date: 'outside policy term' });
      }
      const status = data.status ?? existing?.status;
      if (status === 'closed' && !(data.closed_date ?? existing?.closed_date)) data.closed_date = C.TODAY();
      if (status !== 'closed' && existing?.status === 'closed' && data.status) data.closed_date = null;
    },
    after(ctx, row, existing) {
      if (!existing) {
        systemNote(ctx, { client_id: row.client_id, policy_id: row.policy_id, claim_id: row.id, subject: `Claim reported (${row.loss_type || 'loss'} on ${row.loss_date})` });
      } else if (existing.status !== row.status) {
        systemNote(ctx, { client_id: row.client_id, policy_id: row.policy_id, claim_id: row.id, subject: `Claim status: ${existing.status} → ${row.status}` });
      }
    },
  });
}
