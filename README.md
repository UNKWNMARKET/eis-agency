# EIS Agency Management System (AMS)

A self-hosted agency management system for an independent insurance agency: clients, policies, renewals, sales
pipeline, claims, agency billing, commissions, certificates of insurance, tasks, documents and reporting.

**Zero dependencies.** It runs on Node.js 22.13+ using the built-in `node:sqlite` module and a plain-JavaScript
single-page UI — no `npm install`, no build step.

```bash
npm start                # http://127.0.0.1:3000
npm run seed:demo        # optional: load realistic fictional demo data (see below)
npm test                 # 42 API tests
```

On first start (empty database) an admin account is created and its login is printed **once** in the console. Set
`ADMIN_EMAIL` / `ADMIN_PASSWORD` beforehand to choose your own. Change the password under *Settings → My account*.

## What's in it

| Area | Capabilities |
|---|---|
| **Clients** | Individuals and businesses, household/business contacts, producer + CSR assignment, lead source, do-not-contact flag, CSV import/export, full timeline of notes/calls/emails, documents, tasks |
| **Policies** | All personal, commercial and life/health lines; coverages & limits; vehicles/drivers/locations; per-policy commission override; full **transaction history** |
| **Policy lifecycle** | **Bind → Endorse → Cancel (pro-rata or flat) → Reinstate → Renew → Non-renew.** Each action writes a transaction, the right commission lines, billing and a timeline entry, atomically |
| **Renewals** | 30/60/90/180-day and past-due views, renewal-status workflow (not started → in review → remarketing → quoted → offered → renewed), one-click renew (copies coverages and risk items, links terms), auto-generate review tasks, templated renewal emails |
| **Pipeline** | Drag-and-drop kanban, competing carrier quotes, one-click **convert to policy** (creates the client if new) |
| **Claims** | FNOL through closure, loss date validated against the policy term, adjuster details, reserves/paid, notes, tasks, documents |
| **Billing** | Direct-bill vs agency-bill, payment plans (full/semi/quarterly/monthly) generate installment invoices that sum to the cent, payments with partial/over-payment protection, credit memos, client ledger, A/R aging |
| **Commissions** | Expected commission auto-created per transaction (new/renewal/endorsement/chargeback), **carrier statement reconciliation** (preview → apply, variance tracking), producer splits and payout tracking |
| **Certificates** | Issue COIs against a client's in-force policies, additional-insured / waiver flags, printable page → PDF |
| **Reports** | Production by producer, book by carrier / line, renewal retention, A/R aging, loss ratio by carrier, commission summary, cross-sell list, pipeline by source — all with CSV export |
| **Admin** | Roles & users, agency profile, email templates with merge fields, client CSV import (validate first), audit log, one-click database backup |

### Roles

| Role | Can do |
|---|---|
| `admin` | Everything, including user management and backups |
| `manager` | Everything except user management; may directly correct financial fields and delete records |
| `producer`, `csr` | Day-to-day work: clients, policies, claims, pipeline, tasks, notes, documents, certificates, payments. Cannot change a policy's premium/dates/status except via Endorse/Cancel/Renew |
| `accounting` | Read everything; manages billing and commissions (including statements and producer payouts) |

### Design decisions worth knowing

* **Money is stored as dollars rounded to 2 decimals** and all splits are allocated so totals match exactly.
* **Policy financial fields are protected.** Premium, dates, carrier and billing can only change through lifecycle
  actions (which keep invoices and commissions consistent), unless a manager makes a deliberate correction.
* **Policies auto-expire** at their expiration date. An unrenewed expired policy is only counted as *lost* after a
  30-day grace period, because late renewals are normal.
* **Commission statement matching** applies each statement line to the oldest outstanding expected commission for that
  carrier + policy number. Lines that don't match are listed so you can chase the carrier.
* **Email is never sent from the server.** Templates are merged and opened in your own email client (`mailto:`), with the
  option to log the email on the client's timeline.
* **The certificate is an informational summary**, not an official ACORD 25 form (ACORD forms are licensed). If you need
  the licensed form, generate it from your ACORD-enabled tools.

## Demo data

```bash
ADMIN_EMAIL=admin@demo.local ADMIN_PASSWORD='choose-a-password' AMS_DB=data/demo.db npm run seed:demo
AMS_DB=data/demo.db npm start
```

Creates ~65 fictional clients, ~180 policies, claims, invoices, payments, commissions, pipeline, tasks and certificates.
Demo staff logins (password `demo-password-123`): `manager@demo.local`, `alex@demo.local` (producer),
`casey@demo.local` (CSR), `pat@demo.local` (accounting). **Never seed demo data into a production database.**

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Listen address. Binds to localhost by default — see *Deploying* |
| `AMS_DB` | `data/ams.db` | SQLite database file |
| `AMS_UPLOADS` | `data/uploads` | Where uploaded documents are stored |
| `AMS_SECURE_COOKIES` | off | Set to `1` when served over HTTPS (adds the `Secure` cookie flag) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | `admin@example.com`, generated | First-run admin account |

## Deploying

This is an application holding personal and financial data, so before exposing it beyond your own machine:

1. **Put it behind HTTPS** (Caddy, nginx or a cloud load balancer) and set `AMS_SECURE_COOKIES=1`. The app itself
   serves plain HTTP and binds to `127.0.0.1` by default; set `HOST=0.0.0.0` only behind a TLS-terminating proxy or on a
   private network.
2. **Back up regularly:** *Settings → My account → Download backup* (admin) gives a consistent database snapshot;
   `data/uploads/` holds the documents and must be backed up separately.
3. **Run a single instance** — it uses SQLite (WAL mode) and an in-memory login rate limiter.
4. Encrypt the disk / volume that holds `data/`; SSNs and full payment-card numbers are deliberately **not** stored
   (only the last 4 of an FEIN, for identification).

### Security measures in place

Scrypt password hashing; server-side sessions with HttpOnly + SameSite=Strict cookies (token stored hashed); CSRF
header required on every state-changing request; login throttling (8 failures / 15 min); role checks on every route;
parameterised SQL everywhere with whitelisted sort columns; all UI text rendered via `textContent` (no `innerHTML`);
strict Content-Security-Policy; uploads restricted by extension, size-limited, stored under random names and served
as attachments; CSV exports neutralise spreadsheet-formula injection; an audit log of every create/update/delete/export.

## Project layout

```
src/
  server.js        HTTP server, sessions, static files, security headers, first-run bootstrap
  db.js            SQLite schema + migrations
  crud.js          Generic list/get/create/update/delete (search, filters, sorting, paging, CSV, audit)
  domain.js        Commissions, invoicing/installments, numbering, status refresh, pro-rata math
  routes/          core (auth, users, carriers, clients), policies, sales, claims, billing, work, reports, admin
  seed.js          Demo data generator
public/            Single-page UI (native ES modules, no build): js/views/*.js, css/styles.css
test/              node:test API suite (in-memory database per run)
```

## Extending

* **New field on a record:** add the column in a new entry in `MIGRATIONS` (`src/db.js`), add it to the resource's
  `spec` in its route file, and to the form in `public/js/views/forms.js`.
* **New report:** add an entry to `defs` in `src/routes/reports.js`; it appears in the UI and CSV export automatically.
* **Integrations** (carrier download/IVANS, e-signature, SMS, accounting export) are not included; the API is JSON over
  HTTP with the same session auth as the UI, so they can be added as separate routes.

> **Disclaimer:** commission, premium-return and aging calculations are standard conventions (pro-rata daily
> unearned premium, flat-cancel on inception), but carriers use their own short-rate tables, minimum earned premiums and
> state rules. Always confirm return premiums and regulatory requirements (licensing, notices, record retention) against
> your carriers' and your state's rules.
