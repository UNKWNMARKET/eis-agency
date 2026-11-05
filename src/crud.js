import { clean, HttpError } from './validate.js';
import { idParam, notFound, toCsv } from './http.js';
import { audit } from './audit.js';
import { WRITE_ROLES, MANAGE_ROLES } from './constants.js';

/**
 * Registers list/get/create/update/delete routes for a resource.
 *
 * cfg = {
 *   name, table, alias, select, from,        // select/from SQL fragments (joins allowed)
 *   spec,                                    // validation spec for writable fields
 *   search: ['c.display_name', ...],         // columns for ?q=
 *   filters: { status: 'c.status', expiring_before: { sql: 'p.expiration_date <= ?' } },
 *   sorts: { name: 'c.display_name' }, defaultSort: 'c.display_name ASC',
 *   read: roles | undefined, write: roles, remove: roles,
 *   touch: true (set updated_at), csv: [column names],
 *   before(ctx, data, existing)  -> may mutate data / throw
 *   after(ctx, row, existing)    -> side effects, runs inside the same request
 *   beforeDelete(ctx, row)
 *   afterDelete(ctx, row)        -> runs only after the row was actually deleted
 * }
 */
export function registerCrud(router, cfg) {
  const base = `/api/${cfg.name}`;
  const alias = cfg.alias || cfg.table;
  const select = cfg.select || `${alias}.*`;
  const from = cfg.from || `FROM ${cfg.table} ${alias}`;
  const writeRoles = cfg.write || WRITE_ROLES;
  const removeRoles = cfg.remove || MANAGE_ROLES;
  const entity = cfg.entity || cfg.name.replace(/s$/, '');

  const has = (verb) => !cfg.only || cfg.only.includes(verb);
  const fetchOne = (ctx, id) => ctx.db.prepare(`SELECT ${select} ${from} WHERE ${alias}.id = ?`).get(id);

  if (has('list')) router.get(base, { roles: cfg.read }, (ctx) => {
    const where = [];
    const args = [];
    const q = ctx.query.q?.trim();
    if (q && cfg.search?.length) {
      where.push('(' + cfg.search.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ') + ')');
      const like = '%' + q.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
      cfg.search.forEach(() => args.push(like));
    }
    for (const [key, def] of Object.entries(cfg.filters || {})) {
      const v = ctx.query[key];
      if (v === undefined || v === '') continue;
      if (typeof def === 'string') {
        if (v.includes(',')) {
          const parts = v.split(',');
          where.push(`${def} IN (${parts.map(() => '?').join(',')})`);
          args.push(...parts);
        } else { where.push(`${def} = ?`); args.push(v); }
      } else {
        where.push(def.sql);
        for (let i = 0; i < (def.n || 1); i++) args.push(v);
      }
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const sortKey = ctx.query.sort;
    const dir = ctx.query.dir === 'desc' ? 'DESC' : 'ASC';
    const orderCol = cfg.sorts && Object.prototype.hasOwnProperty.call(cfg.sorts, sortKey) ? `${cfg.sorts[sortKey]} ${dir}` : cfg.defaultSort || `${alias}.id DESC`;
    const isCsv = ctx.query.format === 'csv';
    const limit = isCsv ? 20000 : Math.min(Math.max(parseInt(ctx.query.limit, 10) || 25, 1), 500);
    const offset = isCsv ? 0 : Math.max(parseInt(ctx.query.offset, 10) || 0, 0);

    const total = ctx.db.prepare(`SELECT COUNT(*) AS n ${from} ${whereSql}`).get(...args).n;
    const rows = ctx.db.prepare(`SELECT ${select} ${from} ${whereSql} ORDER BY ${orderCol}, ${alias}.id LIMIT ? OFFSET ?`).all(...args, limit, offset);
    const out = rows.map((r) => ({ ...r }));
    if (isCsv) {
      audit(ctx, 'export', entity, null, `${out.length} rows`);
      return { csv: toCsv(out, cfg.csv), filename: `${cfg.name}.csv` };
    }
    return { rows: out, total, limit, offset };
  });

  if (has('get')) router.get(`${base}/:id`, { roles: cfg.read }, (ctx) => {
    const row = fetchOne(ctx, idParam(ctx));
    if (!row) throw notFound(entity);
    return { ...row };
  });

  if (has('create')) router.post(base, { roles: writeRoles }, (ctx) => {
    const data = clean(cfg.spec, ctx.body);
    if (cfg.before) cfg.before(ctx, data, null);
    const cols = Object.keys(data);
    const info = ctx.db.prepare(`INSERT INTO ${cfg.table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => data[c]));
    const id = Number(info.lastInsertRowid);
    audit(ctx, 'create', entity, id, summarize(data));
    const row = fetchOne(ctx, id);
    if (cfg.after) cfg.after(ctx, row, null);
    ctx.status = 201;
    return { ...row };
  });

  const update = (ctx) => {
    const id = idParam(ctx);
    const existing = ctx.db.prepare(`SELECT * FROM ${cfg.table} WHERE id = ?`).get(id);
    if (!existing) throw notFound(entity);
    const data = clean(cfg.spec, ctx.body, { partial: true });
    if (cfg.before) cfg.before(ctx, data, existing);
    const cols = Object.keys(data);
    if (cols.length) {
      const sets = cols.map((c) => `${c} = ?`);
      if (cfg.touch !== false && hasColumn(ctx.db, cfg.table, 'updated_at')) sets.push("updated_at = datetime('now')");
      ctx.db.prepare(`UPDATE ${cfg.table} SET ${sets.join(', ')} WHERE id = ?`).run(...cols.map((c) => data[c]), id);
      audit(ctx, 'update', entity, id, diff(existing, data));
    }
    const row = fetchOne(ctx, id);
    if (cfg.after) cfg.after(ctx, row, existing);
    return { ...row };
  };
  if (has('update')) router.put(`${base}/:id`, { roles: writeRoles }, update);

  if (has('delete')) router.delete(`${base}/:id`, { roles: removeRoles }, (ctx) => {
    const id = idParam(ctx);
    const row = ctx.db.prepare(`SELECT * FROM ${cfg.table} WHERE id = ?`).get(id);
    if (!row) throw notFound(entity);
    if (cfg.beforeDelete) cfg.beforeDelete(ctx, row);
    try {
      ctx.db.prepare(`DELETE FROM ${cfg.table} WHERE id = ?`).run(id);
    } catch (e) {
      if (/FOREIGN KEY/i.test(e.message)) throw new HttpError(409, `This ${entity} is referenced by other records and cannot be deleted`);
      throw e;
    }
    audit(ctx, 'delete', entity, id, summarize(row));
    if (cfg.afterDelete) cfg.afterDelete(ctx, row);
    return { ok: true };
  });
}

const colCache = new Map();
function hasColumn(db, table, col) {
  const key = table;
  if (!colCache.has(key)) colCache.set(key, new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)));
  return colCache.get(key).has(col);
}

function summarize(data) {
  const out = {};
  for (const [k, v] of Object.entries(data)) if (v !== null && v !== '' && k !== 'password_hash') out[k] = v;
  return out;
}

function diff(before, after) {
  const out = {};
  for (const [k, v] of Object.entries(after)) if (before[k] !== v) out[k] = { from: before[k], to: v };
  return out;
}
