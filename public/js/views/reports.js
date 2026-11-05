import { h, clear, get, table, money, num, pct, date, pageHead, qs, todayStr } from '../lib.js';

const fmt = { money: (v) => money(v), int: (v) => num(v), pct: (v) => pct(v), text: (v) => v ?? '—', date: (v) => date(v) };

export async function reports(key) {
  const { reports: list } = await get('/api/reports');
  const active = list.find((r) => r.key === key) || list[0];
  const year = new Date().getFullYear();
  const state = { from: `${year}-01-01`, to: `${year}-12-31` };
  const out = h('div');
  async function load() {
    const r = await get(`/api/reports/${active.key}`, state);
    const hasTotals = Object.keys(r.totals).length > 0;
    clear(out).append(h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, r.title), h('span', { class: 'muted small' }, r.needsRange ? `${date(r.from)} – ${date(r.to)}` : 'As of today'),
      h('a', { class: 'btn btn-sm', href: `/api/reports/${active.key}?${qs({ ...state, format: 'csv' })}` }, '⬇ CSV'), h('button', { class: 'btn btn-sm', onclick: () => window.print() }, '🖨 Print')),
    h('div', { class: 'card-b flush' }, table(r.columns.map((c) => ({ label: c.label, num: ['money', 'int', 'pct'].includes(c.type), render: (row) => fmt[c.type](row[c.key]) })), r.rows, {
      empty: 'No data for this report and period.',
      foot: hasTotals && r.rows.length ? h('tr', null, r.columns.map((c, i) => h('td', { class: ['money', 'int', 'pct'].includes(c.type) ? 'num' : '' }, i === 0 ? 'Total' : r.totals[c.key] !== undefined ? fmt[c.type](r.totals[c.key]) : ''))) : null,
    }))));
  }
  const range = active.needsRange ? h('div', { class: 'btn-row' },
    h('input', { type: 'date', value: state.from, 'aria-label': 'From', onchange: (e) => { state.from = e.target.value; load(); } }),
    h('span', { class: 'muted' }, 'to'), h('input', { type: 'date', value: state.to, 'aria-label': 'To', onchange: (e) => { state.to = e.target.value; load(); } }),
    h('button', { class: 'btn btn-sm', onclick: () => { state.from = `${year}-01-01`; state.to = todayStr(); const [f, t] = document.querySelectorAll('.rep-range input'); f.value = state.from; t.value = state.to; load(); } }, 'YTD')) : null;
  const root = h('div', { dataset: { title: 'Reports' } }, pageHead('Reports', { sub: 'Production, book of business, retention, receivables and commissions', actions: range ? [range] : null }),
    h('div', { class: 'rep-layout' }, h('nav', { class: 'card card-b rep-list', 'aria-label': 'Reports' }, list.map((r) => h('a', { href: '#/reports/' + r.key, class: r.key === active.key ? 'on' : '' }, r.title))), out));
  range?.classList.add('rep-range');
  await load();
  return root;
}
