import { h, get, del, meta, toast, fail, confirmDialog, tabs, badge, date, money, money0, link, kv, pageHead, opt, lineName, isManager, canWrite, listView, refresh } from '../lib.js';
import { openClaimForm, notesPanel, tasksPanel, docsPanel } from './forms.js';

export async function claimsList() {
  const list = listView({
    endpoint: '/api/claims', searchPlaceholder: 'Search claim #, client, policy…', sort: { key: 'loss_date', dir: 'desc' },
    filters: [
      { key: 'status', label: 'All statuses', options: opt(meta.value.enums.claimStatus) },
      { key: 'open', label: 'Open & closed', options: [['1', 'Open claims only']] },
    ],
    columns: [
      { label: 'Claim', render: (c) => link('#/claims/' + c.id, c.claim_number || '#' + c.id) },
      { label: 'Client', sort: 'client', render: (c) => link('#/clients/' + c.client_id, c.client_name) },
      { label: 'Policy', render: (c) => h('span', null, link('#/policies/' + c.policy_id, c.policy_number), h('div', { class: 'muted small' }, `${lineName(c.line)} · ${c.carrier_name}`)) },
      { label: 'Loss date', sort: 'loss_date', render: (c) => date(c.loss_date) }, { label: 'Type', key: 'loss_type' },
      { label: 'Claimed', sort: 'claimed', num: true, render: (c) => money0(c.amount_claimed) }, { label: 'Paid', sort: 'paid', num: true, render: (c) => money0(c.amount_paid) },
      { label: 'Status', sort: 'status', render: (c) => badge(c.status) },
    ],
    onRow: (c) => { location.hash = '#/claims/' + c.id; }, empty: 'No claims on file. To report one, open a policy and choose “Report claim”.',
  });
  return h('div', { dataset: { title: 'Claims' } }, pageHead('Claims', { sub: 'Track claims from first notice to closure' }), list);
}

export async function claimDetail(id) {
  const c = await get(`/api/claims/${id}`);
  const policy = await get(`/api/policies/${c.policy_id}`);
  return h('div', { dataset: { title: 'Claim ' + (c.claim_number || id) } },
    pageHead(`Claim ${c.claim_number || '#' + c.id}`, {
      crumb: h('span', null, link('#/claims', '← Claims'), ' · ', link('#/clients/' + c.client_id, c.client_name)),
      sub: h('span', null, badge(c.status), ' ', c.loss_type || 'Loss', ' on ', date(c.loss_date)),
      actions: canWrite() ? [
        h('button', { class: 'btn btn-primary', onclick: () => openClaimForm({ claim: c, onSaved: refresh }) }, 'Edit claim'),
        isManager() ? h('button', { class: 'btn btn-danger', onclick: async () => {
          if (!(await confirmDialog('Delete this claim record?', { danger: true, confirmLabel: 'Delete' }))) return;
          try { await del(`/api/claims/${id}`); toast('Claim deleted'); location.hash = '#/claims'; } catch (e) { fail(e); }
        } }, 'Delete') : null,
      ] : null,
    }),
    h('div', { class: 'kpis' },
      h('div', { class: 'card kpi' }, h('div', { class: 'l' }, 'Amount claimed'), h('div', { class: 'v' }, money(c.amount_claimed))),
      h('div', { class: 'card kpi' }, h('div', { class: 'l' }, 'Carrier reserve'), h('div', { class: 'v' }, money(c.reserve))),
      h('div', { class: 'card kpi' }, h('div', { class: 'l' }, 'Paid'), h('div', { class: 'v' }, money(c.amount_paid)), h('div', { class: 's' }, `Deductible ${money(c.deductible)}`)),
      h('div', { class: 'card kpi' }, h('div', { class: 'l' }, 'Days open'), h('div', { class: 'v' }, String(Math.max(0, Math.round(((c.closed_date ? new Date(c.closed_date) : new Date()) - new Date(c.reported_date || c.loss_date)) / 86400000)))))),
    h('div', { class: 'grid g-main' },
      tabs([
        { key: 'notes', label: 'Notes & activity', render: () => notesPanel('claim_id', id) },
        { key: 'tasks', label: 'Tasks', render: () => tasksPanel('claim_id', id, { client_id: c.client_id }) },
        { key: 'docs', label: 'Documents', render: () => docsPanel('claim_id', id) },
      ]),
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Claim details')), h('div', { class: 'card-b' }, kv([
        ['Client', link('#/clients/' + c.client_id, c.client_name)], ['Policy', link('#/policies/' + c.policy_id, `${c.policy_number} (${lineName(c.line)})`)], ['Carrier', c.carrier_name],
        ['Carrier claims line', c.carrier_claims_phone ? h('a', { href: 'tel:' + c.carrier_claims_phone }, c.carrier_claims_phone) : ''],
        ['Date of loss', date(c.loss_date)], ['Reported', date(c.reported_date)], c.closed_date ? ['Closed', date(c.closed_date)] : null, ['Location', c.loss_location || ''],
        ['Adjuster', c.adjuster_name || ''], ['Adjuster phone', c.adjuster_phone ? h('a', { href: 'tel:' + c.adjuster_phone }, c.adjuster_phone) : ''],
        ['Adjuster email', c.adjuster_email ? h('a', { href: 'mailto:' + c.adjuster_email }, c.adjuster_email) : ''],
        ['Description', c.description ? h('span', { class: 'pre' }, c.description) : ''], ['Notes', c.notes ? h('span', { class: 'pre' }, c.notes) : ''],
        ['Policy term', `${date(policy.effective_date)} – ${date(policy.expiration_date)}`],
      ].filter(Boolean))))));
}
