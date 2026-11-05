import { registerCrud } from '../crud.js';
import { idParam, notFound } from '../http.js';
import { clean, HttpError } from '../validate.js';
import { audit } from '../audit.js';
import { tx } from '../db.js';
import * as C from '../constants.js';
import { nextNumber } from '../domain.js';
import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';

export const UPLOAD_DIR = resolve(process.env.AMS_UPLOADS || 'data/uploads');
const MAX_UPLOAD = 10 * 1024 * 1024;
const MIME = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv', '.txt': 'text/plain', '.eml': 'message/rfc822', '.msg': 'application/vnd.ms-outlook',
};

const longDate = (d) => {
  if (!d) return '';
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
};
/** Collect stored file names for documents attached to a record (call BEFORE the cascade delete). */
export function documentFilesFor(db, column, id) {
  if (!['client_id', 'policy_id', 'claim_id'].includes(column)) throw new Error('bad column');
  return db.prepare(`SELECT storage_name FROM documents WHERE ${column} = ?`).all(id).map((d) => d.storage_name);
}
export function removeFiles(names) {
  for (const n of names) { try { unlinkSync(join(UPLOAD_DIR, n)); } catch { /* already gone */ } }
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function registerWork(r) {
  /* ---------- Tasks ---------- */
  registerCrud(r, {
    name: 'tasks', table: 'tasks', alias: 't', entity: 'task',
    select: `t.*, u.name AS assigned_name, c.display_name AS client_name, p.policy_number,
             CASE WHEN t.status = 'open' AND t.due_date < date('now') THEN 1 ELSE 0 END AS overdue`,
    from: 'FROM tasks t LEFT JOIN users u ON u.id = t.assigned_to LEFT JOIN clients c ON c.id = t.client_id LEFT JOIN policies p ON p.id = t.policy_id',
    spec: {
      title: { t: 'text', req: true, max: 200 }, description: { t: 'text' }, due_date: { t: 'date' },
      priority: { t: 'enum', vals: C.TASK_PRIORITY, def: 'normal' }, status: { t: 'enum', vals: C.TASK_STATUS, def: 'open' },
      assigned_to: { t: 'ref' }, client_id: { t: 'ref' }, policy_id: { t: 'ref' }, claim_id: { t: 'ref' }, opportunity_id: { t: 'ref' },
    },
    search: ['t.title', 't.description', 'c.display_name'],
    filters: {
      assigned_to: 't.assigned_to', status: 't.status', priority: 't.priority', client_id: 't.client_id', policy_id: 't.policy_id',
      claim_id: 't.claim_id', opportunity_id: 't.opportunity_id',
      overdue: { sql: "(? = '1' AND t.status = 'open' AND t.due_date < date('now'))" },
      due_to: { sql: 't.due_date <= ?' }, due_from: { sql: 't.due_date >= ?' },
    },
    sorts: { due: 't.due_date', priority: "CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END", title: 't.title', assigned: 'u.name' },
    defaultSort: "t.status = 'done', t.due_date IS NULL, t.due_date ASC",
    remove: C.WRITE_ROLES,
    before(ctx, data, existing) {
      if (!existing) { data.created_by = ctx.user.id; data.assigned_to ??= ctx.user.id; }
      if (data.status === 'done' && existing?.status !== 'done') data.completed_at = new Date().toISOString();
      if (data.status === 'open' && existing?.status === 'done') data.completed_at = null;
    },
  });

  /* ---------- Activities / notes ---------- */
  registerCrud(r, {
    name: 'activities', table: 'activities', alias: 'a', entity: 'activity',
    select: 'a.*, u.name AS user_name',
    from: 'FROM activities a LEFT JOIN users u ON u.id = a.user_id',
    spec: {
      kind: { t: 'enum', vals: C.ACTIVITY_KINDS.filter((k) => k !== 'system'), def: 'note' }, subject: { t: 'text', max: 200 }, body: { t: 'text' },
      client_id: { t: 'ref' }, policy_id: { t: 'ref' }, claim_id: { t: 'ref' }, opportunity_id: { t: 'ref' },
    },
    filters: { client_id: 'a.client_id', policy_id: 'a.policy_id', claim_id: 'a.claim_id', opportunity_id: 'a.opportunity_id', kind: 'a.kind' },
    search: ['a.subject', 'a.body'],
    defaultSort: 'a.created_at DESC, a.id DESC', touch: false, remove: C.WRITE_ROLES,
    before(ctx, data, existing) {
      if (existing) {
        if (existing.kind === 'system') throw new HttpError(403, 'System entries cannot be edited');
        if (existing.user_id !== ctx.user.id && !C.MANAGE_ROLES.includes(ctx.user.role)) throw new HttpError(403, 'You can only edit your own notes');
        delete data.client_id; delete data.policy_id; delete data.claim_id; delete data.opportunity_id;
        return;
      }
      if (!data.client_id && !data.policy_id && !data.claim_id && !data.opportunity_id) throw new HttpError(400, 'A note must be attached to a client, policy, claim or opportunity');
      if (!data.subject && !data.body) throw new HttpError(400, 'Enter a subject or details', { body: 'is required' });
      data.user_id = ctx.user.id;
      if (data.policy_id && !data.client_id) data.client_id = ctx.db.prepare('SELECT client_id FROM policies WHERE id = ?').get(data.policy_id)?.client_id ?? null;
    },
    beforeDelete(ctx, row) {
      if (row.kind === 'system' && !C.MANAGE_ROLES.includes(ctx.user.role)) throw new HttpError(403, 'System entries cannot be deleted');
      if (row.user_id !== ctx.user.id && !C.MANAGE_ROLES.includes(ctx.user.role)) throw new HttpError(403, 'You can only delete your own notes');
    },
  });

  /* ---------- Documents ---------- */
  registerCrud(r, {
    name: 'documents', table: 'documents', alias: 'd', entity: 'document', only: ['list'],
    select: 'd.id, d.name, d.category, d.mime, d.size, d.client_id, d.policy_id, d.claim_id, d.created_at, u.name AS uploaded_by_name',
    from: 'FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by',
    search: ['d.name'], filters: { client_id: 'd.client_id', policy_id: 'd.policy_id', claim_id: 'd.claim_id', category: 'd.category' },
    defaultSort: 'd.created_at DESC',
  });

  r.post('/api/documents', { roles: C.WRITE_ROLES }, (ctx) => {
    const b = clean({
      name: { t: 'text', req: true, max: 200 }, category: { t: 'enum', vals: C.DOC_CATEGORIES, def: 'other' },
      client_id: { t: 'ref' }, policy_id: { t: 'ref' }, claim_id: { t: 'ref' },
    }, ctx.body);
    if (!b.client_id && !b.policy_id && !b.claim_id) throw new HttpError(400, 'Attach the document to a client, policy or claim');
    if (typeof ctx.body.data !== 'string') throw new HttpError(400, 'File data (base64) is required');
    const safeName = b.name.replace(/[\\/\0]/g, '_').replace(/^\.+/, '');
    const ext = extname(safeName).toLowerCase();
    if (!MIME[ext]) throw new HttpError(400, `File type ${ext || '(none)'} is not allowed. Allowed: ${Object.keys(MIME).join(', ')}`);
    const buf = Buffer.from(ctx.body.data, 'base64');
    if (buf.length === 0) throw new HttpError(400, 'File is empty');
    if (buf.length > MAX_UPLOAD) throw new HttpError(413, 'File exceeds the 10 MB limit');
    if (b.policy_id && !b.client_id) b.client_id = ctx.db.prepare('SELECT client_id FROM policies WHERE id = ?').get(b.policy_id)?.client_id ?? null;
    if (b.claim_id && !b.client_id) b.client_id = ctx.db.prepare('SELECT client_id FROM claims WHERE id = ?').get(b.claim_id)?.client_id ?? null;
    mkdirSync(UPLOAD_DIR, { recursive: true });
    const storage = randomUUID() + ext;
    writeFileSync(join(UPLOAD_DIR, storage), buf);
    try {
      const info = ctx.db.prepare(
        'INSERT INTO documents (name, category, mime, size, storage_name, client_id, policy_id, claim_id, uploaded_by) VALUES (?,?,?,?,?,?,?,?,?)'
      ).run(safeName, b.category, MIME[ext], buf.length, storage, b.client_id, b.policy_id, b.claim_id, ctx.user.id);
      const id = Number(info.lastInsertRowid);
      audit(ctx, 'upload', 'document', id, { name: safeName, size: buf.length });
      ctx.status = 201;
      return { id, name: safeName, size: buf.length };
    } catch (e) {
      unlinkSync(join(UPLOAD_DIR, storage));
      throw e;
    }
  });

  r.get('/api/documents/:id/download', (ctx) => {
    const d = ctx.db.prepare('SELECT * FROM documents WHERE id = ?').get(idParam(ctx));
    if (!d) throw notFound('Document');
    const path = join(UPLOAD_DIR, d.storage_name);
    if (!existsSync(path)) throw new HttpError(410, 'The stored file is missing');
    audit(ctx, 'download', 'document', d.id, d.name);
    return { raw: readFileSync(path), contentType: d.mime, filename: d.name };
  });

  r.delete('/api/documents/:id', { roles: C.WRITE_ROLES }, (ctx) => {
    const d = ctx.db.prepare('SELECT * FROM documents WHERE id = ?').get(idParam(ctx));
    if (!d) throw notFound('Document');
    if (d.uploaded_by !== ctx.user.id && !C.MANAGE_ROLES.includes(ctx.user.role)) throw new HttpError(403, 'You can only delete documents you uploaded');
    ctx.db.prepare('DELETE FROM documents WHERE id = ?').run(d.id);
    try { unlinkSync(join(UPLOAD_DIR, d.storage_name)); } catch { /* already gone */ }
    audit(ctx, 'delete', 'document', d.id, d.name);
    return { ok: true };
  });

  /* ---------- Email / letter templates ---------- */
  registerCrud(r, {
    name: 'templates', table: 'templates', alias: 'tp', entity: 'template',
    spec: { name: { t: 'text', req: true, max: 120 }, category: { t: 'text', max: 40, def: 'general' }, subject: { t: 'text', req: true, max: 200 }, body: { t: 'text', req: true, max: 8000 } },
    search: ['tp.name', 'tp.subject'], filters: { category: 'tp.category' }, defaultSort: 'tp.category, tp.name',
    write: C.MANAGE_ROLES, touch: false,
  });

  r.post('/api/templates/:id/render', (ctx) => {
    const t = ctx.db.prepare('SELECT * FROM templates WHERE id = ?').get(idParam(ctx));
    if (!t) throw notFound('Template');
    const b = clean({ client_id: { t: 'ref' }, policy_id: { t: 'ref' } }, ctx.body || {});
    const policy = b.policy_id ? ctx.db.prepare(
      'SELECT p.*, ca.name AS carrier_name FROM policies p JOIN carriers ca ON ca.id = p.carrier_id WHERE p.id = ?').get(b.policy_id) : null;
    const client = ctx.db.prepare('SELECT * FROM clients WHERE id = ?').get(b.client_id ?? policy?.client_id ?? -1);
    const agency = Object.fromEntries(ctx.db.prepare("SELECT key, value FROM settings WHERE key LIKE 'agency_%'").all().map((s) => [s.key, s.value]));
    const vars = {
      client_name: client ? (client.type === 'business' ? client.business_name : `${client.first_name ?? ''} ${client.last_name ?? ''}`.trim()) : '',
      first_name: client?.first_name || client?.business_name || '', last_name: client?.last_name || '',
      policy_number: policy?.policy_number ?? '', carrier: policy?.carrier_name ?? '', line: policy ? C.LINES[policy.line] ?? policy.line : '',
      effective_date: longDate(policy?.effective_date), expiration_date: longDate(policy?.expiration_date),
      premium: policy ? '$' + policy.premium.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '',
      agent_name: ctx.user.name, agency_name: agency.agency_name ?? '', agency_phone: agency.agency_phone ?? '', agency_email: agency.agency_email ?? '',
    };
    const fill = (s) => s.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k) => (k in vars ? vars[k] : m));
    return { subject: fill(t.subject), body: fill(t.body), to: client?.email ?? null, client_id: client?.id ?? null, policy_id: policy?.id ?? null };
  });

  /* ---------- Certificates of insurance ---------- */
  registerCrud(r, {
    name: 'certificates', table: 'certificates', alias: 'ce', entity: 'certificate', only: ['list', 'delete'],
    select: `ce.*, c.display_name AS client_name,
             (SELECT GROUP_CONCAT(p.policy_number, ', ') FROM certificate_policies cp JOIN policies p ON p.id = cp.policy_id WHERE cp.certificate_id = ce.id) AS policy_numbers`,
    from: 'FROM certificates ce JOIN clients c ON c.id = ce.client_id',
    search: ['ce.number', 'ce.holder_name', 'c.display_name'], filters: { client_id: 'ce.client_id' },
    sorts: { number: 'ce.number', issued: 'ce.issued_date', holder: 'ce.holder_name', client: 'c.display_name' }, defaultSort: 'ce.issued_date DESC, ce.id DESC',
    remove: C.MANAGE_ROLES,
  });

  r.post('/api/certificates', { roles: C.WRITE_ROLES }, (ctx) => {
    const b = clean({
      client_id: { t: 'ref', req: true }, holder_name: { t: 'text', req: true, max: 200 }, holder_address: { t: 'text', max: 400 },
      description: { t: 'text', max: 3000 }, additional_insured: { t: 'bool', def: 0 }, waiver_of_subrogation: { t: 'bool', def: 0 },
      primary_noncontributory: { t: 'bool', def: 0 }, issued_date: { t: 'date', def: C.TODAY() },
    }, ctx.body);
    const policyIds = Array.isArray(ctx.body.policy_ids) ? [...new Set(ctx.body.policy_ids.map(Number))] : [];
    if (!policyIds.length || policyIds.some((n) => !Number.isInteger(n))) throw new HttpError(400, 'Select at least one policy', { policy_ids: 'is required' });
    return tx(ctx.db, () => {
      for (const pid of policyIds) {
        const p = ctx.db.prepare('SELECT status, client_id FROM policies WHERE id = ?').get(pid);
        if (!p || p.client_id !== b.client_id) throw new HttpError(400, 'Selected policy does not belong to this client', { policy_ids: 'invalid' });
        if (!['active', 'pending_cancel'].includes(p.status)) throw new HttpError(400, 'Certificates can only be issued on in-force policies', { policy_ids: 'must be active' });
      }
      const number = nextNumber(ctx.db, 'certificate', 'COI');
      const info = ctx.db.prepare(
        `INSERT INTO certificates (number, client_id, holder_name, holder_address, description, additional_insured, waiver_of_subrogation, primary_noncontributory, issued_date, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).run(number, b.client_id, b.holder_name, b.holder_address, b.description, b.additional_insured, b.waiver_of_subrogation, b.primary_noncontributory, b.issued_date, ctx.user.id);
      const id = Number(info.lastInsertRowid);
      for (const pid of policyIds) ctx.db.prepare('INSERT INTO certificate_policies (certificate_id, policy_id) VALUES (?,?)').run(id, pid);
      audit(ctx, 'create', 'certificate', id, { number, holder: b.holder_name, policies: policyIds });
      ctx.status = 201;
      return { id, number };
    });
  });

  /** Printable certificate. Informational summary — not an official ACORD form. */
  r.get('/api/certificates/:id/html', (ctx) => {
    const id = idParam(ctx);
    const cert = ctx.db.prepare('SELECT * FROM certificates WHERE id = ?').get(id);
    if (!cert) throw notFound('Certificate');
    const client = ctx.db.prepare('SELECT * FROM clients WHERE id = ?').get(cert.client_id);
    const pols = ctx.db.prepare(
      `SELECT p.*, ca.name AS carrier_name, ca.naic FROM certificate_policies cp JOIN policies p ON p.id = cp.policy_id
         JOIN carriers ca ON ca.id = p.carrier_id WHERE cp.certificate_id = ? ORDER BY p.line`).all(id);
    const agency = Object.fromEntries(ctx.db.prepare("SELECT key, value FROM settings WHERE key LIKE 'agency_%'").all().map((s) => [s.key, s.value]));
    const covs = ctx.db.prepare('SELECT * FROM coverages WHERE policy_id = ? ORDER BY id');
    const addr = [client.address1, client.address2, [client.city, client.state, client.zip].filter(Boolean).join(' ')].filter(Boolean);
    const rows = pols.map((p) => `
      <tr>
        <td><strong>${esc(C.LINES[p.line] || p.line)}</strong>${cert.additional_insured ? '<br><small>Additional insured: Y</small>' : ''}${cert.waiver_of_subrogation ? '<br><small>Waiver of subrogation: Y</small>' : ''}${cert.primary_noncontributory ? '<br><small>Primary &amp; non-contributory: Y</small>' : ''}</td>
        <td>${esc(p.carrier_name)}${p.naic ? `<br><small>NAIC ${esc(p.naic)}</small>` : ''}</td>
        <td>${esc(p.policy_number)}</td><td>${esc(p.effective_date)}</td><td>${esc(p.expiration_date)}</td>
        <td>${covs.all(p.id).map((cv) => `${esc(cv.coverage)}${cv.limit_text ? ': ' + esc(cv.limit_text) : ''}`).join('<br>') || '—'}</td>
      </tr>`).join('');
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Certificate ${esc(cert.number)}</title>
<style>
 body{font:13px/1.45 Arial,Helvetica,sans-serif;color:#111;margin:0;background:#eee}
 .page{max-width:820px;margin:20px auto;background:#fff;padding:32px 40px;box-shadow:0 1px 6px rgba(0,0,0,.25)}
 h1{font-size:20px;margin:0 0 4px} .top{display:flex;justify-content:space-between;border-bottom:3px solid #111;padding-bottom:10px;margin-bottom:14px}
 .box{border:1px solid #444;padding:8px 10px;margin-bottom:10px} .box h2{font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin:0 0 4px;color:#444}
 table{width:100%;border-collapse:collapse} th,td{border:1px solid #444;padding:6px 8px;text-align:left;vertical-align:top;font-size:12px} th{background:#f0f0f0}
 small{color:#444} .fine{font-size:10.5px;color:#333;margin-top:12px} .actions{max-width:820px;margin:12px auto;text-align:right}
 button{font:inherit;padding:8px 16px;cursor:pointer}
 @media print{body{background:#fff}.page{box-shadow:none;margin:0;max-width:none}.actions{display:none}}
</style></head><body>
<div class="actions"><button id="print">Print / Save as PDF</button></div>
<div class="page">
 <div class="top"><div><h1>CERTIFICATE OF INSURANCE</h1><small>Informational summary of coverage</small></div>
 <div style="text-align:right"><strong>${esc(cert.number)}</strong><br>Date issued: ${esc(cert.issued_date)}</div></div>
 <div class="box"><h2>Producer</h2><strong>${esc(agency.agency_name || 'Agency')}</strong><br>${esc(agency.agency_address || '')}<br>${esc(agency.agency_phone || '')} ${esc(agency.agency_email || '')}${agency.agency_license ? '<br>License: ' + esc(agency.agency_license) : ''}</div>
 <div class="box"><h2>Insured</h2><strong>${esc(client.display_name)}</strong>${client.dba ? ' (dba ' + esc(client.dba) + ')' : ''}<br>${addr.map(esc).join('<br>')}</div>
 <table><thead><tr><th>Type of insurance</th><th>Insurer</th><th>Policy no.</th><th>Effective</th><th>Expires</th><th>Limits</th></tr></thead><tbody>${rows}</tbody></table>
 <div class="box" style="margin-top:10px"><h2>Description of operations / locations / vehicles</h2>${esc(cert.description || '—').replace(/\n/g, '<br>')}</div>
 <div class="box"><h2>Certificate holder</h2><strong>${esc(cert.holder_name)}</strong><br>${esc(cert.holder_address || '').replace(/\n/g, '<br>')}</div>
 <p class="fine">This certificate is issued as a matter of information only and confers no rights upon the certificate holder. It does not affirmatively or negatively amend, extend or alter the coverage afforded by the policies listed. Coverage is subject to all policy terms, conditions and exclusions. Should any of the policies be cancelled before the expiration date, notice will be delivered in accordance with the policy provisions.</p>
</div><script src="/js/print.js"></script></body></html>`;
    return { rawHtml: html };
  });
}
