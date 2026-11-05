import { h, clear, get, post, put, meta, toast, fail, confirmDialog, formModal, tabs, table, badge, date, money, link, pageHead, opt, userOptions, listView, todayStr, title, qs } from '../lib.js';

function receiveDialog(c, onDone) {
  return formModal({
    title: `Record commission — ${c.policy_number || 'manual'}`,
    extra: h('div', { class: 'muted', style: { marginBottom: '12px' } }, `Expected ${money(c.expected_amount)} (${c.carrier_name}, ${c.period})`),
    fields: [{ name: 'received_amount', label: 'Amount received', type: 'money', required: true }, { name: 'received_date', label: 'Date received', type: 'date', required: true }, { name: 'statement_ref', label: 'Statement / deposit reference' }],
    values: { received_amount: c.expected_amount, received_date: todayStr() },
    onSubmit: async (v) => { await post(`/api/commissions/${c.id}/receive`, v); toast('Commission recorded'); onDone?.(); },
  });
}

function ledger() {
  const e = meta.value.enums;
  const list = listView({
    endpoint: '/api/commissions', searchPlaceholder: 'Search policy #, client, carrier, statement…', sort: { key: 'period', dir: 'desc' }, dflt: { status: 'expected' },
    filters: [
      { key: 'status', label: 'All statuses', options: opt(e.commissionStatus) }, { key: 'type', label: 'All types', options: opt(e.commissionTypes) },
      { key: 'carrier_id', label: 'All carriers', options: () => meta.value.carriers.map((c) => [c.id, c.name]) }, { key: 'producer_id', label: 'All producers', options: () => userOptions(['admin', 'manager', 'producer']) },
      { key: 'period_from', label: 'From', type: 'date' }, { key: 'period_to', label: 'To', type: 'date' },
    ],
    columns: [
      { label: 'Period', sort: 'period', key: 'period' }, { label: 'Client / policy', render: (c) => (c.policy_id ? h('span', null, link('#/policies/' + c.policy_id, c.policy_number), h('div', { class: 'muted small' }, c.client_name)) : '—') },
      { label: 'Carrier', sort: 'carrier', key: 'carrier_name' }, { label: 'Type', render: (c) => badge(c.type, c.type === 'chargeback' ? 'red' : 'blue') },
      { label: 'Basis', num: true, render: (c) => money(c.premium_basis) }, { label: 'Rate', num: true, render: (c) => `${c.rate_pct}%` },
      { label: 'Expected', sort: 'expected', num: true, render: (c) => h('span', { class: c.expected_amount < 0 ? 'neg' : '' }, money(c.expected_amount)) },
      { label: 'Received', sort: 'received', num: true, render: (c) => (c.received_amount == null ? '—' : money(c.received_amount)) },
      { label: 'Variance', num: true, render: (c) => (c.variance == null ? '—' : h('span', { class: c.variance < 0 ? 'neg' : c.variance > 0 ? 'pos' : '' }, money(c.variance))) },
      { label: 'Status', sort: 'status', render: (c) => badge(c.status) },
      { label: '', render: (c) => (c.status === 'expected' || c.status === 'disputed' ? h('span', { class: 'btn-row' },
        h('button', { class: 'btn btn-sm btn-primary', onclick: () => receiveDialog(c, () => list.reload()) }, 'Receive'),
        c.status === 'expected' ? h('button', { class: 'btn btn-sm btn-ghost', title: 'Mark disputed', onclick: async () => { await put(`/api/commissions/${c.id}`, { status: 'disputed' }).catch(fail); list.reload(); } }, 'Dispute') : null) : null) },
    ],
  });
  return list;
}

function reconcile() {
  const carrier = h('select', { 'aria-label': 'Carrier' }, meta.value.carriers.filter((c) => c.active).map((c) => h('option', { value: c.id }, c.name)));
  const ref = h('input', { type: 'text', placeholder: 'e.g. STMT-2026-10', 'aria-label': 'Statement reference' });
  const when = h('input', { type: 'date', value: todayStr(), 'aria-label': 'Received date' });
  const text = h('textarea', { rows: 10, placeholder: 'policy_number,amount\nHO-1234567,182.40\nAU-7654321,96.10', 'aria-label': 'Statement lines' });
  const out = h('div');
  function parse() {
    return text.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).filter((l) => !/^policy/i.test(l)).map((l) => {
      const i = l.lastIndexOf(',');
      return { policy_number: l.slice(0, i).trim().replace(/^"|"$/g, ''), amount: Number(l.slice(i + 1).replace(/[$"\s]/g, '')) };
    });
  }
  const run = async (dry) => {
    if (!ref.value.trim()) return toast('Enter a statement reference', 'err');
    const rows = parse();
    if (!rows.length) return toast('Paste at least one statement line', 'err');
    try {
      const r = await post('/api/commissions/statement', { carrier_id: carrier.value, statement_ref: ref.value, received_date: when.value, rows, dry_run: dry });
      clear(out).append(h('div', { class: 'card', style: { marginTop: '16px' } },
        h('div', { class: 'card-h' }, h('h2', null, dry ? 'Preview' : 'Applied'), h('span', { class: 'muted' }, `${r.matched.length} matched · ${r.unmatched.length} unmatched · received ${money(r.total_received)} vs expected ${money(r.total_expected)}`)),
        h('div', { class: 'card-b flush' }, table([
          { label: 'Policy', key: 'policy_number' }, { label: 'Expected', num: true, render: (m) => money(m.expected) }, { label: 'Received', num: true, render: (m) => money(m.received) },
          { label: 'Variance', num: true, render: (m) => h('span', { class: m.variance < 0 ? 'neg' : m.variance > 0 ? 'pos' : '' }, money(m.variance)) },
        ], r.matched, { empty: 'Nothing matched.' })),
        r.unmatched.length ? h('div', { class: 'card-b' }, h('h3', { style: { marginBottom: '6px' } }, 'Unmatched lines — investigate with the carrier'), h('ul', { style: { margin: 0, paddingLeft: '18px' } }, r.unmatched.map((u) => h('li', null, `Line ${u.row}: ${u.policy_number || '(blank)'} ${u.amount ?? ''} — ${u.reason}`)))) : null,
        dry && r.matched.length ? h('div', { class: 'card-b' }, h('button', { class: 'btn btn-primary', onclick: async () => { if (await confirmDialog(`Apply ${r.matched.length} lines to the ledger?`)) run(false); } }, `Apply ${r.matched.length} matched lines`)) : null));
      if (!dry) toast(`Statement applied — ${r.matched.length} lines reconciled`);
    } catch (er) { fail(er); }
  };
  return h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Reconcile a carrier commission statement')),
    h('div', { class: 'card-b' }, h('p', { class: 'muted', style: { marginTop: 0 } }, 'Paste one line per policy as “policy number, amount”. Each line is applied to the oldest outstanding expected commission for that policy. Preview first — nothing changes until you apply.'),
      h('div', { class: 'form-grid', style: { marginBottom: '12px' } }, h('div', { class: 'field' }, h('label', null, 'Carrier'), carrier), h('div', { class: 'field' }, h('label', null, 'Statement reference'), ref), h('div', { class: 'field' }, h('label', null, 'Date received'), when)),
      h('div', { class: 'field' }, h('label', null, 'Statement lines'), text),
      h('div', { class: 'btn-row', style: { marginTop: '12px' } }, h('button', { class: 'btn', onclick: () => run(true) }, 'Preview match')), out));
}

async function payouts() {
  const r = await get('/api/commissions/payouts');
  const root = h('div');
  const draw = (rows) => {
    clear(root).append(h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Producer payouts due'), h('span', { class: 'muted' }, 'Producer share of commissions the agency has actually received')),
      h('div', { class: 'card-b flush' }, table([
        { label: 'Producer', key: 'producer_name' }, { label: 'Lines', num: true, key: 'lines' }, { label: 'Commission received', num: true, render: (x) => money(x.commission_received) }, { label: 'Payout due', num: true, render: (x) => h('strong', null, money(x.payout_due)) },
        { label: '', render: (x) => h('span', { class: 'btn-row' },
          h('a', { class: 'btn btn-sm', href: '/api/commissions?' + qs({ producer_id: x.producer_id, unpaid_producer: 1, format: 'csv' }) }, '⬇ Statement CSV'),
          h('button', { class: 'btn btn-sm btn-primary', onclick: async () => {
            if (!(await confirmDialog(`Mark ${money(x.payout_due)} as paid to ${x.producer_name}?`))) return;
            try { await post('/api/commissions/payouts/pay', { producer_id: x.producer_id }); toast('Payout recorded'); draw(rows.filter((y) => y.producer_id !== x.producer_id)); } catch (er) { fail(er); }
          } }, 'Mark paid')) },
      ], rows, { empty: 'No producer payouts outstanding.' }))));
  };
  draw(r.rows);
  return root;
}

async function summary() {
  const year = new Date().getFullYear();
  const r = await get('/api/reports/commissions', { from: `${year}-01-01`, to: `${year}-12-31` });
  return h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, `${year} commissions by carrier`), h('a', { class: 'btn btn-sm', href: `/api/reports/commissions?from=${year}-01-01&to=${year}-12-31&format=csv` }, '⬇ CSV')),
    h('div', { class: 'card-b flush' }, table(r.columns.map((c) => ({ label: c.label, num: c.type === 'money', render: (row) => (c.type === 'money' ? money(row[c.key]) : row[c.key]) })), r.rows, {
      foot: h('tr', null, r.columns.map((c, i) => h('td', { class: c.type === 'money' ? 'num' : '' }, i === 0 ? 'Total' : c.type === 'money' ? money(r.totals[c.key]) : ''))),
    })));
}

export async function commissions() {
  return h('div', { dataset: { title: 'Commissions' } }, pageHead('Commissions', { sub: 'Expected vs received carrier commissions, reconciliation and producer splits' }),
    tabs([{ key: 'ledger', label: 'Ledger', render: ledger }, { key: 'recon', label: 'Reconcile statement', render: reconcile }, { key: 'payouts', label: 'Producer payouts', render: payouts }, { key: 'summary', label: 'Summary', render: summary }]));
}
