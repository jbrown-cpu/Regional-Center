// Run with: node --test ipv-billing/test/
// All names below are fictional.
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../billing-core.js');

const AUG = { y: 2026, m: 7 };
const days = n => Array.from({ length: n }, (_, i) => i + 1);

function trackerRows(clients, opts = {}) {
  const pad = row => { const r = new Array(33).fill(''); row.forEach((v, i) => { r[i] = v; }); return r; };
  const rows = [
    pad(['ATTENDANCE GOOGLE SHEETS TEMPLATE']),
    pad(['August - 2026', 'A', 'Attended']),
    pad(['Participant', ...days(31).map(d => ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'][(d - 1) % 7])]),
    pad(['List', ...days(31)]),
    pad(['Session #', '', '', '', '2', '', '3']),
  ];
  for (const [name, marks] of clients) {
    const r = pad([name]);
    for (const [d, m] of Object.entries(marks)) r[+d] = m;
    rows.push(r);
  }
  if (opts.tprs) {
    rows.push(pad(['TPRs - Client Names', ...days(31)]));
    for (const n of opts.tprs) rows.push(pad([n]));
  }
  return rows;
}

const grid = clients => {
  const header = [null, 'Program Name and Contract Number', 'File Number (Personal File Number)', 'Other', 'Group Number',
    'Last Name', 'First Name', 'DOB', 'Gender', 'Race', 'ZIP', 'Date Referral Received', 'Date of Initial Contact',
    'Did Client Enroll?', 'Program Entry (Enrollment) Date', 'Service Start Date', 'Program Exit Date ',
    'Program Completion Status (select from dropdown)', 'Discharge Reason', 'Discharge Notes', "Client's assigned Probation Officer",
    'Duration of Intake Appointment:', 'Number of Sessions:', 'Duration of Sessions:', 'Session Type:', 'Session Time:', 'Session Language:',
    'Number of Make-up Sessions:', 'Number of Hours for Make-up Sessions', 'Make-up Session Type (group or individual):'];
  const rows = [{ rowNumber: 1, values: [null, 'Please review'] }, { rowNumber: 3, values: header }];
  clients.forEach((c, i) => {
    const v = new Array(33).fill(null);
    v[2] = c.file; v[4] = c.group; v[5] = c.last; v[6] = c.first;
    v[14] = c.entry || null; v[15] = c.start || null; v[16] = c.exit || null;
    v[17] = c.status || 'Pending/In Progress/Active';
    v[22] = c.V ?? null; v[23] = c.W ?? null; v[27] = c.AA ?? null; v[28] = c.AB ?? null;
    rows.push({ rowNumber: 4 + i, values: v });
  });
  return rows;
};

const d = (m, day) => new Date(Date.UTC(2026, m - 1, day));

test('parses tracker grid: month, day columns, session numbers, marks, TPR list', () => {
  const t = Core.parseTrackerRows(trackerRows([
    ['Rivera Tomas, 7/16, s12, 16s', { 4: 'A', 6: 'MA', 11: 'N', 5: 'M' }],
    ['Blank', {}],
  ], { tprs: ['Oakley Brent'] }), { id: 'T1', fileName: 'Cohort_30_G1a_IPV_Attendance_Tracker.xlsx' });
  assert.equal(t.group, 'G1A');
  assert.deepEqual(t.month, AUG);
  assert.equal(t.sessionNumbers[4], '2');
  assert.equal(t.clients.length, 1);
  assert.equal(t.clients[0].name, 'Rivera Tomas');
  assert.deepEqual(t.clients[0].meta, { startNote: '7/16', startSession: 12, programWeeks: 16 });
  assert.equal(t.tprs[0].name, 'Oakley Brent');
});

test('billing math: A=session, MA=session+makeup, M=makeup, N=absence, hours x1.5', () => {
  const t = Core.parseTrackerRows(trackerRows([['Tomas Rivera', { 4: 'A', 5: 'M', 6: 'MA', 11: 'N', 13: 'A' }]]), { id: 'T', fileName: 'G1a' });
  const roster = Core.parseRoster(grid([{ file: 'AAA111', group: 'G1A', last: 'Rivera', first: 'Tomas', entry: d(8, 3), start: d(8, 4) }])).clients;
  const matches = Object.fromEntries(Object.entries(Core.autoMatch([t], roster)).map(([k, v]) => [k, v.key]));
  const res = Core.computeBilling({ month: AUG, roster, trackers: [t], matches });
  const c = res.rows[0].computed;
  assert.equal(c.sessions, 3);
  assert.equal(c.hours, 4.5);
  assert.equal(c.makeups, 2);
  assert.equal(c.makeupHours, 3);
  assert.equal(c.intake, 1);
  assert.equal(c.makeupType, 'Individual');
  assert.equal(c.absences, 1);
});

test('fuzzy name matching handles misspellings, reversed order, compound surnames, nicknames', () => {
  const roster = Core.parseRoster(grid([
    { file: 'F1', group: 'G1D', last: 'Whitfield Ross', first: 'Keandre' },
    { file: 'F2', group: 'G2B', last: 'Stuckert', first: 'Carl' },
    { file: 'F3', group: 'G1B', last: 'Holloway', first: 'Melvin "Mel"' },
    { file: 'F4', group: 'G1B', last: 'Holloway', first: 'Darius' },
  ])).clients;
  const cases = [['Keandra Whitfield', 'G1D', 'F:F1'], ['Carl Stuckart', 'G2B', 'F:F2'], ['Mel Holloway', 'G1B', 'F:F3'], ['Darius Holloway', 'G1B', 'F:F4']];
  for (const [name, group, key] of cases) {
    const top = Core.candidates({ name, aliases: [] }, roster, group, 1)[0];
    assert.equal(top.key, key, name);
  }
});

test('flags attendance after exit, unmatched rows, missing exit date, hours math errors', () => {
  const t = Core.parseTrackerRows(trackerRows([
    ['Tomas Rivera', { 4: 'A', 20: 'A' }],
    ['Zed Nobody', { 4: 'A' }],
  ]), { id: 'T', fileName: 'G1a' });
  const roster = Core.parseRoster(grid([
    { file: 'A1', group: 'G1A', last: 'Rivera', first: 'Tomas', entry: d(6, 1), start: d(6, 2), exit: d(8, 14), status: 'Completed ' },
    { file: 'A2', group: 'G1A', last: 'Quill', first: 'Owen', entry: d(5, 1), status: 'Completed ', V: 3, W: 3 },
  ])).clients;
  const auto = Core.autoMatch([t], roster);
  const matches = Object.fromEntries(Object.entries(auto).map(([k, v]) => [k, v.key]));
  const res = Core.computeBilling({ month: AUG, roster, trackers: [t], matches });
  const codes = res.findings.map(f => f.code || f.severity);
  assert.ok(res.findings.some(f => f.code === 'AFTER_EXIT' && /8\/20\/2026/.test(f.message)));
  assert.ok(res.unmatched.some(u => u.name === 'Zed Nobody'));
  assert.ok(codes.includes('NO_EXIT_DATE'));
  assert.ok(codes.includes('HOURS_MATH'));
  assert.equal(res.findings[0].severity, 'critical');
});

test('same client in two groups on one date is counted once', () => {
  const a = Core.parseTrackerRows(trackerRows([['Tomas Rivera', { 4: 'A' }]]), { id: 'A', fileName: 'G1a' });
  const b = Core.parseTrackerRows(trackerRows([['Tomas Rivera', { 4: 'A', 6: 'A' }]]), { id: 'B', fileName: 'G2a' });
  const roster = Core.parseRoster(grid([{ file: 'A1', group: 'G1A', last: 'Rivera', first: 'Tomas', start: d(7, 1), entry: d(7, 1) }])).clients;
  const matches = Object.fromEntries(Object.entries(Core.autoMatch([a, b], roster)).map(([k, v]) => [k, v.key]));
  const res = Core.computeBilling({ month: AUG, roster, trackers: [a, b], matches });
  assert.equal(res.rows[0].computed.sessions, 2);
  assert.ok(res.rows[0].flags.some(f => f.code === 'DUP_DATE'));
});

test('month tab lookup and date parsing', () => {
  assert.equal(Core.findMonthSheet(['Lists', 'Instructions', 'July2026', 'Aug2026', 'Sept2026'], AUG), 'Aug2026');
  assert.equal(Core.findMonthSheet(['July2026', 'Aug2026', 'Sept2026'], { y: 2026, m: 8 }), 'Sept2026');
  assert.equal(Core.fmtDate(Core.toDate('5/21/2026]')), '5/21/2026');
  assert.equal(Core.toDate('1/19/0200'), null);
  assert.equal(Core.groupFromText('2026_Group_1a__M1_Cohort_21'), 'G1A');
  assert.equal(Core.groupFromText('Cohort_24_G1d_IPV_Attendance'), 'G1D');
  assert.equal(Core.groupFromText('FACES_IPV_G2B_Cohort22'), 'G2B');
});

test('PDF text items rebuild into day columns', () => {
  const header = days(31).map(n => ({ str: String(n), x: 200 + n * 20, y: 700, w: 8 }));
  const pages = [{ items: [
    { str: 'August - 2026', x: 40, y: 760, w: 60 },
    { str: 'Names', x: 40, y: 700, w: 30 }, ...header,
    { str: 'Tomas Rivera 7/16, s12, 16s', x: 40, y: 680, w: 140 },
    { str: 'A', x: 200 + 4 * 20, y: 680, w: 7 },
    { str: 'MA', x: 200 + 6 * 20 - 3, y: 680, w: 12 },
  ] }];
  const rows = Core.pdfItemsToRows(pages);
  const t = Core.parseTrackerRows(rows, { id: 'P', fileName: 'G1b.pdf' });
  assert.deepEqual(t.month, AUG);
  assert.deepEqual(t.clients[0].marks, { 4: 'A', 6: 'MA' });
});

test('xlsx cell patch keeps styles, column order and untouched cells', () => {
  const xml = '<worksheet><sheetData><row r="4" spans="1:32"><c r="E4" s="2" t="s"><v>9</v></c><c r="V4" s="7"/><c r="AF4" s="3"/></row><row r="6"><c r="A6"><v>1</v></c></row></sheetData></worksheet>';
  const out = Core.patchSheetXml(xml, [
    { row: 4, col: 22, value: 8 }, { row: 4, col: 23, value: 12 }, { row: 4, col: 29, value: 'Individual & Group' },
    { row: 5, col: 22, value: 3 },
  ]);
  assert.match(out, /<c r="E4" s="2" t="s"><v>9<\/v><\/c><c r="V4" s="7"><v>8<\/v><\/c><c r="W4"><v>12<\/v><\/c><c r="AC4" t="inlineStr"><is><t>Individual &amp; Group<\/t><\/is><\/c><c r="AF4" s="3"\/>/);
  assert.match(out, /<row r="5"><c r="V5"><v>3<\/v><\/c><\/row><row r="6">/);
  assert.equal(Core.colLetters(29), 'AC');
  assert.equal(Core.colNumber('AF'), 32);
});

test('patchXlsxEntries finds the tab by name and changes only that sheet', () => {
  const enc = s => new TextEncoder().encode(s);
  const entries = {
    'xl/workbook.xml': enc('<workbook><sheets><sheet name="Lists" sheetId="1" r:id="rId1"/><sheet name="Aug2026" sheetId="4" r:id="rId7"/></sheets><calcPr calcId="1"/></workbook>'),
    'xl/_rels/workbook.xml.rels': enc('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId7" Target="worksheets/sheet4.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': enc('<worksheet><sheetData/></worksheet>'),
    'xl/worksheets/sheet4.xml': enc('<worksheet><sheetData><row r="4"><c r="V4" s="1"/></row></sheetData></worksheet>'),
  };
  const { entries: out, path } = Core.patchXlsxEntries(entries, 'Aug2026', [{ row: 4, col: 22, value: 6 }]);
  assert.equal(path, 'xl/worksheets/sheet4.xml');
  assert.equal(out['xl/worksheets/sheet1.xml'], entries['xl/worksheets/sheet1.xml']);
  assert.match(new TextDecoder().decode(out[path]), /<c r="V4" s="1"><v>6<\/v><\/c>/);
  assert.match(new TextDecoder().decode(out['xl/workbook.xml']), /fullCalcOnLoad="1"/);
});
