import { h, clear, get, post, put, del, meta, toast, fail, confirmDialog, formModal, table, tabs, badge, date, money, money0, num, link, kv, pageHead, opt, userOptions, lineName, isManager, canWrite, title, listView, refresh } from '../lib.js';
import { openClientForm, openPolicyForm, openTaskForm, openEmailComposer, openCertificateForm, notesPanel, tasksPanel, docsPanel, certsTable } from './forms.js';

export function policyTableCols() {
  return [
    { label: 'Policy', render: (p) => link('#/policies/' + p.id, p.policy_number) },
    { label: 'Line', render: (p) => lineName(p.line) }, { label: 'Carrier', key: 'carrier_name' },
    { label: 'Term', render: (p) => `${date(p.effective_date)} – ${date(p.expiration_date)}` },
    { label: 'Premium', num: true, render: (p) => money(p.premium) }, { label: 'Status', render: (p) => badge(p.status) },
  ];
}

export async function clientsList(query = {}) {
  const e = meta.value.enums;
  const list = listView({
    endpoint: '/api/clients', searchPlaceholder: 'Search name, email, phone, city…', sort: { key: 'name', dir: 'asc' },
    dflt: { status: query.status || '' },
    filters: [
      { key: 'status', label: 'All statuses', options: opt(e.clientStatus) },
      { key: 'type', label: 'All types', options: [['person', 'Individuals'], ['business', 'Businesses']] },
      { key: 'producer_id', label: 'All producers', options: () => userOptions(['admin', 'manager', 'producer']) },
    ],
    columns: [
      { label: 'Name', sort: 'name', render: (c) => h('span', null, link('#/clients/' + c.id, c.display_name), c.type === 'business' ? h('span', { class: 'muted small' }, '  business') : null) },
      { label: 'Contact', render: (c) => h('span', null, c.email || '', c.phone ? h('div', { class: 'muted small' }, c.phone) : null) },
      { label: 'Location', sort: 'city', render: (c) => [c.city, c.state].filter(Boolean).join(', ') || '—' },
      { label: 'Policies', sort: 'policies', num: true, render: (c) => num(c.active_policies) },
      { label: 'Premium', sort: 'premium', num: true, render: (c) => money0(c.premium_in_force) },
      { label: 'Producer', key: 'producer_name' }, { label: 'Status', render: (c) => badge(c.status) },
    ],
    onRow: (c) => { location.hash = '#/clients/' + c.id; },
    empty: 'No clients found. Add your first client to get started.',
  });
  const root = h('div', { dataset: { title: 'Clients' } }, pageHead('Clients', {
    sub: 'Individuals and businesses', actions: canWrite() ? [h('button', { class: 'btn btn-primary', onclick: () => openClientForm(null, (c) => { location.hash = '#/clients/' + c.id; }) }, '+ New client')] : null,
  }), list);
  if (query.new && canWrite()) setTimeout(() => { history.replaceState(null, '', '#/clients'); openClientForm(null, (c) => { location.hash = '#/clients/' + c.id; }); }, 0);
  return root;
}

export async function clientDetail(id) {
  const c = await get(`/api/clients/${id}`);
  const [pols, claims, ledger, contacts, opps, certs] = await Promise.all([
    get('/api/policies', { client_id: id, limit: 100, sort: 'effective', dir: 'desc' }), get('/api/claims', { client_id: id, limit: 100 }),
    get(`/api/clients/${id}/ledger`), get('/api/contacts', { client_id: id, limit: 100 }), get('/api/opportunities', { client_id: id, limit: 100 }),
    get('/api/certificates', { client_id: id, limit: 100 }),
  ]);
  const reload = refresh;
  const active = pols.rows.filter((p) => p.status === 'active');
  const addr = [c.address1, c.address2, [c.city, c.state, c.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');

  const contactsPanel = () => {
    const root = h('div');
    const draw = async () => {
      const r = await get('/api/contacts', { client_id: id, limit: 100 });
      clear(root).append(h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, c.type === 'business' ? 'Business contacts' : 'Household members'),
        canWrite() ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => form() }, '+ Add') : null),
      h('div', { class: 'card-b flush' }, table([
        { label: 'Name', key: 'name' }, { label: 'Relationship', key: 'relationship' }, { label: 'Email', key: 'email' }, { label: 'Phone', key: 'phone' }, { label: 'DOB', render: (x) => date(x.dob) },
        { label: '', render: (x) => h('span', { class: 'btn-row' }, h('button', { class: 'btn btn-sm btn-ghost', onclick: () => form(x) }, 'Edit'),
          h('button', { class: 'btn btn-sm btn-ghost btn-danger', onclick: async () => { if (await confirmDialog(`Remove ${x.name}?`, { danger: true, confirmLabel: 'Remove' })) { await del(`/api/contacts/${x.id}`).catch(fail); draw(); } } }, 'Remove')) },
      ], r.rows, { empty: 'No contacts added.' }))));
    };
    const form = (x) => formModal({
      title: x ? 'Edit contact' : 'Add contact', values: x || {},
      fields: [{ name: 'name', label: 'Name', required: true }, { name: 'relationship', label: 'Relationship / role' }, { name: 'email', label: 'Email', type: 'email' },
        { name: 'phone', label: 'Phone', type: 'tel' }, { name: 'dob', label: 'Date of birth', type: 'date' }, { name: 'notes', label: 'Notes', type: 'textarea' }],
      onSubmit: async (v) => { x ? await put(`/api/contacts/${x.id}`, v) : await post('/api/contacts', { ...v, client_id: id }); draw(); },
    });
    draw();
    return root;
  };

  const billingPanel = () => {
    const root = h('div');
    (async () => {
      const [inv, led] = await Promise.all([get('/api/invoices', { client_id: id, limit: 100, sort: 'due', dir: 'desc' }), get(`/api/clients/${id}/ledger`)]);
      clear(root).append(h('div', { class: 'card', style: { marginBottom: '16px' } }, h('div', { class: 'card-h' }, h('h2', null, 'Invoices'), h('span', { class: 'muted' }, 'Due now: '), h('strong', { class: led.due_now > 0 ? 'neg' : '' }, money(led.due_now)), h('span', { class: 'muted' }, ` · total outstanding ${money(led.balance)}`)),
        h('div', { class: 'card-b flush' }, table([
          { label: 'Invoice', key: 'number' }, { label: 'Policy', render: (i) => (i.policy_id ? link('#/policies/' + i.policy_id, i.policy_number) : '—') }, { label: 'Description', key: 'description' },
          { label: 'Due', render: (i) => h('span', { class: i.days_overdue ? 'neg' : '' }, date(i.due_date)) }, { label: 'Amount', num: true, render: (i) => money(i.amount) },
          { label: 'Balance', num: true, render: (i) => money(i.balance) }, { label: 'Status', render: (i) => badge(i.status) },
        ], inv.rows, { empty: 'No invoices. Direct-bill policies are invoiced by the carrier.' }))));
    })().catch((e) => root.append(h('div', { class: 'empty neg' }, e.message)));
    return root;
  };

  const claimsRows = claims.rows;
  const root = h('div', { dataset: { title: c.display_name } },
    pageHead(c.display_name, {
      crumb: link('#/clients', '← Clients'), sub: h('span', null, badge(c.status), ' ', c.type === 'business' ? 'Business' : 'Individual', c.household ? ` · Household: ${c.household}` : ''),
      actions: [
        canWrite() ? h('button', { class: 'btn btn-primary', onclick: () => openPolicyForm({ client: c, onSaved: (p) => { location.hash = '#/policies/' + p.id; } }) }, '+ Policy') : null,
        canWrite() ? h('button', { class: 'btn', onclick: () => openEmailComposer({ client_id: id }) }, '✉ Email') : null,
        canWrite() ? h('button', { class: 'btn', onclick: () => openTaskForm({ defaults: { client_id: id }, onSaved: reload }) }, '+ Task') : null,
        canWrite() ? h('button', { class: 'btn', onclick: () => openClientForm(c, reload) }, 'Edit') : null,
        isManager() ? h('button', { class: 'btn btn-danger', onclick: async () => {
          if (!(await confirmDialog(`Delete ${c.display_name} and ALL of their policies, claims, invoices and documents? This cannot be undone.`, { danger: true, confirmLabel: 'Delete client' }))) return;
          try { await del(`/api/clients/${id}`); toast('Client deleted'); location.hash = '#/clients'; } catch (e) { fail(e); }
        } }, 'Delete') : null,
      ],
    }),
    h('div', { class: 'kpis' },
      h('div', { class: 'card kpi' }, h('div', { class: 'l' }, 'Premium in force'), h('div', { class: 'v' }, money0(active.reduce((s, p) => s + p.premium, 0))), h('div', { class: 's' }, `${active.length} active ${active.length === 1 ? 'policy' : 'policies'}`)),
      h('div', { class: 'card kpi' }, h('div', { class: 'l' }, 'Balance due now'), h('div', { class: 'v ' + (ledger.due_now > 0 ? 'neg' : '') }, money(ledger.due_now)), h('div', { class: 's' }, `${money(ledger.balance)} total outstanding`)),
      h('div', { class: 'card kpi' }, h('div', { class: 'l' }, 'Open claims'), h('div', { class: 'v' }, num(claimsRows.filter((x) => ['open', 'in_review', 'approved'].includes(x.status)).length)), h('div', { class: 's' }, `${claimsRows.length} total`)),
      h('div', { class: 'card kpi' }, h('div', { class: 'l' }, 'Next renewal'), h('div', { class: 'v', style: { fontSize: '18px' } }, date(active.map((p) => p.expiration_date).sort()[0])))),
    h('div', { class: 'grid g-main' },
      h('div', null, tabs([
        { key: 'policies', label: 'Policies', count: pols.rows.length, render: () => h('div', { class: 'card' }, h('div', { class: 'card-b flush' }, table(policyTableCols(), pols.rows, { onRow: (p) => { location.hash = '#/policies/' + p.id; }, empty: 'No policies yet.' }))) },
        { key: 'claims', label: 'Claims', count: claims.rows.length, render: () => h('div', { class: 'card' }, h('div', { class: 'card-b flush' }, table([
          { label: 'Claim', render: (x) => link('#/claims/' + x.id, x.claim_number || '#' + x.id) }, { label: 'Policy', key: 'policy_number' }, { label: 'Loss date', render: (x) => date(x.loss_date) },
          { label: 'Type', key: 'loss_type' }, { label: 'Paid', num: true, render: (x) => money(x.amount_paid) }, { label: 'Status', render: (x) => badge(x.status) },
        ], claims.rows, { empty: 'No claims on file.' }))) },
        { key: 'billing', label: 'Billing', render: billingPanel },
        { key: 'notes', label: 'Notes & activity', render: () => notesPanel('client_id', id) },
        { key: 'tasks', label: 'Tasks', render: () => tasksPanel('client_id', id) },
        { key: 'docs', label: 'Documents', render: () => docsPanel('client_id', id) },
        { key: 'certs', label: 'Certificates', count: certs.rows.length, render: () => h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Certificates of insurance'),
          canWrite() ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => openCertificateForm({ client: c, onSaved: reload }) }, '+ Issue certificate') : null),
        h('div', { class: 'card-b flush' }, certsTable(certs.rows, reload))) },
        { key: 'contacts', label: c.type === 'business' ? 'Contacts' : 'Household', count: contacts.rows.length, render: contactsPanel },
        { key: 'opps', label: 'Opportunities', count: opps.rows.length, render: () => h('div', { class: 'card' }, h('div', { class: 'card-b flush' }, table([
          { label: 'Opportunity', render: (o) => link('#/pipeline?opp=' + o.id, o.name) }, { label: 'Line', render: (o) => lineName(o.line) },
          { label: 'Est. premium', num: true, render: (o) => money(o.est_premium) }, { label: 'Stage', render: (o) => badge(o.stage) },
        ], opps.rows, { empty: 'No opportunities.' }))) },
      ])),
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Details')), h('div', { class: 'card-b' }, kv([
        ['Email', c.email ? h('a', { href: 'mailto:' + c.email }, c.email) : ''], ['Phone', c.phone ? h('a', { href: 'tel:' + c.phone }, c.phone) : ''],
        ['Mobile', c.mobile ? h('a', { href: 'tel:' + c.mobile }, c.mobile) : ''], ['Address', addr], c.dob ? ['Date of birth', date(c.dob)] : null,
        c.type === 'business' ? ['DBA', c.dba || ''] : null, c.type === 'business' ? ['Industry', c.industry || ''] : null,
        c.type === 'business' ? ['Employees', c.employees ? num(c.employees) : ''] : null, c.type === 'business' ? ['Revenue', c.annual_revenue ? money0(c.annual_revenue) : ''] : null,
        ['Producer', c.producer_name || ''], ['Service rep', c.csr_name || ''], ['Source', c.source || ''],
        ['Preferred', c.preferred_contact ? title(c.preferred_contact) : ''], ['Marketing', c.do_not_contact ? h('span', { class: 'neg' }, 'Do not contact') : 'OK'],
        ['Client since', date(c.created_at)], ['Notes', c.notes ? h('span', { class: 'pre' }, c.notes) : ''],
      ].filter(Boolean))))));
  return root;
}
