import {
  h, clear, append, get, post, put, del, meta, toast, fail, formModal, modal, confirmDialog, buildForm, table, badge, date, dateTime, money, title, opt,
  userOptions, carrierOptions, lineOptions, todayStr, addDaysStr, link, can, isManager, canWrite, lineName,
} from '../lib.js';

/* ---------- Form definitions ---------- */
export function clientFields() {
  const e = meta.value.enums;
  return [
    { name: 'type', label: 'Client type', type: 'select', options: [['person', 'Individual'], ['business', 'Business']], required: true },
    { name: 'status', label: 'Status', type: 'select', options: opt(e.clientStatus), required: true },
    { name: 'first_name', label: 'First name' }, { name: 'last_name', label: 'Last name' },
    { name: 'business_name', label: 'Business name' }, { name: 'dba', label: 'DBA' },
    { name: 'email', label: 'Email', type: 'email' }, { name: 'phone', label: 'Phone', type: 'tel' },
    { name: 'mobile', label: 'Mobile', type: 'tel' }, { name: 'dob', label: 'Date of birth', type: 'date' },
    { name: 'address1', label: 'Address', full: true }, { name: 'address2', label: 'Address line 2', full: true },
    { name: 'city', label: 'City' }, { name: 'state', label: 'State', maxlength: 2, placeholder: 'TX' },
    { name: 'zip', label: 'ZIP' }, { name: 'household', label: 'Household / account group', help: 'Clients sharing this name are grouped together' },
    { name: 'industry', label: 'Industry (business)' }, { name: 'employees', label: 'Employees (business)', type: 'number' },
    { name: 'annual_revenue', label: 'Annual revenue (business)', type: 'money' }, { name: 'fein_last4', label: 'FEIN last 4', maxlength: 4 },
    { name: 'producer_id', label: 'Producer', type: 'select', options: () => userOptions(['admin', 'manager', 'producer']), blank: true },
    { name: 'csr_id', label: 'Service rep (CSR)', type: 'select', options: () => userOptions(), blank: true },
    { name: 'source', label: 'Lead source', placeholder: 'Referral, Web, Walk-in…' },
    { name: 'preferred_contact', label: 'Preferred contact', type: 'select', options: [['email', 'Email'], ['phone', 'Phone'], ['text', 'Text']], blank: true },
    { name: 'do_not_contact', label: 'Do not contact (marketing)', type: 'checkbox', full: true },
    { name: 'notes', label: 'Internal notes', type: 'textarea' },
  ];
}

export function openClientForm(client, onSaved) {
  const m = formModal({
    title: client ? `Edit ${client.display_name}` : 'New client', wide: true, fields: clientFields(),
    values: client || { type: 'person', status: 'active', producer_id: window.__user.role === 'producer' ? window.__user.id : '' },
    onSubmit: async (v) => {
      const saved = client ? await put(`/api/clients/${client.id}`, v) : await post('/api/clients', v);
      toast(client ? 'Client updated' : 'Client created');
      onSaved?.(saved);
    },
  });
  // Show only the name fields relevant to the type.
  const sync = () => {
    const biz = m.el.querySelector('#f_type').value === 'business';
    for (const n of ['first_name', 'last_name', 'dob']) m.el.querySelector('#f_' + n).closest('.field').style.display = biz ? 'none' : '';
    for (const n of ['business_name', 'dba', 'industry', 'employees', 'annual_revenue', 'fein_last4']) m.el.querySelector('#f_' + n).closest('.field').style.display = biz ? '' : 'none';
  };
  m.el.querySelector('#f_type').addEventListener('change', sync);
  sync();
}

export function policyFields({ fixedClient } = {}) {
  const e = meta.value.enums;
  return [
    fixedClient ? null : { name: 'client_id', label: 'Client', type: 'client', required: true, full: true },
    { name: 'carrier_id', label: 'Carrier', type: 'select', options: carrierOptions, required: true },
    { name: 'mga', label: 'MGA / wholesaler' },
    { name: 'policy_number', label: 'Policy number', required: true },
    { name: 'line', label: 'Line of business', type: 'select', options: lineOptions, required: true },
    { name: 'effective_date', label: 'Effective date', type: 'date', required: true },
    { name: 'expiration_date', label: 'Expiration date', type: 'date', required: true },
    { name: 'premium', label: 'Annual premium', type: 'money', required: true },
    { name: 'fees', label: 'Policy fees', type: 'money' },
    { name: 'billing_method', label: 'Billing', type: 'select', blank: true, blankLabel: 'Carrier default', options: [['direct_bill', 'Direct bill (carrier bills client)'], ['agency_bill', 'Agency bill (we invoice client)']] },
    { name: 'payment_plan', label: 'Payment plan (agency bill)', type: 'select', options: opt(e.paymentPlans) },
    { name: 'commission_pct', label: 'Commission % override', type: 'money', help: 'Leave blank to use the carrier rate' },
    { name: 'producer_id', label: 'Producer', type: 'select', options: () => userOptions(['admin', 'manager', 'producer']), blank: true },
    { name: 'csr_id', label: 'Service rep', type: 'select', options: () => userOptions(), blank: true },
    { name: 'notes', label: 'Notes', type: 'textarea' },
  ].filter(Boolean);
}

export function openPolicyForm({ policy, client, onSaved } = {}) {
  const fields = policyFields({ fixedClient: !!client || !!policy });
  const editingProtected = policy && !isManager();
  const m = formModal({
    title: policy ? `Edit policy ${policy.policy_number}` : 'New policy', wide: true, fields,
    values: policy || { client_id: client?.id, status: 'active', payment_plan: 'full', effective_date: todayStr(), billing_method: '' },
    extra: editingProtected ? h('div', { class: 'warn', style: { marginBottom: '12px' } }, 'Premium, dates, carrier and billing can be changed with Endorse / Cancel / Renew. Only managers can edit them directly.')
      : policy ? h('div', { class: 'warn', style: { marginBottom: '12px' } }, 'Editing premium or dates here corrects the record only — it does not create a transaction, invoice or commission line. Use Endorse for mid-term changes.') : null,
    onSubmit: async (v) => {
      let saved;
      if (policy) {
        if (editingProtected) for (const k of ['premium', 'fees', 'effective_date', 'expiration_date', 'carrier_id', 'billing_method', 'payment_plan', 'commission_pct']) delete v[k];
        if (!v.billing_method) delete v.billing_method;
        saved = await put(`/api/policies/${policy.id}`, v);
      } else {
        if (client) v.client_id = client.id;
        if (!v.billing_method) delete v.billing_method;
        saved = await post('/api/policies', v);
      }
      toast(policy ? 'Policy updated' : 'Policy bound');
      onSaved?.(saved);
    },
  });
  if (editingProtected) for (const n of ['premium', 'fees', 'effective_date', 'expiration_date', 'carrier_id', 'billing_method', 'payment_plan', 'commission_pct']) m.el.querySelector('#f_' + n).disabled = true;
  if (policy) m.el.querySelector('#f_payment_plan').closest('.field').style.display = 'none';
  // Convenience: default expiration to +1 year.
  const eff = m.el.querySelector('#f_effective_date'), exp = m.el.querySelector('#f_expiration_date');
  if (!policy) eff.addEventListener('change', () => {
    if (!eff.value || exp.value) return;
    const d = new Date(eff.value + 'T00:00:00Z'); d.setUTCFullYear(d.getUTCFullYear() + 1); exp.value = d.toISOString().slice(0, 10);
  });
  return m;
}

export function openTaskForm({ task, defaults = {}, onSaved } = {}) {
  const e = meta.value.enums;
  return formModal({
    title: task ? 'Edit task' : 'New task',
    fields: [
      { name: 'title', label: 'Task', required: true, full: true },
      { name: 'due_date', label: 'Due date', type: 'date' },
      { name: 'priority', label: 'Priority', type: 'select', options: opt(e.taskPriority), required: true },
      { name: 'assigned_to', label: 'Assigned to', type: 'select', options: () => userOptions(), required: true },
      !task && !defaults.client_id ? { name: 'client_id', label: 'Related client', type: 'client' } : null,
      { name: 'description', label: 'Details', type: 'textarea' },
    ].filter(Boolean),
    values: task || { priority: 'normal', assigned_to: window.__user.id, due_date: addDaysStr(3), ...defaults },
    onSubmit: async (v) => {
      const saved = task ? await put(`/api/tasks/${task.id}`, v) : await post('/api/tasks', { ...defaults, ...v });
      toast('Task saved'); onSaved?.(saved);
    },
  });
}

export function openNoteForm({ note, link: lnk, onSaved }) {
  const e = meta.value.enums;
  return formModal({
    title: note ? 'Edit note' : 'Log activity',
    fields: [
      { name: 'kind', label: 'Type', type: 'select', options: opt(e.activityKinds), required: true },
      { name: 'subject', label: 'Subject', full: true },
      { name: 'body', label: 'Details', type: 'textarea', rows: 5 },
    ],
    values: note || { kind: 'note' },
    onSubmit: async (v) => {
      const saved = note ? await put(`/api/activities/${note.id}`, v) : await post('/api/activities', { ...v, ...lnk });
      toast('Saved'); onSaved?.(saved);
    },
  });
}

export function openClaimForm({ claim, policy, onSaved }) {
  const e = meta.value.enums;
  return formModal({
    title: claim ? `Edit claim ${claim.claim_number || '#' + claim.id}` : `Report claim — ${policy.policy_number}`, wide: true,
    fields: [
      { name: 'claim_number', label: 'Carrier claim number' },
      { name: 'status', label: 'Status', type: 'select', options: opt(e.claimStatus), required: true },
      { name: 'loss_date', label: 'Date of loss', type: 'date', required: true },
      { name: 'reported_date', label: 'Date reported', type: 'date' },
      { name: 'loss_type', label: 'Type of loss', placeholder: 'Collision, Water damage, Theft…' },
      { name: 'loss_location', label: 'Loss location' },
      { name: 'description', label: 'Description of loss', type: 'textarea', rows: 4 },
      { name: 'amount_claimed', label: 'Amount claimed', type: 'money' }, { name: 'reserve', label: 'Carrier reserve', type: 'money' },
      { name: 'amount_paid', label: 'Amount paid', type: 'money' }, { name: 'deductible', label: 'Deductible', type: 'money' },
      { name: 'adjuster_name', label: 'Adjuster' }, { name: 'adjuster_phone', label: 'Adjuster phone', type: 'tel' },
      { name: 'adjuster_email', label: 'Adjuster email', type: 'email' },
      { name: 'notes', label: 'Internal notes', type: 'textarea' },
    ],
    values: claim || { status: 'open', reported_date: todayStr() },
    onSubmit: async (v) => {
      const saved = claim ? await put(`/api/claims/${claim.id}`, v) : await post('/api/claims', { ...v, policy_id: policy.id });
      toast('Claim saved'); onSaved?.(saved);
    },
  });
}

/* ---------- Email composer (merge fields → mailto / copy / log) ---------- */
export async function openEmailComposer({ client_id, policy_id, templateName, onLogged }) {
  const { rows: templates } = await get('/api/templates', { limit: 100 });
  if (!templates.length) return toast('No templates available', 'err');
  const sel = h('select', { 'aria-label': 'Template' }, templates.map((t) => h('option', { value: t.id }, `${title(t.category)} — ${t.name}`)));
  const pre = templates.find((t) => t.name === templateName);
  if (pre) sel.value = pre.id;
  const to = h('input', { type: 'email', placeholder: 'recipient@example.com', 'aria-label': 'To' });
  const subject = h('input', { type: 'text', 'aria-label': 'Subject' });
  const body = h('textarea', { rows: 14, 'aria-label': 'Body' });
  async function render() {
    const r = await post(`/api/templates/${sel.value}/render`, { client_id, policy_id });
    to.value = r.to || ''; subject.value = r.subject; body.value = r.body;
  }
  sel.addEventListener('change', () => render().catch(fail));
  await render();
  const m = modal({
    title: 'Compose email', wide: true,
    body: h('div', { class: 'grid' },
      h('div', { class: 'field' }, h('label', null, 'Template'), sel), h('div', { class: 'field' }, h('label', null, 'To'), to),
      h('div', { class: 'field' }, h('label', null, 'Subject'), subject), h('div', { class: 'field' }, h('label', null, 'Message'), body),
      h('div', { class: 'help muted small' }, 'This opens your email app with the message pre-filled. Nothing is sent from the server. "Log" records the email on the client\'s timeline.')),
    actions: [
      h('button', { class: 'btn', onclick: async () => { await navigator.clipboard?.writeText(body.value); toast('Copied to clipboard'); } }, 'Copy'),
      h('button', { class: 'btn', onclick: async () => {
        try { await post('/api/activities', { kind: 'email', subject: subject.value, body: body.value, client_id, policy_id }); toast('Logged to timeline'); onLogged?.(); m.close(); } catch (e) { fail(e); }
      } }, 'Log without sending'),
      h('button', { class: 'btn btn-primary', onclick: async () => {
        window.location.href = `mailto:${encodeURIComponent(to.value)}?subject=${encodeURIComponent(subject.value)}&body=${encodeURIComponent(body.value)}`;
        try { await post('/api/activities', { kind: 'email', subject: subject.value, body: body.value, client_id, policy_id }); onLogged?.(); } catch { /* non-fatal */ }
        m.close();
      } }, 'Open in email app & log'),
    ],
  });
}

/* ---------- Certificates ---------- */
export async function openCertificateForm({ client, policy, onSaved }) {
  let clientRef = client;
  const wrap = h('div');
  const holder = buildForm([
    { name: 'holder_name', label: 'Certificate holder', required: true, full: true },
    { name: 'holder_address', label: 'Holder address', type: 'textarea', rows: 2 },
    { name: 'description', label: 'Description of operations / locations / vehicles', type: 'textarea', rows: 3 },
    { name: 'additional_insured', label: 'Holder is additional insured', type: 'checkbox' },
    { name: 'waiver_of_subrogation', label: 'Waiver of subrogation', type: 'checkbox' },
    { name: 'primary_noncontributory', label: 'Primary & non-contributory', type: 'checkbox' },
  ], {});
  const polBox = h('div');
  const checked = new Set(policy ? [policy.id] : []);
  async function loadPolicies() {
    clear(polBox);
    if (!clientRef) return;
    const r = await get('/api/policies', { client_id: clientRef.id, status: 'active,pending_cancel', limit: 100 });
    append(polBox, [h('h3', { style: { margin: '10px 0 6px' } }, 'Policies to include'),
      r.rows.length ? r.rows.map((p) => h('label', { style: { display: 'flex', gap: '8px', padding: '4px 0', alignItems: 'center' } },
        h('input', { type: 'checkbox', checked: checked.has(p.id), onchange: (e) => (e.target.checked ? checked.add(p.id) : checked.delete(p.id)) }),
        `${lineName(p.line)} — ${p.policy_number} (${p.carrier_name}, exp ${date(p.expiration_date)})`)) : h('div', { class: 'muted' }, 'This client has no in-force policies.')]);
  }
  if (!clientRef) {
    const pick = buildForm([{ name: 'client_id', label: 'Client', type: 'client', required: true, full: true, onPick: (c) => { clientRef = c; loadPolicies(); } }], {});
    wrap.append(pick.el);
  }
  wrap.append(holder.el, polBox);
  await loadPolicies();
  const m = modal({
    title: 'Issue certificate of insurance', wide: true, body: wrap,
    actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
      h('button', { class: 'btn btn-primary', onclick: async () => {
        holder.resetErrors();
        try {
          if (!clientRef) throw new Error('Choose a client');
          const r = await post('/api/certificates', { ...holder.read(), client_id: clientRef.id, policy_ids: [...checked] });
          toast(`Certificate ${r.number} issued`); m.close(); window.open(`/api/certificates/${r.id}/html`, '_blank', 'noopener'); onSaved?.(r);
        } catch (e) { holder.showErrors(e); }
      } }, 'Issue & preview')],
  });
}

/* ---------- Reusable record panels ---------- */
const KIND_ICON = { note: '✎', call: '☎', email: '✉', meeting: '☺', text: '✆', system: '⚙' };

export function notesPanel(linkKey, id, { onChange } = {}) {
  const root = h('div');
  async function load() {
    const r = await get('/api/activities', { [linkKey]: id, limit: 200 });
    clear(root).append(h('div', { class: 'card' },
      h('div', { class: 'card-h' }, h('h2', null, 'Activity & notes'),
        canWrite() ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => openNoteForm({ link: { [linkKey]: id }, onSaved: () => { load(); onChange?.(); } }) }, '+ Add note') : null),
      h('div', { class: 'card-b' }, r.rows.length ? h('ul', { class: 'timeline' }, r.rows.map((a) => h('li', null,
        h('div', { class: 'dot ' + (a.kind === 'system' ? 'system' : '') }, KIND_ICON[a.kind] || '•'),
        h('div', { class: 'bd' },
          h('div', null, h('strong', null, a.subject || title(a.kind)), ' ', h('span', { class: 'muted small' }, `${a.user_name || 'system'} · ${dateTime(a.created_at)}`)),
          a.body ? h('div', { class: 'body' }, a.body) : null,
          a.kind !== 'system' && (a.user_id === window.__user.id || isManager()) ? h('div', { class: 'btn-row', style: { marginTop: '4px' } },
            h('button', { class: 'btn btn-sm btn-ghost', onclick: () => openNoteForm({ note: a, onSaved: load }) }, 'Edit'),
            h('button', { class: 'btn btn-sm btn-ghost btn-danger', onclick: async () => { if (await confirmDialog('Delete this note?', { danger: true, confirmLabel: 'Delete' })) { await del(`/api/activities/${a.id}`).catch(fail); load(); } } }, 'Delete')) : null)))) : h('div', { class: 'empty' }, 'No activity yet.'))));
  }
  load().catch((e) => root.append(h('div', { class: 'empty neg' }, e.message)));
  return root;
}

export function tasksPanel(linkKey, id, defaults = {}) {
  const root = h('div');
  async function load() {
    const r = await get('/api/tasks', { [linkKey]: id, limit: 100 });
    clear(root).append(h('div', { class: 'card' },
      h('div', { class: 'card-h' }, h('h2', null, 'Tasks'), canWrite() ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => openTaskForm({ defaults: { [linkKey]: id, ...defaults }, onSaved: load }) }, '+ Add task') : null),
      h('div', { class: 'card-b flush' }, table([
        { label: '', render: (t) => h('input', { type: 'checkbox', checked: t.status === 'done', 'aria-label': 'Done', onchange: async (e) => { await put(`/api/tasks/${t.id}`, { status: e.target.checked ? 'done' : 'open' }).catch(fail); load(); } }) },
        { label: 'Task', render: (t) => h('span', { style: { textDecoration: t.status === 'done' ? 'line-through' : 'none' } }, t.title) },
        { label: 'Due', render: (t) => h('span', { class: t.overdue ? 'neg' : '' }, date(t.due_date)) },
        { label: 'Priority', render: (t) => badge(t.priority) }, { label: 'Assigned', key: 'assigned_name' },
        { label: '', render: (t) => h('button', { class: 'btn btn-sm btn-ghost', onclick: () => openTaskForm({ task: t, onSaved: load }) }, 'Edit') },
      ], r.rows, { empty: 'No tasks.' }))));
  }
  load().catch((e) => root.append(h('div', { class: 'empty neg' }, e.message)));
  return root;
}

export function docsPanel(linkKey, id) {
  const root = h('div');
  const e = meta.value.enums;
  async function load() {
    const r = await get('/api/documents', { [linkKey]: id, limit: 200 });
    clear(root).append(h('div', { class: 'card' },
      h('div', { class: 'card-h' }, h('h2', null, 'Documents'), canWrite() ? h('button', { class: 'btn btn-sm btn-primary', onclick: upload }, '+ Upload') : null),
      h('div', { class: 'card-b flush' }, table([
        { label: 'Name', render: (d) => h('a', { href: `/api/documents/${d.id}/download` }, d.name) },
        { label: 'Category', render: (d) => badge(d.category, 'blue') },
        { label: 'Size', num: true, render: (d) => (d.size > 1048576 ? (d.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(d.size / 1024)) + ' KB') },
        { label: 'Uploaded', render: (d) => `${dateTime(d.created_at)} · ${d.uploaded_by_name || ''}` },
        { label: '', render: (d) => h('button', { class: 'btn btn-sm btn-ghost btn-danger', onclick: async () => { if (await confirmDialog(`Delete ${d.name}?`, { danger: true, confirmLabel: 'Delete' })) { await del(`/api/documents/${d.id}`).catch(fail); load(); } } }, 'Delete') },
      ], r.rows, { empty: 'No documents uploaded.' }))));
  }
  function upload() {
    const file = h('input', { type: 'file', accept: '.pdf,.png,.jpg,.jpeg,.gif,.doc,.docx,.xls,.xlsx,.csv,.txt,.eml,.msg' });
    const cat = h('select', null, e.docCategories.map((c) => h('option', { value: c }, title(c))));
    const m = modal({
      title: 'Upload document', body: h('div', { class: 'grid' },
        h('div', { class: 'field' }, h('label', null, 'File (max 10 MB)'), file), h('div', { class: 'field' }, h('label', null, 'Category'), cat)),
      actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn btn-primary', onclick: async (ev) => {
        const f = file.files[0]; if (!f) return toast('Choose a file', 'err');
        if (f.size > 10 * 1024 * 1024) return toast('File exceeds 10 MB', 'err');
        ev.target.disabled = true;
        try {
          const buf = new Uint8Array(await f.arrayBuffer());
          let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
          await post('/api/documents', { name: f.name, category: cat.value, [linkKey]: id, data: btoa(bin) });
          toast('Uploaded'); m.close(); load();
        } catch (er) { fail(er); ev.target.disabled = false; }
      } }, 'Upload')],
    });
  }
  load().catch((er) => root.append(h('div', { class: 'empty neg' }, er.message)));
  return root;
}

export function certsTable(rows, reload) {
  return table([
    { label: 'Number', render: (c) => h('a', { href: `/api/certificates/${c.id}/html`, target: '_blank', rel: 'noopener' }, c.number) },
    { label: 'Client', render: (c) => link('#/clients/' + c.client_id, c.client_name) }, { label: 'Holder', key: 'holder_name' },
    { label: 'Policies', key: 'policy_numbers' }, { label: 'Issued', render: (c) => date(c.issued_date) },
    { label: '', render: (c) => isManager() ? h('button', { class: 'btn btn-sm btn-ghost btn-danger', onclick: async () => { if (await confirmDialog(`Delete certificate ${c.number}?`, { danger: true, confirmLabel: 'Delete' })) { await del(`/api/certificates/${c.id}`).catch(fail); reload(); } } }, 'Delete') : null },
  ], rows, { empty: 'No certificates issued.' });
}

export { can };
