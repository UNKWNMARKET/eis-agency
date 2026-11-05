import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setup, seedBasics, isoDate, PASSWORD } from './helpers.js';
import { addMonths } from '../src/validate.js';

let t;
before(async () => { t = await setup(); });
after(async () => { await t.close(); });

describe('auth & security', () => {
  test('API requires authentication', async () => {
    const anon = t.client();
    assert.equal((await anon.get('/api/clients')).status, 401);
    assert.equal((await anon.get('/api/auth/me')).data.user, null);
  });

  test('bad password is rejected and good password sets an HttpOnly cookie', async () => {
    const c = t.client();
    assert.equal((await c.login('admin@test.local', 'wrong-password')).status, 401);
    const ok = await c.login('admin@test.local', PASSWORD);
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.equal((await c.get('/api/auth/me')).data.user.role, 'admin');
  });

  test('mutations without X-Requested-With are rejected (CSRF)', async () => {
    const res = await fetch(t.base + '/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 403);
  });

  test('login is throttled after repeated failures', async () => {
    const c = t.client();
    let last;
    for (let i = 0; i < 10; i++) last = await c.login('nobody@test.local', 'x'.repeat(12));
    assert.equal(last.status, 429);
  });

  test('logout invalidates the session', async () => {
    const c = t.client();
    await c.login('admin@test.local', PASSWORD);
    await c.post('/api/auth/logout');
    assert.equal((await c.get('/api/clients')).status, 401);
  });

  test('static files cannot escape the public directory', async () => {
    const res = await fetch(t.base + '/..%2f..%2fpackage.json');
    assert.notEqual(res.status, 200);
  });

  test('role gates: csr cannot create carriers or read commissions; accounting can', async () => {
    const csr = await t.as('csr');
    assert.equal((await csr.post('/api/carriers', { name: 'Nope' })).status, 403);
    assert.equal((await csr.get('/api/commissions')).status, 403);
    const acct = await t.as('accounting');
    assert.equal((await acct.get('/api/commissions')).status, 200);
    assert.equal((await acct.post('/api/clients', { type: 'person', last_name: 'X' })).status, 403);
  });

  test('SQL metacharacters in search and sort are inert', async () => {
    const res = await t.admin.get("/api/clients?q=%27%3B%20DROP%20TABLE%20clients%3B--&sort=name%3Bdrop");
    assert.equal(res.status, 200);
    assert.equal((await t.admin.get('/api/clients')).status, 200);
  });
});

describe('clients', () => {
  test('creates person and business clients with validation', async () => {
    const bad = await t.admin.post('/api/clients', { type: 'person', first_name: 'NoLast' });
    assert.equal(bad.status, 400);
    const bad2 = await t.admin.post('/api/clients', { type: 'business' });
    assert.equal(bad2.status, 400);
    const badEmail = await t.admin.post('/api/clients', { type: 'person', last_name: 'A', email: 'not-an-email' });
    assert.equal(badEmail.status, 400);
    const p = await t.admin.post('/api/clients', { type: 'person', first_name: 'Ann', last_name: 'Smith', state: 'tx' });
    assert.equal(p.status, 201);
    assert.equal(p.data.display_name, 'Smith, Ann');
    assert.equal(p.data.state, 'TX');
    const b = await t.admin.post('/api/clients', { type: 'business', business_name: 'Acme Plumbing LLC', industry: 'Plumbing' });
    assert.equal(b.data.display_name, 'Acme Plumbing LLC');
  });

  test('search, filter, sort, paginate and export CSV', async () => {
    const found = await t.admin.get('/api/clients?q=acme');
    assert.ok(found.data.rows.some((c) => c.business_name === 'Acme Plumbing LLC'));
    const page = await t.admin.get('/api/clients?limit=1&offset=0');
    assert.equal(page.data.rows.length, 1);
    assert.ok(page.data.total >= 2);
    const csv = await t.admin.get('/api/clients?format=csv');
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-disposition'), /clients\.csv/);
    assert.match(csv.data, /Acme Plumbing LLC/);
  });

  test('CSV export neutralises formula injection', async () => {
    await t.admin.post('/api/clients', { type: 'business', business_name: '=HYPERLINK("http://evil")' });
    const csv = await t.admin.get('/api/clients?format=csv&q=HYPERLINK');
    assert.match(csv.data, /"'=HYPERLINK/);
  });

  test('CSV import validates rows and supports dry run', async () => {
    const csv = 'first_name,last_name,email,state\nBob,Import,bob@example.com,ca\n,,missing@example.com,\nBad,Email,nope,ca\n';
    const dry = await t.admin.post('/api/import/clients', { csv, dry_run: true });
    assert.equal(dry.data.valid, 1);
    assert.equal(dry.data.error_count, 2);
    assert.equal(dry.data.created, 0);
    const real = await t.admin.post('/api/import/clients', { csv });
    assert.equal(real.data.created, 1);
    const q = await t.admin.get('/api/clients?q=Import');
    assert.equal(q.data.rows[0].state, 'CA');
  });

  test('unknown id gives 404, malformed id gives 400', async () => {
    assert.equal((await t.admin.get('/api/clients/999999')).status, 404);
    assert.equal((await t.admin.get('/api/clients/abc')).status, 400);
  });
});

describe('policy lifecycle', () => {
  let carrier, client;
  before(async () => { ({ carrier, client } = await seedBasics(t)); });

  const newPolicy = async (over = {}) => t.admin.post('/api/policies', {
    client_id: client.id, carrier_id: carrier.id, policy_number: 'P-' + Math.random().toString(36).slice(2, 8).toUpperCase(), line: 'homeowners',
    effective_date: isoDate(-100), expiration_date: isoDate(265), premium: 1200, billing_method: 'direct_bill', ...over,
  });

  test('binding creates transaction, expected commission and activity', async () => {
    const res = await newPolicy();
    assert.equal(res.status, 201);
    const full = (await t.admin.get(`/api/policies/${res.data.id}/full`)).data;
    assert.equal(full.transactions.length, 1);
    assert.equal(full.transactions[0].type, 'new');
    assert.equal(full.commissions.length, 1);
    assert.equal(full.commissions[0].expected_amount, 144); // 1200 * 12%
    assert.equal(full.commissions[0].status, 'expected');
    assert.equal(full.invoices.length, 0); // direct bill
  });

  test('rejects bad term, duplicate policy and unknown carrier', async () => {
    assert.equal((await newPolicy({ expiration_date: isoDate(-200) })).status, 400);
    const a = await newPolicy({ policy_number: 'DUP-1' });
    assert.equal(a.status, 201);
    assert.equal((await newPolicy({ policy_number: 'DUP-1' })).status, 409);
    assert.equal((await newPolicy({ carrier_id: 99999 })).status, 400);
  });

  test('agency-billed policy on a quarterly plan generates 4 invoices that sum exactly to the total', async () => {
    const p = await newPolicy({ billing_method: 'agency_bill', payment_plan: 'quarterly', premium: 1000.01, fees: 25 });
    const inv = (await t.admin.get(`/api/invoices?policy_id=${p.data.id}`)).data.rows;
    assert.equal(inv.length, 4);
    const sum = Math.round(inv.reduce((s, i) => s + i.amount, 0) * 100) / 100;
    assert.equal(sum, 1025.01);
  });

  test('payments apply to invoices; overpayment is rejected; invoice becomes paid', async () => {
    const p = await newPolicy({ billing_method: 'agency_bill', payment_plan: 'full', premium: 500 });
    const inv = (await t.admin.get(`/api/invoices?policy_id=${p.data.id}`)).data.rows[0];
    assert.equal(inv.status, 'open');
    assert.equal((await t.admin.post(`/api/invoices/${inv.id}/payments`, { amount: 600 })).status, 400);
    const part = await t.admin.post(`/api/invoices/${inv.id}/payments`, { amount: 200, method: 'check', reference: '1001' });
    assert.equal(part.data.invoice.status, 'partial');
    const rest = await t.admin.post(`/api/invoices/${inv.id}/payments`, { amount: 300 });
    assert.equal(rest.data.invoice.status, 'paid');
    assert.equal((await t.admin.post(`/api/invoices/${inv.id}/payments`, { amount: 1 })).status, 400);
    const ledger = (await t.admin.get(`/api/clients/${client.id}/ledger`)).data;
    assert.ok(Array.isArray(ledger.entries));
  });

  test('endorsement changes premium, adds commission and billing', async () => {
    const p = await newPolicy({ billing_method: 'agency_bill', premium: 1000 });
    const e = await t.admin.post(`/api/policies/${p.data.id}/endorse`, { effective_date: isoDate(-10), premium_change: 150, description: 'Add scheduled jewelry' });
    assert.equal(e.status, 200);
    assert.equal(e.data.premium, 1150);
    const full = (await t.admin.get(`/api/policies/${p.data.id}/full`)).data;
    assert.ok(full.transactions.some((x) => x.type === 'endorsement' && x.premium_change === 150));
    assert.ok(full.commissions.some((x) => x.type === 'endorsement' && x.expected_amount === 18));
    assert.ok(full.invoices.some((x) => x.kind === 'endorsement' && x.amount === 150));
    // Outside the term / making premium negative are refused
    assert.equal((await t.admin.post(`/api/policies/${p.data.id}/endorse`, { effective_date: isoDate(-500), premium_change: 10, description: 'x' })).status, 400);
    assert.equal((await t.admin.post(`/api/policies/${p.data.id}/endorse`, { effective_date: isoDate(-10), premium_change: -99999, description: 'x' })).status, 400);
  });

  test('cancellation prorates return premium, charges back commission, then can be reinstated', async () => {
    const p = await newPolicy({ effective_date: isoDate(-100), expiration_date: isoDate(265), premium: 3650 });
    const c = await t.admin.post(`/api/policies/${p.data.id}/cancel`, { effective_date: isoDate(0), reason: 'Customer request' });
    assert.equal(c.status, 200);
    assert.equal(c.data.status, 'cancelled');
    assert.equal(c.data.return_premium, 2650); // 265 of 365 days unearned
    const full = (await t.admin.get(`/api/policies/${p.data.id}/full`)).data;
    assert.ok(full.commissions.some((x) => x.type === 'chargeback' && x.expected_amount < 0));
    assert.equal((await t.admin.post(`/api/policies/${p.data.id}/cancel`, { effective_date: isoDate(0), reason: 'again' })).status, 409);
    const r = await t.admin.post(`/api/policies/${p.data.id}/reinstate`, { notes: 'Paid in full' });
    assert.equal(r.data.status, 'active');
  });

  test('renewal links terms, copies coverages and marks the prior term renewed', async () => {
    const p = await newPolicy({ effective_date: isoDate(-300), expiration_date: isoDate(65), premium: 1000 });
    await t.admin.post('/api/coverages', { policy_id: p.data.id, coverage: 'Dwelling', limit_text: '$300,000', deductible: '$1,000' });
    const ren = await t.admin.post(`/api/policies/${p.data.id}/renew`, { premium: 1100 });
    assert.equal(ren.status, 201);
    assert.equal(ren.data.prior_policy_id, p.data.id);
    assert.equal(ren.data.effective_date, isoDate(65));
    const old = (await t.admin.get(`/api/policies/${p.data.id}`)).data;
    assert.equal(old.status, 'renewed');
    const cov = (await t.admin.get(`/api/coverages?policy_id=${ren.data.id}`)).data.rows;
    assert.equal(cov.length, 1);
    const full = (await t.admin.get(`/api/policies/${ren.data.id}/full`)).data;
    assert.equal(full.commissions[0].type, 'renewal');
    assert.equal(full.commissions[0].expected_amount, 110); // 10% renewal rate
    assert.equal((await t.admin.post(`/api/policies/${p.data.id}/renew`, { premium: 1 })).status, 409);
  });

  test('non-managers cannot directly edit premium or status', async () => {
    const p = await newPolicy();
    const producer = await t.as('producer');
    assert.equal((await producer.put(`/api/policies/${p.data.id}`, { premium: 1 })).status, 403);
    assert.equal((await producer.put(`/api/policies/${p.data.id}`, { notes: 'fine' })).status, 200);
    assert.equal((await t.admin.put(`/api/policies/${p.data.id}`, { premium: 1250 })).status, 200);
  });

  test('policies with claims cannot be deleted; others can by managers only', async () => {
    const p = await newPolicy();
    const cl = await t.admin.post('/api/claims', { policy_id: p.data.id, loss_date: isoDate(-5), loss_type: 'Water damage', amount_claimed: 5000 });
    assert.equal(cl.status, 201);
    assert.equal((await t.admin.del(`/api/policies/${p.data.id}`)).status, 409);
    const q = await newPolicy();
    const csr = await t.as('csr');
    assert.equal((await csr.del(`/api/policies/${q.data.id}`)).status, 403);
    assert.equal((await t.admin.del(`/api/policies/${q.data.id}`)).status, 200);
  });
});

describe('claims', () => {
  test('loss date must fall in the policy term; closing sets closed date; status changes log activity', async () => {
    const { carrier, client } = await seedBasics(t);
    const p = (await t.admin.post('/api/policies', { client_id: client.id, carrier_id: carrier.id, policy_number: 'CL-1', line: 'personal_auto', effective_date: isoDate(-100), expiration_date: isoDate(265), premium: 900 })).data;
    assert.equal((await t.admin.post('/api/claims', { policy_id: p.id, loss_date: isoDate(-400) })).status, 400);
    const cl = (await t.admin.post('/api/claims', { policy_id: p.id, loss_date: isoDate(-10), loss_type: 'Collision' })).data;
    assert.equal(cl.client_id, client.id);
    const closed = (await t.admin.put(`/api/claims/${cl.id}`, { status: 'closed', amount_paid: 2300 })).data;
    assert.equal(closed.closed_date, isoDate(0));
    const acts = (await t.admin.get(`/api/activities?claim_id=${cl.id}`)).data.rows;
    assert.ok(acts.some((a) => /open → closed/.test(a.subject)));
    assert.equal((await t.admin.put(`/api/claims/${cl.id}`, { policy_id: 999 })).status, 400);
  });
});

describe('sales pipeline', () => {
  test('opportunity -> quotes -> convert creates client, policy, commission', async () => {
    const { carrier } = await seedBasics(t);
    const opp = (await t.admin.post('/api/opportunities', { name: 'Garcia Auto/Home', line: 'personal_auto', est_premium: 2400, source: 'Referral', contact_email: 'g@example.com' })).data;
    await t.admin.post('/api/quotes', { opportunity_id: opp.id, carrier_id: carrier.id, premium: 2300 });
    const q = (await t.admin.get(`/api/quotes?opportunity_id=${opp.id}`)).data.rows;
    assert.equal(q.length, 1);
    assert.equal((await t.admin.put(`/api/opportunities/${opp.id}`, { stage: 'lost' })).status, 400); // needs reason
    const noClient = await t.admin.post(`/api/opportunities/${opp.id}/convert`, {
      carrier_id: carrier.id, policy_number: 'GAR-1', effective_date: isoDate(5), premium: 2300, quote_id: q[0].id,
    });
    assert.equal(noClient.status, 400);
    const res = await t.admin.post(`/api/opportunities/${opp.id}/convert`, {
      carrier_id: carrier.id, policy_number: 'GAR-1', effective_date: isoDate(5), premium: 2300, quote_id: q[0].id,
      new_client: { type: 'person', first_name: 'Maria', last_name: 'Garcia' },
    });
    assert.equal(res.status, 201);
    const after = (await t.admin.get(`/api/opportunities/${opp.id}`)).data;
    assert.equal(after.stage, 'won');
    assert.equal(after.converted_policy_id, res.data.policy_id);
    const pol = (await t.admin.get(`/api/policies/${res.data.policy_id}/full`)).data;
    assert.equal(pol.policy.expiration_date, addMonths(isoDate(5), 12)); // default 12-month term
    assert.equal(pol.commissions.length, 1);
    assert.equal((await t.admin.post(`/api/opportunities/${opp.id}/convert`, { carrier_id: carrier.id, policy_number: 'GAR-2', effective_date: isoDate(5), premium: 1 })).status, 409);
  });
});

describe('commissions', () => {
  test('statement reconciliation previews, applies, and reports unmatched rows', async () => {
    const { carrier, client } = await seedBasics(t);
    const pn = 'COM-' + Math.random().toString(36).slice(2, 7);
    await t.admin.post('/api/policies', { client_id: client.id, carrier_id: carrier.id, policy_number: pn, line: 'homeowners', effective_date: isoDate(-10), expiration_date: isoDate(355), premium: 2000 });
    const body = { carrier_id: carrier.id, statement_ref: 'STMT-1', rows: [{ policy_number: pn, amount: 230 }, { policy_number: 'NOPE', amount: 10 }] };
    const dry = (await t.admin.post('/api/commissions/statement', { ...body, dry_run: true })).data;
    assert.equal(dry.matched.length, 1);
    assert.equal(dry.matched[0].expected, 240);
    assert.equal(dry.matched[0].variance, -10);
    assert.equal(dry.unmatched.length, 1);
    assert.equal((await t.admin.get(`/api/commissions?q=${pn}`)).data.rows[0].status, 'expected');
    await t.admin.post('/api/commissions/statement', body);
    const line = (await t.admin.get(`/api/commissions?q=${pn}`)).data.rows[0];
    assert.equal(line.status, 'received');
    assert.equal(line.received_amount, 230);
    assert.equal(line.variance, -10);
  });

  test('producer splits drive payout totals', async () => {
    const { carrier, client } = await seedBasics(t);
    const producerId = t.addUser('splitter@test.local', 'producer', { split_new_pct: 50, split_renew_pct: 25 });
    const pol = (await t.admin.post('/api/policies', { client_id: client.id, carrier_id: carrier.id, policy_number: 'SPL-1', line: 'homeowners', effective_date: isoDate(-1), expiration_date: isoDate(364), premium: 1000, producer_id: producerId })).data;
    const cm = (await t.admin.get(`/api/commissions?policy_id=${pol.id}`)).data.rows[0];
    assert.equal(cm.producer_split_pct, 50);
    await t.admin.post(`/api/commissions/${cm.id}/receive`, { received_amount: 120 });
    const payouts = (await t.admin.get('/api/commissions/payouts')).data.rows;
    const mine = payouts.find((p) => p.producer_id === producerId);
    assert.equal(mine.payout_due, 60);
    const paid = (await t.admin.post('/api/commissions/payouts/pay', { producer_id: producerId })).data;
    assert.equal(paid.paid_lines, 1);
    assert.equal((await t.admin.get('/api/commissions/payouts')).data.rows.some((p) => p.producer_id === producerId), false);
  });
});

describe('tasks, notes, documents, certificates, reports', () => {
  test('task completion stamps completed_at; renewal task generation is idempotent', async () => {
    const { carrier, client } = await seedBasics(t);
    await t.admin.post('/api/policies', { client_id: client.id, carrier_id: carrier.id, policy_number: 'RT-1', line: 'homeowners', effective_date: isoDate(-335), expiration_date: isoDate(30), premium: 900 });
    const first = (await t.admin.post('/api/renewals/generate-tasks', { days: 60 })).data;
    assert.ok(first.created >= 1);
    assert.equal((await t.admin.post('/api/renewals/generate-tasks', { days: 60 })).data.created, 0);
    const task = (await t.admin.post('/api/tasks', { title: 'Call client', client_id: client.id })).data;
    const done = (await t.admin.put(`/api/tasks/${task.id}`, { status: 'done' })).data;
    assert.ok(done.completed_at);
  });

  test('notes must attach to a record and only authors/managers may edit', async () => {
    const { client } = await seedBasics(t);
    assert.equal((await t.admin.post('/api/activities', { kind: 'note', body: 'orphan' })).status, 400);
    const csrA = await t.as('csr');
    const csrB = await t.as('csr');
    const note = (await csrA.post('/api/activities', { kind: 'call', subject: 'Called', body: 'Left voicemail', client_id: client.id })).data;
    assert.equal((await csrB.put(`/api/activities/${note.id}`, { body: 'hijack' })).status, 403);
    assert.equal((await csrA.put(`/api/activities/${note.id}`, { body: 'edited' })).status, 200);
    assert.equal((await csrA.post('/api/activities', { kind: 'system', body: 'x', client_id: client.id })).status, 400);
  });

  test('document upload/download round-trips; bad extensions and oversize files are refused', async () => {
    const { client } = await seedBasics(t);
    const data = Buffer.from('%PDF-1.4 test').toString('base64');
    const up = await t.admin.post('/api/documents', { name: 'dec page.pdf', category: 'dec_page', client_id: client.id, data });
    assert.equal(up.status, 201);
    const dl = await t.admin.raw('GET', `/api/documents/${up.data.id}/download`);
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get('content-disposition'), /attachment/);
    assert.match(dl.data, /%PDF/);
    assert.equal((await t.admin.post('/api/documents', { name: 'evil.html', client_id: client.id, data })).status, 400);
    assert.equal((await t.admin.post('/api/documents', { name: '../../etc/passwd.pdf', client_id: client.id, data })).status, 201); // path chars neutralised
    const big = Buffer.alloc(11 * 1024 * 1024, 1).toString('base64');
    assert.equal((await t.admin.post('/api/documents', { name: 'big.pdf', client_id: client.id, data: big })).status, 413);
    assert.equal((await t.admin.del(`/api/documents/${up.data.id}`)).status, 200);
  });

  test('certificate requires in-force policies of the same client and renders escaped HTML', async () => {
    const { carrier, client } = await seedBasics(t);
    const other = (await t.admin.post('/api/clients', { type: 'person', last_name: 'Other' })).data;
    const p = (await t.admin.post('/api/policies', { client_id: client.id, carrier_id: carrier.id, policy_number: 'COI-P1', line: 'general_liability', effective_date: isoDate(-30), expiration_date: isoDate(335), premium: 800 })).data;
    const op = (await t.admin.post('/api/policies', { client_id: other.id, carrier_id: carrier.id, policy_number: 'COI-P2', line: 'general_liability', effective_date: isoDate(-30), expiration_date: isoDate(335), premium: 800 })).data;
    assert.equal((await t.admin.post('/api/certificates', { client_id: client.id, holder_name: 'X', policy_ids: [op.id] })).status, 400);
    assert.equal((await t.admin.post('/api/certificates', { client_id: client.id, holder_name: 'X', policy_ids: [] })).status, 400);
    const cert = await t.admin.post('/api/certificates', { client_id: client.id, holder_name: '<script>alert(1)</script> Holder', description: 'Job site <b>A</b>', policy_ids: [p.id], additional_insured: true });
    assert.equal(cert.status, 201);
    assert.match(cert.data.number, /^COI-\d{6}$/);
    const html = (await t.admin.raw('GET', `/api/certificates/${cert.data.id}/html`)).data;
    assert.ok(!html.includes('<script>alert(1)'));
    assert.match(html, /&lt;script&gt;/);
  });

  test('dashboard and every report run, and CSV export works', async () => {
    const dash = await t.admin.get('/api/dashboard');
    assert.equal(dash.status, 200);
    assert.ok(dash.data.kpi.active_policies >= 1);
    const list = (await t.admin.get('/api/reports')).data.reports;
    assert.ok(list.length >= 8);
    for (const rep of list) {
      const res = await t.admin.get(`/api/reports/${rep.key}`);
      assert.equal(res.status, 200, rep.key + ': ' + JSON.stringify(res.data));
      const csv = await t.admin.get(`/api/reports/${rep.key}?format=csv`);
      assert.equal(csv.status, 200, rep.key + ' csv');
    }
    assert.equal((await t.admin.get('/api/reports/production?from=bad')).status, 400);
    const csr = await t.as('csr');
    assert.equal((await csr.get('/api/reports/commissions')).status, 403);
  });

  test('global search finds clients and policies', async () => {
    const res = (await t.admin.get('/api/search?q=COI-P1')).data.results;
    assert.ok(res.some((x) => x.type === 'policy'));
    assert.deepEqual((await t.admin.get('/api/search?q=a')).data.results, []);
  });

  test('audit log records writes and is manager-only', async () => {
    const rows = (await t.admin.get('/api/audit?entity=policy&limit=5')).data.rows;
    assert.ok(rows.length > 0);
    const csr = await t.as('csr');
    assert.equal((await csr.get('/api/audit')).status, 403);
  });

  test('user admin: create, deactivate kills sessions, cannot demote self; password policy', async () => {
    assert.equal((await t.admin.post('/api/users', { email: 'short@test.local', name: 'S', role: 'csr', password: 'short' })).status, 400);
    const u = (await t.admin.post('/api/users', { email: 'newuser@test.local', name: 'New User', role: 'csr', password: 'a-long-enough-password' })).data;
    const c = t.client();
    assert.equal((await c.login('newuser@test.local', 'a-long-enough-password')).status, 200);
    await t.admin.put(`/api/users/${u.id}`, { active: false });
    assert.equal((await c.get('/api/clients')).status, 401);
    const me = (await t.admin.get('/api/auth/me')).data.user;
    assert.equal((await t.admin.put(`/api/users/${me.id}`, { role: 'csr' })).status, 400);
    assert.equal((await t.admin.get('/api/users')).data.rows.every((x) => !('password_hash' in x)), true);
  });

  test('backup returns a SQLite file (admin only)', async () => {
    const res = await fetch(t.base + '/api/admin/backup', { headers: { Cookie: (await (async () => { const c = t.client(); const r = await c.login('admin@test.local', PASSWORD); return r.headers.get('set-cookie').split(';')[0]; })()) } });
    assert.equal(res.status, 200);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.subarray(0, 15).toString(), 'SQLite format 3');
    const csr = await t.as('csr');
    assert.equal((await csr.get('/api/admin/backup')).status, 403);
  });
});

describe('regressions & edge cases', () => {
  test('static routes beat :id routes (payouts is not parsed as an id)', async () => {
    const res = await t.admin.get('/api/commissions/payouts');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data.rows));
  });

  test('expired policies get a 30-day grace period before being treated as lost', async () => {
    const { refreshStatuses } = await import('../src/domain.js');
    const { carrier, client } = await seedBasics(t);
    const mk = async (n, effDays, expDays) => (await t.admin.post('/api/policies', {
      client_id: client.id, carrier_id: carrier.id, policy_number: n, line: 'homeowners', effective_date: isoDate(effDays), expiration_date: isoDate(expDays), premium: 500,
    })).data.id;
    const recent = await mk('GRACE-1', -370, -5);
    const old = await mk('GRACE-2', -420, -55);
    refreshStatuses(t.db);
    const r = t.db.prepare('SELECT status, renewal_status FROM policies WHERE id = ?');
    assert.deepEqual({ ...r.get(recent) }, { status: 'expired', renewal_status: 'not_started' });
    assert.deepEqual({ ...r.get(old) }, { status: 'expired', renewal_status: 'lost' });
    // A late renewal of the recently-expired policy is still possible.
    const ren = await t.admin.post(`/api/policies/${recent}/renew`, { premium: 520 });
    assert.equal(ren.status, 201);
  });

  test('deleting a policy or client removes its uploaded files from disk', async () => {
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { UPLOAD_DIR } = await import('../src/routes/work.js');
    const { carrier, client } = await seedBasics(t);
    const pol = (await t.admin.post('/api/policies', { client_id: client.id, carrier_id: carrier.id, policy_number: 'FILE-1', line: 'homeowners', effective_date: isoDate(-5), expiration_date: isoDate(360), premium: 700 })).data;
    const data = Buffer.from('hello').toString('base64');
    const d1 = (await t.admin.post('/api/documents', { name: 'a.txt', policy_id: pol.id, data })).data;
    const d2 = (await t.admin.post('/api/documents', { name: 'b.txt', client_id: client.id, data })).data;
    const file = (id) => join(UPLOAD_DIR, t.db.prepare('SELECT storage_name FROM documents WHERE id = ?').get(id).storage_name);
    const f1 = file(d1.id), f2 = file(d2.id);
    assert.ok(existsSync(f1) && existsSync(f2));
    assert.equal((await t.admin.del(`/api/policies/${pol.id}`)).status, 200);
    assert.equal(existsSync(f1), false);
    assert.equal(existsSync(f2), true);
    assert.equal((await t.admin.del(`/api/clients/${client.id}`)).status, 200);
    assert.equal(existsSync(f2), false);
  });

  test('client ledger separates amount due now from total outstanding', async () => {
    const { carrier, client } = await seedBasics(t);
    await t.admin.post('/api/policies', { client_id: client.id, carrier_id: carrier.id, policy_number: 'LED-1', line: 'personal_auto', effective_date: isoDate(0), expiration_date: isoDate(365), premium: 1200, billing_method: 'agency_bill', payment_plan: 'quarterly' });
    const led = (await t.admin.get(`/api/clients/${client.id}/ledger`)).data;
    assert.equal(led.balance, 1200);
    assert.equal(led.due_now, 300); // only the first installment is due today
  });

  test('email templates merge fields and format dates for humans', async () => {
    const { carrier, client } = await seedBasics(t);
    const pol = (await t.admin.post('/api/policies', { client_id: client.id, carrier_id: carrier.id, policy_number: 'TPL-1', line: 'homeowners', effective_date: '2026-03-01', expiration_date: '2027-03-01', premium: 1234.5 })).data;
    const tpl = (await t.admin.get('/api/templates?q=Renewal notice')).data.rows[0];
    const out = (await t.admin.post(`/api/templates/${tpl.id}/render`, { client_id: client.id, policy_id: pol.id })).data;
    assert.match(out.subject, /March 1, 2027/);
    assert.match(out.body, /TPL-1/);
    assert.equal(out.to, 'jane@example.com');
    assert.ok(!/\{\{/.test(out.body));
  });

  test('payments cannot be applied to void invoices and deleting a payment restores the balance', async () => {
    const { carrier, client } = await seedBasics(t);
    const p = (await t.admin.post('/api/policies', { client_id: client.id, carrier_id: carrier.id, policy_number: 'PAY-1', line: 'homeowners', effective_date: isoDate(0), expiration_date: isoDate(365), premium: 400, billing_method: 'agency_bill' })).data;
    const inv = (await t.admin.get(`/api/invoices?policy_id=${p.id}`)).data.rows[0];
    const pay = (await t.admin.post(`/api/invoices/${inv.id}/payments`, { amount: 400 })).data;
    assert.equal(pay.invoice.status, 'paid');
    assert.equal((await t.admin.post(`/api/invoices/${inv.id}/void`)).status, 409); // has payments
    assert.equal((await t.admin.del(`/api/payments/${pay.payment_id}`)).status, 200);
    assert.equal((await t.admin.get(`/api/invoices/${inv.id}`)).data.status, 'open');
    assert.equal((await t.admin.post(`/api/invoices/${inv.id}/void`)).status, 200);
    assert.equal((await t.admin.post(`/api/invoices/${inv.id}/payments`, { amount: 10 })).status, 409);
  });

  test('cancelling an agency-billed policy voids unbilled installments and credits the rest', async () => {
    const { carrier, client } = await seedBasics(t);
    const p = (await t.admin.post('/api/policies', { client_id: client.id, carrier_id: carrier.id, policy_number: 'CXL-1', line: 'homeowners', effective_date: isoDate(0), expiration_date: isoDate(365), premium: 1200, billing_method: 'agency_bill', payment_plan: 'quarterly' })).data;
    const first = (await t.admin.get(`/api/invoices?policy_id=${p.id}&sort=due&dir=asc`)).data.rows[0];
    await t.admin.post(`/api/invoices/${first.id}/payments`, { amount: 300 });
    const c = (await t.admin.post(`/api/policies/${p.id}/cancel`, { effective_date: isoDate(0), reason: 'Insured request' })).data;
    assert.equal(c.return_premium, 1200); // flat cancel on the inception date
    const inv = (await t.admin.get(`/api/invoices?policy_id=${p.id}`)).data.rows;
    assert.equal(inv.filter((i) => i.status === 'void').length, 3);
    const credit = inv.find((i) => i.kind === 'credit');
    assert.equal(credit.amount, -300); // 1200 return − 900 of voided future installments = refund of the 300 paid
  });
});
