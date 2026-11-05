import { h, clear, get, post, put, del, meta, toast, fail, confirmDialog, formModal, table, tabs, badge, date, money, money0, num, link, kv, pageHead, opt, userOptions, carrierOptions, lineOptions, lineName, isManager, canWrite, canMoney, title, listView, todayStr, refresh } from '../lib.js';
import { openPolicyForm, openEmailComposer, openClaimForm, openCertificateForm, notesPanel, tasksPanel, docsPanel } from './forms.js';
import { recordPayment } from './billing.js';

export async function policiesList(query = {}) {
  const e = meta.value.enums;
  const list = listView({
    endpoint: '/api/policies', searchPlaceholder: 'Search policy #, client, carrier…', sort: { key: 'expiration', dir: 'asc' },
    dflt: { status: query.status || '' },
    filters: [
      { key: 'status', label: 'All statuses', options: opt(e.policyStatus) },
      { key: 'line', label: 'All lines', options: lineOptions }, { key: 'carrier_id', label: 'All carriers', options: carrierOptions },
      { key: 'producer_id', label: 'All producers', options: () => userOptions(['admin', 'manager', 'producer']) },
      { key: 'exp_from', label: 'Expires from', type: 'date' }, { key: 'exp_to', label: 'Expires to', type: 'date' },
    ],
    columns: [
      { label: 'Policy #', sort: 'policy_number', render: (p) => link('#/policies/' + p.id, p.policy_number) },
      { label: 'Client', sort: 'client', render: (p) => link('#/clients/' + p.client_id, p.client_name) },
      { label: 'Line', sort: 'line', render: (p) => lineName(p.line) }, { label: 'Carrier', sort: 'carrier', key: 'carrier_name' },
      { label: 'Effective', sort: 'effective', render: (p) => date(p.effective_date) },
      { label: 'Expires', sort: 'expiration', render: (p) => h('span', { class: p.status === 'active' && p.days_to_expiry <= 30 ? 'neg' : '' }, date(p.expiration_date)) },
      { label: 'Premium', sort: 'premium', num: true, render: (p) => money(p.premium) }, { label: 'Status', sort: 'status', render: (p) => badge(p.status) },
    ],
    onRow: (p) => { location.hash = '#/policies/' + p.id; }, empty: 'No policies match these filters.',
  });
  return h('div', { dataset: { title: 'Policies' } }, pageHead('Policies', {
    sub: 'Every policy across your book of business',
    actions: canWrite() ? [h('button', { class: 'btn btn-primary', onclick: () => openPolicyForm({ onSaved: (p) => { location.hash = '#/policies/' + p.id; } }) }, '+ New policy')] : null,
  }), list);
}

/* ---------- Lifecycle dialogs ---------- */
function endorseDialog(p) {
  formModal({
    title: `Endorse ${p.policy_number}`,
    fields: [
      { name: 'effective_date', label: 'Effective date', type: 'date', required: true }, { name: 'premium_change', label: 'Premium change (+/−)', type: 'money', required: true, help: 'Use a negative number for a return premium' },
      { name: 'fee', label: 'Endorsement fee', type: 'money' }, { name: 'description', label: 'What changed?', type: 'textarea', required: true, full: true },
    ],
    values: { effective_date: todayStr() },
    onSubmit: async (v) => { await post(`/api/policies/${p.id}/endorse`, v); toast('Endorsement applied'); refresh(); },
  });
}

function cancelDialog(p, unearned) {
  formModal({
    title: `Cancel ${p.policy_number}`,
    extra: h('div', { class: 'warn', style: { marginBottom: '12px' } }, `Pro-rata unearned premium today is ${money(unearned)}. Leave "Return premium" blank to use the pro-rata calculation (flat cancel if effective on the inception date).`),
    fields: [
      { name: 'effective_date', label: 'Cancellation date', type: 'date', required: true }, { name: 'return_premium', label: 'Return premium override', type: 'money' },
      { name: 'reason', label: 'Reason', type: 'select', required: true, options: ['Insured request', 'Non-payment', 'Underwriting', 'Replaced with another carrier', 'Sold property / vehicle', 'Business closed', 'Other'].map((x) => [x, x]), full: true },
    ],
    values: { effective_date: todayStr() },
    onSubmit: async (v) => { const r = await post(`/api/policies/${p.id}/cancel`, v); toast(`Policy cancelled. Return premium ${money(r.return_premium)}`); refresh(); },
  });
}

export function renewDialog(p, onDone) {
  const e = meta.value.enums;
  const m = formModal({
    title: `Renew ${p.policy_number}`, wide: true,
    extra: h('div', { class: 'muted', style: { marginBottom: '12px' } }, `Expiring premium: ${money(p.premium)}. A new term is created, coverages and risk items are copied, and the prior term is marked renewed.`),
    fields: [
      { name: 'premium', label: 'Renewal premium', type: 'money', required: true }, { name: 'fees', label: 'Fees', type: 'money' },
      { name: 'policy_number', label: 'Policy number', help: 'Change if the carrier issued a new number' },
      { name: 'carrier_id', label: 'Carrier', type: 'select', options: carrierOptions, required: true },
      { name: 'effective_date', label: 'Effective date', type: 'date' }, { name: 'expiration_date', label: 'Expiration date', type: 'date', help: 'Blank = same term length' },
      { name: 'billing_method', label: 'Billing', type: 'select', blank: true, blankLabel: 'Same as expiring', options: [['direct_bill', 'Direct bill'], ['agency_bill', 'Agency bill']] },
      { name: 'payment_plan', label: 'Payment plan', type: 'select', blank: true, blankLabel: 'Same as expiring', options: opt(e.paymentPlans) },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
    values: { premium: p.premium, fees: p.fees, policy_number: p.policy_number, carrier_id: p.carrier_id, effective_date: p.expiration_date },
    onSubmit: async (v) => {
      const r = await post(`/api/policies/${p.id}/renew`, v);
      toast('Policy renewed'); if (onDone) onDone(r); else location.hash = '#/policies/' + r.id;
    },
  });
  return m;
}

function inlineSelect(options, value, onChange, label) {
  const sel = h('select', { 'aria-label': label, onchange: (e) => onChange(e.target.value) }, options.map(([v, l]) => h('option', { value: v }, l)));
  sel.value = value;
  return sel;
}

export async function policyDetail(id) {
  const full = await get(`/api/policies/${id}/full`);
  const p = full.policy;
  const inForce = ['active', 'pending_cancel'].includes(p.status);
  const e = meta.value.enums;

  const coveragesPanel = () => {
    const root = h('div');
    const draw = async () => {
      const [cov, risk] = await Promise.all([get('/api/coverages', { policy_id: id, limit: 100 }), get('/api/risk-items', { policy_id: id, limit: 100 })]);
      const covForm = (x) => formModal({
        title: x ? 'Edit coverage' : 'Add coverage', values: x || {},
        fields: [{ name: 'coverage', label: 'Coverage', required: true, full: true, placeholder: 'Dwelling, Bodily injury liability…' }, { name: 'limit_text', label: 'Limit', placeholder: '$300,000 or 100/300/100' },
          { name: 'deductible', label: 'Deductible' }, { name: 'premium', label: 'Premium', type: 'money' }],
        onSubmit: async (v) => { x ? await put(`/api/coverages/${x.id}`, v) : await post('/api/coverages', { ...v, policy_id: id }); draw(); },
      });
      const riskForm = (x) => formModal({
        title: x ? 'Edit item' : 'Add vehicle / driver / location', values: x || { kind: 'vehicle' },
        fields: [{ name: 'kind', label: 'Type', type: 'select', options: opt(e.riskKinds), required: true }, { name: 'description', label: 'Description', required: true, placeholder: '2022 Toyota Camry / Jane Doe / 12 Main St' },
          { name: 'identifier', label: 'VIN / license # / address ID' }, { name: 'value', label: 'Value', type: 'money' }, { name: 'details', label: 'Details', type: 'textarea' }],
        onSubmit: async (v) => { x ? await put(`/api/risk-items/${x.id}`, v) : await post('/api/risk-items', { ...v, policy_id: id }); draw(); },
      });
      const rm = (kind, x) => async () => { if (await confirmDialog('Remove this entry?', { danger: true, confirmLabel: 'Remove' })) { await del(`/api/${kind}/${x.id}`).catch(fail); draw(); } };
      clear(root).append(
        h('div', { class: 'card', style: { marginBottom: '16px' } }, h('div', { class: 'card-h' }, h('h2', null, 'Coverages & limits'), canWrite() ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => covForm() }, '+ Add') : null),
          h('div', { class: 'card-b flush' }, table([
            { label: 'Coverage', key: 'coverage' }, { label: 'Limit', key: 'limit_text' }, { label: 'Deductible', key: 'deductible' }, { label: 'Premium', num: true, render: (x) => (x.premium != null ? money(x.premium) : '—') },
            { label: '', render: (x) => canWrite() ? h('span', { class: 'btn-row' }, h('button', { class: 'btn btn-sm btn-ghost', onclick: () => covForm(x) }, 'Edit'), h('button', { class: 'btn btn-sm btn-ghost btn-danger', onclick: rm('coverages', x) }, 'Remove')) : null },
          ], cov.rows, { empty: 'No coverages recorded. Add limits so certificates and renewals show them.' }))),
        h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Vehicles, drivers & locations'), canWrite() ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => riskForm() }, '+ Add') : null),
          h('div', { class: 'card-b flush' }, table([
            { label: 'Type', render: (x) => badge(x.kind, 'blue') }, { label: 'Description', key: 'description' }, { label: 'Identifier', key: 'identifier' }, { label: 'Value', num: true, render: (x) => (x.value != null ? money0(x.value) : '—') },
            { label: '', render: (x) => canWrite() ? h('span', { class: 'btn-row' }, h('button', { class: 'btn btn-sm btn-ghost', onclick: () => riskForm(x) }, 'Edit'), h('button', { class: 'btn btn-sm btn-ghost btn-danger', onclick: rm('risk-items', x) }, 'Remove')) : null },
          ], risk.rows, { empty: 'No items listed.' }))));
    };
    draw().catch((er) => root.append(h('div', { class: 'empty neg' }, er.message)));
    return root;
  };

  const billingPanel = () => h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Invoices'),
    h('span', { class: 'muted small' }, p.billing_method === 'direct_bill' ? 'Direct bill — the carrier invoices the client' : `Agency bill · ${title(p.payment_plan)}`)),
  h('div', { class: 'card-b flush' }, table([
    { label: 'Invoice', key: 'number' }, { label: 'Description', key: 'description' }, { label: 'Due', render: (i) => date(i.due_date) },
    { label: 'Amount', num: true, render: (i) => money(i.amount) }, { label: 'Paid', num: true, render: (i) => money(i.paid) }, { label: 'Status', render: (i) => badge(i.status) },
    { label: '', render: (i) => (['open', 'partial'].includes(i.status) && i.amount > 0 && canWrite() ? h('button', { class: 'btn btn-sm', onclick: () => recordPayment(i, refresh) }, 'Record payment') : null) },
  ], full.invoices, { empty: p.billing_method === 'direct_bill' ? 'Direct-billed policies have no agency invoices.' : 'No invoices.' })));

  const commissionsPanel = () => h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Commission lines')),
    h('div', { class: 'card-b flush' }, table([
      { label: 'Period', key: 'period' }, { label: 'Type', render: (x) => badge(x.type, 'blue') }, { label: 'Basis', num: true, render: (x) => money(x.premium_basis) }, { label: 'Rate', num: true, render: (x) => `${x.rate_pct}%` },
      { label: 'Expected', num: true, render: (x) => h('span', { class: x.expected_amount < 0 ? 'neg' : '' }, money(x.expected_amount)) }, { label: 'Received', num: true, render: (x) => money(x.received_amount) },
      { label: 'Producer', key: 'producer_name' }, { label: 'Status', render: (x) => badge(x.status) },
    ], full.commissions, { empty: 'No commission lines.' })));

  const txPanel = () => h('div', { class: 'card' }, h('div', { class: 'card-b flush' }, table([
    { label: 'Date', render: (t) => date(t.effective_date) }, { label: 'Type', render: (t) => badge(t.type, t.type === 'cancellation' ? 'red' : 'blue') }, { label: 'Description', key: 'description' },
    { label: 'Premium change', num: true, render: (t) => h('span', { class: t.premium_change < 0 ? 'neg' : '' }, money(t.premium_change)) }, { label: 'By', key: 'user_name' },
  ], full.transactions, { empty: 'No transactions.' })));

  const claimsPanel = () => h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Claims'),
    canWrite() ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => openClaimForm({ policy: p, onSaved: (c) => { location.hash = '#/claims/' + c.id; } }) }, '+ Report claim') : null),
  h('div', { class: 'card-b flush' }, table([
    { label: 'Claim', render: (c) => link('#/claims/' + c.id, c.claim_number || '#' + c.id) }, { label: 'Loss date', render: (c) => date(c.loss_date) }, { label: 'Type', key: 'loss_type' },
    { label: 'Claimed', num: true, render: (c) => money(c.amount_claimed) }, { label: 'Paid', num: true, render: (c) => money(c.amount_paid) }, { label: 'Status', render: (c) => badge(c.status) },
  ], full.claims, { empty: 'No claims on this policy.' })));

  const tabItems = [
    { key: 'coverage', label: 'Coverage', render: coveragesPanel },
    { key: 'billing', label: 'Billing', count: full.invoices.length, render: billingPanel },
    canMoney() ? { key: 'comm', label: 'Commissions', count: full.commissions.length, render: commissionsPanel } : null,
    { key: 'tx', label: 'Transactions', count: full.transactions.length, render: txPanel },
    { key: 'claims', label: 'Claims', count: full.claims.length, render: claimsPanel },
    { key: 'notes', label: 'Notes', render: () => notesPanel('policy_id', id) },
    { key: 'tasks', label: 'Tasks', render: () => tasksPanel('policy_id', id, { client_id: p.client_id }) },
    { key: 'docs', label: 'Documents', render: () => docsPanel('policy_id', id) },
  ].filter(Boolean);

  const exp = p.days_to_expiry;
  const root = h('div', { dataset: { title: p.policy_number } },
    pageHead(`${lineName(p.line)} — ${p.policy_number}`, {
      crumb: h('span', null, link('#/policies', '← Policies'), ' · ', link('#/clients/' + p.client_id, p.client_name)),
      sub: h('span', null, badge(p.status), ' ', p.carrier_name, ' · ', `${date(p.effective_date)} – ${date(p.expiration_date)}`,
        p.status === 'active' && exp >= 0 ? h('span', { class: exp <= 30 ? 'neg' : 'muted' }, `  (${exp} days left)`) : null),
      actions: canWrite() ? [
        inForce ? h('button', { class: 'btn', onclick: () => endorseDialog(p) }, 'Endorse') : null,
        ['active', 'expired'].includes(p.status) && !full.renewed_by ? h('button', { class: 'btn btn-primary', onclick: () => renewDialog(p) }, 'Renew') : null,
        inForce ? h('button', { class: 'btn', onclick: () => openCertificateForm({ client: { id: p.client_id, display_name: p.client_name }, policy: p }) }, 'Certificate') : null,
        h('button', { class: 'btn', onclick: () => openEmailComposer({ client_id: p.client_id, policy_id: id, templateName: 'Renewal notice (60 days)' }) }, '✉ Email'),
        h('button', { class: 'btn', onclick: () => openPolicyForm({ policy: p, onSaved: refresh }) }, 'Edit'),
        inForce ? h('button', { class: 'btn btn-danger', onclick: () => cancelDialog(p, full.unearned_premium) }, 'Cancel policy') : null,
        p.status === 'cancelled' ? h('button', { class: 'btn', onclick: () => formModal({
          title: 'Reinstate policy', fields: [{ name: 'effective_date', label: 'Reinstatement date', type: 'date' }, { name: 'notes', label: 'Notes', type: 'textarea', full: true }], values: { effective_date: todayStr() },
          onSubmit: async (v) => { await post(`/api/policies/${id}/reinstate`, v); toast('Policy reinstated'); refresh(); } }) }, 'Reinstate') : null,
        ['active', 'expired'].includes(p.status) && !full.renewed_by ? h('button', { class: 'btn btn-danger', onclick: () => formModal({
          title: 'Mark as non-renewed', fields: [{ name: 'reason', label: 'Reason', required: true, type: 'textarea', full: true, placeholder: 'Moved carriers, sold property, carrier non-renewal…' }],
          onSubmit: async (v) => { await post(`/api/policies/${id}/non-renew`, v); toast('Marked non-renewed'); refresh(); } }) }, 'Non-renew') : null,
        isManager() ? h('button', { class: 'btn btn-danger', onclick: async () => {
          if (!(await confirmDialog(`Delete policy ${p.policy_number}? Its transactions, invoices and commission lines are removed too.`, { danger: true, confirmLabel: 'Delete' }))) return;
          try { await del(`/api/policies/${id}`); toast('Policy deleted'); location.hash = '#/clients/' + p.client_id; } catch (er) { fail(er); }
        } }, 'Delete') : null,
      ] : null,
    }),
    h('div', { class: 'kpis' },
      h('div', { class: 'card kpi' }, h('div', { class: 'l' }, 'Annual premium'), h('div', { class: 'v' }, money(p.premium)), h('div', { class: 's' }, p.fees ? `+ ${money(p.fees)} fees` : 'No fees')),
      h('div', { class: 'card kpi' }, h('div', { class: 'l' }, 'Outstanding balance'), h('div', { class: 'v ' + (p.balance_due > 0 ? 'neg' : '') }, money(p.balance_due)), h('div', { class: 's' }, 'Unpaid invoices on this policy')),
      h('div', { class: 'card kpi' }, h('div', { class: 'l' }, 'Unearned premium'), h('div', { class: 'v' }, money(full.unearned_premium)), h('div', { class: 's' }, 'Pro-rata, as of today')),
      h('div', { class: 'card kpi' }, h('div', { class: 'l' }, 'Renewal'), h('div', { style: { marginTop: '6px' } },
        p.status === 'active' && canWrite() ? inlineSelect(e.renewalStatus.map((s) => [s, title(s)]), p.renewal_status, async (v) => { await put(`/api/policies/${id}`, { renewal_status: v }).catch(fail); toast('Renewal status updated'); }, 'Renewal status') : badge(p.renewal_status)))),
    h('div', { class: 'grid g-main' },
      tabs(tabItems),
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Policy details')), h('div', { class: 'card-b' }, kv([
        ['Client', link('#/clients/' + p.client_id, p.client_name)], ['Carrier', p.carrier_name], p.mga ? ['MGA', p.mga] : null,
        ['Carrier phone', p.carrier_phone || ''], ['Claims phone', p.carrier_claims_phone || ''],
        ['Billing', title(p.billing_method)], ['Payment plan', title(p.payment_plan)],
        canMoney() ? ['Commission', p.commission_pct != null ? `${p.commission_pct}% (override)` : 'Carrier rate'] : null,
        ['Producer', p.producer_name || ''], ['Service rep', p.csr_name || ''],
        full.renewal_of ? ['Renewal of', link('#/policies/' + full.renewal_of.id, full.renewal_of.policy_number)] : null,
        full.renewed_by ? ['Renewed as', link('#/policies/' + full.renewed_by.id, full.renewed_by.policy_number)] : null,
        p.cancelled_date ? ['Cancelled', `${date(p.cancelled_date)} — ${p.cancel_reason || ''}`] : null,
        p.status === 'non_renewed' ? ['Non-renewed', p.cancel_reason || ''] : null,
        ['Notes', p.notes ? h('span', { class: 'pre' }, p.notes) : ''],
      ].filter(Boolean))))));
  return root;
}
