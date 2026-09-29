'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','biller','staff','viewer')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS regional_centers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  abbreviation TEXT,
  address TEXT,
  phone TEXT,
  billing_contact TEXT,
  billing_email TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS service_codes (
  code TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  default_unit_type TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS programs (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  vendor_number TEXT NOT NULL,
  regional_center_id INTEGER NOT NULL REFERENCES regional_centers(id),
  service_code TEXT NOT NULL REFERENCES service_codes(code),
  subcode TEXT,
  unit_type TEXT NOT NULL,
  default_rate_cents INTEGER,
  full_day_min_hours REAL,
  bills_weekends INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (vendor_number, service_code, subcode)
);

CREATE TABLE IF NOT EXISTS consumers (
  id INTEGER PRIMARY KEY,
  uci TEXT NOT NULL UNIQUE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  dob TEXT,
  regional_center_id INTEGER NOT NULL REFERENCES regional_centers(id),
  service_coordinator TEXT,
  sc_phone TEXT,
  sc_email TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','pending')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS authorizations (
  id INTEGER PRIMARY KEY,
  auth_number TEXT NOT NULL,
  consumer_id INTEGER NOT NULL REFERENCES consumers(id),
  program_id INTEGER NOT NULL REFERENCES programs(id),
  unit_type TEXT NOT NULL,
  rate_cents INTEGER NOT NULL,
  units_authorized REAL NOT NULL,
  units_period TEXT NOT NULL DEFAULT 'month' CHECK (units_period IN ('month','total')),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','expired','terminated')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (auth_number, program_id)
);
CREATE INDEX IF NOT EXISTS idx_auth_consumer ON authorizations(consumer_id);
CREATE INDEX IF NOT EXISTS idx_auth_program ON authorizations(program_id);

CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY,
  authorization_id INTEGER NOT NULL REFERENCES authorizations(id) ON DELETE CASCADE,
  service_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('present','partial','absent','excused','holiday')),
  units REAL NOT NULL DEFAULT 0,
  hours REAL,
  note TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (authorization_id, service_date)
);
CREATE INDEX IF NOT EXISTS idx_att_date ON attendance(service_date);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  invoice_number TEXT NOT NULL UNIQUE,
  program_id INTEGER NOT NULL REFERENCES programs(id),
  regional_center_id INTEGER NOT NULL REFERENCES regional_centers(id),
  service_month TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','partial','paid','void')),
  total_cents INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at TEXT,
  submitted_by INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_inv_month ON invoices(service_month);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  authorization_id INTEGER NOT NULL REFERENCES authorizations(id),
  consumer_id INTEGER NOT NULL REFERENCES consumers(id),
  units REAL NOT NULL,
  rate_cents INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  unbilled_units REAL NOT NULL DEFAULT 0,
  daily_units TEXT NOT NULL,
  flags TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_line_invoice ON invoice_lines(invoice_id);
CREATE INDEX IF NOT EXISTS idx_line_auth ON invoice_lines(authorization_id);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  regional_center_id INTEGER NOT NULL REFERENCES regional_centers(id),
  payment_date TEXT NOT NULL,
  reference TEXT,
  method TEXT NOT NULL DEFAULT 'eft' CHECK (method IN ('eft','check','other')),
  amount_cents INTEGER NOT NULL,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payment_allocations (
  id INTEGER PRIMARY KEY,
  payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  invoice_line_id INTEGER NOT NULL REFERENCES invoice_lines(id),
  amount_cents INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alloc_line ON payment_allocations(invoice_line_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  detail TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

// The 21 California regional centers under contract with the Department of Developmental Services.
const REGIONAL_CENTERS = [
  ['Alta California Regional Center', 'ACRC'],
  ['Central Valley Regional Center', 'CVRC'],
  ['Eastern Los Angeles Regional Center', 'ELARC'],
  ['Far Northern Regional Center', 'FNRC'],
  ['Frank D. Lanterman Regional Center', 'FDLRC'],
  ['Golden Gate Regional Center', 'GGRC'],
  ['Harbor Regional Center', 'HRC'],
  ['Inland Regional Center', 'IRC'],
  ['Kern Regional Center', 'KRC'],
  ['North Bay Regional Center', 'NBRC'],
  ['North Los Angeles County Regional Center', 'NLACRC'],
  ['Regional Center of Orange County', 'RCOC'],
  ['Redwood Coast Regional Center', 'RCRC'],
  ['Regional Center of the East Bay', 'RCEB'],
  ['San Andreas Regional Center', 'SARC'],
  ['San Diego Regional Center', 'SDRC'],
  ['San Gabriel/Pomona Regional Center', 'SG/PRC'],
  ['South Central Los Angeles Regional Center', 'SCLARC'],
  ['Tri-Counties Regional Center', 'TCRC'],
  ['Valley Mountain Regional Center', 'VMRC'],
  ['Westside Regional Center', 'WRC'],
];

// Common DDS service codes for day, employment and in-home programs. Editable in Settings;
// confirm codes and unit types against each program's vendorization letter.
const SERVICE_CODES = [
  ['028', 'Socialization Training Program', 'day'],
  ['048', 'Client/Parent Support Behavior Intervention Training', 'hour'],
  ['055', 'Community Integration Training Program', 'day'],
  ['062', 'Personal Assistance', 'hour'],
  ['063', 'Community Activities Support Services', 'hour'],
  ['091', 'In-Home Day Program', 'hour'],
  ['102', 'Individual or Family Training', 'hour'],
  ['505', 'Activity Center', 'day'],
  ['510', 'Adult Development Center', 'day'],
  ['515', 'Behavior Management Program', 'day'],
  ['520', 'Independent Living Program', 'hour'],
  ['612', 'Behavior Analyst', 'hour'],
  ['862', 'In-Home Respite Services Agency', 'hour'],
  ['896', 'Supported Living Services', 'hour'],
  ['950', 'Supported Employment — Group', 'hour'],
  ['952', 'Supported Employment — Individual', 'hour'],
  ['954', 'Work Activity Program', 'day'],
];

const UNIT_TYPES = ['day', 'hour', 'quarter_hour', 'month', 'session', 'trip', 'mile'];

function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  seedReference(db);
  return db;
}

function seedReference(db) {
  const rc = db.prepare('INSERT OR IGNORE INTO regional_centers (name, abbreviation) VALUES (?, ?)');
  const sc = db.prepare('INSERT OR IGNORE INTO service_codes (code, description, default_unit_type) VALUES (?, ?, ?)');
  transaction(db, () => {
    for (const r of REGIONAL_CENTERS) rc.run(...r);
    for (const s of SERVICE_CODES) sc.run(...s);
  });
}

function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDatabase, transaction, UNIT_TYPES, REGIONAL_CENTERS, SERVICE_CODES };
