import { h, get, post, del, meta, toast, fail, confirmDialog, formModal, tabs, table, badge, date, money, link, pageHead, opt, canWrite, canMoney, listView, todayStr, can } from '../lib.js';

export function recordPayment(inv, onDone) {
  const balance = Math.round((inv.amount - inv.paid) * 100) / 100;
  return formModal({
    title: `Record payment — ${inv.number}`,
    extra: h('div', { class: 'muted', style: { marginBottom: '12px' } }, `${inv.description || ''} · balance ${money(balance)}`),
    fields: [
      { name: 'amount', label: 'Amount', type: 'money', required: true, max: balance }, { name: 'paid_date', label: 'Date received', type: 'date', required: true },
      { name: 'method', label: 'Method', type: 'select', options: opt(meta.value.enums.paymentMethods), required: true }, { name: 'reference', label: 'Check # / reference' },
    ],
    values: { amount: balance, paid_date: todayStr(), method: 'check' },
    onSubmit: async (v) => { await post(`/api/invoices/${inv.id}/payments`, v); toast('Payment recorded'); onDone?.(); },
  });
}

export async function billing() {
  const e = meta.value.enums;
  const invoices = () => {
    const list = listView({
      endpoint: '/api/invoices', searchPlaceholder: 'Search invoice #, client, policy…', sort: { key: 'due', dir: 'desc' },
      filters: [{ key: 'status', label: 'All statuses', options: opt(e.invoiceStatus) }, { key: 'overdue', label: 'Overdue & current', options: [['1', 'Overdue only']] }, { key: 'kind', label: 'All kinds', options: opt(['premium', 'fee', 'endorsement', 'credit']) }],
      columns: [
        { label: 'Invoice', sort: 'number', key: 'number' }, { label: 'Client', sort: 'client', render: (i) => link('#/clients/' + i.client_id, i.client_name) },
        { label: 'Policy', render: (i) => (i.policy_id ? link('#/policies/' + i.policy_id, i.policy_number) : '—') }, { label: 'Description', key: 'description' },
        { label: 'Due', sort: 'due', render: (i) => h('span', { class: i.days_overdue ? 'neg' : '' }, date(i.due_date), i.days_overdue ? h('div', { class: 'small' }, `${i.days_overdue}d overdue`) : null) },
        { label: 'Amount', sort: 'amount', num: true, render: (i) => h('span', { class: i.amount < 0 ? 'neg' : '' }, money(i.amount)) }, { label: 'Balance', sort: 'balance', num: true, render: (i) => money(i.balance) },
        { label: 'Status', sort: 'status', render: (i) => badge(i.status) },
        { label: '', render: (i) => (['open', 'partial'].includes(i.status) && canWrite() ? h('span', { class: 'btn-row' },
          i.amount > 0 ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => recordPayment(i, () => list.reload()) }, 'Pay') : null,
          canMoney() && i.paid === 0 ? h('button', { class: 'btn btn-sm btn-ghost btn-danger', onclick: async () => { if (await confirmDialog(`Void invoice ${i.number}?`, { danger: true, confirmLabel: 'Void' })) { await post(`/api/invoices/${i.id}/void`).catch(fail); list.reload(); } } }, 'Void') : null) : null) },
      ],
      toolbar: can('admin', 'manager', 'accounting', 'csr') ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => formModal({
        title: 'New manual invoice',
        fields: [{ name: 'client_id', label: 'Client', type: 'client', required: true, full: true, onPick: () => {} }, { name: 'kind', label: 'Kind', type: 'select', options: opt(['premium', 'fee', 'endorsement', 'credit']), required: true },
          { name: 'amount', label: 'Amount', type: 'money', required: true, help: 'Credits are stored as negative' }, { name: 'due_date', label: 'Due date', type: 'date', required: true },
          { name: 'description', label: 'Description', required: true, full: true }], values: { kind: 'fee', due_date: todayStr() },
        onSubmit: async (v) => { await post('/api/invoices', v); toast('Invoice created'); list.reload(); },
      }) }, '+ Invoice') : null,
    });
    return list;
  };
  const payments = () => { const list = listView({
    endpoint: '/api/payments', searchPlaceholder: 'Search invoice #, client, reference…', sort: { key: 'date', dir: 'desc' },
    filters: [{ key: 'method', label: 'All methods', options: opt(e.paymentMethods) }, { key: 'from', label: 'From', type: 'date' }, { key: 'to', label: 'To', type: 'date' }],
    columns: [
      { label: 'Date', sort: 'date', render: (p) => date(p.paid_date) }, { label: 'Client', sort: 'client', render: (p) => link('#/clients/' + p.client_id, p.client_name) }, { label: 'Invoice', key: 'invoice_number' },
      { label: 'Method', render: (p) => badge(p.method, 'blue') }, { label: 'Reference', key: 'reference' }, { label: 'Amount', sort: 'amount', num: true, render: (p) => h('span', { class: p.amount < 0 ? 'neg' : '' }, money(p.amount)) }, { label: 'By', key: 'user_name' },
      { label: '', render: (p) => (canMoney() ? h('button', { class: 'btn btn-sm btn-ghost btn-danger', onclick: async () => {
        if (await confirmDialog('Delete this payment? The invoice balance will be restored.', { danger: true, confirmLabel: 'Delete payment' })) { await del(`/api/payments/${p.id}`).catch(fail); list.reload(); }
      } }, 'Delete') : null) },
    ],
  }); return list; };
  const aging = async () => {
    const r = await get('/api/reports/aging');
    return h('div', { class: 'card' }, h('div', { class: 'card-b flush' }, table(r.columns.map((c) => ({ label: c.label, num: c.type === 'money', render: (row) => (c.type === 'money' ? (row[c.key] ? money(row[c.key]) : '—') : row[c.key]) })), r.rows, {
      empty: 'No outstanding receivables. 🎉',
      foot: h('tr', null, r.columns.map((c, i) => h('td', { class: c.type === 'money' ? 'num' : '' }, i === 0 ? 'Total' : c.type === 'money' ? money(r.totals[c.key]) : ''))),
    })));
  };
  return h('div', { dataset: { title: 'Billing' } }, pageHead('Billing', { sub: 'Agency-billed invoices, payments and receivables' }),
    tabs([{ key: 'inv', label: 'Invoices', render: invoices }, { key: 'pay', label: 'Payments', render: payments }, { key: 'aging', label: 'A/R aging', render: aging }]));
}
