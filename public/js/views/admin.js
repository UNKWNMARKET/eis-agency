import { h, clear, get, post, put, del, api, meta, toast, fail, confirmDialog, formModal, buildForm, table, tabs, badge, date, dateTime, money0, num, pageHead, title, isManager, can, listView } from '../lib.js';

/* ---------- Carriers ---------- */
function carrierForm(c, onSaved) {
  return formModal({
    title: c ? `Edit ${c.name}` : 'New carrier', wide: true,
    fields: [
      { name: 'name', label: 'Carrier name', required: true }, { name: 'naic', label: 'NAIC #' }, { name: 'am_best', label: 'AM Best rating' }, { name: 'agency_code', label: 'Our agency / producer code' },
      { name: 'phone', label: 'Service phone', type: 'tel' }, { name: 'claims_phone', label: 'Claims phone', type: 'tel' }, { name: 'email', label: 'Email', type: 'email' }, { name: 'website', label: 'Website / portal' },
      { name: 'commission_new_pct', label: 'Commission % — new business', type: 'money', required: true }, { name: 'commission_renew_pct', label: 'Commission % — renewals', type: 'money', required: true },
      { name: 'default_billing', label: 'Default billing', type: 'select', options: [['direct_bill', 'Direct bill'], ['agency_bill', 'Agency bill']], required: true },
      { name: 'active', label: 'Active (available for new policies)', type: 'checkbox' }, { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
    values: c || { commission_new_pct: 12, commission_renew_pct: 10, default_billing: 'direct_bill', active: true },
    onSubmit: async (v) => { const r = c ? await put(`/api/carriers/${c.id}`, v) : await post('/api/carriers', v); toast('Carrier saved'); meta.value.carriers = (await get('/api/meta')).carriers; onSaved?.(r); },
  });
}

export async function carriers() {
  const list = listView({
    endpoint: '/api/carriers', searchPlaceholder: 'Search carriers…', sort: { key: 'name', dir: 'asc' }, pageSize: 50,
    filters: [{ key: 'active', label: 'Active & inactive', options: [['1', 'Active'], ['0', 'Inactive']] }],
    columns: [
      { label: 'Carrier', sort: 'name', render: (c) => h('span', null, h('strong', null, c.name), c.website ? h('div', { class: 'small' }, h('a', { href: /^https?:\/\//.test(c.website) ? c.website : 'https://' + c.website, target: '_blank', rel: 'noopener noreferrer' }, c.website)) : null) },
      { label: 'Phone', render: (c) => h('span', null, c.phone || '—', c.claims_phone ? h('div', { class: 'muted small' }, 'Claims ' + c.claims_phone) : null) },
      { label: 'Rating', render: (c) => c.am_best || '—' }, { label: 'Agency code', key: 'agency_code' },
      { label: 'Comm. new / renew', render: (c) => `${c.commission_new_pct}% / ${c.commission_renew_pct}%` },
      { label: 'Policies', sort: 'policies', num: true, render: (c) => num(c.active_policies) }, { label: 'Premium', sort: 'premium', num: true, render: (c) => money0(c.premium_in_force) },
      { label: 'Status', render: (c) => badge(c.active ? 'active' : 'inactive') },
    ],
    onRow: isManager() ? (c) => carrierForm(c, () => list.reload()) : null, empty: 'No carriers yet. Add the carriers you place business with.',
  });
  return h('div', { dataset: { title: 'Carriers' } }, pageHead('Carriers', {
    sub: 'Companies you place business with and their commission schedules',
    actions: isManager() ? [h('button', { class: 'btn btn-primary', onclick: () => carrierForm(null, () => list.reload()) }, '+ New carrier')] : null,
  }), list);
}

/* ---------- Settings ---------- */
const agencyTab = () => {
  const a = meta.value.agency;
  const form = buildForm([
    { name: 'agency_name', label: 'Agency name', required: true, full: true }, { name: 'agency_address', label: 'Address', full: true }, { name: 'agency_phone', label: 'Phone', type: 'tel' },
    { name: 'agency_email', label: 'Email', type: 'email' }, { name: 'agency_license', label: 'Agency license #', full: true },
  ], a);
  return h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Agency profile'), h('span', { class: 'muted small' }, 'Appears on certificates and email templates')),
    h('div', { class: 'card-b' }, form.el, h('div', { style: { marginTop: '14px' } }, h('button', { class: 'btn btn-primary', disabled: !isManager(), onclick: async () => {
      form.resetErrors();
      try { await put('/api/settings', form.read()); meta.value = await get('/api/meta'); toast('Agency profile saved'); } catch (e) { form.showErrors(e); }
    } }, 'Save'))));
};

function userForm(u, onSaved) {
  return formModal({
    title: u ? `Edit ${u.name}` : 'New user',
    fields: [
      { name: 'name', label: 'Full name', required: true }, { name: 'email', label: 'Email (login)', type: 'email', required: true },
      { name: 'role', label: 'Role', type: 'select', options: () => meta.value.roles.map((r) => [r, title(r)]), required: true, help: 'Admin: everything · Manager: all but user admin · Producer/CSR: day-to-day · Accounting: billing & commissions' },
      { name: 'phone', label: 'Phone', type: 'tel' }, { name: 'license_no', label: 'License #' },
      { name: 'split_new_pct', label: 'Producer split — new business %', type: 'money' }, { name: 'split_renew_pct', label: 'Producer split — renewals %', type: 'money' },
      { name: 'password', label: u ? 'Reset password (optional)' : 'Initial password', type: 'password', required: !u, help: 'Minimum 10 characters', full: true },
      u ? { name: 'active', label: 'Active', type: 'checkbox' } : null,
    ].filter(Boolean),
    values: u || { role: 'csr', split_new_pct: 0, split_renew_pct: 0 },
    onSubmit: async (v) => {
      if (u && !v.password) delete v.password;
      const r = u ? await put(`/api/users/${u.id}`, v) : await post('/api/users', v);
      toast('User saved'); meta.value = await get('/api/meta'); onSaved?.(r);
    },
  });
}

const usersTab = async () => {
  const root = h('div');
  const draw = async () => {
    const r = await get('/api/users');
    clear(root).append(h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Users'), can('admin') ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => userForm(null, draw) }, '+ New user') : null),
      h('div', { class: 'card-b flush' }, table([
        { label: 'Name', key: 'name' }, { label: 'Email', key: 'email' }, { label: 'Role', render: (u) => badge(u.role, 'purple') },
        { label: 'Split new / renew', render: (u) => (u.split_new_pct || u.split_renew_pct ? `${u.split_new_pct}% / ${u.split_renew_pct}%` : '—') }, { label: 'Status', render: (u) => badge(u.active ? 'active' : 'inactive') },
        { label: '', render: (u) => (can('admin') ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => userForm(u, draw) }, 'Edit') : null) },
      ], r.rows))));
  };
  await draw();
  return root;
};

const templatesTab = async () => {
  const root = h('div');
  const form = (t) => formModal({
    title: t ? 'Edit template' : 'New template', wide: true,
    extra: h('div', { class: 'muted small', style: { marginBottom: '10px' } }, 'Merge fields: {{client_name}} {{first_name}} {{policy_number}} {{carrier}} {{line}} {{effective_date}} {{expiration_date}} {{premium}} {{agent_name}} {{agency_name}} {{agency_phone}} {{agency_email}}'),
    fields: [{ name: 'name', label: 'Name', required: true }, { name: 'category', label: 'Category', placeholder: 'renewal, billing, sales…' }, { name: 'subject', label: 'Subject', required: true, full: true }, { name: 'body', label: 'Body', type: 'textarea', rows: 12, required: true }],
    values: t || { category: 'general' }, onSubmit: async (v) => { t ? await put(`/api/templates/${t.id}`, v) : await post('/api/templates', v); toast('Template saved'); draw(); },
  });
  const draw = async () => {
    const r = await get('/api/templates', { limit: 200 });
    clear(root).append(h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Email templates'), isManager() ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => form() }, '+ New template') : null),
      h('div', { class: 'card-b flush' }, table([
        { label: 'Name', key: 'name' }, { label: 'Category', render: (t) => badge(t.category, 'blue') }, { label: 'Subject', key: 'subject' },
        { label: '', render: (t) => (isManager() ? h('span', { class: 'btn-row' }, h('button', { class: 'btn btn-sm btn-ghost', onclick: () => form(t) }, 'Edit'),
          h('button', { class: 'btn btn-sm btn-ghost btn-danger', onclick: async () => { if (await confirmDialog(`Delete “${t.name}”?`, { danger: true, confirmLabel: 'Delete' })) { await del(`/api/templates/${t.id}`).catch(fail); draw(); } } }, 'Delete')) : null) },
      ], r.rows))));
  };
  await draw();
  return root;
};

const importTab = () => {
  const text = h('textarea', { rows: 10, placeholder: 'first_name,last_name,email,phone,city,state,zip\nJane,Doe,jane@example.com,555-0100,Austin,TX,78701', 'aria-label': 'CSV data' });
  const file = h('input', { type: 'file', accept: '.csv,text/csv', 'aria-label': 'CSV file', onchange: async (e) => { const f = e.target.files[0]; if (f) text.value = await f.text(); } });
  const out = h('div');
  const run = async (dry) => {
    try {
      const r = await post('/api/import/clients', { csv: text.value, dry_run: dry });
      clear(out).append(h('div', { class: 'card-b' }, h('p', null, dry ? `${r.valid} rows are valid and ready to import. ${r.error_count} have problems.` : `Imported ${r.created} clients. ${r.error_count} rows were skipped.`),
        r.errors.length ? h('ul', null, r.errors.map((e) => h('li', { class: 'neg' }, `Row ${e.row}: ${e.error}`))) : null,
        dry && r.valid ? h('button', { class: 'btn btn-primary', onclick: () => run(false) }, `Import ${r.valid} clients`) : null));
      if (!dry) toast(`Imported ${r.created} clients`);
    } catch (e) { fail(e); }
  };
  return h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Import clients from CSV')),
    h('div', { class: 'card-b' }, h('p', { class: 'muted', style: { marginTop: 0 } }, 'Columns: type (person/business), first_name, last_name, business_name, email, phone, mobile, address1, city, state, zip, dob (YYYY-MM-DD), status, industry, source. A header row is required. Validate first — nothing is saved until you import.'),
      h('div', { class: 'field' }, h('label', null, 'CSV file'), file), h('div', { class: 'field', style: { marginTop: '10px' } }, h('label', null, 'Or paste CSV'), text),
      h('div', { class: 'btn-row', style: { marginTop: '12px' } }, h('button', { class: 'btn', onclick: () => run(true) }, 'Validate')), out));
};

const auditTab = () => listView({
  endpoint: '/api/audit', searchPlaceholder: 'Search user, entity, details…', pageSize: 50,
  filters: [{ key: 'entity', label: 'All records', options: ['client', 'policy', 'claim', 'invoice', 'payment', 'commission', 'opportunity', 'document', 'certificate', 'user', 'settings', 'carrier'].map((x) => [x, title(x)]) },
    { key: 'from', label: 'From', type: 'date' }, { key: 'to', label: 'To', type: 'date' }],
  columns: [
    { label: 'When', render: (a) => dateTime(a.created_at) }, { label: 'User', key: 'user_name' }, { label: 'Action', render: (a) => badge(a.action, 'blue') },
    { label: 'Record', render: (a) => `${a.entity}${a.entity_id ? ' #' + a.entity_id : ''}` }, { label: 'Details', render: (a) => h('span', { class: 'small muted', style: { overflowWrap: 'anywhere' } }, (a.detail || '').slice(0, 220)) },
  ],
});

const accountTab = () => {
  const form = buildForm([
    { name: 'current', label: 'Current password', type: 'password', required: true, full: true }, { name: 'next', label: 'New password', type: 'password', required: true, full: true, help: 'At least 10 characters. Other sessions are signed out.' },
  ]);
  const card = h('div', { class: 'card', style: { marginBottom: '16px' } }, h('div', { class: 'card-h' }, h('h2', null, 'Change my password')), h('div', { class: 'card-b' }, form.el,
    h('div', { style: { marginTop: '14px' } }, h('button', { class: 'btn btn-primary', onclick: async () => {
      form.resetErrors();
      try { await post('/api/auth/password', form.read()); toast('Password changed'); form.el.reset(); } catch (e) { form.showErrors(e); }
    } }, 'Update password'))));
  const backup = can('admin') ? h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Database backup')),
    h('div', { class: 'card-b' }, h('p', { class: 'muted', style: { marginTop: 0 } }, 'Downloads a consistent snapshot of the entire database (client data included — store it securely). Uploaded documents live in data/uploads and should be backed up separately.'),
      h('a', { class: 'btn', href: '/api/admin/backup' }, '⬇ Download backup'))) : null;
  return h('div', null, card, backup);
};

export async function settings(tab) {
  const items = [
    { key: 'account', label: 'My account', render: accountTab },
    isManager() ? { key: 'agency', label: 'Agency profile', render: agencyTab } : null,
    isManager() ? { key: 'users', label: 'Users', render: usersTab } : null,
    { key: 'templates', label: 'Email templates', render: templatesTab },
    isManager() ? { key: 'import', label: 'Import clients', render: importTab } : null,
    isManager() ? { key: 'audit', label: 'Audit log', render: auditTab } : null,
  ].filter(Boolean);
  return h('div', { dataset: { title: 'Settings' } }, pageHead('Settings', { sub: 'Agency profile, team, templates and data tools' }),
    tabs(items, { initial: items.find((i) => i.key === tab)?.key, onChange: (k) => history.replaceState(null, '', '#/settings/' + k) }));
}
