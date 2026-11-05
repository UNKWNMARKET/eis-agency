// Tiny schema validator. Spec: { field: { t: 'text'|'int'|'num'|'date'|'email'|'enum'|'bool'|'ref', req, vals, max, min, def } }

export class HttpError extends Error {
  constructor(status, message, fields) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function coerce(name, rule, raw) {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return { value: null };
  switch (rule.t) {
    case 'text': {
      if (typeof raw !== 'string' && typeof raw !== 'number') return { error: 'must be text' };
      const v = String(raw).trim();
      if (v.length > (rule.max ?? 4000)) return { error: `must be at most ${rule.max ?? 4000} characters` };
      return { value: v };
    }
    case 'email': {
      const v = String(raw).trim();
      return EMAIL_RE.test(v) && v.length <= 254 ? { value: v } : { error: 'must be a valid email' };
    }
    case 'int':
    case 'ref': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isInteger(n)) return { error: 'must be a whole number' };
      if (rule.min !== undefined && n < rule.min) return { error: `must be at least ${rule.min}` };
      if (rule.max !== undefined && n > rule.max) return { error: `must be at most ${rule.max}` };
      return { value: n };
    }
    case 'num': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n)) return { error: 'must be a number' };
      if (rule.min !== undefined && n < rule.min) return { error: `must be at least ${rule.min}` };
      if (rule.max !== undefined && n > rule.max) return { error: `must be at most ${rule.max}` };
      return { value: Math.round(n * 100) / 100 };
    }
    case 'date':
      return isDate(raw) ? { value: raw } : { error: 'must be a date (YYYY-MM-DD)' };
    case 'enum': {
      const vals = typeof rule.vals === 'function' ? rule.vals() : rule.vals;
      return vals.includes(raw) ? { value: raw } : { error: `must be one of: ${vals.join(', ')}` };
    }
    case 'bool':
      if (raw === true || raw === 1 || raw === '1' || raw === 'true') return { value: 1 };
      if (raw === false || raw === 0 || raw === '0' || raw === 'false') return { value: 0 };
      return { error: 'must be true or false' };
    default:
      throw new Error(`Unknown type ${rule.t} for ${name}`);
  }
}

/** Returns cleaned data containing only spec'd keys. Throws HttpError(400) on problems. */
export function clean(spec, input, { partial = false } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Request body must be a JSON object');
  const data = {};
  const errors = {};
  for (const [name, rule] of Object.entries(spec)) {
    const present = Object.prototype.hasOwnProperty.call(input, name) && input[name] !== undefined;
    if (!present) {
      if (partial) continue;
      if (rule.req && rule.def === undefined) { errors[name] = 'is required'; continue; }
      data[name] = rule.def === undefined ? null : rule.def;
      continue;
    }
    const { value, error } = coerce(name, rule, input[name]);
    if (error) { errors[name] = error; continue; }
    if (value === null) {
      if (rule.req) { errors[name] = 'is required'; continue; }
      data[name] = rule.def !== undefined && !partial ? rule.def : null;
      continue;
    }
    data[name] = value;
  }
  if (Object.keys(errors).length) {
    throw new HttpError(400, 'Validation failed: ' + Object.entries(errors).map(([k, v]) => `${k} ${v}`).join('; '), errors);
  }
  return data;
}

export function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function addMonths(dateStr, months) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const total = (y * 12 + (m - 1)) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

export function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}
