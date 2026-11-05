import { h, clear, get, post, put, meta, toast, fail, table, badge, date, money, money0, num, link, pageHead, lineName, isManager, canWrite, title, userOptions } from '../lib.js';
import { openEmailComposer } from './forms.js';
import { renewDialog } from './policies.js';

const RANGES = [['pastdue', 'Past due'], ['30', 'Next 30 days'], ['60', 'Next 60 days'], ['90', 'Next 90 days'], ['180', 'Next 6 months']];

export async function renewals(query = {}) {
  const state = { range: query.range || '60', status: '', producer: '' };
  const holder = h('div');
  const chipBar = h('div', { class: 'chips' });

  async function load() {
    const params = { status: 'active', sort: 'expiration', dir: 'asc', limit: 200, renewal_status: state.status, producer_id: state.producer };
    if (state.range === 'pastdue') { params.status = 'active,expired'; params.exp_to = new Date(Date.now() - 86400000).toISOString().slice(0, 10); params.renewal_status = state.status || 'not_started,in_review,remarketing,quoted,offered'; }
    else params.expiring_within = state.range;
    const [list, summary] = await Promise.all([get('/api/policies', params), get('/api/renewals/summary', { days: state.range === 'pastdue' ? 90 : state.range })]);
    clear(chipBar).append(
      h('button', { class: 'chip' + (state.status === '' ? ' on' : ''), onclick: () => { state.status = ''; load(); } }, 'All', h('b', null, num(summary.byStatus.reduce((s, x) => s + x.n, 0)))),
      meta.value.enums.renewalStatus.filter((s) => !['renewed', 'lost'].includes(s)).map((s) => {
        const row = summary.byStatus.find((x) => x.renewal_status === s);
        return h('button', { class: 'chip' + (state.status === s ? ' on' : ''), onclick: () => { state.status = s; load(); } }, title(s), h('b', null, num(row?.n || 0)));
      }));
    const total = list.rows.reduce((s, p) => s + p.premium, 0);
    clear(holder).append(h('div', { class: 'card' },
      h('div', { class: 'card-h' }, h('h2', null, `${list.total} policies · ${money0(total)} premium`),
        summary.overdue.n ? h('span', { class: 'badge b-red' }, `${summary.overdue.n} past due without renewal`) : null),
      h('div', { class: 'card-b flush' }, table([
        { label: 'Expires', render: (p) => h('span', null, date(p.expiration_date), h('div', { class: p.days_to_expiry <= 14 ? 'neg small' : 'muted small' }, p.days_to_expiry < 0 ? `${-p.days_to_expiry}d overdue` : `${p.days_to_expiry} days`)) },
        { label: 'Client', render: (p) => link('#/clients/' + p.client_id, p.client_name) },
        { label: 'Policy', render: (p) => h('span', null, link('#/policies/' + p.id, p.policy_number), h('div', { class: 'muted small' }, `${lineName(p.line)} · ${p.carrier_name}`)) },
        { label: 'Premium', num: true, render: (p) => money(p.premium) }, { label: 'Producer', key: 'producer_name' },
        { label: 'Renewal status', render: (p) => canWrite() ? (() => {
          const sel = h('select', { 'aria-label': 'Renewal status', onchange: async (e) => { await put(`/api/policies/${p.id}`, { renewal_status: e.target.value }).catch(fail); toast('Updated'); load(); } },
            meta.value.enums.renewalStatus.map((s) => h('option', { value: s }, title(s))));
          sel.value = p.renewal_status; return sel;
        })() : badge(p.renewal_status) },
        { label: '', render: (p) => canWrite() ? h('span', { class: 'btn-row' },
          h('button', { class: 'btn btn-sm btn-primary', onclick: () => renewDialog(p, () => { toast('Renewed'); load(); }) }, 'Renew'),
          h('button', { class: 'btn btn-sm', onclick: () => openEmailComposer({ client_id: p.client_id, policy_id: p.id, templateName: 'Renewal notice (60 days)' }) }, '✉')) : null },
      ], list.rows, { empty: 'No policies need renewing in this window.' }))));
  }

  const root = h('div', { dataset: { title: 'Renewals' } }, pageHead('Renewals', {
    sub: 'Work expiring policies from review to renewal',
    actions: [
      h('select', { 'aria-label': 'Window', onchange: (e) => { state.range = e.target.value; load(); } }, RANGES.map(([v, l]) => h('option', { value: v, selected: v === state.range }, l))),
      h('select', { 'aria-label': 'Producer', onchange: (e) => { state.producer = e.target.value; load(); } }, h('option', { value: '' }, 'All producers'), userOptions(['admin', 'manager', 'producer']).map(([v, l]) => h('option', { value: v }, l))),
      isManager() ? h('button', { class: 'btn', onclick: async () => {
        try { const r = await post('/api/renewals/generate-tasks', { days: 60 }); toast(`${r.created} renewal review tasks created`); load(); } catch (e) { fail(e); }
      } }, 'Generate 60-day review tasks') : null,
    ],
  }), chipBar, holder);
  await load();
  return root;
}
