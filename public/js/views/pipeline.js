import { h, clear, get, post, put, del, meta, toast, fail, confirmDialog, formModal, modal, table, badge, date, money, money0, link, pageHead, opt, userOptions, carrierOptions, lineOptions, lineName, canWrite, isManager, title, todayStr } from '../lib.js';
import { notesPanel, tasksPanel } from './forms.js';

const STAGES = ['new', 'contacted', 'quoting', 'proposal', 'won', 'lost'];

function oppFields() {
  return [
    { name: 'name', label: 'Opportunity name', required: true, full: true, placeholder: 'Garcia — Auto & Home' },
    { name: 'client_id', label: 'Existing client (optional)', type: 'client', full: true },
    { name: 'contact_email', label: 'Contact email', type: 'email' }, { name: 'contact_phone', label: 'Contact phone', type: 'tel' },
    { name: 'line', label: 'Line of business', type: 'select', options: lineOptions, blank: true }, { name: 'est_premium', label: 'Estimated premium', type: 'money' },
    { name: 'stage', label: 'Stage', type: 'select', options: opt(STAGES), required: true }, { name: 'expected_close', label: 'Expected close', type: 'date' },
    { name: 'source', label: 'Source', placeholder: 'Referral, Web, Walk-in…' }, { name: 'producer_id', label: 'Producer', type: 'select', options: () => userOptions(['admin', 'manager', 'producer']), blank: true },
    { name: 'lost_reason', label: 'Lost reason', full: true }, { name: 'notes', label: 'Notes', type: 'textarea' },
  ];
}

export function openOppForm(opp, onSaved) {
  return formModal({
    title: opp ? 'Edit opportunity' : 'New opportunity', wide: true, fields: oppFields(),
    values: opp || { stage: 'new', producer_id: window.__user.role === 'producer' ? window.__user.id : '' },
    onSubmit: async (v) => { const r = opp ? await put(`/api/opportunities/${opp.id}`, v) : await post('/api/opportunities', v); toast('Saved'); onSaved?.(r); },
  });
}

function convertDialog(opp, quotes, onDone) {
  const accepted = quotes.find((q) => q.status === 'accepted') || [...quotes].sort((a, b) => a.premium - b.premium)[0];
  const fields = [
    !opp.client_id ? { type: 'heading', label: 'New client' } : null,
    !opp.client_id ? { name: 'nc_type', label: 'Client type', type: 'select', options: [['person', 'Individual'], ['business', 'Business']], required: true } : null,
    !opp.client_id ? { name: 'nc_first', label: 'First name' } : null, !opp.client_id ? { name: 'nc_last', label: 'Last name' } : null,
    !opp.client_id ? { name: 'nc_business', label: 'Business name', full: true } : null,
    { type: 'heading', label: 'Policy' },
    { name: 'carrier_id', label: 'Carrier', type: 'select', options: carrierOptions, required: true }, { name: 'policy_number', label: 'Policy number', required: true },
    { name: 'line', label: 'Line', type: 'select', options: lineOptions, required: true }, { name: 'premium', label: 'Premium', type: 'money', required: true },
    { name: 'effective_date', label: 'Effective date', type: 'date', required: true }, { name: 'expiration_date', label: 'Expiration', type: 'date', help: 'Blank = 12 months' },
    { name: 'billing_method', label: 'Billing', type: 'select', blank: true, blankLabel: 'Carrier default', options: [['direct_bill', 'Direct bill'], ['agency_bill', 'Agency bill']] },
    { name: 'payment_plan', label: 'Payment plan', type: 'select', options: opt(meta.value.enums.paymentPlans), required: true },
  ].filter(Boolean);
  return formModal({
    title: `Convert “${opp.name}” to a policy`, wide: true, fields, submitLabel: 'Bind policy',
    values: { nc_type: 'person', carrier_id: accepted?.carrier_id, premium: accepted?.premium || opp.est_premium, line: opp.line, effective_date: opp.expected_close || todayStr(), payment_plan: 'full', nc_business: opp.name },
    onSubmit: async (v) => {
      const body = { carrier_id: v.carrier_id, policy_number: v.policy_number, line: v.line, premium: v.premium, effective_date: v.effective_date, expiration_date: v.expiration_date, billing_method: v.billing_method || undefined, payment_plan: v.payment_plan, quote_id: accepted?.id };
      if (!opp.client_id) body.new_client = v.nc_type === 'business' ? { type: 'business', business_name: v.nc_business } : { type: 'person', first_name: v.nc_first, last_name: v.nc_last };
      const r = await post(`/api/opportunities/${opp.id}/convert`, body);
      toast('Won! Policy bound.'); onDone?.(r);
    },
  });
}

async function openOpp(id, onChange) {
  const opp = await get(`/api/opportunities/${id}`);
  const body = h('div');
  let m;
  let quotes = []; // always the latest list, so the Convert button never uses stale quotes
  async function draw() {
    const q = await get('/api/quotes', { opportunity_id: id, limit: 50 });
    quotes = q.rows;
    const quoteForm = (x) => formModal({
      title: x ? 'Edit quote' : 'Add carrier quote', values: x || { status: 'pending', line: opp.line },
      fields: [{ name: 'carrier_id', label: 'Carrier', type: 'select', options: carrierOptions, required: true }, { name: 'premium', label: 'Premium', type: 'money', required: true },
        { name: 'status', label: 'Status', type: 'select', options: opt(meta.value.enums.quoteStatus), required: true }, { name: 'quote_ref', label: 'Quote reference' }, { name: 'valid_until', label: 'Valid until', type: 'date' }, { name: 'notes', label: 'Notes', type: 'textarea' }],
      onSubmit: async (v) => { x ? await put(`/api/quotes/${x.id}`, v) : await post('/api/quotes', { ...v, opportunity_id: id }); draw(); onChange?.(); },
    });
    clear(body).append(
      h('div', { class: 'btn-row', style: { marginBottom: '12px' } }, badge(opp.stage), h('span', { class: 'muted' }, `${opp.client_name || opp.contact_email || 'No client yet'} · ${lineName(opp.line)} · est. ${money0(opp.est_premium)} · close ${date(opp.expected_close)}`)),
      opp.converted_policy_id ? h('div', { class: 'warn', style: { marginBottom: '12px', background: 'var(--green-soft)', color: 'var(--green)' } }, 'Won — ', link('#/policies/' + opp.converted_policy_id, 'view policy')) : null,
      h('div', { class: 'card', style: { marginBottom: '14px' } }, h('div', { class: 'card-h' }, h('h2', null, 'Carrier quotes'), canWrite() ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => quoteForm() }, '+ Add quote') : null),
        h('div', { class: 'card-b flush' }, table([
          { label: 'Carrier', key: 'carrier_name' }, { label: 'Premium', num: true, render: (x) => money(x.premium) }, { label: 'Status', render: (x) => badge(x.status) }, { label: 'Valid until', render: (x) => date(x.valid_until) },
          { label: '', render: (x) => canWrite() ? h('span', { class: 'btn-row' }, h('button', { class: 'btn btn-sm btn-ghost', onclick: () => quoteForm(x) }, 'Edit'),
            h('button', { class: 'btn btn-sm btn-ghost btn-danger', onclick: async () => { await del(`/api/quotes/${x.id}`).catch(fail); draw(); onChange?.(); } }, 'Remove')) : null },
        ], q.rows, { empty: 'No quotes yet — add carrier quotes to compare.' }))),
      notesPanel('opportunity_id', id), h('div', { style: { height: '14px' } }), tasksPanel('opportunity_id', id, opp.client_id ? { client_id: opp.client_id } : {}));
    return q;
  }
  await draw();
  m = modal({
    title: opp.name, wide: true, body,
    actions: canWrite() ? [
      isManager() ? h('button', { class: 'btn btn-danger', onclick: async () => { if (await confirmDialog('Delete this opportunity?', { danger: true, confirmLabel: 'Delete' })) { await del(`/api/opportunities/${id}`).catch(fail); m.close(); onChange?.(); } } }, 'Delete') : null,
      h('button', { class: 'btn', onclick: () => { m.close(); openOppForm(opp, () => { onChange?.(); openOpp(id, onChange); }); } }, 'Edit'),
      !opp.converted_policy_id ? h('button', { class: 'btn btn-primary', onclick: () => { m.close(); convertDialog(opp, quotes, (r) => { onChange?.(); location.hash = '#/policies/' + r.policy_id; }); } }, 'Convert to policy ✓') : null,
    ] : [],
  });
}

export async function pipeline(query = {}) {
  const board = h('div', { class: 'kanban' });
  const kpis = h('div', { class: 'kpis' });
  const state = { producer: '' };
  async function load() {
    const r = await get('/api/opportunities', { limit: 500, producer_id: state.producer, sort: 'close', dir: 'asc' });
    const open = r.rows.filter((o) => !['won', 'lost'].includes(o.stage));
    clear(kpis).append(
      h('div', { class: 'card kpi' }, h('div', { class: 'l' }, 'Open pipeline'), h('div', { class: 'v' }, money0(open.reduce((s, o) => s + o.est_premium, 0))), h('div', { class: 's' }, `${open.length} opportunities`)),
      h('div', { class: 'card kpi' }, h('div', { class: 'l' }, 'Won'), h('div', { class: 'v pos' }, money0(r.rows.filter((o) => o.stage === 'won').reduce((s, o) => s + o.est_premium, 0)))),
      h('div', { class: 'card kpi' }, h('div', { class: 'l' }, 'Lost'), h('div', { class: 'v' }, String(r.rows.filter((o) => o.stage === 'lost').length))));
    clear(board);
    for (const stage of STAGES) {
      const items = r.rows.filter((o) => o.stage === stage);
      const lane = h('div', { class: 'lane', dataset: { stage } },
        h('h3', null, title(stage), h('span', { class: 'tot' }, `${items.length} · ${money0(items.reduce((s, o) => s + o.est_premium, 0))}`)),
        h('div', { class: 'cards' }, items.map((o) => h('div', { class: 'opp', draggable: canWrite(), tabindex: 0, dataset: { id: o.id }, role: 'button',
          onclick: () => openOpp(o.id, load), onkeydown: (e) => { if (e.key === 'Enter') openOpp(o.id, load); },
          ondragstart: (e) => { e.dataTransfer.setData('text/plain', String(o.id)); e.dataTransfer.effectAllowed = 'move'; } },
        h('div', { class: 'n' }, o.name), h('div', { class: 'm' }, `${money0(o.est_premium)} · ${lineName(o.line)}`),
        h('div', { class: 'm' }, [o.producer_name, o.expected_close ? 'close ' + date(o.expected_close) : null].filter(Boolean).join(' · ') || ' ')))));
      lane.addEventListener('dragover', (e) => { e.preventDefault(); lane.classList.add('over'); });
      lane.addEventListener('dragleave', () => lane.classList.remove('over'));
      lane.addEventListener('drop', async (e) => {
        e.preventDefault(); lane.classList.remove('over');
        const id = Number(e.dataTransfer.getData('text/plain'));
        const opp = r.rows.find((o) => o.id === id);
        if (!opp || opp.stage === stage || !canWrite()) return;
        if (stage === 'won') { toast('Use “Convert to policy” to mark an opportunity won.', 'err'); return openOpp(id, load); }
        const patch = { stage };
        if (stage === 'lost') { patch.lost_reason = prompt('Why was this opportunity lost?'); if (!patch.lost_reason) return; }
        try { await put(`/api/opportunities/${id}`, patch); load(); } catch (er) { fail(er); }
      });
      board.append(lane);
    }
  }
  const root = h('div', { dataset: { title: 'Pipeline' } }, pageHead('Sales pipeline', {
    sub: 'Drag cards between stages. Click a card for quotes, notes and conversion.',
    actions: [h('select', { 'aria-label': 'Producer', onchange: (e) => { state.producer = e.target.value; load(); } }, h('option', { value: '' }, 'All producers'), userOptions(['admin', 'manager', 'producer']).map(([v, l]) => h('option', { value: v }, l))),
      canWrite() ? h('button', { class: 'btn btn-primary', onclick: () => openOppForm(null, load) }, '+ New opportunity') : null],
  }), kpis, board);
  await load();
  if (query.opp) setTimeout(() => openOpp(query.opp, load).catch(fail), 0);
  return root;
}
