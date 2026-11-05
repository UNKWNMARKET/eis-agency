import { HttpError } from './validate.js';

/** Minimal router. Paths like /api/clients/:id. */
export class Router {
  constructor() { this.routes = []; }

  add(method, path, opts, handler) {
    if (typeof opts === 'function') { handler = opts; opts = {}; }
    const keys = [];
    const re = new RegExp('^' + path.replace(/:([a-z_]+)/gi, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, roles: opts.roles, public: !!opts.public, handler });
  }
  get(p, o, h) { this.add('GET', p, o, h); }
  post(p, o, h) { this.add('POST', p, o, h); }
  put(p, o, h) { this.add('PUT', p, o, h); }
  delete(p, o, h) { this.add('DELETE', p, o, h); }

  match(method, pathname) {
    let pathMatched = false;
    let best = null;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      // Prefer the most specific route: fewer :params means a more literal path (/x/payouts beats /x/:id).
      if (!best || r.keys.length < best.route.keys.length) best = { route: r, m };
    }
    if (!best) return { route: null, pathMatched };
    const params = {};
    try {
      best.route.keys.forEach((k, i) => { params[k] = decodeURIComponent(best.m[i + 1]); });
    } catch {
      return { route: null, pathMatched: false };
    }
    return { route: best.route, params };
  }
}

export function requireRole(ctx, roles) {
  if (!ctx.user) throw new HttpError(401, 'Authentication required');
  if (roles && !roles.includes(ctx.user.role)) throw new HttpError(403, 'You do not have permission to do that');
}

export function idParam(ctx, name = 'id') {
  const n = Number(ctx.params[name]);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, `Invalid ${name}`);
  return n;
}

export function notFound(what = 'Record') { return new HttpError(404, `${what} not found`); }

export function csvEscape(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s))) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toCsv(rows, columns) {
  const cols = columns || (rows[0] ? Object.keys(rows[0]) : []);
  const lines = [cols.map(csvEscape).join(',')];
  for (const r of rows) lines.push(cols.map((c) => csvEscape(r[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}

/** Parse CSV text (RFC4180-ish) into array of objects keyed by header. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x !== '')) rows.push(row);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}
