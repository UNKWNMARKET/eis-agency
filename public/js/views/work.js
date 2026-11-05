import { h, put, del, meta, fail, confirmDialog, badge, date, link, pageHead, opt, userOptions, listView, canWrite, isManager, title } from '../lib.js';
import { openTaskForm, openCertificateForm } from './forms.js';

export async function tasksView() {
  const me = window.__user.id;
  const list = listView({
    endpoint: '/api/tasks', searchPlaceholder: 'Search tasks…', sort: { key: 'due', dir: 'asc' }, dflt: { assigned_to: String(me), status: 'open' }, pageSize: 50, csv: false,
    filters: [
      { key: 'assigned_to', label: 'Everyone', options: () => userOptions() }, { key: 'status', label: 'Open & done', options: opt(['open', 'done']) },
      { key: 'priority', label: 'All priorities', options: opt(meta.value.enums.taskPriority) }, { key: 'overdue', label: 'All dates', options: [['1', 'Overdue only']] },
    ],
    columns: [
      { label: '', render: (t) => h('input', { type: 'checkbox', checked: t.status === 'done', 'aria-label': 'Mark done', onchange: async (e) => { await put(`/api/tasks/${t.id}`, { status: e.target.checked ? 'done' : 'open' }).catch(fail); list.reload(); } }) },
      { label: 'Task', sort: 'title', render: (t) => h('span', { style: { textDecoration: t.status === 'done' ? 'line-through' : 'none' } }, t.title, t.description ? h('div', { class: 'muted small' }, t.description.slice(0, 120)) : null) },
      { label: 'Related', render: (t) => h('span', null, t.client_name ? link('#/clients/' + t.client_id, t.client_name) : '—', t.policy_id ? h('div', { class: 'small' }, link('#/policies/' + t.policy_id, t.policy_number)) : null) },
      { label: 'Due', sort: 'due', render: (t) => h('span', { class: t.overdue ? 'neg' : '' }, date(t.due_date), t.overdue ? ' · overdue' : '') },
      { label: 'Priority', sort: 'priority', render: (t) => badge(t.priority) }, { label: 'Assigned', sort: 'assigned', key: 'assigned_name' },
      { label: '', render: (t) => h('span', { class: 'btn-row' }, h('button', { class: 'btn btn-sm btn-ghost', onclick: () => openTaskForm({ task: t, onSaved: () => list.reload() }) }, 'Edit'),
        h('button', { class: 'btn btn-sm btn-ghost btn-danger', onclick: async () => { if (await confirmDialog('Delete this task?', { danger: true, confirmLabel: 'Delete' })) { await del(`/api/tasks/${t.id}`).catch(fail); list.reload(); } } }, 'Delete')) },
    ],
    empty: 'No tasks here — nice work.',
  });
  return h('div', { dataset: { title: 'Tasks' } }, pageHead('Tasks', {
    sub: 'Follow-ups, renewals reviews and to-dos',
    actions: canWrite() ? [h('button', { class: 'btn btn-primary', onclick: () => openTaskForm({ onSaved: () => list.reload() }) }, '+ New task')] : null,
  }), list);
}

export async function certificatesView() {
  let list;
  list = listView({
    endpoint: '/api/certificates', searchPlaceholder: 'Search certificate #, holder, client…', sort: { key: 'issued', dir: 'desc' }, csv: false,
    columns: [
      { label: 'Number', sort: 'number', render: (c) => h('a', { href: `/api/certificates/${c.id}/html`, target: '_blank', rel: 'noopener' }, c.number) },
      { label: 'Client', sort: 'client', render: (c) => link('#/clients/' + c.client_id, c.client_name) }, { label: 'Holder', sort: 'holder', key: 'holder_name' },
      { label: 'Policies', key: 'policy_numbers' }, { label: 'Issued', sort: 'issued', render: (c) => date(c.issued_date) },
      { label: '', render: (c) => (isManager() ? h('button', { class: 'btn btn-sm btn-ghost btn-danger', onclick: async () => { if (await confirmDialog(`Delete certificate ${c.number}?`, { danger: true, confirmLabel: 'Delete' })) { await del(`/api/certificates/${c.id}`).catch(fail); list.reload(); } } }, 'Delete') : null) },
    ],
    empty: 'No certificates issued yet.',
  });
  return h('div', { dataset: { title: 'Certificates' } }, pageHead('Certificates of insurance', {
    sub: 'Issue, preview and print certificates for in-force policies',
    actions: canWrite() ? [h('button', { class: 'btn btn-primary', onclick: () => openCertificateForm({ onSaved: () => list.reload() }) }, '+ Issue certificate')] : null,
  }), list);
}
