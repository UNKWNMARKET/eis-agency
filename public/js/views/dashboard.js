import { h, get, money0, num, date, badge, table, link, lineName, title, pageHead, canMoney } from '../lib.js';

const kpi = (label, value, sub, href) => h(href ? 'a' : 'div', { class: 'card kpi', href }, h('div', { class: 'l' }, label), h('div', { class: 'v' }, value), sub ? h('div', { class: 's' }, sub) : null);

function monthLabel(m) {
  const [y, mo] = m.split('-').map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString('en-US', { month: 'short' });
}

function monthlyChart(rows) {
  const max = Math.max(1, ...rows.map((r) => r.new_premium + r.renewal_premium));
  return h('div', null,
    h('div', { class: 'legend' }, h('span', null, h('i', { style: { background: 'var(--primary)' } }), 'New business'), h('span', null, h('i', { style: { background: '#94a8f5' } }), 'Renewals')),
    rows.length ? h('div', { class: 'bars', role: 'img', 'aria-label': 'Premium written by month' }, rows.map((r) => {
      const total = r.new_premium + r.renewal_premium;
      return h('div', { class: 'col', title: `${r.month}: new ${money0(r.new_premium)}, renewal ${money0(r.renewal_premium)}` },
        h('div', { class: 'val' }, total ? money0(total).replace(/,\d{3}$/, 'k') : ''),
        h('div', { class: 'stack', style: { height: `${(total / max) * 130}px` } },
          h('div', { class: 'seg-new', style: { height: total ? `${(r.new_premium / total) * 100}%` : '0' } }),
          h('div', { class: 'seg-ren', style: { height: total ? `${(r.renewal_premium / total) * 100}%` : '0' } })),
        h('div', { class: 'lbl' }, monthLabel(r.month)));
    })) : h('div', { class: 'empty' }, 'No production recorded in the last 12 months.'));
}

function hbars(rows, labelFn, valueKey = 'premium') {
  const max = Math.max(1, ...rows.map((r) => r[valueKey]));
  return rows.length ? rows.map((r) => h('div', { class: 'hbar' }, h('div', { class: 'name', title: labelFn(r) }, labelFn(r)),
    h('div', { class: 'track' }, h('div', { class: 'fill', style: { width: `${(r[valueKey] / max) * 100}%` } })), h('div', { class: 'right mono' }, money0(r[valueKey]))))
    : h('div', { class: 'empty' }, 'No data yet.');
}

export async function dashboard() {
  const d = await get('/api/dashboard');
  const k = d.kpi;
  const root = h('div', { dataset: { title: 'Dashboard' } },
    pageHead('Dashboard', { sub: new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) }),
    h('div', { class: 'kpis' },
      kpi('Premium in force', money0(k.premium_in_force), `${num(k.active_policies)} active policies`, '#/policies?status=active'),
      kpi('Active clients', num(k.active_clients), `${num(k.prospects)} prospects`, '#/clients'),
      kpi('New premium (MTD)', money0(k.new_premium_mtd), `${money0(k.new_premium_ytd)} year to date`),
      kpi('Renewals · next 30 days', num(k.renewals_30.n), `${money0(k.renewals_30.premium)} · ${num(k.renewals_90.n)} in 90 days`, '#/renewals'),
      kpi('Open pipeline', money0(k.pipeline_value), `${num(k.pipeline_count)} opportunities`, '#/pipeline'),
      kpi('Open claims', num(k.open_claims), `${money0(k.open_reserves)} reserved`, '#/claims'),
      kpi('Overdue invoices', money0(k.overdue_amount), `${num(k.overdue_invoices)} invoices`, '#/billing'),
      canMoney() ? kpi('Est. annual commission', money0(k.annual_commission_est), `${money0(k.commission_received_ytd)} received YTD`, '#/commissions') : null),
    h('div', { class: 'grid g-main', style: { marginBottom: '16px' } },
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Premium written — last 12 months')), h('div', { class: 'card-b' }, monthlyChart(d.monthly))),
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, `My tasks (${k.my_open_tasks} open${k.my_overdue_tasks ? `, ${k.my_overdue_tasks} overdue` : ''})`), link('#/tasks', 'All tasks')),
        h('div', { class: 'card-b flush' }, table([
          { label: 'Task', render: (t) => h('span', null, t.title, t.client_name ? h('div', { class: 'muted small' }, t.client_name) : null) },
          { label: 'Due', render: (t) => h('span', { class: t.overdue ? 'neg' : '' }, date(t.due_date)) },
        ], d.myTasks, { empty: 'You are all caught up. 🎉' })))),
    h('div', { class: 'grid g2', style: { marginBottom: '16px' } },
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Upcoming renewals (60 days)'), link('#/renewals', 'View all')),
        h('div', { class: 'card-b flush' }, table([
          { label: 'Expires', render: (p) => h('span', null, date(p.expiration_date), h('div', { class: 'muted small' }, `${p.days_to_expiry}d`)) },
          { label: 'Client / policy', render: (p) => h('span', null, link('#/clients/' + p.client_id, p.client_name), h('div', { class: 'small' }, link('#/policies/' + p.id, `${lineName(p.line)} · ${p.policy_number}`))) },
          { label: 'Premium', num: true, render: (p) => money0(p.premium) }, { label: 'Status', render: (p) => badge(p.renewal_status) },
        ], d.upcomingRenewals, { empty: 'No renewals due in the next 60 days.' }))),
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Recent activity')),
        h('div', { class: 'card-b flush' }, table([
          { label: 'When', render: (a) => h('span', { class: 'muted small' }, new Date(a.created_at.replace(' ', 'T') + 'Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })) },
          { label: 'Activity', render: (a) => h('span', null, a.subject || title(a.kind), a.client_name ? h('div', { class: 'small' }, link('#/clients/' + a.client_id, a.client_name)) : null) },
          { label: 'By', render: (a) => a.user_name || 'system' },
        ], d.recentActivity, { empty: 'No activity yet.' })))),
    h('div', { class: 'grid g3' },
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Premium by line')), h('div', { class: 'card-b' }, hbars(d.byLine, (r) => lineName(r.line)))),
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Premium by carrier')), h('div', { class: 'card-b' }, hbars(d.byCarrier, (r) => r.carrier))),
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Pipeline by stage')), h('div', { class: 'card-b' }, hbars(d.pipeline, (r) => title(r.stage), 'value')))));
  return root;
}
