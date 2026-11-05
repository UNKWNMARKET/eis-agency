// Shared UI helpers. All DOM is built with textContent / property setters — never innerHTML — so record data cannot inject markup.

/* ---------- DOM ---------- */
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  let value, checked;
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'value') value = v;
    else if (k === 'checked') checked = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, kids);
  if (value !== undefined) el.value = value;
  if (checked !== undefined) el.checked = !!checked;
  return el;
}
export function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}
/** Empties `el` and returns an appender that (unlike Element.append) accepts arrays and ignores null/false. */
export const clear = (el) => {
  while (el.firstChild) el.removeChild(el.firstChild);
  return { append: (...kids) => append(el, kids), el };
};
export const $ = (sel, root = document) => root.querySelector(sel);

/* ---------- Formatting ---------- */
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
export const money = (n) => (n === null || n === undefined || n === '' ? '—' : usd.format(Number(n)));
export const money0 = (n) => (n === null || n === undefined ? '—' : usd0.format(Number(n)));
export const num = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US'));
export const pct = (n) => (n === null || n === undefined ? '—' : `${n}%`);
export function date(d) {
  if (!d) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if (!m) return d;
  return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
export function dateTime(s) {
  if (!s) return '—';
  const d = new Date(s.replace(' ', 'T') + (s.includes('Z') || s.includes('+') ? '' : 'Z'));
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
export const todayStr = () => new Date().toISOString().slice(0, 10);
export const addDaysStr = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
export const title = (s) => { const t = String(s ?? '').replace(/_/g, ' '); return t.charAt(0).toUpperCase() + t.slice(1); };
export const meta = { value: null };
export const lineName = (k) => meta.value?.lines[k] || title(k);

const BADGE = {
  active: 'green', paid: 'green', won: 'green', received: 'green', approved: 'green', done: 'green', renewed: 'green', accepted: 'green',
  prospect: 'blue', quoting: 'blue', new: 'blue', open: 'blue', in_review: 'amber', quoted: 'blue', offered: 'blue', proposal: 'purple', presented: 'purple',
  pending_cancel: 'amber', partial: 'amber', expected: 'amber', contacted: 'amber', remarketing: 'amber', pending: 'amber', disputed: 'amber', in_review_: 'amber',
  cancelled: 'red', lost: 'red', denied: 'red', non_renewed: 'red', expired: 'red', void: 'red', written_off: 'red', declined: 'red', urgent: 'red', high: 'amber',
  inactive: '', closed: '', quote: 'blue', not_started: '',
};
export function badge(v, kind) {
  if (v === null || v === undefined || v === '') return '—';
  const k = kind || BADGE[v] || '';
  return h('span', { class: `badge ${k ? 'b-' + k : ''}` }, title(v));
}

/* ---------- API ---------- */
export class ApiError extends Error {
  constructor(status, message, fields) { super(message); this.status = status; this.fields = fields || {}; }
}
export async function api(method, path, body) {
  const opts = { method, headers: { 'X-Requested-With': 'ams' }, credentials: 'same-origin' };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(path, opts); } catch { throw new ApiError(0, 'Network error — is the server running?'); }
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/')) window.dispatchEvent(new Event('ams:unauth'));
    throw new ApiError(res.status, data?.error || res.statusText, data?.fields);
  }
  return data;
}
export const get = (p, params) => api('GET', params ? p + '?' + qs(params) : p);
export const post = (p, b = {}) => api('POST', p, b);
export const put = (p, b) => api('PUT', p, b);
export const del = (p) => api('DELETE', p);
export function qs(params) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, v);
  return u.toString();
}

/* ---------- Toasts / dialogs ---------- */
export function toast(msg, type = 'ok') {
  const el = h('div', { class: 'toast' + (type === 'err' ? ' err' : ''), role: 'status' }, msg);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), type === 'err' ? 6000 : 3200);
}
export const fail = (e) => toast(e instanceof ApiError || e instanceof Error ? e.message : String(e), 'err');

let modalDepth = 0;
export function modal({ title: ttl, body, actions = [], wide = false, onClose }) {
  const previouslyFocused = document.activeElement;
  const close = () => {
    overlay.remove(); modalDepth--;
    document.removeEventListener('keydown', onKey);
    previouslyFocused?.focus?.();
    onClose?.();
  };
  const onKey = (e) => { if (e.key === 'Escape' && overlay === [...document.querySelectorAll('.overlay')].pop()) close(); };
  const overlay = h('div', { class: 'overlay', onmousedown: (e) => { if (e.target === overlay) close(); } },
    h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': ttl },
      h('div', { class: 'modal-h' }, h('h2', null, ttl), h('button', { class: 'x', type: 'button', 'aria-label': 'Close', onclick: close }, '×')),
      h('div', { class: 'modal-b' }, body),
      actions.length ? h('div', { class: 'modal-f' }, actions) : null));
  document.body.append(overlay);
  modalDepth++;
  document.addEventListener('keydown', onKey);
  overlay.querySelector('input:not([type=hidden]), select, textarea')?.focus();
  return { close, el: overlay };
}

export function confirmDialog(message, { confirmLabel = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const m = modal({
      title: 'Please confirm', body: h('p', null, message), onClose: () => finish(false),
      actions: [
        h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
        h('button', { class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary'), onclick: () => { finish(true); m.close(); } }, confirmLabel),
      ],
    });
  });
}

/* ---------- Forms ---------- */
/**
 * fields: [{ name, label, type, options, required, help, full, placeholder, step, min, max, rows, value }]
 * types: text email tel number money date select textarea checkbox client policy
 */
export function buildForm(fields, values = {}) {
  const inputs = {};
  const errs = {};
  const nodes = fields.map((f) => {
    if (f.type === 'heading') return h('h3', { class: 'full', style: { gridColumn: '1 / -1', marginTop: '6px' } }, f.label);
    let input;
    const v = values[f.name] ?? f.value ?? '';
    const common = { id: 'f_' + f.name, name: f.name, required: f.required, placeholder: f.placeholder };
    switch (f.type) {
      case 'select':
        input = h('select', common, !f.required || f.blank ? h('option', { value: '' }, f.blankLabel || '—') : null,
          (typeof f.options === 'function' ? f.options() : f.options).map(([val, label]) => h('option', { value: val }, label)));
        if (v !== null && v !== '') input.value = String(v); // keep the browser's default option when there is no value
        else if (!f.required || f.blank) input.value = '';
        break;
      case 'textarea':
        input = h('textarea', { ...common, rows: f.rows || 3 }); input.value = v ?? ''; break;
      case 'checkbox':
        input = h('input', { type: 'checkbox', id: common.id, name: f.name, checked: !!values[f.name] }); break;
      case 'client': case 'policy':
        input = autocomplete(f, values); break;
      case 'money': case 'number':
        input = h('input', { ...common, type: 'number', step: f.step || (f.type === 'money' ? '0.01' : '1'), min: f.min, max: f.max, value: v ?? '' }); break;
      default:
        input = h('input', { ...common, type: f.type || 'text', value: v ?? '', maxlength: f.maxlength });
    }
    inputs[f.name] = input;
    const errEl = h('div', { class: 'err', role: 'alert' });
    errs[f.name] = errEl;
    if (f.type === 'checkbox') return h('div', { class: 'field check' + (f.full ? ' full' : '') }, input, h('label', { for: common.id }, f.label), errEl);
    return h('div', { class: 'field' + (f.full || f.type === 'textarea' ? ' full' : '') },
      h('label', { for: common.id, class: f.required ? 'req' : '' }, f.label), input, f.help ? h('div', { class: 'help' }, f.help) : null, errEl);
  });
  const banner = h('div', { class: 'form-banner', hidden: true, role: 'alert' });
  const el = h('form', { novalidate: true }, banner, h('div', { class: 'form-grid' }, nodes));
  const read = () => {
    const out = {};
    for (const f of fields) {
      const i = inputs[f.name];
      if (!i) continue;
      out[f.name] = f.type === 'checkbox' ? i.checked : i.value.trim?.() ?? i.value;
    }
    return out;
  };
  const showErrors = (e) => {
    banner.hidden = false; banner.textContent = e.message || String(e);
    for (const [k, msg] of Object.entries(e.fields || {})) if (errs[k]) errs[k].textContent = `${fields.find((f) => f.name === k)?.label || k} ${msg}`;
  };
  const resetErrors = () => { banner.hidden = true; Object.values(errs).forEach((x) => { x.textContent = ''; }); };
  return { el, read, showErrors, resetErrors, inputs };
}

/** Modal wrapping buildForm. onSubmit(values) may throw ApiError to show inline errors. */
export function formModal({ title: ttl, fields, values = {}, submitLabel = 'Save', onSubmit, wide, extra }) {
  const form = buildForm(fields, values);
  let m;
  const submit = async () => {
    form.resetErrors();
    const btn = m.el.querySelector('.btn-primary');
    btn.disabled = true;
    try {
      await onSubmit(form.read());
      m.close();
    } catch (e) {
      if (e instanceof ApiError || e.fields) form.showErrors(e); else { form.showErrors(e); console.error(e); }
    } finally { btn.disabled = false; }
  };
  form.el.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  m = modal({
    title: ttl, wide, body: h('div', null, extra, form.el),
    actions: [h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancel'),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: submit }, submitLabel)],
  });
  return m;
}

/** Typeahead for clients / policies. Stores the numeric id in a hidden input; exposes .value like a normal input. */
function autocomplete(f, values) {
  const hidden = h('input', { type: 'hidden', name: f.name });
  hidden.value = values[f.name] ?? '';
  const box = h('input', { type: 'text', id: 'f_' + f.name, placeholder: f.placeholder || (f.type === 'client' ? 'Search clients…' : 'Search policy number…'), autocomplete: 'off', required: f.required });
  const list = h('div', { class: 'ac-list', hidden: true });
  const wrap = h('div', { class: 'ac' }, box, hidden, list);
  const label = values[f.name + '_label'] || f.label_value;
  if (label) box.value = label;
  else if (hidden.value) {
    get(f.type === 'client' ? `/api/clients/${hidden.value}` : `/api/policies/${hidden.value}`)
      .then((r) => { box.value = f.type === 'client' ? r.display_name : `${r.policy_number} — ${r.client_name}`; }).catch(() => {});
  }
  let timer;
  box.addEventListener('input', () => {
    hidden.value = '';
    clearTimeout(timer);
    const q = box.value.trim();
    if (q.length < 2) { list.hidden = true; return; }
    timer = setTimeout(async () => {
      try {
        const extra = f.params ? '&' + qs(f.params) : '';
        const r = await get(`/api/${f.type === 'client' ? 'clients' : 'policies'}?q=${encodeURIComponent(q)}&limit=8${extra}`);
        clear(list);
        for (const row of r.rows) {
          const text = f.type === 'client' ? row.display_name : `${row.policy_number} — ${row.client_name} (${lineName(row.line)})`;
          list.append(h('div', { onmousedown: (e) => { e.preventDefault(); hidden.value = row.id; box.value = text; list.hidden = true; f.onPick?.(row); } }, text));
        }
        if (!r.rows.length) list.append(h('div', { class: 'muted' }, 'No matches'));
        list.hidden = false;
      } catch { /* ignore */ }
    }, 200);
  });
  box.addEventListener('blur', () => setTimeout(() => { list.hidden = true; }, 150));
  Object.defineProperty(wrap, 'value', { get: () => hidden.value, set: (v) => { hidden.value = v; } });
  return wrap;
}

/* ---------- Tables / lists ---------- */
export function table(columns, rows, { onRow, empty = 'Nothing here yet.', foot, sort, onSort } = {}) {
  const thead = h('tr', null, columns.map((c) => {
    const arrow = sort && c.sort && sort.key === c.sort ? (sort.dir === 'desc' ? ' ▼' : ' ▲') : '';
    return h('th', {
      class: (c.num ? 'num ' : '') + (c.sort ? 'sortable' : ''), scope: 'col',
      onclick: c.sort && onSort ? () => onSort(c.sort) : null, 'aria-sort': arrow ? (sort.dir === 'desc' ? 'descending' : 'ascending') : null,
    }, c.label, arrow);
  }));
  const body = rows.map((r) => h('tr', { class: onRow ? 'click' : '', onclick: onRow ? (e) => { if (!e.target.closest('a,button,select,input,label')) onRow(r); } : null },
    columns.map((c) => h('td', { class: (c.num ? 'num ' : '') + (c.class || '') }, c.render ? c.render(r) : r[c.key] ?? '—'))));
  const t = h('table', { class: 't' }, h('thead', null, thead), h('tbody', null, body), foot ? h('tfoot', null, foot) : null);
  return rows.length ? h('div', { class: 'table-wrap' }, t) : h('div', { class: 'empty' }, empty);
}

/**
 * Server-paginated list with search/filters/sort/CSV.
 * cfg: { endpoint, columns, filters:[{key,label,options,type}], fixed:{}, search:true, pageSize, onRow, csv, empty, dflt:{} }
 */
export function listView(cfg) {
  const state = { q: '', filters: { ...(cfg.dflt || {}) }, sort: cfg.sort || null, offset: 0, total: 0 };
  const pageSize = cfg.pageSize || 25;
  const body = h('div');
  const pager = h('div', { class: 'pager' });
  const params = (extra = {}) => ({
    ...cfg.fixed, q: state.q, ...state.filters, sort: state.sort?.key, dir: state.sort?.dir, limit: pageSize, offset: state.offset, ...extra,
  });
  let seq = 0;
  async function load() {
    const my = ++seq;
    try {
      const r = await get(cfg.endpoint, params());
      if (my !== seq) return;
      state.total = r.total; state.rows = r.rows;
      cfg.onLoad?.(r);
      clear(body).append(table(cfg.columns, r.rows, {
        onRow: cfg.onRow, empty: cfg.empty || 'No records match.', sort: state.sort,
        onSort: (key) => { state.sort = { key, dir: state.sort?.key === key && state.sort.dir === 'asc' ? 'desc' : 'asc' }; state.offset = 0; load(); },
      }));
      const from = r.total ? state.offset + 1 : 0, to = Math.min(state.offset + pageSize, r.total);
      clear(pager).append(
        h('span', { class: 'grow', style: { flex: 1 } }, `${from}–${to} of ${num(r.total)}`),
        h('button', { class: 'btn btn-sm', disabled: state.offset === 0, onclick: () => { state.offset = Math.max(0, state.offset - pageSize); load(); } }, '← Prev'),
        h('button', { class: 'btn btn-sm', disabled: to >= r.total, onclick: () => { state.offset += pageSize; load(); } }, 'Next →'));
    } catch (e) { if (my === seq) clear(body).append(h('div', { class: 'empty neg' }, e.message)); }
  }
  let timer;
  const controls = [];
  if (cfg.search !== false) {
    controls.push(h('input', { type: 'search', placeholder: cfg.searchPlaceholder || 'Search…', 'aria-label': 'Search', oninput: (e) => {
      clearTimeout(timer); timer = setTimeout(() => { state.q = e.target.value.trim(); state.offset = 0; load(); }, 250);
    } }));
  }
  for (const f of cfg.filters || []) {
    const sel = f.type === 'date'
      ? h('input', { type: 'date', 'aria-label': f.label, title: f.label, value: state.filters[f.key] || '', onchange: (e) => { state.filters[f.key] = e.target.value; state.offset = 0; load(); } })
      : h('select', { 'aria-label': f.label, onchange: (e) => { state.filters[f.key] = e.target.value; state.offset = 0; load(); } },
        h('option', { value: '' }, f.label), (typeof f.options === 'function' ? f.options() : f.options).map(([v, l]) => h('option', { value: v }, l)));
    if (f.type !== 'date') sel.value = state.filters[f.key] ?? '';
    controls.push(sel);
  }
  const csvLink = cfg.csv === false ? null : h('button', { class: 'btn btn-sm', onclick: () => { window.location.href = cfg.endpoint + '?' + qs({ ...params(), format: 'csv', limit: undefined, offset: undefined }); } }, '⬇ CSV');
  const root = h('div', { class: 'card' },
    h('div', { class: 'toolbar' }, controls, h('span', { class: 'grow' }), cfg.toolbar, csvLink),
    body, pager);
  root.reload = load;
  root.state = state;
  load();
  return root;
}

export function tabs(items, { initial, onChange } = {}) {
  // items: [{ key, label, render: () => Node|Promise<Node>, count }]
  const panel = h('div');
  const bar = h('div', { class: 'tabs', role: 'tablist' });
  let current = initial || items[0].key;
  const loaded = new Map();
  async function show(key, force = false) {
    current = key;
    onChange?.(key);
    [...bar.children].forEach((b) => { b.classList.toggle('on', b.dataset.key === key); b.setAttribute('aria-selected', b.dataset.key === key); });
    const item = items.find((i) => i.key === key);
    clear(panel).append(h('div', { class: 'empty' }, 'Loading…'));
    try {
      const node = await item.render();
      if (current === key) clear(panel).append(node);
    } catch (e) { if (current === key) clear(panel).append(h('div', { class: 'empty neg' }, e.message)); }
  }
  for (const it of items) {
    bar.append(h('button', { type: 'button', role: 'tab', dataset: { key: it.key }, onclick: () => show(it.key) }, it.label, it.count !== undefined ? h('span', { class: 'cnt' }, it.count) : null));
  }
  const root = h('div', null, bar, panel);
  root.refresh = () => show(current);
  show(current);
  return root;
}

/** Re-render the current route (after a mutation on a detail page). */
export const refresh = () => window.dispatchEvent(new Event('ams:refresh'));
export const link = (href, text, cls) => h('a', { href, class: cls }, text);
export const field = (label, value) => [h('dt', null, label), h('dd', null, value ?? '—')];
export const kv = (pairs) => h('dl', { class: 'kv' }, pairs.map(([l, v]) => field(l, v === '' ? '—' : v)));
export const opt = (arr) => arr.map((v) => [v, title(v)]);
export const userOptions = (role) => (meta.value.users.filter((u) => u.active && (!role || role.includes(u.role))).map((u) => [u.id, u.name]));
export const carrierOptions = () => meta.value.carriers.filter((c) => c.active).map((c) => [c.id, c.name]);
export const lineOptions = () => Object.entries(meta.value.lines);
export const can = (...roles) => roles.includes(window.__user?.role);
export const isManager = () => can('admin', 'manager');
export const canMoney = () => can('admin', 'manager', 'accounting');
export const canWrite = () => can('admin', 'manager', 'producer', 'csr');

export function pageHead(titleText, { sub, crumb, actions } = {}) {
  return h('div', { class: 'page-head' },
    h('div', { class: 'grow' }, crumb ? h('div', { class: 'crumb' }, crumb) : null, h('h1', null, titleText), sub ? h('div', { class: 'sub' }, sub) : null),
    actions ? h('div', { class: 'btn-row' }, actions) : null);
}

export function downloadBlob(filename, blob) {
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a); a.click(); a.remove();
}
