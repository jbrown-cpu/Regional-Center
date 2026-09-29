# Regional Center Billing

Billing, attendance, authorization and accounts-receivable management for service providers vendored by California's 21 regional centers (Department of Developmental Services). It is built for day programs, behavior management, community integration, employment and in-home services.

The app follows the monthly billing cycle end to end:

```
POS authorization  →  daily attendance  →  monthly invoice (capped at authorized units)
      →  eBilling worksheet / submission  →  remittance posting  →  A/R aging & follow-up
```

## Features

| Area | What it does |
|---|---|
| **Consumers** | Consumer records keyed by 7-digit UCI, with regional center and service coordinator contacts. |
| **Authorizations** | POS authorizations: auth number, rate, units per month or per authorization period, start and end dates. Shows alerts at 30 and 45 days before expiration. |
| **Attendance** | Month grid per program. Click to mark Present, ½, Absent, Excused or Holiday, or type units for hourly services. Shift+click records hours and notes. "Mark scheduled days present" fills a month with one click. Rows lock once the month is invoiced. |
| **Invoices** | Builds a draft invoice for each program and month from attendance. It never bills past the authorization: excess units are held back and flagged. It also flags weekend service, short full days, service outside the authorization dates, inactive authorizations and missing rates. Exports an **eBilling worksheet CSV** with a per-day unit grid, and prints a certified invoice. |
| **Payments** | Records EFT or check remittances from each regional center. Applies them oldest-first automatically or line by line, flags short-pays and derives each invoice's paid or partial status. |
| **Reports** | A/R aging (0–30 … 120+) by regional center, billed vs. collected by month, revenue by service code and by regional center, and authorization utilization with unused authorized value. Every report exports to CSV. |
| **Dashboard** | Outstanding A/R, 90+ day exposure, collections, a 12-month billing trend, expiring authorizations, unbilled attendance, drafts and over-authorization alerts. |
| **Security** | Role-based access (admin, biller, staff, viewer), scrypt password hashing, HttpOnly SameSite session cookies (only token hashes are stored), login throttling, a strict Content Security Policy and a full **audit log** of sign-ins, record views, changes and exports. |

## Quick start

Requires **Node.js 22.13+**. There are no dependencies to install; the app uses Node's built-in SQLite.

```bash
npm start                 # http://127.0.0.1:3000 — first visit creates the admin account
```

To explore with fictitious sample data:

```bash
npm run seed:demo         # creates admin / DemoAdmin2026 plus demo programs, consumers and attendance
npm start
```

Run the tests:

```bash
npm test
```

## First-time setup checklist

1. **Settings → Programs**: add each vendored program with its vendor number, service code (and subcode), vendoring regional center, billing unit and default rate. Set a full-day minimum-hours threshold if your contract has one.
2. **Settings → Regional centers**: fill in accounting contacts and remit addresses for the centers you bill.
3. **Settings → Users**: give direct-support staff the *Staff* role (attendance only) and billing staff the *Biller* role.
4. **Consumers → Add consumer**, then **Add authorization** from each consumer's page. Enter it exactly as it appears on the POS authorization.
5. Record attendance daily. After month-end, go to **Invoices → Generate invoices**. Resolve any flags, enter the invoice in the regional center's eBilling system (the CSV worksheet matches its per-day layout), then click **Mark submitted**.
6. Post each remittance under **Payments → Record payment**.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` only behind a TLS reverse proxy. |
| `DB_FILE` | `./data/billing.db` | SQLite database location |
| `COOKIE_SECURE` | unset | Set to `1` when served over HTTPS |
| `BILLING_TZ` | `America/Los_Angeles` | Time zone used for "today", aging and expirations |

## Production and compliance notes

This app stores protected health information (PHI) covered by HIPAA and by the Lanterman Act's confidentiality rules (W&I Code §4514).

- Serve it only over **HTTPS** (nginx, Caddy or a cloud load balancer in front of it) and set `COOKIE_SECURE=1`.
- Keep the database on an **encrypted volume**, back up `data/` nightly to encrypted storage, and test your restores.
- Have a Business Associate Agreement in place with any hosting provider.
- Review the **audit log** regularly and deactivate users promptly when staff leave.
- Service codes, units and rates are seeded as editable examples. Confirm them against each program's vendorization letter and rate schedule.

## Project layout

```
server.js            HTTP server, static files, security headers, session handling
src/billing.js       Pure billing rules (unit caps, flags, aging, allocation, CSV) — fully unit-tested
src/api.js           REST API routes and validation
src/db.js            SQLite schema and reference data (21 regional centers, common service codes)
src/auth.js          Password hashing, sessions, roles, login throttling
public/              Single-page web client (vanilla JS, no build step)
scripts/seed-demo.js Fictitious demo data
test/                Unit and end-to-end API tests (node:test)
```
