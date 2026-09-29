'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../src/billing');

const auth = (over = {}) => ({
  id: 1, start_date: '2026-01-01', end_date: '2026-12-31', status: 'active', rate_cents: 10000,
  units_authorized: 22, units_period: 'month', unit_type: 'day', ...over,
});
const present = (dates, extra = {}) => dates.map((d) => ({ service_date: d, status: 'present', units: 1, ...extra }));
const weekdays = (month) => {
  const out = [];
  for (let d = 1; d <= B.daysInMonth(month); d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    if (!B.isWeekend(date)) out.push(date);
  }
  return out;
};

test('validators', () => {
  assert.ok(B.isValidUci('1234567'));
  assert.ok(!B.isValidUci('123456'));
  assert.ok(!B.isValidUci('12345678'));
  assert.ok(B.isValidMonth('2026-02'));
  assert.ok(!B.isValidMonth('2026-13'));
  assert.ok(B.isValidDate('2024-02-29'));
  assert.ok(!B.isValidDate('2026-02-29'));
  assert.equal(B.daysInMonth('2026-02'), 28);
});

test('money is exact in cents', () => {
  assert.equal(B.dollarsToCents('$1,234.56'), 123456);
  assert.equal(B.dollarsToCents('98.76'), 9876);
  assert.equal(B.dollarsToCents('abc'), null);
  assert.equal(B.lineAmountCents(21, 9876), 207396);
  assert.equal(B.lineAmountCents(2.5, 4333), 10833);
  assert.equal(B.centsToDollars(207396), '2073.96');
});

test('bills present days within the authorization', () => {
  const line = B.buildInvoiceLine(auth(), present(['2026-03-02', '2026-03-03', '2026-03-04']), '2026-03');
  assert.equal(line.units, 3);
  assert.equal(line.amount_cents, 30000);
  assert.equal(line.daily_units[1], 1);
  assert.equal(line.daily_units.length, 31);
  assert.deepEqual(line.flags, []);
});

test('absences and excused days are never billed', () => {
  const recs = [
    { service_date: '2026-03-02', status: 'present', units: 1 },
    { service_date: '2026-03-03', status: 'absent', units: 1 },
    { service_date: '2026-03-04', status: 'excused', units: 0 },
    { service_date: '2026-03-05', status: 'partial', units: 0.5 },
  ];
  const line = B.buildInvoiceLine(auth(), recs, '2026-03');
  assert.equal(line.units, 1.5);
  assert.equal(line.amount_cents, 15000);
});

test('caps units at the monthly authorization and trims from month end', () => {
  const days = weekdays('2026-03'); // 22 weekdays
  const line = B.buildInvoiceLine(auth({ units_authorized: 20 }), present(days), '2026-03');
  assert.equal(line.units, 20);
  assert.equal(line.unbilled_units, 2);
  assert.equal(line.amount_cents, 200000);
  assert.equal(line.daily_units.reduce((a, b) => a + b, 0), 20);
  assert.equal(line.daily_units[30], 0); // Mar 31 trimmed
  assert.ok(line.flags.some((f) => f.code === 'EXCEEDS_AUTH'));
});

test('total-period authorizations subtract units already billed', () => {
  const a = auth({ units_period: 'total', units_authorized: 100, unit_type: 'hour' });
  const recs = [{ service_date: '2026-03-02', status: 'present', units: 8 }];
  const line = B.buildInvoiceLine(a, recs, '2026-03', { priorBilledUnits: 95 });
  assert.equal(line.units, 5);
  assert.equal(line.unbilled_units, 3);
});

test('excludes service outside authorization dates', () => {
  const a = auth({ start_date: '2026-03-10', end_date: '2026-03-20' });
  const line = B.buildInvoiceLine(a, present(['2026-03-09', '2026-03-10', '2026-03-20', '2026-03-23']), '2026-03');
  assert.equal(line.units, 2);
  assert.ok(line.flags.some((f) => f.code === 'OUTSIDE_AUTH_DATES'));
});

test('inactive or rateless authorizations are not billable', () => {
  const l1 = B.buildInvoiceLine(auth({ status: 'terminated' }), present(['2026-03-02']), '2026-03');
  assert.equal(l1.units, 0);
  assert.equal(l1.unbilled_units, 1);
  const l2 = B.buildInvoiceLine(auth({ rate_cents: 0 }), present(['2026-03-02']), '2026-03');
  assert.equal(l2.amount_cents, 0);
  assert.ok(l2.flags.some((f) => f.code === 'NO_RATE'));
});

test('warns on weekend service and short full days', () => {
  const recs = [
    { service_date: '2026-03-07', status: 'present', units: 1, hours: 6 },
    { service_date: '2026-03-09', status: 'present', units: 1, hours: 3 },
  ];
  const line = B.buildInvoiceLine(auth(), recs, '2026-03', { program: { full_day_min_hours: 5 } });
  assert.ok(line.flags.some((f) => f.code === 'WEEKEND_SERVICE'));
  assert.ok(line.flags.some((f) => f.code === 'BELOW_FULL_DAY'));
  const weekendProgram = B.buildInvoiceLine(auth(), recs, '2026-03', { program: { bills_weekends: 1 } });
  assert.ok(!weekendProgram.flags.some((f) => f.code === 'WEEKEND_SERVICE'));
});

test('warns when the authorization is about to expire', () => {
  const line = B.buildInvoiceLine(auth({ end_date: '2026-04-15' }), present(['2026-03-02']), '2026-03', { today: '2026-04-01' });
  assert.ok(line.flags.some((f) => f.code === 'AUTH_EXPIRING'));
});

test('invoice status follows payments', () => {
  assert.equal(B.deriveInvoiceStatus({ status: 'submitted', total_cents: 1000 }, 0), 'submitted');
  assert.equal(B.deriveInvoiceStatus({ status: 'submitted', total_cents: 1000 }, 400), 'partial');
  assert.equal(B.deriveInvoiceStatus({ status: 'partial', total_cents: 1000 }, 1000), 'paid');
  assert.equal(B.deriveInvoiceStatus({ status: 'draft', total_cents: 1000 }, 0), 'draft');
});

test('aging buckets', () => {
  assert.equal(B.agingBucket('2026-03-01', '2026-03-15'), 'current');
  assert.equal(B.agingBucket('2026-01-01', '2026-03-15'), 'd61');
  assert.equal(B.agingBucket('2025-01-01', '2026-03-15'), 'd120');
});

test('auto-allocation applies oldest first without overpaying lines', () => {
  const r = B.autoAllocate(2500, [{ id: 1, invoice_id: 9, open_cents: 1000 }, { id: 2, invoice_id: 9, open_cents: 1000 }, { id: 3, invoice_id: 10, open_cents: 1000 }]);
  assert.deepEqual(r.allocations.map((a) => a.amount_cents), [1000, 1000, 500]);
  assert.equal(r.unapplied_cents, 0);
  assert.equal(B.autoAllocate(5000, [{ id: 1, invoice_id: 1, open_cents: 1000 }]).unapplied_cents, 4000);
});

test('CSV output escapes quotes and neutralizes formulas', () => {
  const csv = B.toCsv([['a,b', 'say "hi"', '=HYPERLINK("x")', '-5']]);
  assert.equal(csv, '"a,b","say ""hi""","\'=HYPERLINK(""x"")",-5\r\n');
});
