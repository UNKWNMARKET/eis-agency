import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','manager','producer','csr','accounting')),
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  phone TEXT,
  license_no TEXT,
  split_new_pct REAL NOT NULL DEFAULT 0,      -- producer share of agency commission, new business
  split_renew_pct REAL NOT NULL DEFAULT 0,    -- producer share of agency commission, renewals
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE carriers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  naic TEXT,
  am_best TEXT,
  phone TEXT,
  claims_phone TEXT,
  email TEXT,
  website TEXT,
  agency_code TEXT,
  commission_new_pct REAL NOT NULL DEFAULT 10,
  commission_renew_pct REAL NOT NULL DEFAULT 10,
  default_billing TEXT NOT NULL DEFAULT 'direct_bill',
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE clients (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'person' CHECK (type IN ('person','business')),
  first_name TEXT,
  last_name TEXT,
  business_name TEXT,
  dba TEXT,
  display_name TEXT GENERATED ALWAYS AS (
    CASE WHEN type = 'business' THEN COALESCE(business_name,'') ELSE TRIM(COALESCE(last_name,'') || ', ' || COALESCE(first_name,''), ', ') END
  ) VIRTUAL,
  dob TEXT,
  email TEXT,
  phone TEXT,
  mobile TEXT,
  address1 TEXT,
  address2 TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('prospect','active','inactive')),
  industry TEXT,
  fein_last4 TEXT,
  employees INTEGER,
  annual_revenue REAL,
  source TEXT,
  producer_id INTEGER REFERENCES users(id),
  csr_id INTEGER REFERENCES users(id),
  household TEXT,
  preferred_contact TEXT,
  do_not_contact INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_clients_name ON clients(display_name);
CREATE INDEX idx_clients_producer ON clients(producer_id);

CREATE TABLE contacts (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  relationship TEXT,
  email TEXT,
  phone TEXT,
  dob TEXT,
  notes TEXT
);
CREATE INDEX idx_contacts_client ON contacts(client_id);

CREATE TABLE policies (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  carrier_id INTEGER NOT NULL REFERENCES carriers(id),
  mga TEXT,
  policy_number TEXT NOT NULL,
  line TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('quote','active','pending_cancel','cancelled','expired','non_renewed','renewed')),
  renewal_status TEXT NOT NULL DEFAULT 'not_started',
  effective_date TEXT NOT NULL,
  expiration_date TEXT NOT NULL,
  premium REAL NOT NULL DEFAULT 0,
  fees REAL NOT NULL DEFAULT 0,
  billing_method TEXT NOT NULL DEFAULT 'direct_bill',
  payment_plan TEXT NOT NULL DEFAULT 'full',
  commission_pct REAL,
  producer_id INTEGER REFERENCES users(id),
  csr_id INTEGER REFERENCES users(id),
  prior_policy_id INTEGER REFERENCES policies(id) ON DELETE SET NULL,
  cancelled_date TEXT,
  cancel_reason TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_policies_client ON policies(client_id);
CREATE INDEX idx_policies_exp ON policies(expiration_date);
CREATE INDEX idx_policies_number ON policies(policy_number);
CREATE INDEX idx_policies_carrier ON policies(carrier_id);

CREATE TABLE coverages (
  id INTEGER PRIMARY KEY,
  policy_id INTEGER NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  coverage TEXT NOT NULL,
  limit_text TEXT,
  deductible TEXT,
  premium REAL
);
CREATE INDEX idx_coverages_policy ON coverages(policy_id);

CREATE TABLE risk_items (
  id INTEGER PRIMARY KEY,
  policy_id INTEGER NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'other',
  description TEXT NOT NULL,
  identifier TEXT,          -- VIN, license no., address, etc.
  value REAL,
  details TEXT
);
CREATE INDEX idx_risk_policy ON risk_items(policy_id);

CREATE TABLE policy_transactions (
  id INTEGER PRIMARY KEY,
  policy_id INTEGER NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  type TEXT NOT NULL,   -- new, renewal, endorsement, cancellation, reinstatement
  effective_date TEXT NOT NULL,
  premium_change REAL NOT NULL DEFAULT 0,
  description TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_tx_policy ON policy_transactions(policy_id);

CREATE TABLE opportunities (
  id INTEGER PRIMARY KEY,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  contact_email TEXT,
  contact_phone TEXT,
  line TEXT,
  stage TEXT NOT NULL DEFAULT 'new' CHECK (stage IN ('new','contacted','quoting','proposal','won','lost')),
  est_premium REAL NOT NULL DEFAULT 0,
  expected_close TEXT,
  source TEXT,
  producer_id INTEGER REFERENCES users(id),
  lost_reason TEXT,
  converted_policy_id INTEGER REFERENCES policies(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_opp_stage ON opportunities(stage);

CREATE TABLE quotes (
  id INTEGER PRIMARY KEY,
  opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  carrier_id INTEGER NOT NULL REFERENCES carriers(id),
  line TEXT,
  premium REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','presented','accepted','declined')),
  quote_ref TEXT,
  valid_until TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_quotes_opp ON quotes(opportunity_id);

CREATE TABLE claims (
  id INTEGER PRIMARY KEY,
  policy_id INTEGER NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  claim_number TEXT,
  loss_date TEXT NOT NULL,
  reported_date TEXT,
  loss_type TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_review','approved','denied','closed')),
  description TEXT,
  loss_location TEXT,
  amount_claimed REAL NOT NULL DEFAULT 0,
  reserve REAL NOT NULL DEFAULT 0,
  amount_paid REAL NOT NULL DEFAULT 0,
  deductible REAL NOT NULL DEFAULT 0,
  adjuster_name TEXT,
  adjuster_phone TEXT,
  adjuster_email TEXT,
  closed_date TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_claims_client ON claims(client_id);
CREATE INDEX idx_claims_policy ON claims(policy_id);

CREATE TABLE invoices (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  policy_id INTEGER REFERENCES policies(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'premium',     -- premium, fee, endorsement, credit
  description TEXT,
  issue_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  amount REAL NOT NULL,                     -- negative for credit memos
  paid REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','partial','paid','void')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_invoices_client ON invoices(client_id);
CREATE INDEX idx_invoices_policy ON invoices(policy_id);
CREATE INDEX idx_invoices_due ON invoices(due_date);

CREATE TABLE payments (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  method TEXT NOT NULL DEFAULT 'check',
  paid_date TEXT NOT NULL,
  reference TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_payments_invoice ON payments(invoice_id);

CREATE TABLE commissions (
  id INTEGER PRIMARY KEY,
  policy_id INTEGER REFERENCES policies(id) ON DELETE SET NULL,
  carrier_id INTEGER NOT NULL REFERENCES carriers(id),
  producer_id INTEGER REFERENCES users(id),
  type TEXT NOT NULL DEFAULT 'new',
  period TEXT NOT NULL,                    -- YYYY-MM the commission is attributed to
  premium_basis REAL NOT NULL DEFAULT 0,
  rate_pct REAL NOT NULL DEFAULT 0,
  expected_amount REAL NOT NULL DEFAULT 0,
  received_amount REAL,
  received_date TEXT,
  statement_ref TEXT,
  status TEXT NOT NULL DEFAULT 'expected' CHECK (status IN ('expected','received','disputed','written_off')),
  producer_split_pct REAL NOT NULL DEFAULT 0,
  producer_paid INTEGER NOT NULL DEFAULT 0,
  producer_paid_date TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_comm_policy ON commissions(policy_id);
CREATE INDEX idx_comm_period ON commissions(period);
CREATE INDEX idx_comm_status ON commissions(status);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  due_date TEXT,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  assigned_to INTEGER REFERENCES users(id),
  client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  policy_id INTEGER REFERENCES policies(id) ON DELETE CASCADE,
  claim_id INTEGER REFERENCES claims(id) ON DELETE CASCADE,
  opportunity_id INTEGER REFERENCES opportunities(id) ON DELETE CASCADE,
  created_by INTEGER REFERENCES users(id),
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_tasks_assigned ON tasks(assigned_to, status);
CREATE INDEX idx_tasks_due ON tasks(due_date);

CREATE TABLE activities (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note','call','email','meeting','text','system')),
  subject TEXT,
  body TEXT,
  client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  policy_id INTEGER REFERENCES policies(id) ON DELETE CASCADE,
  claim_id INTEGER REFERENCES claims(id) ON DELETE CASCADE,
  opportunity_id INTEGER REFERENCES opportunities(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_act_client ON activities(client_id, created_at);
CREATE INDEX idx_act_policy ON activities(policy_id);

CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  mime TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  storage_name TEXT NOT NULL UNIQUE,
  client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  policy_id INTEGER REFERENCES policies(id) ON DELETE CASCADE,
  claim_id INTEGER REFERENCES claims(id) ON DELETE CASCADE,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_docs_client ON documents(client_id);

CREATE TABLE certificates (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  holder_name TEXT NOT NULL,
  holder_address TEXT,
  description TEXT,
  additional_insured INTEGER NOT NULL DEFAULT 0,
  waiver_of_subrogation INTEGER NOT NULL DEFAULT 0,
  primary_noncontributory INTEGER NOT NULL DEFAULT 0,
  issued_date TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_certs_client ON certificates(client_id);

CREATE TABLE certificate_policies (
  certificate_id INTEGER NOT NULL REFERENCES certificates(id) ON DELETE CASCADE,
  policy_id INTEGER NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  PRIMARY KEY (certificate_id, policy_id)
);

CREATE TABLE templates (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL DEFAULT 'general',
  subject TEXT NOT NULL,
  body TEXT NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  user_name TEXT,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);
CREATE INDEX idx_audit_time ON audit_log(created_at);
`;

const MIGRATIONS = [SCHEMA];

export function openDb(path = process.env.AMS_DB || 'data/ams.db') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const { user_version: current } = db.prepare('PRAGMA user_version').get();
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return db;
}

/** Run fn inside a transaction (supports nesting via savepoints). */
let depth = 0;
export function tx(db, fn) {
  const name = `sp${depth++}`;
  db.exec(depth === 1 ? 'BEGIN' : `SAVEPOINT ${name}`);
  try {
    const out = fn();
    db.exec(depth === 1 ? 'COMMIT' : `RELEASE ${name}`);
    return out;
  } catch (e) {
    db.exec(depth === 1 ? 'ROLLBACK' : `ROLLBACK TO ${name}`);
    throw e;
  } finally {
    depth--;
  }
}

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
