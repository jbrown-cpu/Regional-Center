'use strict';

// Loads fictitious demo data so the app can be explored end to end. Never run against production data.
const path = require('node:path');
const { openDatabase, transaction } = require('../src/db');
const { hashPassword } = require('../src/auth');
const B = require('../src/billing');

const file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'billing.db');
const db = openDatabase(file);

if (db.prepare('SELECT COUNT(*) AS n FROM consumers').get().n > 0) {
  console.log('Database already has consumers; demo seed skipped.');
  process.exit(0);
}

const rc = (abbr) => db.prepare('SELECT id FROM regional_centers WHERE abbreviation = ?').get(abbr).id;
const now = new Date();
const monthsBack = (n) => { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 1)); return d.toISOString().slice(0, 7); };

transaction(db, () => {
  let adminNote = '';
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
    db.prepare("INSERT INTO users (username, full_name, password_hash, role) VALUES ('admin', 'Demo Administrator', ?, 'admin')")
      .run(hashPassword('DemoAdmin2026'));
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('organization_name', 'Demo Community Services')").run();
    adminNote = 'Sign in with username "admin" and password "DemoAdmin2026" (change it under Settings).';
  }

  const prog = db.prepare(`INSERT INTO programs (name, vendor_number, regional_center_id, service_code, unit_type, default_rate_cents, full_day_min_hours)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const adp = Number(prog.run('Adult Day Program — Main Campus', 'H99001', rc('SG/PRC'), '510', 'day', 9876, 5).lastInsertRowid);
  const bmp = Number(prog.run('Behavior Management Program', 'H99002', rc('ELARC'), '515', 'day', 11250, 5).lastInsertRowid);
  const cit = Number(prog.run('Community Integration Training', 'H99003', rc('SG/PRC'), '055', 'day', 10340, 4).lastInsertRowid);

  const people = [
    ['Avery', 'Sample', '9000001', 'SG/PRC', adp], ['Jordan', 'Example', '9000002', 'SG/PRC', adp], ['Riley', 'Testcase', '9000003', 'SG/PRC', adp],
    ['Morgan', 'Placeholder', '9000004', 'SG/PRC', cit], ['Casey', 'Demo', '9000005', 'ELARC', bmp], ['Quinn', 'Fictional', '9000006', 'ELARC', bmp],
  ];
  const cons = db.prepare(`INSERT INTO consumers (uci, first_name, last_name, regional_center_id, service_coordinator, sc_email)
    VALUES (?, ?, ?, ?, 'Demo Coordinator', 'coordinator@example.org')`);
  const auth = db.prepare(`INSERT INTO authorizations (auth_number, consumer_id, program_id, unit_type, rate_cents, units_authorized, start_date, end_date)
    VALUES (?, ?, ?, 'day', ?, ?, ?, ?)`);
  const att = db.prepare(`INSERT INTO attendance (authorization_id, service_date, status, units, hours) VALUES (?, ?, ?, ?, ?)`);
  const rates = { [adp]: 9876, [bmp]: 11250, [cit]: 10340 };

  people.forEach(([first, last, uci, abbr, programId], i) => {
    const cid = Number(cons.run(uci, first, last, rc(abbr)).lastInsertRowid);
    const start = `${monthsBack(4)}-01`;
    // One authorization expires soon so the renewal alert is visible.
    const end = i === 1 ? B.addDays(now.toISOString().slice(0, 10), 20) : `${monthsBack(-8)}-01`;
    const aid = Number(auth.run(`P${String(7000000 + i * 137)}`, cid, programId, rates[programId], i === 2 ? 18 : 22, start, end).lastInsertRowid);
    for (let back = 3; back >= 0; back--) {
      const m = monthsBack(back);
      const lastDay = back === 0 ? Number(now.toISOString().slice(8, 10)) - 1 : B.daysInMonth(m);
      for (let d = 1; d <= lastDay; d++) {
        const date = `${m}-${String(d).padStart(2, '0')}`;
        if (B.isWeekend(date)) continue;
        const roll = (d * 7 + i * 3 + back) % 17;
        if (roll === 0) att.run(aid, date, 'absent', 0, null);
        else if (roll === 5) att.run(aid, date, 'excused', 0, null);
        else att.run(aid, date, 'present', 1, roll === 9 ? 4 : 6);
      }
    }
  });
  if (adminNote) console.log(adminNote);
});

console.log(`Demo data loaded into ${file}. Generate invoices for ${monthsBack(3)} through ${monthsBack(1)} from the Invoices page.`);
