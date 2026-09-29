/*
 * FACES Adult IPV Billing — core engine.
 *
 * Pure functions only (no DOM, no file I/O) so the same rules run in the
 * browser app and in the Node test suite.
 *
 * Billing rules, derived from the approved FY27 County Client List and the
 * monthly Google Sheets attendance trackers:
 *   A  = Attended            -> 1 group session
 *   MA = Makeup + Attended   -> 1 group session + 1 make-up session
 *   M  = Makeup only         -> 1 make-up session
 *   N  = Not attended        -> not billable (tracked as an absence)
 *   -  = Not enrolled / n/a  -> ignored
 *   Duration of Sessions (hours)        = sessions x 1.5
 *   Hours for Make-up Sessions          = make-ups x 1.5
 *   Duration of Intake Appointment      = 1.0 when the client enrolled this month
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.IPVCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const BILLABLE = { A: { session: 1, makeup: 0 }, MA: { session: 1, makeup: 1 }, M: { session: 0, makeup: 1 } };
  const ATTENDANCE_MARKS = new Set(['A', 'N', 'M', 'MA']);
  const PAGE_HEAD = '\u00a7page-head';
  const JUNK_NAME = /^(e|only|attended.*|attendanc.*|makeup.*|not makeup.*|not attended.*|-)$/i;

  const DEFAULT_SETTINGS = {
    sessionHours: 1.5,
    intakeHours: 1.0,
    defaultMakeupType: 'Individual',
    rateGroupHour: 0,
    rateMakeupHour: 0,
    rateIntake: 0,
  };

  /* ---------------------------------------------------------------- utils */

  function str(v) {
    if (v == null) return '';
    if (v instanceof Date) return fmtDate(v);
    if (typeof v === 'object') {
      if (Array.isArray(v.richText)) return str(v.richText.map(r => r.text).join(''));
      if ('result' in v) return str(v.result);
      if ('text' in v) return str(v.text);
      return '';
    }
    return String(v).replace(/\s+/g, ' ').trim();
  }

  function daysInMonth(y, m) { return new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); }

  function utc(y, m, d) { return new Date(Date.UTC(y, m, d)); }

  function fmtDate(d) {
    if (!(d instanceof Date) || isNaN(d)) return '';
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
  }

  function monthLabel(month) { return `${MONTHS[month.m]} ${month.y}`; }

  /** Any Excel/CSV cell value -> UTC midnight Date, or null. */
  function toDate(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return isNaN(v) ? null : utc(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate());
    if (typeof v === 'object') return toDate('result' in v ? v.result : str(v));
    if (typeof v === 'number') {
      if (v < 20000 || v > 80000) return null; // not a plausible Excel serial date
      const d = new Date(Math.round((v - 25569) * 86400000));
      return utc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    }
    const s = str(v);
    let m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
    if (m) {
      let y = +m[3];
      if (y < 100) y += 2000;
      if (y < 1900 || y > 2100) return null;
      return utc(y, +m[1] - 1, +m[2]);
    }
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return utc(+m[1], +m[2] - 1, +m[3]);
    return null;
  }

  function toNumber(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v;
    if (typeof v === 'object' && 'result' in v) return toNumber(v.result);
    const n = parseFloat(str(v));
    return isNaN(n) ? null : n;
  }

  function inMonth(d, month) {
    return !!d && d.getUTCFullYear() === month.y && d.getUTCMonth() === month.m;
  }

  /* ------------------------------------------------------ month / group */

  const MONTH_RE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b[\s._-]*(20\d\d)/i;

  function monthFromText(text) {
    const m = str(text).match(MONTH_RE);
    if (!m) return null;
    const key = m[1].slice(0, 3).toLowerCase();
    const idx = MONTHS.findIndex(n => n.slice(0, 3).toLowerCase() === key);
    return idx < 0 ? null : { y: +m[2], m: idx };
  }

  /** "Group_1a", "G1b", "G2B", "Cohort_24_G1d" -> "G1A" etc. */
  function groupFromText(text) {
    const m = str(text).replace(/_/g, ' ').match(/(?:^|[^a-z])g(?:roup)?[\s-]*([12])[\s-]*([a-d])(?![a-z])/i);
    return m ? `G${m[1]}${m[2].toUpperCase()}` : '';
  }

  function cohortFromText(text) {
    const m = str(text).replace(/_/g, ' ').match(/cohort[\s-]*(\d{1,3})/i);
    return m ? m[1] : '';
  }

  /* -------------------------------------------------- tracker parsing */

  function isDayHeaderRow(row) {
    const cols = {};
    let expect = 1;
    for (let c = 0; c < row.length; c++) {
      const s = str(row[c]);
      if (!/^\d{1,2}$/.test(s)) continue;
      const n = +s;
      if (n === expect) { cols[n] = c; expect++; }
    }
    return expect - 1 >= 28 ? cols : null;
  }

  function isWeekdayRow(row) {
    let n = 0;
    for (const v of row) if (WEEKDAYS.includes(str(v).slice(0, 3).toLowerCase()) && str(v).length <= 9) n++;
    return n >= 28;
  }

  function weekdayHeaderCols(row, month) {
    const cols = {};
    let day = 0;
    for (let c = 0; c < row.length; c++) {
      const w = str(row[c]).slice(0, 3).toLowerCase();
      if (!WEEKDAYS.includes(w)) continue;
      day++;
      if (day === 1 && month && WEEKDAYS[utc(month.y, month.m, 1).getUTCDay()] !== w) return null;
      cols[day] = c;
    }
    return day >= 28 ? cols : null;
  }

  function cleanTrackerName(raw) {
    let s = str(raw);
    const aliases = [];
    s = s.replace(/["“”']([^"“”']+)["“”']/g, (_, a) => { aliases.push(a); return ' '; });
    s = s.replace(/\([^)]*\)/g, ' ');
    s = s.split(',')[0];
    s = s.split(/\d/)[0];
    s = s.replace(/[^A-Za-zÀ-ÿ.\-\s']/g, ' ').replace(/\s+/g, ' ').trim();
    s = s.replace(/(\s+[A-Za-z])+$/, '').trim();
    return { name: s, aliases };
  }

  /** Pulls "7/23, s14, 16s" style notes out of a tracker name cell. */
  function trackerNameMeta(raw) {
    const s = str(raw);
    const meta = {};
    const d = s.match(/(\d{1,2})\s*\/\s*-?(\d{1,2})/);
    if (d) meta.startNote = `${d[1]}/${d[2]}`;
    const rest = s.replace(/\d{1,2}\s*\/\s*-?\d{1,2}/g, ' ');
    const sess = rest.match(/\bs-?(\d{1,2})\b/i) || rest.match(/session\s*(\d{1,2})/i);
    if (sess) meta.startSession = +sess[1];
    const prog = rest.match(/\b(16|52)\s*s?\b/i);
    if (prog) meta.programWeeks = +prog[1];
    return meta;
  }

  /**
   * Parse one monthly attendance grid.
   * rows: array of arrays (cell values). Works for Google Sheets CSV/XLSX
   * exports and for rows reconstructed from a PDF export.
   */
  function parseTrackerRows(rows, info) {
    info = info || {};
    const text = [info.title, info.fileName].filter(Boolean).join(' ');
    const tracker = {
      id: info.id || '',
      source: info.source || 'file',
      fileName: info.fileName || '',
      title: info.title || info.fileName || '',
      group: info.group || groupFromText(text),
      cohort: cohortFromText(text),
      month: null,
      sessionNumbers: {},
      clients: [],
      tprs: [],
      warnings: [],
    };

    for (let r = 0; r < Math.min(rows.length, 40) && !tracker.month; r++) {
      for (const v of rows[r]) { const m = monthFromText(v); if (m) { tracker.month = m; break; } }
    }
    if (!tracker.month) tracker.month = monthFromText(text.replace(/_/g, ' '));
    const month = tracker.month || info.fallbackMonth || null;

    let dayCols = null;
    let headerRow = -1;
    for (let r = 0; r < rows.length && !dayCols; r++) {
      dayCols = isDayHeaderRow(rows[r]);
      if (dayCols) headerRow = r;
    }
    if (!dayCols) {
      for (let r = 0; r < rows.length && !dayCols; r++) {
        if (isWeekdayRow(rows[r])) { dayCols = weekdayHeaderCols(rows[r], month); if (dayCols) headerRow = r; }
      }
    }
    if (!dayCols) {
      tracker.warnings.push('Could not find the 1–31 day header row. Is this the monthly attendance tab?');
      return tracker;
    }
    tracker.daysFound = Object.keys(dayCols).length;
    const firstDayCol = dayCols[1];
    const days = Object.keys(dayCols).map(Number);

    let mode = 'clients';
    let lastClient = null;
    let expectSessionRow = true;

    for (let r = headerRow + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      if (row[0] === PAGE_HEAD) continue;
      const name = row.slice(0, firstDayCol).map(str).filter(Boolean).join(' ').trim();
      if (/tpr/i.test(name) && /client|name/i.test(name)) { mode = 'tpr'; continue; }
      if (isDayHeaderRow(row) || isWeekdayRow(row)) {
        expectSessionRow = false;
        continue;
      }
      const marks = {};
      for (const d of days) {
        const v = str(row[dayCols[d]]).toUpperCase();
        if (v) marks[d] = v;
      }
      const markVals = Object.values(marks);
      const lname = name.toLowerCase();

      if (/attendance google sheets|monthly section|back to menu/.test(lname)) continue;
      if (/^(client|participant)?\s*(names?|list)$/.test(lname)) continue;
      if (/^(session|lesson)\b/.test(lname)) {
        for (const d of days) if (marks[d] && marks[d] !== '-') tracker.sessionNumbers[d] = marks[d];
        expectSessionRow = false;
        continue;
      }

      if (!name) {
        // Session numbers sometimes sit on their own line in PDF exports.
        if (expectSessionRow && markVals.length && markVals.every(v => /^\d+(\/\d+)?$/.test(v))) {
          for (const d of days) if (marks[d]) tracker.sessionNumbers[d] = marks[d];
          continue;
        }
        const att = markVals.filter(v => ATTENDANCE_MARKS.has(v));
        if (att.length && mode === 'clients') {
          if (lastClient && !lastClient.hasAttendance) {
            Object.assign(lastClient.marks, marks);
            lastClient.hasAttendance = true;
          } else {
            tracker.warnings.push(`Attendance marks with no client name (row ${r + 1}).`);
          }
        }
        continue;
      }
      if (/^blank$/i.test(name) || JUNK_NAME.test(name) || /^[\d\s.]+$/.test(name) || /^(tpr|term\.?)$/i.test(name)) continue;
      expectSessionRow = false;

      if (mode === 'tpr') {
        tracker.tprs.push({ rawName: name, ...cleanTrackerName(name) });
        continue;
      }
      const cleaned = cleanTrackerName(name);
      const client = {
        id: `${tracker.id}#${tracker.clients.length}`,
        rawName: name,
        name: cleaned.name,
        aliases: cleaned.aliases,
        meta: trackerNameMeta(name),
        marks,
        hasAttendance: markVals.some(v => ATTENDANCE_MARKS.has(v)),
        unknownMarks: Object.entries(marks).filter(([, v]) => v !== '-' && !ATTENDANCE_MARKS.has(v) && /^[A-Z.]{1,4}$/.test(v)).map(([d, v]) => ({ day: +d, mark: v })),
      };
      tracker.clients.push(client);
      lastClient = client;
    }

    const classDays = new Set(Object.keys(tracker.sessionNumbers).map(Number));
    for (const c of tracker.clients) for (const [d, v] of Object.entries(c.marks)) if (v === 'A' || v === 'N' || v === 'MA') classDays.add(+d);
    tracker.classDays = [...classDays].sort((a, b) => a - b);
    const unknown = new Set(tracker.clients.flatMap(c => c.unknownMarks.map(u => u.mark)));
    if (unknown.size) tracker.warnings.push(`Unrecognized marks ignored (not billed): ${[...unknown].join(', ')}. Only A, MA, M and N are counted.`);
    if (!tracker.clients.length) tracker.warnings.push('No client rows found under the day header.');
    return tracker;
  }

  /**
   * Rebuild spreadsheet-like rows from PDF text items.
   * pages: [{ items: [{ str, x, y, w }] }]  (x/y in PDF points, y grows upward)
   * Output rows: [name, day1, ..., dayN]; a header row is ['', 1, 2, ..., N].
   */
  function pdfItemsToRows(pages) {
    const rows = [];
    for (const page of pages) {
      const items = page.items.filter(it => str(it.str));
      // Group items into visual lines.
      const sorted = items.slice().sort((a, b) => b.y - a.y || a.x - b.x);
      const lines = [];
      for (const it of sorted) {
        const line = lines.find(l => Math.abs(l.y - it.y) <= 2.5);
        if (line) line.items.push(it); else lines.push({ y: it.y, items: [it] });
      }
      lines.sort((a, b) => b.y - a.y);
      for (const l of lines) l.items.sort((a, b) => a.x - b.x);

      const words = it => {
        const out = [];
        const s = it.str;
        const cw = s.length ? (it.w || 0) / s.length : 0;
        const re = /\S+/g;
        let m;
        while ((m = re.exec(s))) out.push({ text: m[0], x0: it.x + m.index * cw, x1: it.x + (m.index + m[0].length) * cw });
        return out;
      };

      // Locate the 1..31 header line.
      let dayX = null;
      let headerIdx = -1;
      for (let i = 0; i < lines.length && !dayX; i++) {
        const ws = lines[i].items.flatMap(words);
        const xs = {};
        let expect = 1;
        for (const w of ws) if (/^\d{1,2}$/.test(w.text) && +w.text === expect) { xs[expect] = (w.x0 + w.x1) / 2; expect++; }
        if (expect - 1 >= 28) { dayX = xs; headerIdx = i; }
      }
      if (!dayX) { for (const l of lines) rows.push([l.items.map(i => i.str).join(' ')]); continue; }

      const nDays = Object.keys(dayX).length;
      const gaps = [];
      for (let d = 2; d <= nDays; d++) gaps.push(dayX[d] - dayX[d - 1]);
      gaps.sort((a, b) => a - b);
      const gap = gaps[Math.floor(gaps.length / 2)] || 10;
      const nameLimit = dayX[1] - gap * 0.55;
      const nearestDay = x => {
        let best = 0; let bd = Infinity;
        for (let d = 1; d <= nDays; d++) { const dd = Math.abs(dayX[d] - x); if (dd < bd) { bd = dd; best = d; } }
        return bd <= gap * 0.5 ? best : 0;
      };

      lines.forEach((line, i) => {
        if (i < headerIdx) { rows.push([PAGE_HEAD, line.items.map(it => it.str).join(' ')]); return; }
        if (i === headerIdx) { rows.push(['', ...Array.from({ length: nDays }, (_, k) => k + 1)]); return; }
        const row = new Array(nDays + 1).fill('');
        const nameParts = [];
        for (const it of line.items) {
          const itEnd = it.x + (it.w || 0);
          if (itEnd <= nameLimit) { nameParts.push(it.str); continue; }
          for (const w of words(it)) {
            const cx = (w.x0 + w.x1) / 2;
            if (cx < nameLimit) { nameParts.push(w.text); continue; }
            const d = nearestDay(cx);
            if (d) row[d] = row[d] ? `${row[d]} ${w.text}` : w.text;
          }
        }
        row[0] = nameParts.join(' ').replace(/\s+/g, ' ').trim();
        rows.push(row);
      });
    }
    return rows;
  }

  /* --------------------------------------------------------- CSV parse */

  function parseCSV(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  /* ------------------------------------------------------ roster parse */

  const ROSTER_FIELDS = [
    ['program', /program name and contract/i],
    ['fileNo', /file number/i],
    ['otherId', /other identifying/i],
    ['group', /group number/i],
    ['last', /last name/i],
    ['first', /first name/i],
    ['entry', /program entry/i],
    ['start', /service start/i],
    ['exit', /program exit/i],
    ['status', /completion status/i],
    ['reason', /discharge reason/i],
    ['po', /probation officer/i],
    ['intake', /intake appointment/i],
    ['sessions', /^number of sessions/i],
    ['hours', /^duration of sessions/i],
    ['sessionType', /^session type/i],
    ['makeups', /number of make-?\s?up sessions/i],
    ['makeupHours', /hours for make-?\s?up/i],
    ['makeupType', /make-?\s?up session type/i],
    ['notes', /service notes/i],
  ];

  function normStatus(s) {
    const t = str(s).toLowerCase();
    if (!t) return 'unknown';
    if (/non-?\s?completion/.test(t)) return 'noncompletion';
    if (/complet/.test(t)) return 'completed';
    if (/pending|progress|active/.test(t)) return 'active';
    return 'other';
  }

  /**
   * grid: array of { rowNumber, values } where values[colNumber] (1-based)
   * holds the raw cell value. Returns { columns, header, clients }.
   */
  function parseRoster(grid, sheetName) {
    let headerIdx = -1;
    const columns = {};
    for (let i = 0; i < Math.min(grid.length, 12) && headerIdx < 0; i++) {
      const vals = grid[i].values || [];
      if (!vals.some(v => /last name/i.test(str(v)))) continue;
      headerIdx = i;
      vals.forEach((v, col) => {
        const s = str(v);
        if (!s) return;
        for (const [key, re] of ROSTER_FIELDS) if (!columns[key] && re.test(s)) { columns[key] = col; break; }
      });
    }
    if (headerIdx < 0) return { sheetName, columns, clients: [], error: 'No "Last Name" header found in the first 12 rows.' };

    const clients = [];
    for (let i = headerIdx + 1; i < grid.length; i++) {
      const vals = grid[i].values || [];
      const get = k => (columns[k] ? vals[columns[k]] : null);
      const last = str(get('last'));
      const first = str(get('first'));
      if (!last && !first) continue;
      const fileNo = str(get('fileNo'));
      clients.push({
        key: fileNo ? `F:${fileNo}` : `R:${grid[i].rowNumber}`,
        rowNumber: grid[i].rowNumber,
        fileNo,
        group: str(get('group')).toUpperCase(),
        last, first,
        display: `${last}, ${first}`,
        entry: toDate(get('entry')),
        start: toDate(get('start')),
        exit: toDate(get('exit')),
        statusRaw: str(get('status')),
        status: normStatus(get('status')),
        reason: str(get('reason')),
        po: str(get('po')),
        notes: str(get('notes')),
        current: {
          intake: toNumber(get('intake')),
          sessions: toNumber(get('sessions')),
          hours: toNumber(get('hours')),
          makeups: toNumber(get('makeups')),
          makeupHours: toNumber(get('makeupHours')),
          makeupType: str(get('makeupType')),
        },
      });
    }
    return { sheetName, columns, headerRowNumber: grid[headerIdx].rowNumber, clients };
  }

  /** Picks the month tab: "Aug2026", "Sept2026", "July2026"... */
  function findMonthSheet(names, month) {
    const full = MONTHS[month.m].toLowerCase();
    return names.find(n => {
      const s = n.toLowerCase().replace(/[\s_-]/g, '');
      const mm = s.match(/^([a-z]+)(\d{4})$/);
      return mm && +mm[2] === month.y && mm[1].length >= 3 && full.startsWith(mm[1]);
    }) || null;
  }

  /* ---------------------------------------------------- name matching */

  function jaroWinkler(a, b) {
    if (a === b) return 1;
    if (!a || !b) return 0;
    const md = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
    const am = new Array(a.length).fill(false);
    const bm = new Array(b.length).fill(false);
    let m = 0;
    for (let i = 0; i < a.length; i++) {
      for (let j = Math.max(0, i - md); j < Math.min(b.length, i + md + 1); j++) {
        if (bm[j] || a[i] !== b[j]) continue;
        am[i] = bm[j] = true; m++; break;
      }
    }
    if (!m) return 0;
    let t = 0; let k = 0;
    for (let i = 0; i < a.length; i++) {
      if (!am[i]) continue;
      while (!bm[k]) k++;
      if (a[i] !== b[k]) t++;
      k++;
    }
    const j = (m / a.length + m / b.length + (m - t / 2) / m) / 3;
    let p = 0;
    while (p < 4 && a[p] === b[p]) p++;
    return j + p * 0.1 * (1 - j);
  }

  const STOP = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'de', 'la', 'del']);
  function tokens(s) {
    return str(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[^a-z\s-]/g, ' ').split(/[\s-]+/).filter(t => t.length > 1 && !STOP.has(t));
  }
  function withJoins(ts) {
    const out = ts.slice();
    for (let i = 0; i + 1 < ts.length; i++) out.push(ts[i] + ts[i + 1]);
    return out;
  }
  function best(as, bs) {
    let b = 0;
    for (const x of as) for (const y of bs) b = Math.max(b, jaroWinkler(x, y));
    return b;
  }

  function rosterNameParts(c) {
    const aliases = [];
    const strip = s => str(s).replace(/["“”]([^"“”]+)["“”]/g, (_, a) => { aliases.push(a); return ' '; });
    const last = tokens(strip(c.last));
    const first = tokens(strip(c.first));
    return { last, first, aliases: aliases.flatMap(tokens) };
  }

  function scoreName(trackerClient, rosterClient, trackerGroup) {
    const tt = withJoins(tokens(trackerClient.name).concat(trackerClient.aliases.flatMap(tokens)));
    if (!tt.length) return 0;
    const p = rosterClient._parts || (rosterClient._parts = rosterNameParts(rosterClient));
    if (!p.last.length) return 0;
    const lastScore = best(withJoins(p.last), tt);
    const firstScore = p.first.length ? best([p.first[0], ...p.aliases], tt) : lastScore;
    let s = 0.55 * lastScore + 0.45 * firstScore;
    if (trackerGroup && rosterClient.group === trackerGroup) s += 0.03;
    return Math.min(1, s);
  }

  /** Ranked roster candidates for a tracker row. */
  function candidates(trackerClient, roster, trackerGroup, limit) {
    return roster.map(rc => ({ key: rc.key, score: scoreName(trackerClient, rc, trackerGroup) }))
      .sort((a, b) => b.score - a.score).slice(0, limit || 5);
  }

  /**
   * Suggests a roster match per tracker row that has attendance.
   * Returns { [trackerClientId]: { key, score, confidence: 'auto'|'review'|'none' } }
   */
  function autoMatch(trackers, roster) {
    const out = {};
    for (const t of trackers) {
      for (const c of t.clients) {
        if (!c.hasAttendance) continue;
        const cand = candidates(c, roster, t.group, 2);
        const top = cand[0];
        const margin = top ? top.score - (cand[1] ? cand[1].score : 0) : 0;
        let confidence = 'none';
        if (top && top.score >= 0.88 && margin >= 0.04) confidence = 'auto';
        else if (top && top.score >= 0.75) confidence = 'review';
        out[c.id] = { key: confidence === 'none' ? null : top.key, score: top ? top.score : 0, confidence };
      }
    }
    return out;
  }

  /* ----------------------------------------------------------- billing */

  function round2(n) { return Math.round(n * 100) / 100; }

  /**
   * state = { month, settings, roster (clients[]), trackers[], matches, overrides }
   *  matches:   { trackerClientId: rosterKey | null }
   *  overrides: { rosterKey: { intake?: boolean, makeupType?: string } }
   */
  function computeBilling(state) {
    const month = state.month;
    const S = Object.assign({}, DEFAULT_SETTINGS, state.settings || {});
    const roster = state.roster || [];
    const trackers = state.trackers || [];
    const matches = state.matches || {};
    const overrides = state.overrides || {};
    const monthStart = utc(month.y, month.m, 1);
    const monthEnd = utc(month.y, month.m, daysInMonth(month.y, month.m));
    const loadedGroups = new Set(trackers.map(t => t.group).filter(Boolean));
    const byKey = new Map(roster.map(c => [c.key, c]));

    const activity = new Map(); // rosterKey -> [{day, mark, group, tracker, session}]
    const unmatched = [];
    const trackerNotes = [];
    const tprNames = new Map(); // rosterKey -> [group]

    for (const t of trackers) {
      if (t.month && (t.month.y !== month.y || t.month.m !== month.m)) {
        trackerNotes.push({ severity: 'critical', tracker: t.title, message: `Tracker is for ${monthLabel(t.month)}, but you are billing ${monthLabel(month)}.` });
      }
      if (!t.group) trackerNotes.push({ severity: 'warning', tracker: t.title, message: 'Group code not detected. Set it so roster checks can run.' });
      for (const c of t.clients) {
        if (!c.hasAttendance) continue;
        const key = matches[c.id];
        if (!key || !byKey.has(key)) {
          unmatched.push({ tracker: t.title, group: t.group, name: c.rawName, marks: c.marks });
          continue;
        }
        const list = activity.get(key) || [];
        for (const [d, mark] of Object.entries(c.marks)) {
          if (!ATTENDANCE_MARKS.has(mark)) continue;
          list.push({ day: +d, mark, group: t.group, tracker: t.title, session: t.sessionNumbers[d] || '' });
        }
        activity.set(key, list);
      }
      for (const tp of t.tprs) {
        const cand = candidates({ name: tp.name, aliases: tp.aliases || [] }, roster, t.group, 1)[0];
        if (cand && cand.score >= 0.9) tprNames.set(cand.key, (tprNames.get(cand.key) || []).concat(t.group));
      }
    }

    const rows = [];
    for (const rc of roster) {
      const acts = (activity.get(rc.key) || []).sort((a, b) => a.day - b.day);
      const inScope = loadedGroups.has(rc.group) || acts.length > 0;
      if (!inScope) continue;
      const ov = overrides[rc.key] || {};
      const flags = [];
      const flag = (severity, code, message) => flags.push({ severity, code, message });

      let sessions = 0; let makeups = 0; let absences = 0;
      const seen = new Map();
      const afterExit = [];
      const beforeStart = [];
      const startRef = rc.start || rc.entry;
      for (const a of acts) {
        const b = BILLABLE[a.mark];
        if (a.mark === 'N') absences++;
        if (!b) continue;
        const date = utc(month.y, month.m, a.day);
        const dup = seen.get(a.day);
        if (dup && b.session && dup.session) {
          flag('warning', 'DUP_DATE', `Billed in two groups on ${fmtDate(date)} (${dup.group} and ${a.group}). Only one session counted.`);
          continue;
        }
        seen.set(a.day, { group: a.group, session: b.session });
        a.billed = true;
        sessions += b.session; makeups += b.makeup;
        if (rc.exit && date > rc.exit) afterExit.push(fmtDate(date));
        if (startRef && date < startRef) beforeStart.push(fmtDate(date));
      }
      if (afterExit.length) {
        flag('critical', 'AFTER_EXIT', `Billed attendance after the program exit date ${fmtDate(rc.exit)}: ${afterExit.join(', ')}. Correct the exit date or the tracker.`);
      }
      if (beforeStart.length) {
        flag('warning', 'BEFORE_START', `Attendance before the service start date ${fmtDate(startRef)}: ${beforeStart.join(', ')}.`);
      }

      const autoIntake = inMonth(rc.entry, month);
      const intake = ov.intake != null ? !!ov.intake : autoIntake;
      const computed = {
        intake: intake ? S.intakeHours : null,
        sessions,
        hours: round2(sessions * S.sessionHours),
        makeups,
        makeupHours: round2(makeups * S.sessionHours),
        makeupType: makeups ? (ov.makeupType || rc.current.makeupType || S.defaultMakeupType) : '',
        absences,
      };

      if (rc.status === 'active' && loadedGroups.has(rc.group) && !acts.some(a => a.billed) &&
        (!rc.start || rc.start <= monthEnd) && (!rc.exit || rc.exit >= monthStart)) {
        flag('warning', 'NO_ATTENDANCE', 'Active client with no attendance in the loaded trackers. Check the tracker or a different group.');
      }
      if ((rc.status === 'completed' || rc.status === 'noncompletion') && !rc.exit) {
        flag('warning', 'NO_EXIT_DATE', `Status is "${rc.statusRaw}" but the Program Exit Date is blank.`);
      }
      if (rc.status === 'active' && rc.exit && rc.exit <= monthEnd) {
        flag('warning', 'EXIT_BUT_ACTIVE', `Program exit date ${fmtDate(rc.exit)} is set but status is still "${rc.statusRaw}".`);
      }
      const groupsSeen = [...new Set(acts.filter(a => a.billed).map(a => a.group).filter(Boolean))];
      if (groupsSeen.length && rc.group && groupsSeen.some(g => g !== rc.group)) {
        flag('info', 'GROUP', `Roster group ${rc.group}; attendance found in ${groupsSeen.join(', ')}.`);
      }
      if (acts.length && rc.group && !loadedGroups.has(rc.group)) {
        flag('warning', 'PARTIAL', `The ${rc.group} tracker is not loaded, so this client's ${rc.group} sessions are not counted yet.`);
      }
      if (absences) flag('info', 'ABSENCES', `${absences} absence${absences > 1 ? 's' : ''} (N) this month.`);
      if (tprNames.has(rc.key)) flag('info', 'TPR', `Listed in the TPR section of the ${tprNames.get(rc.key).join(', ')} tracker.`);

      const cur = rc.current;
      if (cur.sessions != null && cur.hours != null && round2(cur.sessions * S.sessionHours) !== round2(cur.hours)) {
        flag('warning', 'HOURS_MATH', `Workbook shows ${cur.sessions} sessions but ${cur.hours} hours (expected ${round2(cur.sessions * S.sessionHours)}).`);
      }
      if (cur.makeups != null && cur.makeupHours != null && round2(cur.makeups * S.sessionHours) !== round2(cur.makeupHours)) {
        flag('warning', 'HOURS_MATH', `Workbook shows ${cur.makeups} make-ups but ${cur.makeupHours} make-up hours.`);
      }

      const diffs = [];
      const cmp = (field, label, compVal) => {
        const curVal = cur[field] == null ? 0 : cur[field];
        const cv = compVal == null ? 0 : compVal;
        if (round2(curVal) !== round2(cv)) diffs.push({ field, label, current: cur[field], computed: compVal });
      };
      cmp('sessions', 'Sessions', computed.sessions);
      cmp('hours', 'Hours', computed.hours);
      cmp('makeups', 'Make-ups', computed.makeups);
      cmp('makeupHours', 'Make-up hours', computed.makeupHours);
      cmp('intake', 'Intake', computed.intake);

      rows.push({
        key: rc.key, rowNumber: rc.rowNumber, group: rc.group, display: rc.display, fileNo: rc.fileNo,
        status: rc.status, statusRaw: rc.statusRaw, entry: rc.entry, start: rc.start, exit: rc.exit,
        po: rc.po, autoIntake, computed, current: cur, diffs, flags, attendance: acts,
        groupLoaded: loadedGroups.has(rc.group),
      });
    }

    const sev = { critical: 0, warning: 1, info: 2 };
    rows.sort((a, b) => (a.group || '').localeCompare(b.group || '') || a.display.localeCompare(b.display));

    const totals = { clientsServed: 0, sessions: 0, hours: 0, makeups: 0, makeupHours: 0, intakes: 0, intakeHours: 0, absences: 0 };
    for (const r of rows) {
      const c = r.computed;
      if (c.sessions || c.makeups || c.intake) totals.clientsServed++;
      totals.sessions += c.sessions; totals.hours += c.hours;
      totals.makeups += c.makeups; totals.makeupHours += c.makeupHours;
      if (c.intake) { totals.intakes++; totals.intakeHours += c.intake; }
      totals.absences += c.absences;
    }
    totals.hours = round2(totals.hours); totals.makeupHours = round2(totals.makeupHours);
    totals.amount = round2(totals.hours * S.rateGroupHour + totals.makeupHours * S.rateMakeupHour + totals.intakes * S.rateIntake);

    const findings = [];
    for (const n of trackerNotes) findings.push({ severity: n.severity, client: '', group: '', message: `${n.tracker}: ${n.message}` });
    for (const u of unmatched) findings.push({ severity: 'critical', client: u.name, group: u.group, message: 'Tracker row has attendance but is not matched to a client on the County list. It is not billed.' });
    for (const r of rows) for (const f of r.flags) findings.push({ severity: f.severity, code: f.code, client: r.display, group: r.group, key: r.key, message: f.message });
    findings.sort((a, b) => sev[a.severity] - sev[b.severity]);

    // Program movement for the monthly narrative (whole roster, all groups).
    const movement = { enrolled: 0, completed: 0, discharged: 0, activeEnd: 0 };
    for (const rc of roster) {
      if (inMonth(rc.entry, month)) movement.enrolled++;
      if (inMonth(rc.exit, month) && rc.status === 'completed') movement.completed++;
      if (inMonth(rc.exit, month) && rc.status === 'noncompletion') movement.discharged++;
      if (rc.status === 'active' && rc.entry && rc.entry <= monthEnd && (!rc.exit || rc.exit > monthEnd)) movement.activeEnd++;
    }

    const allGroups = [...new Set(roster.map(r => r.group).filter(g => /^G\d[A-Z]$/.test(g)))].sort();
    const coverage = allGroups.map(g => ({
      group: g,
      loaded: loadedGroups.has(g),
      clients: roster.filter(r => r.group === g && r.status === 'active').length,
    }));

    return { month, settings: S, rows, unmatched, findings, totals, movement, coverage };
  }

  function narrative(result, meta) {
    const t = result.totals;
    const mv = result.movement;
    const loaded = result.coverage.filter(c => c.loaded).map(c => c.group);
    const missing = result.coverage.filter(c => !c.loaded).map(c => c.group);
    const lines = [
      `${meta && meta.program ? meta.program + ' — ' : ''}${monthLabel(result.month)} service summary`,
      '',
      `Clients served: ${t.clientsServed}`,
      `Group sessions delivered (client-sessions): ${t.sessions} (${t.hours} hours)`,
      `Make-up sessions: ${t.makeups} (${t.makeupHours} hours)`,
      `Intake appointments: ${t.intakes}`,
      `Absences recorded: ${t.absences}`,
      '',
      `New enrollments: ${mv.enrolled}`,
      `Program completions: ${mv.completed}`,
      `Non-completion discharges: ${mv.discharged}`,
      `Active clients at month end: ${mv.activeEnd}`,
      '',
      `Groups included: ${loaded.join(', ') || 'none'}`,
    ];
    if (missing.length) lines.push(`Groups without a loaded tracker: ${missing.join(', ')}`);
    return lines.join('\n');
  }


  /* ------------------------------------------- surgical .xlsx cell patch */
  // Edits only the <c> elements for the given cells in one worksheet's XML.
  // Every other part of the workbook (styles, dropdown lists, conditional
  // formatting, other tabs) is left byte-for-byte as it was.

  function colNumber(letters) { let n = 0; for (const ch of letters.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64; return n; }
  function colLetters(n) { let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; }
  function xmlEsc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function reEsc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function buildCell(ref, style, value) {
    const s = style ? ` s="${style}"` : '';
    if (value == null || value === '') return `<c r="${ref}"${s}/>`;
    if (typeof value === 'number') return `<c r="${ref}"${s}><v>${value}</v></c>`;
    return `<c r="${ref}"${s} t="inlineStr"><is><t>${xmlEsc(value)}</t></is></c>`;
  }

  /** edits: [{ row, col, value }] with 1-based row/col; value number|string|null. */
  function patchSheetXml(xml, edits) {
    const byRow = new Map();
    for (const e of edits) (byRow.get(e.row) || byRow.set(e.row, []).get(e.row)).push(e);
    for (const [rowNum, rowEdits] of [...byRow.entries()].sort((a, b) => a[0] - b[0])) {
      const rowRe = new RegExp(`<row\\b[^>]*?\\br="${rowNum}"[^>]*?(?:\\/>|>([\\s\\S]*?)<\\/row>)`);
      let m = xml.match(rowRe);
      if (!m) {
        // Insert an empty row in order.
        const rows = [...xml.matchAll(/<row\b[^>]*?\br="(\d+)"/g)];
        const after = rows.find(r => +r[1] > rowNum);
        const blank = `<row r="${rowNum}"></row>`;
        if (after) xml = xml.slice(0, after.index) + blank + xml.slice(after.index);
        else xml = xml.replace(/<\/sheetData>|<sheetData\s*\/>/, t => (t.startsWith('</') ? `${blank}</sheetData>` : `<sheetData>${blank}</sheetData>`));
        m = xml.match(rowRe);
      }
      const whole = m[0];
      const openTag = whole.match(/^<row\b[^>]*?(?=\/?>)/)[0].replace(/\sspans="[^"]*"/, '');
      let inner = m[1] || '';
      for (const e of rowEdits) {
        const ref = `${colLetters(e.col)}${rowNum}`;
        const cellRe = new RegExp(`<c\\b[^>]*?\\br="${reEsc(ref)}"[^>]*?(?:\\/>|>[\\s\\S]*?<\\/c>)`);
        const cm = inner.match(cellRe);
        if (cm) {
          const style = (cm[0].match(/\bs="(\d+)"/) || [])[1];
          inner = inner.replace(cellRe, buildCell(ref, style, e.value));
        } else {
          if (e.value == null || e.value === '') continue;
          const cells = [...inner.matchAll(/<c\b[^>]*?\br="([A-Z]+)\d+"/g)];
          const next = cells.find(c => colNumber(c[1]) > e.col);
          const cell = buildCell(ref, null, e.value);
          inner = next ? inner.slice(0, next.index) + cell + inner.slice(next.index) : inner + cell;
        }
      }
      xml = xml.replace(whole, () => `${openTag}>${inner}</row>`);
    }
    return xml;
  }

  /** Finds the worksheet XML path for a tab name inside unzipped entries. */
  function sheetPathFor(entries, sheetName) {
    const dec = new TextDecoder();
    const wbXml = dec.decode(entries['xl/workbook.xml']);
    const relsXml = dec.decode(entries['xl/_rels/workbook.xml.rels']);
    const unx = s => s.replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    let rid = null;
    for (const m of wbXml.matchAll(/<sheet\b[^>]*>/g)) {
      const name = (m[0].match(/\bname="([^"]*)"/) || [])[1];
      if (name != null && unx(name) === sheetName) rid = (m[0].match(/\br:id="([^"]*)"/) || [])[1];
    }
    if (!rid) return null;
    for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
      if ((m[0].match(/\bId="([^"]*)"/) || [])[1] !== rid) continue;
      let target = (m[0].match(/\bTarget="([^"]*)"/) || [])[1];
      if (target.startsWith('/')) return target.slice(1);
      return `xl/${target}`.replace(/\/\.\//g, '/');
    }
    return null;
  }

  /**
   * entries: fflate-style { path: Uint8Array }. Returns a new entries object
   * with only the target worksheet (and nothing else) changed.
   */
  function patchXlsxEntries(entries, sheetName, edits) {
    const path = sheetPathFor(entries, sheetName);
    if (!path || !entries[path]) throw new Error(`Tab "${sheetName}" was not found in the workbook.`);
    const xml = new TextDecoder().decode(entries[path]);
    const out = Object.assign({}, entries);
    out[path] = new TextEncoder().encode(patchSheetXml(xml, edits));
    // Ask Excel to recalculate on open so any totals refresh.
    const wb = new TextDecoder().decode(entries['xl/workbook.xml']);
    if (/<calcPr\b/.test(wb) && !/fullCalcOnLoad/.test(wb)) {
      out['xl/workbook.xml'] = new TextEncoder().encode(wb.replace(/<calcPr\b/, '<calcPr fullCalcOnLoad="1"'));
    }
    return { entries: out, path };
  }

  return {
    MONTHS, DEFAULT_SETTINGS, BILLABLE, PAGE_HEAD,
    str, toDate, toNumber, fmtDate, monthLabel, daysInMonth, inMonth,
    monthFromText, groupFromText, cohortFromText, cleanTrackerName, trackerNameMeta,
    parseTrackerRows, pdfItemsToRows, parseCSV,
    parseRoster, findMonthSheet, normStatus,
    jaroWinkler, scoreName, candidates, autoMatch,
    computeBilling, narrative,
    colNumber, colLetters, patchSheetXml, sheetPathFor, patchXlsxEntries,
  };
});
