import { registerCrud } from '../crud.js';
import { clean, HttpError } from '../validate.js';
import { parseCsv } from '../http.js';
import { audit } from '../audit.js';
import { tx } from '../db.js';
import * as C from '../constants.js';
import { CLIENT_SPEC } from './core.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SETTING_KEYS = ['agency_name', 'agency_address', 'agency_phone', 'agency_email', 'agency_license'];

export function registerAdmin(r) {
  registerCrud(r, {
    name: 'audit', table: 'audit_log', alias: 'al', entity: 'audit', only: ['list'],
    select: 'al.*', search: ['al.user_name', 'al.entity', 'al.action', 'al.detail'],
    filters: { entity: 'al.entity', action: 'al.action', user_id: 'al.user_id', entity_id: 'al.entity_id', from: { sql: 'al.created_at >= ?' }, to: { sql: "al.created_at <= ? || ' 23:59:59'" } },
    sorts: { time: 'al.created_at' }, defaultSort: 'al.id DESC', read: C.MANAGE_ROLES,
    csv: ['created_at', 'user_name', 'action', 'entity', 'entity_id', 'detail'],
  });

  r.put('/api/settings', { roles: C.MANAGE_ROLES }, (ctx) => {
    const b = ctx.body || {};
    const up = ctx.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const k of SETTING_KEYS) {
      if (k in b) {
        if (typeof b[k] !== 'string' || b[k].length > 300) throw new HttpError(400, `${k} must be text up to 300 characters`);
        up.run(k, b[k].trim());
      }
    }
    audit(ctx, 'update', 'settings', null, b);
    return { ok: true };
  });

  /**
   * Bulk client import from CSV text. Columns: type, first_name, last_name, business_name, email, phone, mobile,
   * address1, city, state, zip, dob, status, industry, source. Set dry_run to validate only.
   */
  r.post('/api/import/clients', { roles: C.MANAGE_ROLES }, (ctx) => {
    const text = ctx.body?.csv;
    if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'Provide CSV text');
    const rows = parseCsv(text);
    if (!rows.length) throw new HttpError(400, 'No data rows found');
    if (rows.length > 5000) throw new HttpError(400, 'Import is limited to 5000 rows at a time');
    const dry = !!ctx.body.dry_run;
    const errors = [];
    const valid = [];
    rows.forEach((raw, i) => {
      try {
        const input = { ...raw };
        if (!input.type) input.type = input.business_name && !input.last_name ? 'business' : 'person';
        const data = clean(CLIENT_SPEC, input);
        if (data.type === 'business' ? !data.business_name : !data.last_name) throw new HttpError(400, data.type === 'business' ? 'business_name is required' : 'last_name is required');
        if (data.state) data.state = data.state.toUpperCase();
        valid.push(data);
      } catch (e) {
        errors.push({ row: i + 2, error: e.message });
      }
    });
    if (!dry && valid.length) {
      tx(ctx.db, () => {
        for (const d of valid) {
          const cols = Object.keys(d);
          ctx.db.prepare(`INSERT INTO clients (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => d[c]));
        }
      });
      audit(ctx, 'import', 'client', null, { created: valid.length, errors: errors.length });
    }
    return { dry_run: dry, valid: valid.length, created: dry ? 0 : valid.length, errors: errors.slice(0, 100), error_count: errors.length };
  });

  /** Consistent snapshot of the database for download (admin only). */
  r.get('/api/admin/backup', { roles: ['admin'] }, (ctx) => {
    const dir = mkdtempSync(join(tmpdir(), 'ams-backup-'));
    const file = join(dir, 'ams-backup.db');
    try {
      ctx.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
      const raw = readFileSync(file);
      audit(ctx, 'backup', 'database', null, `${raw.length} bytes`);
      return { raw, contentType: 'application/octet-stream', filename: `ams-backup-${C.TODAY()}.db` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
