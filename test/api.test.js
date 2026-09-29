'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server');

let server;
let base;
let cookie = '';

async function call(method, path, body, { expect = 200, raw = false } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const data = raw ? await res.text() : await res.json();
  assert.equal(res.status, expect, `${method} ${path} -> ${res.status}: ${raw ? data : JSON.stringify(data)}`);
  return data;
}

test.before(async () => {
  server = createServer({ dbFile: ':memory:' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test('end-to-end billing cycle', async () => {
  assert.equal((await call('GET', '/api/setup-status')).needsSetup, true);
  await call('GET', '/api/meta', undefined, { expect: 401 });
  await call('POST', '/api/setup', { username: 'owner', full_name: 'Owner', password: 'short' }, { expect: 400 });
  await call('POST', '/api/setup', { username: 'owner', full_name: 'Owner', password: 'CorrectHorse42', organization_name: 'Test Org' });
  await call('POST', '/api/setup', { username: 'x', full_name: 'x', password: 'CorrectHorse42' }, { expect: 409 });

  const meta = await call('GET', '/api/meta');
  assert.equal(meta.regional_centers.length, 21);
  const rcId = meta.regional_centers.find((r) => r.abbreviation === 'IRC').id;

  const { id: programId } = await call('POST', '/api/programs', {
    name: 'ADP', vendor_number: 'h12345', regional_center_id: rcId, service_code: '510', unit_type: 'day', default_rate: '98.76', full_day_min_hours: 5,
  });
  await call('POST', '/api/consumers', { uci: '12345', first_name: 'A', last_name: 'B', regional_center_id: rcId }, { expect: 400 });
  const { id: consumerId } = await call('POST', '/api/consumers', { uci: '1234567', first_name: 'Test', last_name: 'Person', regional_center_id: rcId });
  await call('POST', '/api/consumers', { uci: '1234567', first_name: 'Dup', last_name: 'Person', regional_center_id: rcId }, { expect: 409 });

  const { id: authId } = await call('POST', '/api/authorizations', {
    auth_number: 'P100', consumer_id: consumerId, program_id: programId, unit_type: 'day', rate: '98.76',
    units_authorized: 3, units_period: 'month', start_date: '2026-01-01', end_date: '2026-12-31',
  });

  const entries = ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05'].map((d) => ({ authorization_id: authId, service_date: d, status: 'present' }));
  entries.push({ authorization_id: authId, service_date: '2026-03-06', status: 'absent', units: '' });
  assert.equal((await call('PUT', '/api/attendance', { entries })).saved, 5);

  const grid = await call('GET', `/api/attendance?program_id=${programId}&month=2026-03`);
  assert.equal(grid.rows.length, 1);
  assert.equal(Object.keys(grid.rows[0].records).length, 5);

  const gen = await call('POST', '/api/invoices/generate', { program_id: programId, month: '2026-03' });
  const invId = gen.results[0].invoice_id;
  let inv = await call('GET', `/api/invoices/${invId}`);
  assert.equal(inv.invoice.total_cents, 3 * 9876); // capped at 3 authorized days
  assert.equal(inv.lines[0].unbilled_units, 1);
  assert.match(inv.invoice.invoice_number, /^202603-H12345-/);

  // Regenerating a draft replaces lines rather than duplicating the invoice.
  await call('POST', '/api/invoices/generate', { program_id: programId, month: '2026-03' });
  assert.equal((await call('GET', '/api/invoices?month=2026-03')).invoices.length, 1);

  await call('POST', `/api/invoices/${invId}/submit`, {});
  await call('PUT', '/api/attendance', { entries: [{ authorization_id: authId, service_date: '2026-03-09', status: 'present' }] }, { expect: 409 });
  await call('POST', '/api/invoices/generate', { program_id: programId, month: '2026-03' }, { expect: 409 });

  const csv = await call('GET', `/api/invoices/${invId}/export.csv`, undefined, { raw: true });
  assert.match(csv, /^Vendor Number,Service Code/);
  assert.match(csv, /H12345,510,,03\/2026,1234567,Person,Test,P100,day,,1,1,1,/);

  const pay = await call('POST', '/api/payments', { regional_center_id: rcId, payment_date: '2026-04-20', amount: '100.00', method: 'eft' });
  assert.equal(pay.applied_cents, 10000);
  inv = await call('GET', `/api/invoices/${invId}`);
  assert.equal(inv.invoice.status, 'partial');
  await call('POST', `/api/invoices/${invId}/void`, { reason: 'x' }, { expect: 409 });

  await call('POST', '/api/payments', { regional_center_id: rcId, payment_date: '2026-04-25', amount: '500.00', method: 'check' });
  inv = await call('GET', `/api/invoices/${invId}`);
  assert.equal(inv.invoice.status, 'paid');

  const aging = await call('GET', '/api/reports/aging');
  assert.equal(aging.totals.total, 0);
  const rev = await call('GET', '/api/reports/revenue');
  assert.equal(rev.by_month[0].billed_cents, 29628);
  assert.equal(rev.by_month[0].collected_cents, 29628);
  const dash = await call('GET', '/api/dashboard');
  assert.equal(dash.kpis.active_consumers, 1);

  // Role enforcement: staff can record attendance but not bill.
  await call('POST', '/api/users', { username: 'staff1', full_name: 'Staff', role: 'staff', password: 'StaffPass123' });
  await call('POST', '/api/logout', {});
  await call('POST', '/api/login', { username: 'staff1', password: 'wrong-password1' }, { expect: 401 });
  await call('POST', '/api/login', { username: 'staff1', password: 'StaffPass123' });
  await call('POST', '/api/invoices/generate', { program_id: programId, month: '2026-04' }, { expect: 403 });
  await call('PUT', '/api/attendance', { entries: [{ authorization_id: authId, service_date: '2026-04-01', status: 'present' }] });
});

test('rejects non-JSON writes (CSRF guard) and sets security headers', async () => {
  const res = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=a' });
  assert.equal(res.status, 415);
  const page = await fetch(base + '/');
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  const trav = await fetch(base + '/..%2f..%2fpackage.json');
  assert.notEqual(await trav.text(), require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'package.json'), 'utf8'));
});
