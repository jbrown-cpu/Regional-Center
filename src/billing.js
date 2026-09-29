'use strict';

// Pure billing logic: no database or HTTP access, so every rule here is unit-testable.
// Money is handled in integer cents throughout to avoid floating-point drift.

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidMonth(month) {
  return typeof month === 'string' && MONTH_RE.test(month);
}

function isValidDate(date) {
  if (typeof date !== 'string' || !DATE_RE.test(date)) return false;
  const d = new Date(date + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

// California DDS Unique Client Identifier: 7 digits.
function isValidUci(uci) {
  return typeof uci === 'string' && /^\d{7}$/.test(uci);
}

function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function monthBounds(month) {
  const n = daysInMonth(month);
  return { start: `${month}-01`, end: `${month}-${String(n).padStart(2, '0')}`, days: n };
}

function dayOfWeek(date) {
  return new Date(date + 'T00:00:00Z').getUTCDay();
}

function isWeekend(date) {
  const d = dayOfWeek(date);
  return d === 0 || d === 6;
}

function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round((new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 86400000);
}

function dollarsToCents(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function centsToDollars(cents) {
  return (Number(cents || 0) / 100).toFixed(2);
}

// Rates may carry fractional cents in some contracts; amount is rounded once, per line.
function lineAmountCents(units, rateCents) {
  return Math.round(Number(units) * Number(rateCents));
}

function roundUnits(u) {
  return Math.round(Number(u) * 100) / 100;
}

const BILLABLE_STATUSES = new Set(['present', 'partial']);

/**
 * Build one invoice line for an authorization for a service month.
 *
 * @param {object} auth  authorization row: { id, start_date, end_date, status, rate_cents,
 *                       units_authorized, units_period ('month'|'total'), unit_type }
 * @param {Array}  attendance rows: { service_date, units, status, hours }
 * @param {string} month 'YYYY-MM'
 * @param {object} opts  { program: { full_day_min_hours, bills_weekends },
 *                         priorBilledUnits: units already billed on other invoices (for 'total' auths),
 *                         today: 'YYYY-MM-DD' }
 * @returns {{ units, rate_cents, amount_cents, daily_units, unbilled_units, flags }}
 */
function buildInvoiceLine(auth, attendance, month, opts = {}) {
  const program = opts.program || {};
  const flags = [];
  const { start, end, days } = monthBounds(month);
  const daily = new Array(days).fill(0);

  if (auth.status && auth.status !== 'active') {
    flags.push({ level: 'error', code: 'AUTH_INACTIVE', message: `Authorization status is "${auth.status}".` });
  }
  if (!auth.rate_cents || auth.rate_cents <= 0) {
    flags.push({ level: 'error', code: 'NO_RATE', message: 'Authorization has no rate on file.' });
  }
  if (auth.end_date < start || auth.start_date > end) {
    flags.push({ level: 'error', code: 'AUTH_OUT_OF_PERIOD', message: 'Authorization does not cover this service month.' });
  }

  let outsideWindow = 0;
  let weekendDays = 0;
  let belowThreshold = 0;
  let requested = 0;

  const sorted = [...attendance].sort((a, b) => (a.service_date < b.service_date ? -1 : 1));
  for (const rec of sorted) {
    if (!rec.service_date.startsWith(month)) continue;
    const units = Number(rec.units) || 0;
    if (!BILLABLE_STATUSES.has(rec.status) || units <= 0) continue;
    if (rec.service_date < auth.start_date || rec.service_date > auth.end_date) {
      outsideWindow += units;
      continue;
    }
    if (!program.bills_weekends && isWeekend(rec.service_date)) weekendDays++;
    if (auth.unit_type === 'day' && program.full_day_min_hours && rec.hours != null && rec.hours !== ''
        && Number(rec.hours) < Number(program.full_day_min_hours) && units >= 1) {
      belowThreshold++;
    }
    const day = Number(rec.service_date.slice(8, 10));
    daily[day - 1] = roundUnits(daily[day - 1] + units);
    requested = roundUnits(requested + units);
  }

  if (outsideWindow > 0) {
    flags.push({ level: 'warning', code: 'OUTSIDE_AUTH_DATES',
      message: `${outsideWindow} unit(s) recorded outside the authorization dates were excluded.` });
  }
  if (weekendDays > 0) {
    flags.push({ level: 'warning', code: 'WEEKEND_SERVICE',
      message: `${weekendDays} weekend service day(s) recorded; confirm the program is vendored for weekend service.` });
  }
  if (belowThreshold > 0) {
    flags.push({ level: 'warning', code: 'BELOW_FULL_DAY',
      message: `${belowThreshold} day(s) billed as a full unit with hours below the ${program.full_day_min_hours}-hour full-day threshold.` });
  }

  // These conditions make the whole line non-billable until the authorization is corrected.
  const blocked = flags.some((f) => f.code === 'AUTH_INACTIVE' || f.code === 'NO_RATE');

  let cap = blocked ? 0 : Number(auth.units_authorized) || 0;
  if (auth.units_period === 'total') cap = Math.max(0, roundUnits(cap - (Number(opts.priorBilledUnits) || 0)));

  let billed = requested;
  let unbilled = 0;
  if (blocked && requested > 0) {
    billed = 0;
    unbilled = requested;
    daily.fill(0);
  } else if (requested > cap) {
    billed = cap;
    unbilled = roundUnits(requested - cap);
    // Trim excess from the end of the month so the per-day grid matches the billed total.
    let excess = unbilled;
    for (let i = daily.length - 1; i >= 0 && excess > 0; i--) {
      const take = Math.min(daily[i], excess);
      daily[i] = roundUnits(daily[i] - take);
      excess = roundUnits(excess - take);
    }
    flags.push({ level: 'error', code: 'EXCEEDS_AUTH',
      message: `${requested} unit(s) recorded but only ${cap} remain authorized; ${unbilled} unit(s) not billed. Request an authorization increase from the service coordinator.` });
  }

  if (opts.today && auth.end_date >= start) {
    const left = daysBetween(opts.today, auth.end_date);
    if (left >= 0 && left <= 30) {
      flags.push({ level: 'warning', code: 'AUTH_EXPIRING',
        message: `Authorization expires ${auth.end_date} (${left} day(s)). Request renewal now to avoid a billing gap.` });
    }
  }

  if (requested === 0 && !flags.some((f) => f.level === 'error')) {
    flags.push({ level: 'info', code: 'NO_SERVICE', message: 'No billable attendance recorded this month.' });
  }

  const rate = Number(auth.rate_cents) || 0;
  return {
    units: billed,
    rate_cents: rate,
    amount_cents: lineAmountCents(billed, rate),
    daily_units: daily,
    unbilled_units: unbilled,
    flags,
  };
}

// Invoice status is derived from what has been paid against what was billed.
function deriveInvoiceStatus(invoice, paidCents) {
  if (invoice.status === 'draft' || invoice.status === 'void') return invoice.status;
  const total = Number(invoice.total_cents) || 0;
  if (paidCents <= 0) return 'submitted';
  if (paidCents >= total) return 'paid';
  return 'partial';
}

const AGING_BUCKETS = [
  { key: 'current', label: '0–30', min: 0, max: 30 },
  { key: 'd31', label: '31–60', min: 31, max: 60 },
  { key: 'd61', label: '61–90', min: 61, max: 90 },
  { key: 'd91', label: '91–120', min: 91, max: 120 },
  { key: 'd120', label: '120+', min: 121, max: Infinity },
];

function agingBucket(fromDate, today) {
  const age = Math.max(0, daysBetween(fromDate, today));
  return AGING_BUCKETS.find((b) => age >= b.min && age <= b.max).key;
}

// Allocate a payment across invoice lines oldest-first, never exceeding each line's open balance.
function autoAllocate(amountCents, openLines) {
  let remaining = amountCents;
  const allocations = [];
  for (const line of openLines) {
    if (remaining <= 0) break;
    const open = Number(line.open_cents) || 0;
    if (open <= 0) continue;
    const take = Math.min(open, remaining);
    allocations.push({ invoice_line_id: line.id, invoice_id: line.invoice_id, amount_cents: take });
    remaining -= take;
  }
  return { allocations, unapplied_cents: remaining };
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  // Neutralize spreadsheet formula injection, then quote.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function toCsv(rows) {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

module.exports = {
  isValidMonth,
  isValidDate,
  isValidUci,
  daysInMonth,
  monthBounds,
  isWeekend,
  addDays,
  daysBetween,
  dollarsToCents,
  centsToDollars,
  lineAmountCents,
  buildInvoiceLine,
  deriveInvoiceStatus,
  AGING_BUCKETS,
  agingBucket,
  autoAllocate,
  toCsv,
  csvCell,
};
