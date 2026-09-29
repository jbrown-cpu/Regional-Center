/* FACES Adult IPV Billing — browser app. All processing stays in this browser. */
(function () {
  'use strict';
  const Core = window.IPVCore;
  const $ = s => document.querySelector(s);
  const GROUPS = ['G1A', 'G1B', 'G1C', 'G1D', 'G2A', 'G2B', 'G2C', 'G2D'];
  const STORE = 'faces-ipv-billing-v1';

  if (window.pdfjsLib) window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

  /* ------------------------------------------------------------ state */
  const saved = load();
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const state = {
    month: { y: prev.getFullYear(), m: prev.getMonth() },
    settings: Object.assign({}, Core.DEFAULT_SETTINGS, saved.settings || {}),
    classes: saved.classes || defaultClasses(),
    matchMemory: saved.matchMemory || {},
    workbook: null,          // { name, buffer, sheetNames, sheetName, meta }
    roster: [],
    rosterInfo: null,
    trackers: [],
    auto: {},
    manual: {},              // trackerClientId -> rosterKey | '' (explicitly unmatched)
    overrides: {},
    result: null,
    filter: 'attention',
    search: '',
    showAllMatches: false,
    sample: false,
    exportMode: 'fill',
  };

  function defaultClasses() {
    return [
      { group: 'G1A', label: 'Cohort 21 · Module 1 · 5:30–7:00 pm · Elijah & Veronika', url: '', tab: '' },
      { group: 'G1B', label: 'Cohort 22 · Module 1 · 7:15–8:45 pm · Julio & Asyia', url: '', tab: '' },
      { group: 'G1D', label: 'Cohort 24 · Mon/Wed 5:30–7:00 pm · Veronika & Suzi', url: '', tab: '' },
      { group: 'G2B', label: 'Cohort 22 · Module 2', url: '', tab: '' },
    ];
  }

  function load() { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch (e) { return {}; } }
  function persist() {
    try {
      localStorage.setItem(STORE, JSON.stringify({ settings: state.settings, classes: state.classes, matchMemory: state.matchMemory, seenSample: true }));
    } catch (e) { /* storage unavailable: app still works for this session */ }
  }

  /* ----------------------------------------------------------- helpers */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtN = n => (n == null || n === '' ? '' : (Math.round(n * 100) / 100).toString());
  const money = n => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  let toastTimer;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3600);
  }
  const memKey = (group, name) => `${group || '?'}|${String(name).toLowerCase().replace(/\s+/g, ' ').trim()}`;
  let uid = 0;

  /* ----------------------------------------------------- roster loading */
  async function loadRosterFile(file) {
    const buffer = await file.arrayBuffer();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const meta = readInstructions(wb);
    clearSample();
    state.workbook = { name: file.name, buffer, sheetNames: wb.worksheets.map(w => w.name), sheetName: null, meta, wb };
    const m = Core.monthFromText(file.name.replace(/_/g, ' '));
    if (m && !state.trackers.length) setMonth(m, false);
    parseRosterSheet();
    toast(`Loaded ${state.roster.length} clients from ${state.rosterInfo.sheetName}.`);
  }

  function readInstructions(wb) {
    const ws = wb.worksheets.find(w => /instruction/i.test(w.name));
    const meta = {};
    if (!ws) return meta;
    ws.eachRow((row) => {
      const label = Core.str(row.getCell(2).value);
      const val = Core.str(row.getCell(3).value);
      if (/contractor/i.test(label)) meta.contractor = val;
      if (/program name/i.test(label)) meta.program = val;
      if (/fiscal year/i.test(label)) meta.fy = val;
      if (/submit/i.test(Core.str(row.getCell(1).value))) meta.submitRow = row.number + 1;
    });
    if (meta.submitRow) {
      const emails = [];
      ws.getRow(meta.submitRow).eachCell(c => { Core.str(c.value).split(/\s+/).forEach(e => { if (/@/.test(e)) emails.push(e); }); });
      meta.emails = [...new Set(emails)];
    }
    return meta;
  }

  function parseRosterSheet(sheetName) {
    const W = state.workbook;
    if (!W) return;
    W.sheetName = sheetName || Core.findMonthSheet(W.sheetNames, state.month) || W.sheetName;
    const ws = W.sheetName && W.wb.getWorksheet(W.sheetName);
    if (!ws) {
      state.roster = [];
      state.rosterInfo = { sheetName: '', error: `No tab for ${Core.monthLabel(state.month)} in this workbook. Pick one below.` };
    } else {
      const grid = [];
      ws.eachRow({ includeEmpty: false }, (row, rowNumber) => grid.push({ rowNumber, values: row.values }));
      const parsed = Core.parseRoster(grid, W.sheetName);
      state.roster = parsed.clients;
      state.rosterInfo = parsed;
    }
    rematch();
  }

  /* ---------------------------------------------------- tracker loading */
  async function loadTrackerFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    const info = { fileName: file.name, title: file.name.replace(/\.[^.]+$/, '').replace(/_+/g, ' '), source: ext };
    let parsed = [];
    if (ext === 'pdf') {
      const rows = await pdfToRows(await file.arrayBuffer());
      parsed = [Core.parseTrackerRows(rows, { ...info, id: `t${++uid}`, fallbackMonth: state.month })];
    } else if (ext === 'csv') {
      parsed = [Core.parseTrackerRows(Core.parseCSV(await file.text()), { ...info, id: `t${++uid}`, fallbackMonth: state.month })];
    } else if (ext === 'xlsx') {
      parsed = await xlsxTrackers(await file.arrayBuffer(), info);
    } else {
      toast(`${file.name}: use a PDF, .xlsx or .csv file.`);
      return;
    }
    clearSample();
    for (const t of parsed) addTracker(t);
  }

  async function pdfToRows(buffer) {
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      pages.push({ items: tc.items.map(it => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width })) });
    }
    return Core.pdfItemsToRows(pages);
  }

  function sheetRows(ws) {
    const rows = [];
    for (let r = 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const out = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        const slave = cell.isMerged && cell.master && cell.master.address !== cell.address;
        out[col - 1] = slave ? '' : cell.value;
      });
      rows.push(out);
    }
    return rows;
  }

  async function xlsxTrackers(buffer, info) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const all = wb.worksheets.map(ws => Core.parseTrackerRows(sheetRows(ws), {
      ...info, id: `t${++uid}`, title: `${info.title} · ${ws.name}`, fallbackMonth: state.month,
      group: Core.groupFromText(info.fileName),
    })).filter(t => t.clients.length);
    const same = all.filter(t => t.month && t.month.y === state.month.y && t.month.m === state.month.m);
    if (same.length) return same;
    if (all.length === 1) return all;
    toast(`${info.fileName}: no tab for ${Core.monthLabel(state.month)} was found.`);
    return [];
  }

  function addTracker(t) {
    const dupe = state.trackers.findIndex(x => x.fileName === t.fileName && x.title === t.title);
    if (dupe >= 0) state.trackers.splice(dupe, 1);
    state.trackers.push(t);
    if (t.month && (t.month.y !== state.month.y || t.month.m !== state.month.m) && state.trackers.length === 1 && !state.workbook) {
      setMonth(t.month, false);
    }
    rematch();
  }

  /* ------------------------------------------------- Google Sheets fetch */
  function sheetId(url) { const m = String(url).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/); return m ? m[1] : null; }
  function gidOf(url) { const m = String(url).match(/[#&?]gid=(\d+)/); return m ? m[1] : null; }
  function tabName(tab) {
    return String(tab || '').replace(/\{Month\}/g, Core.MONTHS[state.month.m]).replace(/\{MONTH\}/g, Core.MONTHS[state.month.m].toUpperCase())
      .replace(/\{Mon\}/g, Core.MONTHS[state.month.m].slice(0, 3)).replace(/\{Year\}/g, state.month.y);
  }

  async function fetchClass(cls) {
    const id = sheetId(cls.url);
    if (!id) throw new Error('That link is not a Google Sheets link.');
    const tab = tabName(cls.tab);
    const gid = gidOf(cls.url);
    const urls = [];
    if (tab) urls.push(`https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&headers=0&sheet=${encodeURIComponent(tab)}`);
    else {
      urls.push(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv${gid ? `&gid=${gid}` : ''}`);
      urls.push(`https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&headers=0${gid ? `&gid=${gid}` : ''}`);
    }
    let lastErr;
    for (const u of urls) {
      try {
        const res = await fetch(u, { credentials: 'omit' });
        const text = await res.text();
        if (!res.ok || /^\s*</.test(text)) throw new Error('Google asked for a sign-in. Share the sheet as “Anyone with the link can view”, or download it as .xlsx and drop it in.');
        const t = Core.parseTrackerRows(Core.parseCSV(text), {
          id: `t${++uid}`, source: 'google', fileName: cls.url, title: `${cls.group} · ${cls.label || 'Google Sheet'}${tab ? ` · ${tab}` : ''}`,
          group: cls.group, fallbackMonth: state.month,
        });
        if (!t.clients.length) throw new Error(t.warnings[0] || 'No client rows found on that tab.');
        return t;
      } catch (e) {
        lastErr = e instanceof TypeError ? new Error('The browser could not reach Google Sheets. The sheet is probably private. Download it as .xlsx and drop it in.') : e;
      }
    }
    throw lastErr;
  }

  /* --------------------------------------------------------- matching */
  function rematch() {
    state.auto = state.roster.length ? Core.autoMatch(state.trackers, state.roster) : {};
    recompute();
  }

  function matchFor(t, c) {
    if (c.id in state.manual) return { key: state.manual[c.id] || null, confidence: 'manual' };
    const mem = state.matchMemory[memKey(t.group, c.name)];
    if (mem && state.roster.some(r => r.key === mem)) return { key: mem, confidence: 'manual' };
    return state.auto[c.id] || { key: null, confidence: 'none', score: 0 };
  }

  function currentMatches() {
    const out = {};
    for (const t of state.trackers) for (const c of t.clients) if (c.hasAttendance) out[c.id] = matchFor(t, c).key;
    return out;
  }

  /* --------------------------------------------------------- compute */
  function recompute() {
    state.result = Core.computeBilling({
      month: state.month, settings: state.settings, roster: state.roster, trackers: state.trackers,
      matches: currentMatches(), overrides: state.overrides,
    });
    render();
  }

  function setMonth(m, reparse = true) {
    state.month = m;
    $('#month').value = `${m.y}-${String(m.m + 1).padStart(2, '0')}`;
    if (reparse && state.workbook) parseRosterSheet(); else if (reparse) recompute();
  }

  /* ---------------------------------------------------------- render */
  function render() {
    renderContract(); renderRoster(); renderTrackers(); renderClasses(); renderTiles();
    renderFindings(); renderMatches(); renderFilters(); renderLedger(); renderNarrative();
    $('#sample-banner').hidden = !state.sample;
    $('#hrs-label').textContent = state.settings.sessionHours;
    $('#export-county').disabled = !state.workbook;
    $('#export-county').title = state.workbook ? '' : 'Load the County Client List workbook first.';
  }

  function renderContract() {
    const meta = (state.workbook && state.workbook.meta) || {};
    if (meta.program) {
      const [prog, contract] = meta.program.split(',').map(s => s.trim());
      $('#contract').innerHTML = `<span>${esc(prog)}</span><span>Contract <b class="mono">${esc(contract || '')}</b></span><span>${esc(meta.contractor || '')}</span>`;
    }
    $('#submit-to').textContent = meta.emails && meta.emails.length ? `(${meta.emails.join(', ')})` : '';
  }

  function renderRoster() {
    const el = $('#roster-info');
    const W = state.workbook;
    if (!W && !state.sample) { el.innerHTML = ''; return; }
    if (state.sample) { el.innerHTML = `<div class="file-row"><span class="group-tag">List</span><div><div class="name">Sample County Client List</div><div class="meta">${state.roster.length} fictional clients</div></div></div>`; return; }
    const info = state.rosterInfo || {};
    const opts = W.sheetNames.filter(n => !/^(lists|instructions)$/i.test(n)).map(n => `<option ${n === W.sheetName ? 'selected' : ''}>${esc(n)}</option>`).join('');
    el.innerHTML = `<div class="file-row">
      <span class="group-tag">List</span>
      <div><div class="name">${esc(W.name)}</div>
      <div class="meta">${info.error ? esc(info.error) : `${state.roster.length} clients on the ${esc(W.sheetName)} tab`}</div></div>
      <select id="sheet-pick" aria-label="Month tab">${opts}</select></div>`;
    $('#sheet-pick').onchange = e => parseRosterSheet(e.target.value);
  }

  function renderTrackers() {
    const el = $('#tracker-list');
    el.innerHTML = state.trackers.map((t, i) => {
      const withAtt = t.clients.filter(c => c.hasAttendance).length;
      const opts = ['', ...GROUPS].map(g => `<option value="${g}" ${g === t.group ? 'selected' : ''}>${g || 'Group?'}</option>`).join('');
      const monthTxt = t.month ? Core.monthLabel(t.month) : 'month not found';
      const off = t.month && (t.month.y !== state.month.y || t.month.m !== state.month.m);
      return `<div class="file-row">
        <select class="group-tag" data-tgroup="${i}" aria-label="Group for ${esc(t.title)}">${opts}</select>
        <div><div class="name">${esc(t.title)}</div>
        <div class="meta">${esc(monthTxt)} · ${t.classDays.length} class dates · ${withAtt} clients with attendance${t.tprs.length ? ` · ${t.tprs.length} in TPR section` : ''}</div></div>
        <button class="btn ghost sm" data-tremove="${i}" type="button" aria-label="Remove tracker">Remove</button>
        ${(t.warnings.length || off) ? `<div class="warnings">${off ? `<div class="flag critical">This tracker is for ${esc(monthTxt)}, not ${esc(Core.monthLabel(state.month))}.</div>` : ''}${t.warnings.map(w => `<div class="flag warning">${esc(w)}</div>`).join('')}</div>` : ''}
      </div>`;
    }).join('');
    el.querySelectorAll('[data-tgroup]').forEach(s => { s.onchange = e => { state.trackers[+e.target.dataset.tgroup].group = e.target.value; rematch(); }; });
    el.querySelectorAll('[data-tremove]').forEach(b => { b.onclick = e => { state.trackers.splice(+e.target.dataset.tremove, 1); rematch(); }; });

    const cov = (state.result && state.result.coverage) || [];
    $('#coverage').innerHTML = cov.length ? cov.map(c => `<span class="cov ${c.loaded ? 'on' : c.clients ? 'missing' : ''}" title="${c.clients} active clients">${c.group} ${c.loaded ? '✓' : c.clients ? `· ${c.clients} active, no tracker` : ''}</span>`).join('') : '';
  }

  function renderClasses() {
    const el = $('#class-list');
    if (el.contains(document.activeElement)) return; // don't disrupt typing
    el.innerHTML = state.classes.map((c, i) => `<div class="class-row">
      <div class="field"><label for="cg${i}">Group</label><select id="cg${i}" data-c="${i}" data-k="group">${GROUPS.map(g => `<option ${g === c.group ? 'selected' : ''}>${g}</option>`).join('')}</select></div>
      <div class="field wide"><label for="cl${i}">Class</label><input type="text" id="cl${i}" data-c="${i}" data-k="label" value="${esc(c.label)}" placeholder="Cohort, days, time, facilitators"></div>
      <div class="field wide"><label for="cu${i}">Google Sheets link</label><input type="url" id="cu${i}" data-c="${i}" data-k="url" value="${esc(c.url)}" placeholder="https://docs.google.com/spreadsheets/d/…"></div>
      <div class="field"><label for="ct${i}">Tab (optional)</label><input type="text" id="ct${i}" data-c="${i}" data-k="tab" value="${esc(c.tab)}" placeholder="{Month} - {Year}"></div>
      <button class="btn sm" data-fetch="${i}" type="button" ${c.url ? '' : 'disabled'}>Fetch</button>
      <button class="btn ghost sm" data-cdel="${i}" type="button" aria-label="Remove class">✕</button>
    </div>`).join('');
    el.querySelectorAll('[data-c]').forEach(inp => {
      inp.onchange = e => {
        state.classes[+e.target.dataset.c][e.target.dataset.k] = e.target.value.trim();
        persist(); el.blur(); renderClasses();
      };
    });
    el.querySelectorAll('[data-fetch]').forEach(b => { b.onclick = () => runFetch([state.classes[+b.dataset.fetch]]); });
    el.querySelectorAll('[data-cdel]').forEach(b => { b.onclick = () => { state.classes.splice(+b.dataset.cdel, 1); persist(); renderClasses(); }; });
  }

  async function runFetch(list) {
    const todo = list.filter(c => c.url);
    if (!todo.length) { toast('Add a Google Sheets link first.'); return; }
    let ok = 0; const errs = [];
    for (const c of todo) {
      try { const t = await fetchClass(c); clearSample(); addTracker(t); ok++; } catch (e) { errs.push(`${c.group}: ${e.message}`); }
    }
    toast(errs.length ? `${ok} fetched. ${errs[0]}` : `Fetched ${ok} class tracker${ok === 1 ? '' : 's'}.`);
  }

  function renderTiles() {
    const r = state.result;
    const t = r.totals;
    const crit = r.findings.filter(f => f.severity === 'critical').length;
    const warn = r.findings.filter(f => f.severity === 'warning').length;
    const S = state.settings;
    const hasRates = S.rateGroupHour || S.rateMakeupHour || S.rateIntake;
    const tiles = [
      ['Clients served', t.clientsServed, `${r.rows.length} on the list in loaded groups`],
      ['Group sessions', t.sessions, `${fmtN(t.hours)} hours billed`],
      ['Make-up sessions', t.makeups, `${fmtN(t.makeupHours)} hours`],
      ['Intakes', t.intakes, `${fmtN(t.intakeHours)} hour${t.intakeHours === 1 ? '' : 's'}`],
      ['Absences', t.absences, 'marked N, not billed'],
      ['Critical findings', crit, `${warn} warnings`, crit > 0],
    ];
    if (hasRates) tiles.push(['Estimated billing', money(t.amount), 'at the rates in Export']);
    $('#tiles').innerHTML = tiles.map(([k, v, s, alert]) => `<div class="tile ${alert ? 'alert' : ''}"><span class="eyebrow">${k}</span><span class="v">${esc(v)}</span><span class="s">${esc(s)}</span></div>`).join('');
    const loaded = r.coverage.filter(c => c.loaded).map(c => c.group);
    $('#summary-scope').textContent = `${Core.monthLabel(state.month)} · ${loaded.length ? loaded.join(', ') : 'no trackers loaded'}`;
  }

  let findingsExpanded = false;
  function renderFindings() {
    const f = state.result.findings.filter(x => x.severity !== 'info');
    const info = state.result.findings.length - f.length;
    $('#findings-count').textContent = f.length ? `${f.length} to review · ${info} notes in the ledger` : `Nothing blocking · ${info} notes in the ledger`;
    const shown = findingsExpanded ? f : f.slice(0, 8);
    $('#findings').innerHTML = f.length ? shown.map(x => `<div class="finding">
        <span class="sev ${x.severity}">${x.severity}</span>
        <span class="mono small">${esc(x.group || '')}</span>
        ${x.key ? `<button class="link" type="button" data-goto="${esc(x.key)}">${esc(x.client)}</button>` : `<span class="client">${esc(x.client || 'Tracker')}</span>`}
        <span class="msg">${esc(x.message)}</span></div>`).join('') +
      (f.length > 8 ? `<button class="btn sm more" id="more-findings" type="button">${findingsExpanded ? 'Show fewer' : `Show all ${f.length}`}</button>` : '')
      : `<div class="panel empty">${state.roster.length && state.trackers.length ? 'No critical findings or warnings for this month.' : 'Load the County Client List and at least one tracker to run the checks.'}</div>`;
    $('#findings').querySelectorAll('[data-goto]').forEach(b => { b.onclick = () => gotoRow(b.dataset.goto); });
    const more = $('#more-findings');
    if (more) more.onclick = () => { findingsExpanded = !findingsExpanded; renderFindings(); };
  }

  function gotoRow(key) {
    state.filter = 'all'; state.search = ''; $('#search').value = '';
    renderFilters(); renderLedger();
    const row = document.querySelector(`tr[data-key="${CSS.escape(key)}"]`);
    if (row) { row.scrollIntoView({ behavior: 'smooth', block: 'center' }); row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash'); }
  }

  function rosterOptions(selected, t, c) {
    const ranked = Core.candidates(c, state.roster, t.group, 6);
    const top = new Set(ranked.map(r => r.key));
    const byKey = new Map(state.roster.map(r => [r.key, r]));
    const opt = (r, label) => `<option value="${esc(r.key)}" ${r.key === selected ? 'selected' : ''}>${esc(label || `${r.display} · ${r.group}${r.fileNo ? ' · ' + r.fileNo : ''}`)}</option>`;
    const rest = state.roster.filter(r => !top.has(r.key)).sort((a, b) => a.display.localeCompare(b.display));
    return `<option value="" ${!selected ? 'selected' : ''}>Not on the County list (do not bill)</option>
      <optgroup label="Closest names">${ranked.map(r => opt(byKey.get(r.key), `${byKey.get(r.key).display} · ${byKey.get(r.key).group} · ${Math.round(r.score * 100)}%`)).join('')}</optgroup>
      <optgroup label="Everyone else">${rest.map(r => opt(r)).join('')}</optgroup>`;
  }

  function renderMatches() {
    const rows = [];
    for (const t of state.trackers) for (const c of t.clients) {
      if (!c.hasAttendance) continue;
      const m = matchFor(t, c);
      if (!state.showAllMatches && m.confidence === 'auto') continue;
      rows.push({ t, c, m });
    }
    const sec = $('#match-section');
    const any = state.trackers.some(t => t.clients.some(c => c.hasAttendance));
    sec.hidden = !any || !state.roster.length;
    const byKey = new Map(state.roster.map(r => [r.key, r]));
    const labels = { auto: 'Matched', review: 'Review', none: 'Unmatched', manual: 'Confirmed' };
    $('#match-table').innerHTML = rows.length ? `<thead><tr><th>Status</th><th>Tracker</th><th>Name on tracker</th><th>Client on County list</th></tr></thead><tbody>${rows.map(({ t, c, m }) => {
      const r = m.key && byKey.get(m.key);
      return `<tr><td><span class="conf ${m.confidence}">${labels[m.confidence]}</span></td>
        <td class="mono small">${esc(t.group || '?')}</td>
        <td><div class="client">${esc(c.rawName)}</div>${r && r.group !== t.group ? `<div class="sub">County list group ${esc(r.group)}</div>` : ''}</td>
        <td><select data-match="${esc(c.id)}" data-group="${esc(t.group)}" data-name="${esc(c.name)}" aria-label="County list client for ${esc(c.rawName)}" style="width:100%;max-width:26rem">${rosterOptions(m.key, t, c)}</select></td></tr>`;
    }).join('')}</tbody>` : `<tbody><tr><td class="empty">Every tracker name matched a County list client with high confidence. Tick “Show all matches” to review them.</td></tr></tbody>`;
    $('#match-table').querySelectorAll('[data-match]').forEach(s => {
      s.onchange = e => {
        const { match, group, name } = e.target.dataset;
        state.manual[match] = e.target.value;
        if (e.target.value) state.matchMemory[memKey(group, name)] = e.target.value; else delete state.matchMemory[memKey(group, name)];
        persist(); recompute();
        toast(e.target.value ? 'Match confirmed and remembered.' : 'Marked as not on the County list.');
      };
    });
  }

  function worstSeverity(flags) {
    if (flags.some(f => f.severity === 'critical')) return 'critical';
    if (flags.some(f => f.severity === 'warning')) return 'warning';
    return '';
  }

  const FILTERS = [
    ['attention', 'Needs attention', r => worstSeverity(r.flags)],
    ['changes', 'Differs from list', r => r.diffs.length],
    ['billable', 'Billable', r => r.computed.sessions || r.computed.makeups || r.computed.intake],
    ['all', 'All', () => true],
  ];

  function visibleRows() {
    const f = FILTERS.find(x => x[0] === state.filter)[2];
    const q = state.search.toLowerCase();
    return state.result.rows.filter(r => f(r) && (!q || `${r.display} ${r.fileNo} ${r.group}`.toLowerCase().includes(q)));
  }

  function renderFilters() {
    const rows = state.result.rows;
    $('#filters').innerHTML = FILTERS.map(([k, label, fn]) => `<button type="button" data-f="${k}" aria-pressed="${state.filter === k}">${label}<span class="c">${rows.filter(fn).length}</span></button>`).join('');
    $('#filters').querySelectorAll('button').forEach(b => { b.onclick = () => { state.filter = b.dataset.f; renderFilters(); renderLedger(); }; });
  }

  function renderLedger() {
    const rows = visibleRows();
    const el = $('#ledger');
    if (!state.result.rows.length) {
      el.innerHTML = `<tbody><tr><td class="empty">The ledger fills in once the County list and a tracker are loaded.</td></tr></tbody>`;
      return;
    }
    const was = (r, field) => {
      const d = r.diffs.find(x => x.field === field);
      return d ? `<span class="was" title="Currently on the County list">list: ${d.current == null ? 'blank' : fmtN(d.current)}</span>` : '';
    };
    const types = ['Individual', 'Group'];
    const body = rows.map(r => {
      const c = r.computed;
      const strip = r.attendance.map(a => `<span class="d ${a.mark} ${a.billed || a.mark === 'N' ? '' : 'x'}" title="${esc(Core.MONTHS[state.month.m])} ${a.day} · ${a.mark}${a.session ? ' · session ' + esc(a.session) : ''} · ${esc(a.group)}">${a.day}</span>`).join('');
      return `<tr data-key="${esc(r.key)}" class="${worstSeverity(r.flags) ? 'sev-' + worstSeverity(r.flags) : ''}">
        <td class="mono small">${esc(r.group)}</td>
        <td><div class="client">${esc(r.display)}</div><div class="sub">${esc(r.fileNo)} <span class="status ${r.status}">${esc(r.statusRaw || 'No status')}</span></div>
          <div class="sub">start ${esc(Core.fmtDate(r.start) || '—')}${r.exit ? ` · exit ${esc(Core.fmtDate(r.exit))}` : ''}</div></td>
        <td><div class="strip">${strip || '<span class="muted small">No attendance</span>'}</div></td>
        <td class="n"><input type="checkbox" data-intake="${esc(r.key)}" ${c.intake ? 'checked' : ''} aria-label="Intake this month for ${esc(r.display)}">${was(r, 'intake')}</td>
        <td class="n">${c.sessions || ''}${was(r, 'sessions')}</td>
        <td class="n">${fmtN(c.hours) === '0' ? '' : fmtN(c.hours)}${was(r, 'hours')}</td>
        <td class="n">${c.makeups || ''}${was(r, 'makeups')}</td>
        <td class="n">${c.makeupHours ? fmtN(c.makeupHours) : ''}${was(r, 'makeupHours')}</td>
        <td>${c.makeups ? `<select data-mutype="${esc(r.key)}" aria-label="Make-up type">${types.map(t => `<option ${t === c.makeupType ? 'selected' : ''}>${t}</option>`).join('')}</select>` : ''}</td>
        <td><div class="flags">${r.flags.map(f => `<span class="flag ${f.severity}">${esc(f.message)}</span>`).join('')}</div></td>
      </tr>`;
    }).join('');
    const sum = k => rows.reduce((a, r) => a + (r.computed[k] || 0), 0);
    el.innerHTML = `<thead><tr><th>Group</th><th>Client</th><th>Attendance</th><th class="n">Intake</th><th class="n">Sessions</th><th class="n">Hours</th><th class="n">Make-ups</th><th class="n">M/U hrs</th><th>M/U type</th><th>Checks</th></tr></thead>
      <tbody>${body || `<tr><td colspan="10" class="empty">No clients match this filter.</td></tr>`}</tbody>
      <tfoot><tr><td colspan="3">${rows.length} clients shown</td><td class="n">${rows.filter(r => r.computed.intake).length}</td><td class="n">${sum('sessions')}</td><td class="n">${fmtN(sum('hours'))}</td><td class="n">${sum('makeups')}</td><td class="n">${fmtN(sum('makeupHours'))}</td><td colspan="2"></td></tr></tfoot>`;
    el.querySelectorAll('[data-intake]').forEach(cb => { cb.onchange = e => { setOverride(e.target.dataset.intake, 'intake', e.target.checked); }; });
    el.querySelectorAll('[data-mutype]').forEach(s => { s.onchange = e => { setOverride(e.target.dataset.mutype, 'makeupType', e.target.value); }; });
  }

  function setOverride(key, field, value) {
    state.overrides[key] = Object.assign({}, state.overrides[key], { [field]: value });
    recompute();
  }

  function renderNarrative() {
    const meta = (state.workbook && state.workbook.meta) || {};
    $('#narrative').value = Core.narrative(state.result, { program: meta.program || 'Adult IPV' });
  }

  /* ---------------------------------------------------------- exports */
  function download(buffer, name) {
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  function isBlank(v) { return v == null || v === '' || (typeof v === 'object' && !(v instanceof Date) && Core.str(v) === ''); }

  async function exportCounty() {
    const W = state.workbook;
    if (!W) return;
    // Current values come from the parsed copy; the file itself is patched
    // cell by cell so dropdowns, formatting and other tabs stay untouched.
    const ws = W.wb.getWorksheet(W.sheetName);
    const cols = state.rosterInfo.columns;
    const replace = document.querySelector('input[name="mode"]:checked').value === 'replace';
    const log = [];
    const edits = [];
    let skipped = 0;
    for (const r of state.result.rows) {
      if (r.flags.some(f => f.code === 'PARTIAL')) { skipped++; continue; }
      const c = r.computed;
      const values = {
        intake: c.intake || null,
        sessions: c.sessions || null,
        hours: c.hours || null,
        makeups: c.makeups || null,
        makeupHours: c.makeupHours || null,
        makeupType: c.makeups ? c.makeupType : null,
      };
      for (const [field, val] of Object.entries(values)) {
        if (!cols[field]) continue;
        const cur = ws.getRow(r.rowNumber).getCell(cols[field]).value;
        const blank = isBlank(cur);
        if (!replace && (!blank || val == null)) continue;
        if (replace && val == null && blank) continue;
        if (!blank && Core.str(cur) === Core.str(val)) continue;
        edits.push({ row: r.rowNumber, col: cols[field], value: val });
        log.push({ row: r.rowNumber, client: r.display, field, from: blank ? '' : Core.str(cur), to: val == null ? '' : val });
      }
    }
    if (!edits.length) {
      toast(`Nothing to write. Every billing cell on ${W.sheetName} already has a value${replace ? ' that matches' : ''}.`);
      state.lastExportLog = [];
      return;
    }
    const entries = fflate.unzipSync(new Uint8Array(W.buffer));
    const patched = Core.patchXlsxEntries(entries, W.sheetName, edits).entries;
    const buf = fflate.zipSync(patched, { level: 6 });
    const base = W.name.replace(/\.xlsx$/i, '');
    download(buf, `${base} - ${W.sheetName} billing ${replace ? 'replaced' : 'filled'}.xlsx`);
    state.lastExportLog = log;
    toast(`${log.length} cells written on ${W.sheetName}${skipped ? `; ${skipped} clients skipped (group tracker missing)` : ''}.`);
  }

  async function exportAudit() {
    const r = state.result;
    const wb = new ExcelJS.Workbook();
    wb.creator = 'FACES Adult IPV Billing';
    const head = (ws, cols) => {
      ws.columns = cols.map(([header, key, width]) => ({ header, key, width }));
      ws.getRow(1).font = { bold: true };
      ws.views = [{ state: 'frozen', ySplit: 1 }];
    };
    const meta = (state.workbook && state.workbook.meta) || {};
    const s = wb.addWorksheet('Summary');
    s.columns = [{ width: 38 }, { width: 60 }];
    const t = r.totals; const mv = r.movement;
    [
      ['Program', meta.program || 'Adult IPV'], ['Contractor', meta.contractor || 'Faith in Action Community Education Services'],
      ['Billing month', Core.monthLabel(state.month)], ['Generated', new Date().toLocaleString()],
      ['County Client List', state.workbook ? `${state.workbook.name} (${state.workbook.sheetName})` : 'Sample data'],
      ['Trackers', state.trackers.map(x => `${x.group || '?'}: ${x.title}`).join('\n')],
      [], ['Clients served', t.clientsServed], ['Group sessions', t.sessions], ['Group hours', t.hours],
      ['Make-up sessions', t.makeups], ['Make-up hours', t.makeupHours], ['Intakes', t.intakes], ['Intake hours', t.intakeHours],
      ['Absences (N)', t.absences], ['Estimated billing', t.amount || ''], [],
      ['New enrollments', mv.enrolled], ['Program completions', mv.completed], ['Non-completion discharges', mv.discharged], ['Active at month end', mv.activeEnd], [],
      ['Hours per session', state.settings.sessionHours], ['Rate per group hour', state.settings.rateGroupHour || ''],
      ['Rate per make-up hour', state.settings.rateMakeupHour || ''], ['Rate per intake', state.settings.rateIntake || ''],
      ['Groups without a tracker', r.coverage.filter(c => !c.loaded && c.clients).map(c => c.group).join(', ')],
    ].forEach(row => s.addRow(row));
    s.getColumn(1).font = { bold: true };
    s.getColumn(2).alignment = { wrapText: true, vertical: 'top' };

    const b = wb.addWorksheet('Client billing');
    head(b, [['Row on list', 'row', 10], ['Group', 'group', 8], ['Last, First', 'name', 30], ['File #', 'file', 12], ['Status', 'status', 24],
      ['Intake hrs (U)', 'u', 12], ['Sessions (V)', 'v', 12], ['Hours (W)', 'w', 11], ['Make-ups (AA)', 'aa', 13], ['M/U hrs (AB)', 'ab', 12], ['M/U type (AC)', 'ac', 13],
      ['Absences', 'n', 10], ['Attendance dates', 'dates', 40], ['List now V/W/AA/AB', 'cur', 20], ['Differences', 'diff', 30], ['Checks', 'flags', 70]]);
    for (const x of r.rows) {
      const c = x.computed; const k = x.current;
      b.addRow({
        row: x.rowNumber, group: x.group, name: x.display, file: x.fileNo, status: x.statusRaw,
        u: c.intake || '', v: c.sessions || '', w: c.hours || '', aa: c.makeups || '', ab: c.makeupHours || '', ac: c.makeupType, n: c.absences || '',
        dates: x.attendance.map(a => `${state.month.m + 1}/${a.day} ${a.mark}${a.group !== x.group ? ` (${a.group})` : ''}`).join(', '),
        cur: [k.sessions, k.hours, k.makeups, k.makeupHours].map(v => (v == null ? '–' : v)).join(' / '),
        diff: x.diffs.map(d => `${d.label}: ${d.current == null ? 'blank' : d.current} → ${d.computed == null ? 'blank' : d.computed}`).join('; '),
        flags: x.flags.map(f => `[${f.severity}] ${f.message}`).join('\n'),
      });
    }
    b.getColumn('flags').alignment = { wrapText: true, vertical: 'top' };

    const a = wb.addWorksheet('Attendance detail');
    head(a, [['Date', 'date', 12], ['Weekday', 'wd', 10], ['Group', 'group', 8], ['Session #', 'sess', 10], ['Client', 'name', 30], ['File #', 'file', 12], ['Mark', 'mark', 7], ['Billed as', 'billed', 22], ['Tracker', 'tracker', 60]]);
    const billedAs = { A: 'Group session', MA: 'Group session + make-up', M: 'Make-up', N: 'Absent (not billed)' };
    for (const x of r.rows) for (const at of x.attendance) {
      const d = new Date(Date.UTC(state.month.y, state.month.m, at.day));
      a.addRow({ date: d, wd: d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }), group: at.group, sess: at.session, name: x.display, file: x.fileNo, mark: at.mark,
        billed: at.billed || at.mark === 'N' ? billedAs[at.mark] : 'Duplicate date, not billed', tracker: at.tracker });
    }
    a.getColumn('date').numFmt = 'm/d/yyyy';

    const f = wb.addWorksheet('Findings');
    head(f, [['Severity', 'sev', 10], ['Group', 'group', 8], ['Client', 'client', 30], ['Finding', 'msg', 100]]);
    r.findings.forEach(x => f.addRow({ sev: x.severity, group: x.group, client: x.client, msg: x.message }));

    if (state.lastExportLog && state.lastExportLog.length) {
      const l = wb.addWorksheet('Cells written');
      head(l, [['Row', 'row', 8], ['Client', 'client', 30], ['Field', 'field', 14], ['Was', 'from', 12], ['Now', 'to', 12]]);
      state.lastExportLog.forEach(x => l.addRow(x));
    }

    const buf = await wb.xlsx.writeBuffer();
    download(buf, `FACES Adult IPV billing audit - ${Core.monthLabel(state.month)}.xlsx`);
    toast('Audit workbook downloaded.');
  }

  /* ------------------------------------------------------- sample data */
  function loadSample() {
    const m = state.month;
    const dim = Core.daysInMonth(m.y, m.m);
    const classDaysFor = weekdays => Array.from({ length: dim }, (_, i) => i + 1).filter(d => weekdays.includes(new Date(Date.UTC(m.y, m.m, d)).getUTCDay()));
    const tue = classDaysFor([2, 4]); const mon = classDaysFor([1, 3]);
    const D = (mm, d) => new Date(Date.UTC(m.y, m.m + mm, d));
    const people = [
      ['SMP101', 'G1A', 'Rivera', 'Tomas', D(-2, 3), D(-2, 10), null, 'Pending/In Progress/Active', 8, 12],
      ['SMP102', 'G1A', 'Okafor', 'Daniel', D(0, 2), D(0, 4), null, 'Pending/In Progress/Active', null, null],
      ['SMP103', 'G1A', 'Castellano', 'Marco "Mars"', D(-3, 1), D(-3, 8), D(0, 12), 'Non-completion Discharge', null, null],
      ['SMP104', 'G1A', 'Whitfield Ross', 'Keandre', D(-1, 5), D(-1, 12), null, 'Pending/In Progress/Active', null, null],
      ['SMP105', 'G1A', 'Nguyen', 'Kevin', D(-4, 2), D(-4, 9), null, 'Completed ', null, null],
      ['SMP201', 'G1D', 'Delgado', 'Ruben', D(-1, 20), D(-1, 22), null, 'Pending/In Progress/Active', 9, 12],
      ['SMP202', 'G1D', 'Holloway', 'Melvin "Mel"', D(-2, 14), D(-2, 20), null, 'Pending/In Progress/Active', null, null],
      ['SMP203', 'G1D', 'Stuckert', 'Carl', D(-1, 1), D(-1, 6), null, 'Pending/In Progress/Active', null, null],
      ['SMP204', 'G1D', 'Ibarra', 'Joel', D(-3, 9), D(-3, 15), null, 'Pending/In Progress/Active', null, null],
      ['SMP301', 'G2D', 'Pacheco', 'Luis', D(-5, 1), D(-5, 7), null, 'Pending/In Progress/Active', null, null],
    ];
    const grid = [{ rowNumber: 3, values: [null, 'Program Name and Contract Number', 'File Number (Personal File Number)', 'Other', 'Group Number', 'Last Name', 'First Name', 'DOB', 'Gender', 'Race', 'ZIP', 'Referral', 'Contact', 'Enroll', 'Program Entry (Enrollment) Date', 'Service Start Date', 'Program Exit Date ', 'Program Completion Status (select from dropdown)', 'Discharge Reason', 'Discharge Notes', "Client's assigned Probation Officer", 'Duration of Intake Appointment:', 'Number of Sessions:', 'Duration of Sessions:', 'Session Type:', 'Session Time:', 'Session Language:', 'Number of Make-up Sessions:', 'Number of Hours for Make-up Sessions', 'Make-up Session Type (group or individual):'] }];
    people.forEach((p, i) => {
      const v = []; v[2] = p[0]; v[4] = p[1]; v[5] = p[2]; v[6] = p[3]; v[14] = p[4]; v[15] = p[5]; v[16] = p[6]; v[17] = p[7]; v[22] = p[8]; v[23] = p[9];
      grid.push({ rowNumber: 4 + i, values: v });
    });
    const roster = Core.parseRoster(grid, 'Sample').clients;
    const mk = (days, pattern) => Object.fromEntries(days.map((d, i) => [d, pattern[i] || 'A']).filter(([, v]) => v !== '_'));
    const tracker = (id, group, title, days, rows) => {
      const sheet = [[`${Core.MONTHS[m.m]} - ${m.y}`], ['Names', ...Array.from({ length: dim }, (_, i) => i + 1)], ['Session #', ...Array.from({ length: dim }, (_, i) => { const k = days.indexOf(i + 1); return k >= 0 ? String(k + 4) : ''; })]];
      for (const [name, marks] of rows) { const r = [name]; for (const [d, v] of Object.entries(marks)) r[+d] = v; sheet.push(r); }
      return Core.parseTrackerRows(sheet, { id, fileName: title, title, group, source: 'sample' });
    };
    const t1 = tracker('s1', 'G1A', 'Sample Cohort 30 G1A · Tue/Thu 5:30 pm', tue, [
      ['Tomas Rivera, 6/10, s9, 16s', mk(tue, [])],
      ['Daniel Okafor (new) s1 52', mk(tue, ['-', '_', 'A', 'N', 'A', 'MA', 'A', 'A', 'A'])],
      ['Marco Castellano', mk(tue, ['A', 'N', 'A', 'N', 'A', 'A', 'A', 'A'])],
      ['Keandra Whitfield', mk(tue, ['A', 'M', 'A', 'A', 'N', 'A', 'A', 'A'])],
      ['Jordan Pike', mk(tue.slice(0, 3), [])],
    ]);
    const t2 = tracker('s2', 'G1D', 'Sample Cohort 31 G1D · Mon/Wed 5:30 pm', mon, [
      ['Ruben Delgado', mk(mon, [])],
      ['Mel Holloway', mk(mon, ['A', 'A', 'MA', 'A', 'N', 'A', 'A', 'A', 'A'])],
      ['Carl Stuckart', mk(mon, ['A', 'A', 'A', 'N', 'N', 'N', 'A', 'A'])],
      ['Luis Pacheco', mk(mon.slice(0, 4), [])],
    ]);
    state.sample = true;
    state.workbook = null; state.rosterInfo = { sheetName: 'Sample' };
    state.roster = roster; state.trackers = [t1, t2]; state.manual = {}; state.overrides = {};
    state.filter = 'attention';
    rematch();
  }

  function clearSample() {
    if (!state.sample) return;
    state.sample = false; state.roster = []; state.trackers = []; state.rosterInfo = null; state.manual = {}; state.overrides = {};
  }

  /* ---------------------------------------------------------- wiring */
  function dropZone(zone, input, handler) {
    const run = async files => {
      for (const f of files) {
        try { await handler(f); } catch (e) { console.error(e); toast(`${f.name}: ${e.message || 'could not be read.'}`); }
      }
    };
    input.onchange = () => { run([...input.files]); input.value = ''; };
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('over'); run([...e.dataTransfer.files]); });
  }

  function bindSettings() {
    const map = [['#set-session', 'sessionHours'], ['#set-intake', 'intakeHours'], ['#set-rate-group', 'rateGroupHour'], ['#set-rate-makeup', 'rateMakeupHour'], ['#set-rate-intake', 'rateIntake']];
    for (const [sel, key] of map) {
      const el = $(sel);
      el.value = state.settings[key] || (key.startsWith('rate') ? '' : 0);
      el.onchange = () => { state.settings[key] = parseFloat(el.value) || 0; persist(); recompute(); };
    }
    $('#set-mu-type').value = state.settings.defaultMakeupType;
    $('#set-mu-type').onchange = e => { state.settings.defaultMakeupType = e.target.value; persist(); recompute(); };
  }

  function init() {
    $('#month').value = `${state.month.y}-${String(state.month.m + 1).padStart(2, '0')}`;
    $('#month').onchange = e => {
      const [y, mm] = e.target.value.split('-').map(Number);
      if (y && mm) setMonth({ y, m: mm - 1 });
    };
    dropZone($('#drop-roster'), $('#file-roster'), loadRosterFile);
    dropZone($('#drop-trackers'), $('#file-trackers'), loadTrackerFile);
    $('#add-class').onclick = () => { state.classes.push({ group: 'G1C', label: '', url: '', tab: '' }); persist(); renderClasses(); };
    $('#fetch-all').onclick = () => runFetch(state.classes);
    $('#show-all-matches').onchange = e => { state.showAllMatches = e.target.checked; renderMatches(); };
    $('#search').oninput = e => { state.search = e.target.value; renderLedger(); };
    $('#export-county').onclick = () => exportCounty().catch(e => toast(`Export failed: ${e.message}`));
    $('#export-audit').onclick = () => exportAudit().catch(e => toast(`Export failed: ${e.message}`));
    $('#copy-narrative').onclick = () => {
      const ta = $('#narrative');
      navigator.clipboard.writeText(ta.value).then(() => toast('Figures copied.'), () => { ta.select(); toast('Press Ctrl+C to copy the selected text.'); });
    };
    $('#clear-sample').onclick = () => { clearSample(); rematch(); };
    $('#forget').onclick = () => {
      try { localStorage.removeItem(STORE); } catch (e) { /* ignore */ }
      state.matchMemory = {}; state.classes = defaultClasses(); state.settings = Object.assign({}, Core.DEFAULT_SETTINGS);
      bindSettings(); recompute(); toast('Saved links, rates and matches cleared from this computer.');
    };
    $('#theme').onclick = () => {
      const root = document.documentElement;
      const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
      root.dataset.theme = dark ? 'light' : 'dark';
    };
    bindSettings();
    if (!saved.seenSample) loadSample(); else recompute();
    persist();
  }

  init();
})();
