// Demo data generator:  npm run seed:demo   (add --force to seed into a non-empty database)
// Creates fictional carriers, staff, clients, policies, claims, invoices and commissions so every screen has data.
import { openDb, tx, round2 } from './db.js';
import { bootstrap } from './server.js';
import { hashPassword } from './auth.js';
import { onBound } from './routes/policies.js';
import { getPolicy, nextNumber } from './domain.js';
import { addDays, addMonths } from './validate.js';
import { TODAY } from './constants.js';

export const DEMO_PASSWORD = 'demo-password-123';

function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const FIRST = ['James', 'Maria', 'Robert', 'Linda', 'Michael', 'Patricia', 'David', 'Jennifer', 'Carlos', 'Aisha', 'Wei', 'Priya', 'Tomas', 'Hannah', 'Omar', 'Grace', 'Luis', 'Natalie', 'Kenji', 'Sofia', 'Marcus', 'Elena', 'Daniel', 'Olivia', 'Samuel', 'Rachel'];
const LAST = ['Johnson', 'Garcia', 'Nguyen', 'Patel', 'Williams', 'Brown', 'Kim', 'Davis', 'Martinez', 'Lopez', 'Anderson', 'Thomas', 'Moore', 'Jackson', 'Lee', 'Walker', 'Hall', 'Allen', 'Young', 'King', 'Wright', 'Scott', 'Green', 'Adams', 'Baker', 'Nelson'];
const BIZ = ['Lone Star Plumbing', 'Brightside Dental', 'Harvest Table Café', 'Ironwood Builders', 'Peak Fitness Studio', 'Bluebonnet Landscaping', 'Cobalt IT Consulting', 'Redline Auto Repair', 'Sweet Crumb Bakery', 'Northgate Realty', 'Summit Physical Therapy', 'Delta Freight Logistics', 'Evergreen Pet Care', 'Pixel & Ink Studio'];
const INDUSTRY = ['Plumbing', 'Dental', 'Restaurant', 'Construction', 'Fitness', 'Landscaping', 'IT services', 'Auto repair', 'Bakery', 'Real estate', 'Healthcare', 'Transportation', 'Pet services', 'Design'];
const CITIES = [['Austin', 'TX', '787'], ['Round Rock', 'TX', '786'], ['Cedar Park', 'TX', '786'], ['San Marcos', 'TX', '786'], ['Georgetown', 'TX', '786'], ['Pflugerville', 'TX', '786']];
const STREETS = ['Oak Ln', 'Maple Dr', 'Congress Ave', 'Riverside Blvd', 'Lakeline Pkwy', 'Cedar St', 'Elm Ct', 'Sunset Trl'];
const SOURCES = ['Referral', 'Website', 'Walk-in', 'Facebook', 'Existing client', 'Google', 'Center of influence'];

export function seedDemo(db, { log = console.log } = {}) {
  const r = rng(20260101);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const today = TODAY();
  const pass = hashPassword(DEMO_PASSWORD);

  return tx(db, () => {
    const user = (email, name, role, sn = 0, sr = 0) => Number(db.prepare('INSERT INTO users (email, name, role, password_hash, split_new_pct, split_renew_pct, license_no) VALUES (?,?,?,?,?,?,?)').run(email, name, role, pass, sn, sr, role === 'producer' ? 'TX-' + int(1000000, 9999999) : null).lastInsertRowid);
    const manager = user('manager@demo.local', 'Morgan Ellis', 'manager');
    const prod1 = user('alex@demo.local', 'Alex Rivera', 'producer', 50, 25);
    const prod2 = user('sam@demo.local', 'Sam Okafor', 'producer', 40, 20);
    const csr1 = user('casey@demo.local', 'Casey Tran', 'csr');
    const csr2 = user('jordan@demo.local', 'Jordan Blake', 'csr');
    user('pat@demo.local', 'Pat Morgan', 'accounting');
    const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get().id;
    const ctx = { db, user: { id: admin, name: 'Seed' } };
    const producers = [prod1, prod2, manager];
    const csrs = [csr1, csr2];

    const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    set.run('agency_name', 'Lone Oak Insurance Group'); set.run('agency_address', '100 Congress Ave, Suite 400, Austin, TX 78701');
    set.run('agency_phone', '(512) 555-0142'); set.run('agency_email', 'service@loneoak.example'); set.run('agency_license', 'TX-1234567');

    const carrierDefs = [
      ['Liberty Shield Insurance', '10001', 'A', 12, 10, 'direct_bill'], ['Summit Mutual', '10002', 'A+', 15, 12, 'direct_bill'], ['Keystone Casualty', '10003', 'A-', 14, 11, 'agency_bill'],
      ['Harbor Specialty Lines', '10004', 'A', 17, 15, 'agency_bill'], ['Pioneer Life & Annuity', '10005', 'A+', 40, 5, 'direct_bill'], ['Atlas Commercial Group', '10006', 'A', 13, 12, 'agency_bill'],
      ['Blue Ridge Mutual', '10007', 'B++', 11, 10, 'direct_bill'],
    ];
    const carriers = carrierDefs.map(([name, naic, best, n, rn, bill], i) => Number(db.prepare(
      'INSERT INTO carriers (name, naic, am_best, phone, claims_phone, website, agency_code, commission_new_pct, commission_renew_pct, default_billing) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(name, naic, best, `(800) 555-${1000 + i * 37}`, `(800) 555-${2000 + i * 41}`, `www.${name.toLowerCase().replace(/[^a-z]+/g, '')}.example`, `AG${int(10000, 99999)}`, n, rn, bill).lastInsertRowid));
    const carrierById = Object.fromEntries(carriers.map((id, i) => [id, carrierDefs[i]]));

    const personalLines = [['personal_auto', 900, 2600], ['homeowners', 1100, 3400], ['umbrella', 250, 600], ['renters', 140, 320], ['life', 600, 2400], ['condo', 450, 900]];
    const bizLines = [['bop', 1400, 6000], ['general_liability', 900, 4200], ['workers_comp', 2500, 14000], ['commercial_auto', 2200, 7500], ['cyber', 700, 2200], ['commercial_property', 1800, 8000], ['professional_liability', 1200, 4500]];

    const insertClient = (c) => {
      const cols = Object.keys(c);
      return Number(db.prepare(`INSERT INTO clients (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((k) => c[k])).lastInsertRowid);
    };
    const clients = [];
    for (let i = 0; i < 46; i++) {
      const city = pick(CITIES);
      const last = pick(LAST);
      const id = insertClient({
        type: 'person', first_name: pick(FIRST), last_name: last, email: `${last.toLowerCase()}${int(1, 99)}@example.com`, phone: `(512) 555-${int(1000, 9999)}`,
        dob: `${int(1950, 1998)}-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`,
        address1: `${int(100, 9999)} ${pick(STREETS)}`, city: city[0], state: city[1], zip: city[2] + int(10, 99), status: 'active', source: pick(SOURCES),
        producer_id: pick(producers), csr_id: pick(csrs), household: `${last} household`,
      });
      clients.push({ id, type: 'person' });
    }
    BIZ.forEach((name, i) => {
      const city = pick(CITIES);
      const id = insertClient({
        type: 'business', business_name: name + (i % 3 === 0 ? ' LLC' : i % 3 === 1 ? ', Inc.' : ''), industry: INDUSTRY[i], employees: int(2, 60), annual_revenue: int(2, 90) * 100000,
        email: `office@${name.toLowerCase().replace(/[^a-z]+/g, '')}.example`, phone: `(512) 555-${int(1000, 9999)}`, address1: `${int(100, 9999)} ${pick(STREETS)}`, city: city[0], state: city[1],
        zip: city[2] + int(10, 99), status: 'active', source: pick(SOURCES), producer_id: pick(producers), csr_id: pick(csrs),
      });
      clients.push({ id, type: 'business' });
    });
    for (let i = 0; i < 5; i++) {
      insertClient({ type: 'person', first_name: pick(FIRST), last_name: pick(LAST), email: `prospect${i}@example.com`, phone: `(512) 555-${int(1000, 9999)}`, status: 'prospect', source: pick(SOURCES), producer_id: pick(producers) });
    }
    // Household members for a few individuals
    for (const c of clients.filter((x) => x.type === 'person').slice(0, 10)) {
      db.prepare('INSERT INTO contacts (client_id, name, relationship, phone) VALUES (?,?,?,?)').run(c.id, `${pick(FIRST)} ${db.prepare('SELECT last_name FROM clients WHERE id = ?').get(c.id).last_name}`, pick(['Spouse', 'Child', 'Partner']), `(512) 555-${int(1000, 9999)}`);
    }

    const policies = [];
    let pn = 1000000;
    const createPolicy = (client, [line, lo, hi], eff, prior = null, forceStatus = null) => {
      const clientRow = db.prepare('SELECT * FROM clients WHERE id = ?').get(client.id);
      const carrierId = pick(client.type === 'business' ? carriers.filter((c) => ['agency_bill', 'direct_bill'].includes(carrierById[c][5])) : carriers.slice(0, 3).concat(carriers[4], carriers[6]));
      const def = carrierById[carrierId];
      const premium = round2(int(lo, hi) + r());
      const exp = addMonths(eff, 12);
      const billing = def[5];
      const status = forceStatus || (exp < today ? 'expired' : 'active');
      const prefix = { personal_auto: 'PA', homeowners: 'HO', umbrella: 'UM', renters: 'RN', life: 'LF', condo: 'CN', bop: 'BP', general_liability: 'GL', workers_comp: 'WC', commercial_auto: 'CA', cyber: 'CY', commercial_property: 'CP', professional_liability: 'PL' }[line];
      const id = Number(db.prepare(
        `INSERT INTO policies (client_id, carrier_id, policy_number, line, status, renewal_status, effective_date, expiration_date, premium, fees, billing_method, payment_plan, producer_id, csr_id, prior_policy_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(client.id, carrierId, `${prefix}-${pn++}`, line, 'active', 'not_started', eff, exp, premium, billing === 'agency_bill' ? 25 : 0, billing,
        billing === 'agency_bill' ? pick(['full', 'quarterly', 'monthly']) : 'full', clientRow.producer_id, clientRow.csr_id, prior).lastInsertRowid);
      const p = getPolicy(db, id);
      onBound(ctx, p, prior ? 'renewal' : 'new');
      if (status !== 'active') db.prepare('UPDATE policies SET status = ? WHERE id = ?').run(status, id);
      if (status === 'active') {
        const days = Math.round((new Date(exp) - new Date(today)) / 86400000);
        const rs = days <= 20 ? pick(['quoted', 'offered', 'in_review']) : days <= 60 ? pick(['in_review', 'not_started', 'remarketing']) : 'not_started';
        db.prepare('UPDATE policies SET renewal_status = ? WHERE id = ?').run(rs, id);
      }
      const covs = {
        personal_auto: [['Bodily injury liability', '100/300', null], ['Property damage', '$100,000', null], ['Collision', 'ACV', '$500'], ['Comprehensive', 'ACV', '$250']],
        homeowners: [['Dwelling', `$${int(18, 70) * 10000}`, '$1,000'], ['Personal property', '$150,000', '$1,000'], ['Liability', '$300,000', null], ['Medical payments', '$5,000', null]],
        umbrella: [['Personal umbrella liability', '$1,000,000', null]], renters: [['Personal property', '$40,000', '$500'], ['Liability', '$100,000', null]],
        life: [['Death benefit', `$${int(2, 10) * 100000}`, null]], condo: [['Dwelling', '$75,000', '$1,000'], ['Liability', '$300,000', null]],
        bop: [['Building', '$500,000', '$1,000'], ['Business personal property', '$150,000', '$1,000'], ['General liability', '$1,000,000 / $2,000,000', null]],
        general_liability: [['Each occurrence', '$1,000,000', null], ['General aggregate', '$2,000,000', null]], workers_comp: [['Employers liability', '$500,000 / $500,000 / $500,000', null]],
        commercial_auto: [['Liability CSL', '$1,000,000', null], ['Hired & non-owned', 'Included', null]], cyber: [['Aggregate limit', '$1,000,000', '$2,500']],
        commercial_property: [['Building', '$750,000', '$2,500'], ['Business income', '12 months', null]], professional_liability: [['Per claim', '$1,000,000', '$5,000']],
      }[line] || [];
      for (const [cv, lim, ded] of covs) db.prepare('INSERT INTO coverages (policy_id, coverage, limit_text, deductible) VALUES (?,?,?,?)').run(id, cv, lim, ded);
      if (line === 'personal_auto') {
        db.prepare("INSERT INTO risk_items (policy_id, kind, description, identifier) VALUES (?, 'vehicle', ?, ?)").run(id, `${int(2015, 2025)} ${pick(['Toyota Camry', 'Honda CR-V', 'Ford F-150', 'Subaru Outback', 'Tesla Model 3'])}`, 'VIN ' + String(int(10000000, 99999999)) + 'XZ' + int(1000, 9999));
        db.prepare("INSERT INTO risk_items (policy_id, kind, description) VALUES (?, 'driver', ?)").run(id, `${clientRow.first_name} ${clientRow.last_name}`);
      }
      if (['homeowners', 'condo', 'bop', 'commercial_property'].includes(line)) db.prepare("INSERT INTO risk_items (policy_id, kind, description) VALUES (?, 'location', ?)").run(id, `${clientRow.address1}, ${clientRow.city}, ${clientRow.state}`);
      policies.push({ id, client_id: client.id, status, eff, exp, line });
      return id;
    };

    for (const c of clients) {
      const pool = c.type === 'business' ? bizLines : personalLines;
      const n = c.type === 'business' ? int(1, 3) : int(1, 4);
      const lines = [...pool].sort(() => r() - 0.5).slice(0, n);
      for (const l of lines) {
        const eff = addDays(today, -int(5, 358));
        if (r() < 0.3) { // existing renewal history: an expired prior term that was renewed
          const prior = createPolicy(c, l, addMonths(eff, -12), null, 'renewed');
          db.prepare("UPDATE policies SET renewal_status = 'renewed' WHERE id = ?").run(prior);
          createPolicy(c, l, eff, prior);
        } else createPolicy(c, l, eff);
      }
    }
    // A handful of cancellations / non-renewals / lapsed renewals for realistic retention numbers
    const active = policies.filter((p) => p.status === 'active');
    for (const p of active.slice(0, 4)) db.prepare("UPDATE policies SET status = 'cancelled', cancelled_date = ?, cancel_reason = 'Insured request', renewal_status = 'lost' WHERE id = ?").run(addDays(today, -int(5, 60)), p.id);
    for (const p of active.slice(4, 6)) db.prepare("UPDATE policies SET status = 'non_renewed', cancel_reason = 'Moved to another carrier', renewal_status = 'lost' WHERE id = ?").run(p.id);

    // Payments: most invoices due in the past are paid; some are left overdue
    for (const inv of db.prepare("SELECT * FROM invoices WHERE status = 'open' AND due_date <= date('now')").all()) {
      const roll = r();
      if (roll < 0.82) {
        db.prepare("INSERT INTO payments (invoice_id, client_id, amount, method, paid_date, reference, user_id) VALUES (?,?,?,?,?,?,?)").run(inv.id, inv.client_id, inv.amount, pick(['check', 'ach', 'card']), addDays(inv.due_date, -int(0, 6)), String(int(1000, 9999)), admin);
        db.prepare("UPDATE invoices SET paid = amount, status = 'paid' WHERE id = ?").run(inv.id);
      } else if (roll < 0.9) {
        const part = round2(inv.amount * 0.4);
        db.prepare("INSERT INTO payments (invoice_id, client_id, amount, method, paid_date, reference, user_id) VALUES (?,?,?,?,?,?,?)").run(inv.id, inv.client_id, part, 'check', addDays(inv.due_date, 3), String(int(1000, 9999)), admin);
        db.prepare("UPDATE invoices SET paid = ?, status = 'partial' WHERE id = ?").run(part, inv.id);
      }
    }

    // Commissions: older periods have mostly been received (with small variances)
    const cutoff = addDays(today, -45).slice(0, 7);
    for (const cm of db.prepare("SELECT * FROM commissions WHERE period <= ? AND status = 'expected'").all(cutoff)) {
      if (r() < 0.92) {
        const variance = r() < 0.15 ? round2((r() - 0.5) * 12) : 0;
        db.prepare("UPDATE commissions SET status = 'received', received_amount = ?, received_date = ?, statement_ref = ? WHERE id = ?")
          .run(round2(cm.expected_amount + variance), `${cm.period}-28`, `STMT-${cm.period}-${cm.carrier_id}`, cm.id);
      }
    }

    // Claims
    const claimTypes = ['Collision', 'Water damage', 'Hail', 'Theft', 'Slip and fall', 'Windshield', 'Fire', 'Equipment breakdown', 'Wind damage'];
    const stat = ['open', 'open', 'in_review', 'approved', 'closed', 'closed', 'denied'];
    const eligible = db.prepare("SELECT * FROM policies WHERE status IN ('active','cancelled') AND effective_date < date('now','-20 days')").all();
    for (let i = 0; i < 14 && i < eligible.length; i++) {
      const p = eligible[i * 3 % eligible.length];
      const loss = addDays(today, -int(5, Math.min(180, Math.round((new Date(today) - new Date(p.effective_date)) / 86400000) - 1)));
      const status = pick(stat), claimed = int(8, 180) * 100;
      const id = Number(db.prepare(
        `INSERT INTO claims (policy_id, client_id, claim_number, loss_date, reported_date, loss_type, status, description, amount_claimed, reserve, amount_paid, deductible, adjuster_name, adjuster_phone, closed_date)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(p.id, p.client_id, `CLM-${int(100000, 999999)}`, loss, addDays(loss, int(0, 3)), pick(claimTypes), status, 'Reported by insured; adjuster assigned.', claimed,
        ['open', 'in_review', 'approved'].includes(status) ? Math.round(claimed * 0.8) : 0, ['closed', 'approved'].includes(status) ? Math.round(claimed * 0.85) : 0, 500, pick(['Dana Whitfield', 'Ray Colton', 'Mei Zhang']),
        `(800) 555-${int(1000, 9999)}`, status === 'closed' ? addDays(loss, int(10, 40)) : null).lastInsertRowid);
      db.prepare("INSERT INTO activities (kind, subject, claim_id, client_id, policy_id, user_id) VALUES ('system', 'Claim reported', ?, ?, ?, ?)").run(id, p.client_id, p.id, admin);
    }

    // Pipeline
    const stages = ['new', 'new', 'contacted', 'contacted', 'quoting', 'quoting', 'quoting', 'proposal', 'proposal', 'won', 'lost'];
    stages.forEach((stage, i) => {
      const last = pick(LAST);
      const line = pick([...personalLines, ...bizLines])[0];
      const oid = Number(db.prepare(
        'INSERT INTO opportunities (name, contact_email, contact_phone, line, stage, est_premium, expected_close, source, producer_id, lost_reason) VALUES (?,?,?,?,?,?,?,?,?,?)'
      ).run(`${last} — ${line.replace(/_/g, ' ')}`, `${last.toLowerCase()}${i}@example.com`, `(512) 555-${int(1000, 9999)}`, line, stage, int(6, 70) * 100, addDays(today, int(-5, 40)), pick(SOURCES), pick(producers),
        stage === 'lost' ? 'Went with incumbent carrier' : null).lastInsertRowid);
      if (['quoting', 'proposal', 'won', 'lost'].includes(stage)) {
        for (const cid of [...carriers].sort(() => r() - 0.5).slice(0, int(2, 3))) {
          db.prepare("INSERT INTO quotes (opportunity_id, carrier_id, line, premium, status, valid_until) VALUES (?,?,?,?,?,?)").run(oid, cid, line, int(6, 70) * 100 + int(0, 99), pick(['pending', 'presented']), addDays(today, int(5, 30)));
        }
      }
    });

    // Tasks & notes
    const titles = ['Call back about umbrella quote', 'Send updated dec page', 'Collect signed application', 'Review loss runs', 'Follow up on missing driver info', 'Verify mortgagee change', 'Schedule annual policy review'];
    for (let i = 0; i < 18; i++) {
      const c = pick(clients);
      db.prepare('INSERT INTO tasks (title, due_date, priority, assigned_to, client_id, created_by) VALUES (?,?,?,?,?,?)')
        .run(pick(titles), addDays(today, int(-6, 14)), pick(['low', 'normal', 'normal', 'high', 'urgent']), pick([admin, ...csrs, prod1, prod2]), c.id, admin);
    }
    for (const c of clients.slice(0, 30)) {
      db.prepare("INSERT INTO activities (kind, subject, body, client_id, user_id, created_at) VALUES (?,?,?,?,?, datetime('now', ?))")
        .run(pick(['call', 'email', 'note', 'meeting']), pick(['Annual review', 'Discussed coverage options', 'Billing question', 'Address update', 'Cross-sell conversation']),
          pick(['Client is happy with service. Interested in bundling.', 'Left voicemail, will try again Thursday.', 'Walked through deductible options; wants quotes at $1,000 and $2,500.', 'Updated mailing address and verified contact info.']),
          c.id, pick([admin, ...csrs, prod1]), `-${int(1, 60)} days`);
    }

    // Certificates for a few business clients
    for (const c of clients.filter((x) => x.type === 'business').slice(0, 4)) {
      const pol = db.prepare("SELECT id FROM policies WHERE client_id = ? AND status = 'active' LIMIT 2").all(c.id);
      if (!pol.length) continue;
      const cid = Number(db.prepare('INSERT INTO certificates (number, client_id, holder_name, holder_address, description, additional_insured, issued_date, created_by) VALUES (?,?,?,?,?,?,?,?)')
        .run(nextNumber(db, 'certificate', 'COI'), c.id, pick(['City of Austin', 'Westlake Property Management', 'Capital Metro Authority', 'Hill Country Developers']), 'Attn: Risk Management\nAustin, TX 78701', 'Certificate holder is named additional insured as required by written contract.', 1, addDays(today, -int(1, 90)), admin).lastInsertRowid);
      for (const p of pol) db.prepare('INSERT INTO certificate_policies (certificate_id, policy_id) VALUES (?,?)').run(cid, p.id);
    }

    const counts = Object.fromEntries(['clients', 'policies', 'claims', 'invoices', 'payments', 'commissions', 'opportunities', 'tasks'].map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]));
    log('Seeded demo data:', counts);
    return counts;
  });
}

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = openDb();
  bootstrap(db);
  if (db.prepare('SELECT COUNT(*) AS n FROM clients').get().n > 0 && !process.argv.includes('--force')) {
    console.error('Database already contains clients. Re-run with --force to add demo data anyway (user emails must not already exist).');
    process.exit(1);
  }
  seedDemo(db);
  console.log(`\nDemo logins (password for all: ${DEMO_PASSWORD})\n  manager@demo.local · alex@demo.local (producer) · casey@demo.local (csr) · pat@demo.local (accounting)`);
}
