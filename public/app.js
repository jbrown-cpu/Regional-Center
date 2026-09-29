/* Regional Center Billing — single-page client. No framework, no inline scripts (strict CSP). */
(() => {
  'use strict';

  // ---------- utilities ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
  const raw = (s) => new Raw(String(s));
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function fmt(v) {
    if (v instanceof Raw) return v.s;
    if (Array.isArray(v)) return v.map(fmt).join('');
    if (v === null || v === undefined || v === false) return '';
    return esc(v);
  }
  // Tagged template: interpolated values are HTML-escaped unless wrapped with raw().
  function h(strings, ...vals) {
    let out = strings[0];
    vals.forEach((v, i) => { out += fmt(v) + strings[i + 1]; });
    return raw(out);
  }

  const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const money = (c) => moneyFmt.format((Number(c) || 0) / 100);
  const wholeFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const moneyFmtCents = (c) => moneyFmt.format((Number(c) || 0) / 100);
  const moneyWhole = (c) => wholeFmt.format(Math.round((Number(c) || 0) / 100));
  const dollars = (c) => (c === null || c === undefined ? '' : (Number(c) / 100).toFixed(2));
  const units = (u) => (Math.round(Number(u || 0) * 100) / 100).toString();
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthLabel = (m) => (m ? `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}` : '');
  const fullName = (r) => `${r.last_name}, ${r.first_name}`;
  const unitLabel = (t) => ({ day: 'day', hour: 'hour', quarter_hour: '15 min', month: 'month', session: 'session', trip: 'trip', mile: 'mile' }[t] || t);
  function prevMonth(m) {
    const [y, mo] = m.split('-').map(Number);
    const d = new Date(Date.UTC(y, mo - 2, 1));
    return d.toISOString().slice(0, 7);
  }
  function daysIn(m) { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo, 0)).getUTCDate(); }
  function dow(dateStr) { return new Date(dateStr + 'T00:00:00Z').getUTCDay(); }
  const pad = (n) => String(n).padStart(2, '0');

  const ROLE_RANK = { viewer: 0, staff: 1, biller: 2, admin: 3 };
  const can = (role) => state.me && ROLE_RANK[state.me.user.role] >= ROLE_RANK[role];

  const STATUS_BADGE = {
    draft: '', submitted: 'accent', partial: 'warn', paid: 'good', void: 'bad',
    active: 'good', pending: 'warn', inactive: '', expired: 'bad', terminated: 'bad',
  };
  const badge = (s, label) => h`<span class="badge ${STATUS_BADGE[s] || ''}">${label || s}</span>`;

  const state = { me: null, meta: null };

  async function api(method, url, body) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (res.status === 401 && !url.startsWith('/api/login') && !url.startsWith('/api/me')) { boot(); throw new Error('Session expired. Please sign in again.'); }
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status}).`);
    return data;
  }
  const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v !== null && v !== undefined)).toString();

  let toastTimer;
  function toast(msg, isError) {
    let el = $('#toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
    el.className = 'toast' + (isError ? ' error' : '');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 7000 : 3500);
  }

  function downloadCsv(filename, rows) {
    const cell = (v) => {
      let s = v === null || v === undefined ? '' : String(v);
      if (/^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const blob = new Blob([rows.map((r) => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- dialogs & forms ----------
  function fieldHtml(f, v) {
    const val = v ?? f.default ?? '';
    const req = f.required ? raw(' required') : '';
    const cls = f.full ? 'field full' : 'field';
    const help = f.help ? h`<span class="help">${f.help}</span>` : '';
    if (f.type === 'checkbox') {
      return h`<label class="check ${f.full ? 'full' : ''}"><input type="checkbox" name="${f.name}" ${val ? raw('checked') : ''}> ${f.label}</label>`;
    }
    if (f.type === 'select') {
      const opts = (f.options || []).map(([ov, ol]) => h`<option value="${ov}" ${String(ov) === String(val) ? raw('selected') : ''}>${ol}</option>`);
      return h`<label class="${cls}">${f.label}<select name="${f.name}"${req}>${f.placeholder ? h`<option value="">${f.placeholder}</option>` : ''}${opts}</select>${help}</label>`;
    }
    if (f.type === 'textarea') {
      return h`<label class="${cls}">${f.label}<textarea name="${f.name}"${req}>${val}</textarea>${help}</label>`;
    }
    return h`<label class="${cls}">${f.label}<input type="${f.type || 'text'}" name="${f.name}" value="${val}"${req}
      ${f.step ? raw(`step="${esc(f.step)}"`) : ''} ${f.min !== undefined ? raw(`min="${esc(f.min)}"`) : ''}
      ${f.maxlength ? raw(`maxlength="${esc(f.maxlength)}"`) : ''} ${f.pattern ? raw(`pattern="${esc(f.pattern)}"`) : ''}
      ${f.placeholder ? raw(`placeholder="${esc(f.placeholder)}"`) : ''} autocomplete="off">${help}</label>`;
  }

  function readForm(form, fields) {
    const out = {};
    for (const f of fields) {
      const el = form.elements[f.name];
      if (!el) continue;
      out[f.name] = f.type === 'checkbox' ? el.checked : el.value;
    }
    return out;
  }

  function openDialog({ title, body, submitLabel = 'Save', onSubmit, onOpen, danger, wide }) {
    const dlg = document.createElement('dialog');
    if (wide) dlg.classList.add('wide');
    dlg.innerHTML = String(h`<form method="dialog">
      <div class="dlg-head"><h2>${title}</h2><button type="button" class="small" data-close aria-label="Close">✕</button></div>
      <div class="dlg-body"><div class="alert error hidden" data-err></div>${body}</div>
      <div class="dlg-foot"><button type="button" data-close>Cancel</button>
        ${onSubmit ? h`<button type="submit" class="${danger ? 'danger' : 'primary'}">${submitLabel}</button>` : ''}</div></form>`);
    document.body.appendChild(dlg);
    const form = $('form', dlg);
    const close = () => { dlg.close(); dlg.remove(); };
    $$('[data-close]', dlg).forEach((b) => b.addEventListener('click', close));
    dlg.addEventListener('cancel', () => setTimeout(() => dlg.remove(), 0));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!onSubmit) return close();
      const btn = $('button[type=submit]', dlg);
      btn.disabled = true;
      const err = $('[data-err]', dlg);
      err.classList.add('hidden');
      try {
        const keepOpen = await onSubmit(form);
        if (!keepOpen) close();
      } catch (ex) {
        err.textContent = ex.message;
        err.classList.remove('hidden');
        btn.disabled = false;
      }
    });
    dlg.showModal();
    if (onOpen) onOpen(form, dlg);
    return dlg;
  }

  function formDialog({ title, fields, values = {}, submitLabel, onSubmit, onOpen, intro }) {
    return openDialog({
      title,
      submitLabel,
      body: h`${intro || ''}<div class="form-grid">${fields.map((f) => fieldHtml(f, values[f.name]))}</div>`,
      onSubmit: (form) => onSubmit(readForm(form, fields), form),
      onOpen,
    });
  }

  function confirmDialog(title, message, onConfirm, { label = 'Confirm', danger = true, reason = false } = {}) {
    return openDialog({
      title,
      body: h`<p>${message}</p>${reason ? h`<label class="field">Reason<textarea name="reason" required></textarea></label>` : ''}`,
      submitLabel: label,
      danger,
      onSubmit: (form) => onConfirm(reason ? form.elements.reason.value : undefined),
    });
  }

  // ---------- option helpers ----------
  const rcOptions = () => state.meta.regional_centers.filter((r) => r.active).map((r) => [r.id, r.name]);
  const programOptions = (activeOnly = true) => state.meta.programs.filter((p) => !activeOnly || p.active)
    .map((p) => [p.id, `${p.name} — ${p.vendor_number} / ${p.service_code}${p.subcode ? '-' + p.subcode : ''} (${p.rc_abbr || p.regional_center_name})`]);
  const unitOptions = () => state.meta.unit_types.map((u) => [u, unitLabel(u)]);
  async function reloadMeta() { state.meta = await api('GET', '/api/meta'); }

  // ---------- boot / auth ----------
  const app = $('#app');

  async function boot() {
    try {
      const me = await api('GET', '/api/me');
      state.me = me;
      await reloadMeta();
      renderShell();
      route();
    } catch {
      state.me = null;
      const s = await api('GET', '/api/setup-status');
      if (s.needsSetup) renderSetup(); else renderLogin();
    }
  }

  function renderLogin() {
    app.innerHTML = String(h`<div class="auth-screen"><div class="card auth-card">
      <h1>Regional Center Billing</h1><div class="muted">Sign in to continue.</div>
      <div class="alert error hidden" id="login-err"></div>
      <form id="login-form">
        <label class="field">Username<input name="username" autocomplete="username" required autofocus></label>
        <label class="field">Password<input name="password" type="password" autocomplete="current-password" required></label>
        <button class="primary" type="submit">Sign in</button>
      </form>
      <p class="help">This system contains confidential consumer information protected under HIPAA and the Lanterman Act (W&amp;I Code §4514). Access is logged.</p>
    </div></div>`);
    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await api('POST', '/api/login', { username: f.username.value, password: f.password.value });
        boot();
      } catch (ex) {
        $('#login-err').textContent = ex.message;
        $('#login-err').classList.remove('hidden');
      }
    });
  }

  function renderSetup() {
    app.innerHTML = String(h`<div class="auth-screen"><div class="card auth-card">
      <h1>Welcome</h1><div class="muted">Create the administrator account to get started.</div>
      <div class="alert error hidden" id="setup-err"></div>
      <form id="setup-form">
        <label class="field">Organization name<input name="organization_name" placeholder="e.g. Bright Futures Adult Day Program"></label>
        <label class="field">Your full name<input name="full_name" required></label>
        <label class="field">Username<input name="username" autocomplete="username" required></label>
        <label class="field">Password<input name="password" type="password" autocomplete="new-password" required minlength="10">
          <span class="help">At least 10 characters with letters and numbers.</span></label>
        <button class="primary" type="submit">Create administrator</button>
      </form></div></div>`);
    $('#setup-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await api('POST', '/api/setup', { organization_name: f.organization_name.value, full_name: f.full_name.value, username: f.username.value, password: f.password.value });
        location.hash = '#/settings';
        boot();
      } catch (ex) {
        $('#setup-err').textContent = ex.message;
        $('#setup-err').classList.remove('hidden');
      }
    });
  }

  const NAV = [
    ['dashboard', 'Dashboard'],
    ['consumers', 'Consumers'],
    ['authorizations', 'Authorizations'],
    ['attendance', 'Attendance'],
    ['invoices', 'Invoices'],
    ['payments', 'Payments'],
    ['reports', 'Reports'],
    ['settings', 'Settings'],
  ];

  function renderShell() {
    const u = state.me.user;
    app.innerHTML = String(h`<div class="layout">
      <aside class="sidebar">
        <div class="brand">Regional Center Billing</div>
        <div class="brand-sub">${state.me.organization_name || 'DDS vendor billing'}</div>
        <nav class="nav">${NAV.map(([k, l]) => h`<a href="#/${k}" data-nav="${k}">${l}</a>`)}</nav>
        <div class="spacer"></div>
        <div class="userbox"><div class="name">${u.full_name}</div><div>${u.role}</div>
          <p><button class="small" id="logout">Sign out</button></p></div>
      </aside>
      <main class="main" id="view"></main></div>`);
    $('#logout').addEventListener('click', async () => { await api('POST', '/api/logout', {}); state.me = null; location.hash = ''; boot(); });
  }

  // ---------- router ----------
  const ROUTES = [
    [/^\/?$/, () => pageDashboard()],
    [/^\/dashboard$/, () => pageDashboard()],
    [/^\/consumers$/, () => pageConsumers()],
    [/^\/consumers\/(\d+)$/, (m) => pageConsumer(Number(m[1]))],
    [/^\/authorizations$/, () => pageAuthorizations()],
    [/^\/attendance$/, () => pageAttendance()],
    [/^\/invoices$/, () => pageInvoices()],
    [/^\/invoices\/(\d+)$/, (m) => pageInvoice(Number(m[1]))],
    [/^\/payments$/, () => pagePayments()],
    [/^\/payments\/new$/, () => pagePaymentNew()],
    [/^\/payments\/(\d+)$/, (m) => pagePayment(Number(m[1]))],
    [/^\/reports$/, () => pageReports()],
    [/^\/settings$/, () => pageSettings()],
  ];

  function hashParts() {
    const hsh = location.hash.replace(/^#/, '');
    const [path, query] = hsh.split('?');
    return { path: path || '/', params: new URLSearchParams(query || '') };
  }

  async function route() {
    if (!state.me) return;
    const { path } = hashParts();
    const view = $('#view');
    const top = path.split('/')[1] || 'dashboard';
    $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === top));
    for (const [re, fn] of ROUTES) {
      const m = re.exec(path);
      if (m) {
        view.innerHTML = '<div class="muted">Loading…</div>';
        try { await fn(m); } catch (ex) { view.innerHTML = String(h`<div class="alert error">${ex.message}</div>`); }
        return;
      }
    }
    view.innerHTML = '<div class="alert error">Page not found.</div>';
  }
  window.addEventListener('hashchange', route);
  const setView = (content) => { $('#view').innerHTML = String(content); return $('#view'); };
  const pageHead = (title, sub, actions) => h`<div class="page-head"><div><h1>${title}</h1>${sub ? h`<div class="sub">${sub}</div>` : ''}</div><div class="toolbar">${actions || ''}</div></div>`;

  // ---------- chart ----------
  function barChart(el, data, { valueLabel = (v) => v, height = 220 } = {}) {
    if (!data.length) { el.innerHTML = '<div class="empty">No submitted invoices yet.</div>'; return; }
    const W = 640, H = height, L = 64, R = 8, T = 10, Bm = 26;
    const max = Math.max(...data.map((d) => d.value), 1);
    const niceStep = (() => { const raw = max / 4; const p = 10 ** Math.floor(Math.log10(raw)); return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw); })();
    const top = niceStep * Math.ceil(max / niceStep);
    const y = (v) => T + (H - T - Bm) * (1 - v / top);
    const band = (W - L - R) / data.length;
    const bw = Math.min(36, band * 0.6);
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Bar chart">`;
    for (let v = 0; v <= top + 1e-9; v += niceStep) {
      svg += `<line class="gridline" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"></line>`;
      svg += `<g class="axis"><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${esc(valueLabel(v, true))}</text></g>`;
    }
    data.forEach((d, i) => {
      const x = L + band * i + (band - bw) / 2;
      const yy = y(d.value);
      const hgt = Math.max(0, H - Bm - yy);
      const r = Math.min(4, hgt / 2, bw / 2);
      // Bar with rounded data-end (top) anchored flat to the baseline.
      const path = hgt > 0
        ? `M${x},${H - Bm} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + bw - r} Q${x + bw},${yy} ${x + bw},${yy + r} V${H - Bm} Z`
        : '';
      svg += `<g class="col" data-i="${i}"><rect class="hit" x="${L + band * i}" y="${T}" width="${band}" height="${H - T - Bm}"></rect>`;
      svg += path ? `<path class="bar" d="${path}"></path>` : '';
      svg += `</g><g class="axis"><text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${esc(d.short)}</text></g>`;
    });
    svg += '</svg>';
    el.innerHTML = `<div class="chart">${svg}<div class="tooltip" hidden></div></div>`;
    const tip = $('.tooltip', el);
    const chart = $('.chart', el);
    $$('g.col', el).forEach((g) => {
      g.addEventListener('mouseenter', () => {
        const d = data[Number(g.dataset.i)];
        tip.textContent = `${d.label}: ${valueLabel(d.value)}`;
        const box = g.getBoundingClientRect();
        const cb = chart.getBoundingClientRect();
        const bar = $('.bar', g);
        const bb = bar ? bar.getBoundingClientRect() : box;
        tip.style.left = `${box.left - cb.left + box.width / 2}px`;
        tip.style.top = `${bb.top - cb.top}px`;
        tip.hidden = false;
      });
      g.addEventListener('mouseleave', () => { tip.hidden = true; });
    });
  }

  // ---------- dashboard ----------
  async function pageDashboard() {
    const d = await api('GET', '/api/dashboard');
    const k = d.kpis;
    const trendData = [];
    for (let i = 11; i >= 0; i--) {
      let m = d.month;
      for (let j = 0; j < i; j++) m = prevMonth(m);
      const row = d.trend.find((t) => t.service_month === m);
      trendData.push({ label: monthLabel(m), short: MONTHS[Number(m.slice(5, 7)) - 1], value: row ? row.billed_cents : 0 });
    }
    const v = setView(h`${pageHead('Dashboard', `Today is ${d.today}`, can('biller') ? h`<a class="btn primary" href="#/invoices?generate=${d.previous_month}">Bill ${monthLabel(d.previous_month)}</a>` : '')}
      <div class="grid kpis">
        ${kpi('Outstanding A/R', money(k.outstanding_cents), 'Submitted, not yet paid')}
        ${kpi('Over 90 days', money(k.over_90_cents), k.over_90_cents ? 'Escalate with RC accounting' : 'Nothing aged past 90 days')}
        ${kpi('Collected this month', money(k.collected_this_month_cents), 'Payments posted')}
        ${kpi(`Billed ${monthLabel(d.previous_month)}`, money(k.billed_last_month_cents), 'Submitted invoices')}
        ${kpi('Active consumers', k.active_consumers, `${k.active_authorizations} active authorizations`)}
        ${kpi('Draft invoices', k.draft_invoices, k.draft_invoices ? 'Awaiting review & submission' : 'All caught up')}
      </div>
      <div class="grid two">
        <div class="card"><h2>Billed by service month</h2><div id="trend"></div>
          <details><summary class="muted">View as table</summary><table><thead><tr><th>Month</th><th class="num">Billed</th></tr></thead>
          <tbody>${trendData.map((t) => h`<tr><td>${t.label}</td><td class="num">${money(t.value)}</td></tr>`)}</tbody></table></details></div>
        <div class="card"><h2>A/R aging by regional center</h2>${agingTable(d.aging, true)}</div>
      </div>
      <div class="grid two">
        <div class="card"><h2>Authorizations expiring (45 days)</h2>
          ${d.expiring.length ? h`<ul class="list">${d.expiring.map((a) => h`<li><span><a href="#/consumers/${a.consumer_id}">${fullName(a)}</a>
            <span class="muted">· ${a.program_name} · #${a.auth_number}</span></span>
            <span class="badge ${a.days_left <= 14 ? 'bad' : 'warn'}">${a.days_left} days</span></li>`)}</ul>`
            : h`<div class="empty">No authorizations expiring soon.</div>`}</div>
        <div class="card"><h2>Action items</h2>${actionItems(d)}</div>
      </div>`);
    barChart($('#trend', v), trendData, { valueLabel: (val, axis) => (axis ? (val >= 100000 ? `$${Math.round(val / 100000)}k` : `$${Math.round(val / 100)}`) : money(val)) });
  }

  const kpi = (label, value, hint) => h`<div class="card kpi"><div class="label">${label}</div><div class="value">${value}</div><div class="hint">${hint}</div></div>`;

  function actionItems(d) {
    const items = [];
    for (const u of d.unbilled) {
      items.push(h`<li><span>Unbilled attendance: <strong>${u.program_name}</strong> · ${monthLabel(u.service_month)} (${units(u.units)} units)</span>
        ${can('biller') ? h`<a class="btn small" href="#/invoices?generate=${u.service_month}&program=${u.program_id}">Bill</a>` : ''}</li>`);
    }
    for (const inv of d.drafts) {
      items.push(h`<li><span>Draft invoice <a href="#/invoices/${inv.id}">${inv.invoice_number}</a> · ${inv.program_name} · ${monthLabel(inv.service_month)}</span><span>${money(inv.total_cents)}</span></li>`);
    }
    for (const o of d.over_authorization) {
      items.push(h`<li><span>${fullName(o)} exceeded authorization by ${units(o.unbilled_units)} unit(s) on <a href="#/invoices/${o.invoice_id}">${o.invoice_number}</a></span><span class="badge bad">Request increase</span></li>`);
    }
    return items.length ? h`<ul class="list">${items}</ul>` : h`<div class="empty">Nothing needs attention. Well done.</div>`;
  }

  function agingTable(aging, compact) {
    if (!aging.rows.length) return h`<div class="empty">No outstanding receivables.</div>`;
    const money = compact ? moneyWhole : moneyFmtCents;
    return h`<div class="table-wrap"><table class="${compact ? 'compact' : ''}"><thead><tr><th>Regional center</th>${aging.buckets.map((b) => h`<th class="num">${b.label}</th>`)}<th class="num">Total</th></tr></thead>
      <tbody>${aging.rows.map((r) => h`<tr><td>${compact ? (r.abbr || r.name) : r.name}</td>${aging.buckets.map((b) => h`<td class="num">${r[b.key] ? money(r[b.key]) : '—'}</td>`)}<td class="num"><strong>${money(r.total)}</strong></td></tr>`)}</tbody>
      <tfoot><tr><td>Total</td>${aging.buckets.map((b) => h`<td class="num">${money(aging.totals[b.key])}</td>`)}<td class="num">${money(aging.totals.total)}</td></tr></tfoot></table></div>`;
  }

  // ---------- consumers ----------
  const consumerFields = () => [
    { name: 'first_name', label: 'First name', required: true },
    { name: 'last_name', label: 'Last name', required: true },
    { name: 'uci', label: 'UCI number', required: true, pattern: '\\d{7}', maxlength: 7, help: '7-digit Unique Client Identifier' },
    { name: 'dob', label: 'Date of birth', type: 'date' },
    { name: 'regional_center_id', label: 'Regional center', type: 'select', options: rcOptions(), required: true, placeholder: 'Select…' },
    { name: 'status', label: 'Status', type: 'select', options: [['active', 'Active'], ['pending', 'Pending intake'], ['inactive', 'Inactive']] },
    { name: 'service_coordinator', label: 'Service coordinator' },
    { name: 'sc_phone', label: 'SC phone' },
    { name: 'sc_email', label: 'SC email', type: 'email', full: true },
    { name: 'notes', label: 'Notes', type: 'textarea', full: true },
  ];

  function editConsumer(c, after) {
    formDialog({
      title: c ? 'Edit consumer' : 'Add consumer',
      fields: consumerFields(),
      values: c || { status: 'active' },
      onSubmit: async (vals) => {
        const r = c ? await api('PUT', `/api/consumers/${c.id}`, vals) : await api('POST', '/api/consumers', vals);
        toast('Consumer saved.');
        after(c ? c.id : r.id);
      },
    });
  }

  async function pageConsumers() {
    const { params } = hashParts();
    const q = params.get('q') || '';
    const status = params.get('status') ?? 'active';
    const data = await api('GET', '/api/consumers?' + qs({ q, status }));
    const v = setView(h`${pageHead('Consumers', `${data.consumers.length} shown`, can('biller') ? h`<button class="primary" id="add">Add consumer</button>` : '')}
      <form class="toolbar" id="filters"><input name="q" placeholder="Search name or UCI" value="${q}">
        <select name="status"><option value="">All statuses</option>${['active', 'pending', 'inactive'].map((s) => h`<option ${s === status ? raw('selected') : ''}>${s}</option>`)}</select>
        <button>Filter</button></form>
      <div class="card table-wrap">${data.consumers.length ? h`<table><thead><tr><th>Name</th><th>UCI</th><th>Regional center</th><th>Service coordinator</th><th class="num">Active auths</th><th>Status</th></tr></thead>
      <tbody>${data.consumers.map((c) => h`<tr class="clickable" data-href="#/consumers/${c.id}"><td><strong>${fullName(c)}</strong></td><td class="mono">${c.uci}</td>
        <td>${c.rc_abbr || c.regional_center_name}</td><td>${c.service_coordinator || '—'}</td>
        <td class="num">${c.active_auths ? c.active_auths : h`<span class="badge warn">None</span>`}</td><td>${badge(c.status)}</td></tr>`)}</tbody></table>`
      : h`<div class="empty">No consumers found.</div>`}</div>`);
    wireRowLinks(v);
    $('#filters', v).addEventListener('submit', (e) => { e.preventDefault(); location.hash = '#/consumers?' + qs({ q: e.target.q.value, status: e.target.status.value }); });
    $('#add', v)?.addEventListener('click', () => editConsumer(null, (cid) => { location.hash = `#/consumers/${cid}`; }));
  }

  function wireRowLinks(root) {
    $$('tr[data-href]', root).forEach((tr) => tr.addEventListener('click', (e) => {
      if (e.target.closest('a,button,input,select')) return;
      location.hash = tr.dataset.href;
    }));
  }

  async function pageConsumer(cid) {
    const { consumer: c, authorizations } = await api('GET', `/api/consumers/${cid}`);
    const v = setView(h`${pageHead(fullName(c), h`UCI <span class="mono">${c.uci}</span> · ${c.regional_center_name}`,
      can('biller') ? h`<button id="edit">Edit</button><button class="primary" id="add-auth">Add authorization</button>` : '')}
      <div class="grid two"><div class="card"><h2>Profile</h2><table>
        <tr><th>Status</th><td>${badge(c.status)}</td></tr>
        <tr><th>Date of birth</th><td>${c.dob || '—'}</td></tr>
        <tr><th>Service coordinator</th><td>${c.service_coordinator || '—'}</td></tr>
        <tr><th>SC phone</th><td>${c.sc_phone || '—'}</td></tr>
        <tr><th>SC email</th><td>${c.sc_email ? h`<a href="mailto:${c.sc_email}">${c.sc_email}</a>` : '—'}</td></tr>
        <tr><th>Notes</th><td>${c.notes || '—'}</td></tr></table></div>
      <div class="card"><h2>Authorization summary</h2>${authorizations.length ? h`<ul class="list">${authorizations.map((a) => h`<li><span>#${a.auth_number} · ${a.program_name}</span><span>${authStatusBadge(a)}</span></li>`)}</ul>` : h`<div class="empty">No authorizations on file. Services cannot be billed without a POS authorization.</div>`}</div></div>
      <div class="card"><h2>Authorizations</h2>${authTable(authorizations, false)}</div>`);
    $('#edit', v)?.addEventListener('click', () => editConsumer(c, () => route()));
    $('#add-auth', v)?.addEventListener('click', () => editAuth(null, route, { consumer_id: cid }));
    wireAuthRows(v, authorizations);
  }

  // ---------- authorizations ----------
  function authStatusBadge(a) {
    if (a.status === 'active' && a.days_to_expiration < 0) return badge('expired', 'Expired');
    if (a.status === 'active' && a.days_to_expiration <= 30) return badge('pending', `Expires in ${a.days_to_expiration}d`);
    return badge(a.status);
  }

  function authTable(rows, showConsumer = true) {
    if (!rows.length) return h`<div class="empty">No authorizations found.</div>`;
    return h`<div class="table-wrap"><table><thead><tr>${showConsumer ? h`<th>Consumer</th>` : ''}<th>Auth #</th><th>Program / service</th><th class="num">Rate</th>
      <th class="num">Authorized</th><th class="num">This month</th><th>Period</th><th>Status</th></tr></thead>
      <tbody>${rows.map((a) => {
        const used = Number(a.units_recorded_this_month || 0);
        const cap = a.units_period === 'month' ? Number(a.units_authorized) : Number(a.units_authorized) - Number(a.units_billed_total || 0);
        const over = used > cap;
        return h`<tr class="${can('biller') ? 'clickable' : ''}" data-auth="${a.id}">${showConsumer ? h`<td><a href="#/consumers/${a.consumer_id}">${fullName(a)}</a><div class="muted mono">${a.uci}</div></td>` : ''}
        <td class="mono">${a.auth_number}</td><td>${a.program_name}<div class="muted">${a.vendor_number} · svc ${a.service_code}${a.subcode ? '-' + a.subcode : ''}</div></td>
        <td class="num">${money(a.rate_cents)}/${unitLabel(a.unit_type)}</td>
        <td class="num">${units(a.units_authorized)} ${a.units_period === 'month' ? '/mo' : 'total'}${a.units_period === 'total' ? h`<div class="muted">${units(a.units_billed_total)} billed</div>` : ''}</td>
        <td class="num">${units(used)}${over ? h` <span class="badge bad">Over</span>` : ''}</td>
        <td>${a.start_date} → ${a.end_date}</td><td>${authStatusBadge(a)}</td></tr>`;
      })}</tbody></table></div>`;
  }

  function wireAuthRows(root, rows) {
    if (!can('biller')) return;
    $$('tr[data-auth]', root).forEach((tr) => tr.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      editAuth(rows.find((a) => a.id === Number(tr.dataset.auth)), route);
    }));
  }

  async function editAuth(a, after, preset = {}) {
    const { consumers } = await api('GET', '/api/consumers?status=');
    const fields = [
      { name: 'consumer_id', label: 'Consumer', type: 'select', required: true, placeholder: 'Select…', full: true,
        options: consumers.map((c) => [c.id, `${fullName(c)} (UCI ${c.uci})`]) },
      { name: 'program_id', label: 'Program (vendor / service code)', type: 'select', required: true, placeholder: 'Select…', full: true, options: programOptions(false) },
      { name: 'auth_number', label: 'POS authorization number', required: true },
      { name: 'status', label: 'Status', type: 'select', options: [['active', 'Active'], ['pending', 'Pending'], ['expired', 'Expired'], ['terminated', 'Terminated']] },
      { name: 'unit_type', label: 'Unit type', type: 'select', options: unitOptions(), required: true },
      { name: 'rate', label: 'Rate per unit ($)', type: 'number', step: '0.01', min: 0, required: true },
      { name: 'units_authorized', label: 'Units authorized', type: 'number', step: '0.01', min: 0, required: true },
      { name: 'units_period', label: 'Units apply', type: 'select', options: [['month', 'Per month'], ['total', 'Total for authorization period']] },
      { name: 'start_date', label: 'Start date', type: 'date', required: true },
      { name: 'end_date', label: 'End date', type: 'date', required: true },
      { name: 'notes', label: 'Notes', type: 'textarea', full: true },
    ];
    const values = a ? { ...a, rate: dollars(a.rate_cents) } : { status: 'active', units_period: 'month', ...preset };
    formDialog({
      title: a ? `Authorization #${a.auth_number}` : 'Add authorization',
      fields,
      values,
      onOpen: (form) => {
        form.elements.program_id.addEventListener('change', () => {
          const p = state.meta.programs.find((x) => x.id === Number(form.elements.program_id.value));
          if (!p) return;
          form.elements.unit_type.value = p.unit_type;
          if (!form.elements.rate.value && p.default_rate_cents) form.elements.rate.value = dollars(p.default_rate_cents);
        });
      },
      onSubmit: async (vals) => {
        if (a) await api('PUT', `/api/authorizations/${a.id}`, vals); else await api('POST', '/api/authorizations', vals);
        toast('Authorization saved.');
        after();
      },
    });
  }

  async function pageAuthorizations() {
    const { params } = hashParts();
    const f = { q: params.get('q') || '', program_id: params.get('program_id') || '', status: params.get('status') ?? 'active', expiring_days: params.get('expiring_days') || '' };
    const { authorizations } = await api('GET', '/api/authorizations?' + qs(f));
    const v = setView(h`${pageHead('Authorizations', 'Purchase of Service (POS) authorizations from regional centers', can('biller') ? h`<button class="primary" id="add">Add authorization</button>` : '')}
      <form class="toolbar" id="filters"><input name="q" placeholder="Auth #, UCI or name" value="${f.q}">
        <select name="program_id"><option value="">All programs</option>${programOptions(false).map(([id, l]) => h`<option value="${id}" ${String(id) === f.program_id ? raw('selected') : ''}>${l}</option>`)}</select>
        <select name="status"><option value="">All statuses</option>${['active', 'pending', 'expired', 'terminated'].map((s) => h`<option ${s === f.status ? raw('selected') : ''}>${s}</option>`)}</select>
        <select name="expiring_days"><option value="">Any end date</option>${[30, 60, 90].map((n) => h`<option value="${n}" ${String(n) === f.expiring_days ? raw('selected') : ''}>Expiring ≤ ${n} days</option>`)}</select>
        <button>Filter</button></form>
      <div class="card">${authTable(authorizations)}</div>`);
    wireAuthRows(v, authorizations);
    $('#filters', v).addEventListener('submit', (e) => {
      e.preventDefault();
      const t = e.target;
      location.hash = '#/authorizations?' + qs({ q: t.q.value, program_id: t.program_id.value, status: t.status.value, expiring_days: t.expiring_days.value });
    });
    $('#add', v)?.addEventListener('click', () => editAuth(null, route));
  }

  // ---------- attendance ----------
  const DAY_CYCLE = ['', 'present', 'partial', 'absent', 'excused', 'holiday'];
  const DAY_LABEL = { present: 'P', partial: '½', absent: 'A', excused: 'E', holiday: 'H', '': '' };

  async function pageAttendance() {
    const { params } = hashParts();
    const programs = programOptions();
    if (!programs.length) {
      setView(h`${pageHead('Attendance')}<div class="card empty">Add a program under <a href="#/settings">Settings</a> before recording attendance.</div>`);
      return;
    }
    const programId = params.get('program') || String(programs[0][0]);
    const month = params.get('month') || state.me.today.slice(0, 7);
    const data = await api('GET', '/api/attendance?' + qs({ program_id: programId, month }));
    const p = data.program;
    const isDay = (row) => row.unit_type === 'day';
    const pending = new Map(); // key auth|date -> entry

    const days = [];
    for (let d = 1; d <= data.days; d++) {
      const date = `${month}-${pad(d)}`;
      days.push({ d, date, we: [0, 6].includes(dow(date)), label: 'SMTWTFS'[dow(date)] });
    }

    const cellFor = (row, day) => {
      const rec = pending.get(`${row.id}|${day.date}`) || row.records[day.date] || null;
      const dirty = pending.has(`${row.id}|${day.date}`);
      const out = day.date < row.start_date || day.date > row.end_date;
      const cls = [day.we ? 'we' : '', out ? 'oow' : ''].join(' ');
      if (out) return h`<td class="${cls}" title="Outside authorization dates"></td>`;
      const title = rec ? `${rec.status}${rec.units ? ` · ${rec.units} unit(s)` : ''}${rec.hours ? ` · ${rec.hours} h` : ''}${rec.note ? ` · ${rec.note}` : ''}` : 'Not recorded';
      if (isDay(row)) {
        const st = rec ? rec.status : '';
        return h`<td class="${cls}"><button type="button" class="cell ${st} ${dirty ? 'dirty' : ''}" data-a="${row.id}" data-d="${day.date}"
          ${row.locked || !can('staff') ? raw('disabled') : ''} title="${title}">${DAY_LABEL[st]}</button></td>`;
      }
      const val = rec && ['present', 'partial'].includes(rec.status) ? rec.units : '';
      return h`<td class="${cls}"><input class="cell-input ${val ? 'filled' : ''} ${dirty ? 'dirty' : ''}" data-a="${row.id}" data-d="${day.date}"
        value="${val}" inputmode="decimal" ${row.locked || !can('staff') ? raw('disabled') : ''} title="${title}"></td>`;
    };

    const rowTotal = (row) => days.reduce((s, day) => {
      const rec = pending.get(`${row.id}|${day.date}`) || row.records[day.date];
      return s + (rec && ['present', 'partial'].includes(rec.status) ? Number(rec.units) || 0 : 0);
    }, 0);

    const render = () => {
      const v = setView(h`${pageHead('Attendance', `${p.name} · vendor ${p.vendor_number} · service code ${p.service_code}`,
        h`<button id="save" class="primary" ${pending.size ? '' : raw('disabled')}>Save changes${pending.size ? ` (${pending.size})` : ''}</button>`)}
        <form class="toolbar" id="filters">
          <select name="program">${programs.map(([id, l]) => h`<option value="${id}" ${String(id) === String(programId) ? raw('selected') : ''}>${l}</option>`)}</select>
          <input type="month" name="month" value="${month}" required><button>Load</button>
          ${can('staff') ? h`<button type="button" id="fill">Mark scheduled days present</button><button type="button" id="discard" ${pending.size ? '' : raw('disabled')}>Discard changes</button>` : ''}
        </form>
        <div class="toolbar legend"><span><span class="k cell present">P</span>Present (1 unit)</span><span><span class="k cell partial">½</span>Partial day</span>
          <span><span class="k cell absent">A</span>Absent</span><span><span class="k cell excused">E</span>Excused</span><span><span class="k cell holiday">H</span>Holiday/closure</span>
          <span class="muted">Click a day to cycle status · Shift+click to set hours, units and a note · Hourly services: type units directly</span></div>
        ${data.rows.some((r) => r.locked) ? h`<div class="alert warning">Rows with a submitted invoice are locked. Void the invoice to correct attendance.</div>` : ''}
        ${data.rows.length ? h`<div class="att-wrap"><table class="att"><thead><tr><th class="name">Consumer / authorization</th>
          ${days.map((day) => h`<th class="${day.we ? 'we' : ''}">${day.label}<br>${day.d}</th>`)}<th>Total</th></tr></thead>
          <tbody>${data.rows.map((row) => {
            const total = rowTotal(row);
            const cap = row.units_period === 'month' ? Number(row.units_authorized) : null;
            return h`<tr><td class="name"><strong>${fullName(row)}</strong>${row.locked ? h` <span class="badge accent">Billed</span>` : ''}
              <div class="muted">#${row.auth_number} · ${cap !== null ? `${units(cap)} ${unitLabel(row.unit_type)}s/mo` : `${units(row.units_authorized)} total`}</div></td>
              ${days.map((day) => cellFor(row, day))}
              <td class="total">${units(total)}${cap !== null && total > cap ? h`<div class="badge bad">Over</div>` : ''}</td></tr>`;
          })}</tbody></table></div>`
        : h`<div class="card empty">No active authorizations for this program in ${monthLabel(month)}. Add authorizations first.</div>`}`);

      $('#filters', v).addEventListener('submit', (e) => {
        e.preventDefault();
        if (pending.size && !window.confirm('Discard unsaved attendance changes?')) return;
        location.hash = '#/attendance?' + qs({ program: e.target.program.value, month: e.target.month.value });
      });
      $('#save', v).addEventListener('click', save);
      $('#discard', v)?.addEventListener('click', () => { pending.clear(); render(); });
      $('#fill', v)?.addEventListener('click', () => {
        for (const row of data.rows) {
          if (row.locked) continue;
          for (const day of days) {
            if (day.date < row.start_date || day.date > row.end_date) continue;
            if (day.we && !p.bills_weekends) continue;
            const key = `${row.id}|${day.date}`;
            if (row.records[day.date] || pending.has(key)) continue;
            const u = isDay(row) ? 1 : (p.full_day_min_hours || 1);
            pending.set(key, { authorization_id: row.id, service_date: day.date, status: 'present', units: u, hours: null, note: null });
          }
        }
        render();
      });
      $$('button.cell[data-a]', v).forEach((btn) => btn.addEventListener('click', (e) => {
        const key = `${btn.dataset.a}|${btn.dataset.d}`;
        const row = data.rows.find((r) => r.id === Number(btn.dataset.a));
        const cur = pending.get(key) || row.records[btn.dataset.d] || { status: '' };
        if (e.shiftKey) return cellDetail(row, btn.dataset.d, cur);
        const next = DAY_CYCLE[(DAY_CYCLE.indexOf(cur.status) + 1) % DAY_CYCLE.length];
        pending.set(key, { authorization_id: row.id, service_date: btn.dataset.d, status: next,
          units: next === 'present' ? 1 : next === 'partial' ? 0.5 : 0, hours: cur.hours ?? null, note: cur.note ?? null });
        const sx = $('.att-wrap').scrollLeft;
        render();
        $('.att-wrap').scrollLeft = sx;
      }));
      $$('input.cell-input', v).forEach((inp) => inp.addEventListener('change', () => {
        const row = data.rows.find((r) => r.id === Number(inp.dataset.a));
        const val = inp.value.trim();
        const n = Number(val);
        if (val && (!Number.isFinite(n) || n < 0 || n > 24)) { toast('Enter units between 0 and 24.', true); inp.value = ''; return; }
        pending.set(`${row.id}|${inp.dataset.d}`, { authorization_id: row.id, service_date: inp.dataset.d, status: val && n > 0 ? 'present' : '', units: val ? n : 0, hours: null, note: null });
        inp.classList.add('dirty');
        inp.classList.toggle('filled', !!(val && n > 0));
        $('#save').disabled = false;
        $('#save').textContent = `Save changes (${pending.size})`;
      }));
    };

    function cellDetail(row, date, cur) {
      formDialog({
        title: `${fullName(row)} · ${date}`,
        fields: [
          { name: 'status', label: 'Status', type: 'select', options: [['', '— Not recorded —'], ['present', 'Present'], ['partial', 'Partial'], ['absent', 'Absent'], ['excused', 'Excused'], ['holiday', 'Holiday / closure']] },
          { name: 'units', label: 'Units billed', type: 'number', step: '0.01', min: 0 },
          { name: 'hours', label: 'Hours attended', type: 'number', step: '0.25', min: 0, help: p.full_day_min_hours ? `Full-day threshold: ${p.full_day_min_hours} h` : '' },
          { name: 'note', label: 'Note', type: 'textarea', full: true },
        ],
        values: cur,
        submitLabel: 'Apply',
        onSubmit: (vals) => {
          pending.set(`${row.id}|${date}`, { authorization_id: row.id, service_date: date, status: vals.status,
            units: vals.units === '' ? undefined : Number(vals.units), hours: vals.hours === '' ? null : Number(vals.hours), note: vals.note || null });
          render();
        },
      });
    }

    async function save() {
      try {
        const r = await api('PUT', '/api/attendance', { entries: [...pending.values()] });
        toast(`Saved ${r.saved} attendance entr${r.saved === 1 ? 'y' : 'ies'}.`);
        pending.clear();
        route();
      } catch (ex) { toast(ex.message, true); }
    }

    window.onbeforeunload = () => (pending.size ? true : undefined);
    render();
  }

  // ---------- invoices ----------
  function generateDialog(month, programId) {
    formDialog({
      title: 'Generate invoices',
      intro: h`<p class="muted">Builds a draft invoice from recorded attendance, capped at authorized units. Existing drafts are rebuilt; submitted invoices are never changed.</p>`,
      fields: [
        { name: 'program_id', label: 'Program', type: 'select', options: [['all', 'All active programs'], ...programOptions()], full: true },
        { name: 'month', label: 'Service month', type: 'month', required: true },
      ],
      values: { month, program_id: programId || 'all' },
      submitLabel: 'Generate',
      onSubmit: async (vals) => {
        const { results } = await api('POST', '/api/invoices/generate', vals);
        const ok = results.filter((r) => r.invoice_id);
        const errs = results.filter((r) => r.error);
        if (errs.length) toast(`${ok.length} generated; ${errs.length} skipped: ${errs.map((e) => e.error).join(' ')}`, true);
        else toast(`${ok.length} draft invoice(s) ready for review.`);
        if (ok.length === 1) location.hash = `#/invoices/${ok[0].invoice_id}`;
        else location.hash = `#/invoices?month=${vals.month}`;
      },
    });
  }

  async function pageInvoices() {
    const { params } = hashParts();
    const f = { month: params.get('month') || '', status: params.get('status') || '' };
    const { invoices } = await api('GET', '/api/invoices?' + qs(f));
    const total = invoices.filter((i) => i.status !== 'void').reduce((s, i) => s + i.total_cents, 0);
    const paid = invoices.reduce((s, i) => s + i.paid_cents, 0);
    const v = setView(h`${pageHead('Invoices', 'Monthly regional center invoices by program', can('biller') ? h`<button class="primary" id="gen">Generate invoices</button>` : '')}
      <form class="toolbar" id="filters"><input type="month" name="month" value="${f.month}">
        <select name="status"><option value="">All statuses</option>${['draft', 'submitted', 'partial', 'paid', 'void'].map((s) => h`<option ${s === f.status ? raw('selected') : ''}>${s}</option>`)}</select>
        <button>Filter</button></form>
      <div class="card table-wrap">${invoices.length ? h`<table><thead><tr><th>Invoice #</th><th>Service month</th><th>Program</th><th>Regional center</th><th class="num">Lines</th>
        <th class="num">Billed</th><th class="num">Paid</th><th class="num">Balance</th><th>Status</th></tr></thead>
        <tbody>${invoices.map((i) => h`<tr class="clickable" data-href="#/invoices/${i.id}"><td class="mono">${i.invoice_number}</td><td>${monthLabel(i.service_month)}</td>
          <td>${i.program_name}<div class="muted">${i.vendor_number} · ${i.service_code}</div></td><td>${i.rc_abbr || i.regional_center_name}</td><td class="num">${i.line_count}</td>
          <td class="num">${money(i.total_cents)}</td><td class="num">${money(i.paid_cents)}</td><td class="num">${i.status === 'void' ? '—' : money(i.total_cents - i.paid_cents)}</td><td>${badge(i.status)}</td></tr>`)}</tbody>
        <tfoot><tr><td colspan="5">Total (excluding void)</td><td class="num">${money(total)}</td><td class="num">${money(paid)}</td><td class="num">${money(total - paid)}</td><td></td></tr></tfoot></table>`
      : h`<div class="empty">No invoices yet. Record attendance, then generate invoices for the service month.</div>`}</div>`);
    wireRowLinks(v);
    $('#filters', v).addEventListener('submit', (e) => { e.preventDefault(); location.hash = '#/invoices?' + qs({ month: e.target.month.value, status: e.target.status.value }); });
    $('#gen', v)?.addEventListener('click', () => generateDialog(f.month || prevMonth(state.me.today.slice(0, 7))));
    if (params.get('generate') && can('biller')) generateDialog(params.get('generate'), params.get('program'));
  }

  async function pageInvoice(invId) {
    const d = await api('GET', `/api/invoices/${invId}`);
    const { invoice: inv, lines, program: p, regional_center: rc } = d;
    const flags = lines.flatMap((l) => l.flags.map((f) => ({ ...f, who: fullName(l) })));
    const errors = flags.filter((f) => f.level === 'error');
    const warnings = flags.filter((f) => f.level === 'warning');
    const totalUnits = lines.reduce((s, l) => s + Number(l.units), 0);
    const daysList = (l) => l.daily_units.map((u, i) => (u ? (u === 1 ? `${i + 1}` : `${i + 1}(${units(u)})`) : null)).filter(Boolean).join(', ');
    const isDraft = inv.status === 'draft';
    const actions = [];
    if (can('biller')) {
      if (isDraft) actions.push(h`<button id="regen">Rebuild from attendance</button><button id="del" class="danger">Delete draft</button><button id="submit" class="primary">Mark submitted</button>`);
      if (inv.status !== 'void') actions.push(h`<a class="btn" href="/api/invoices/${inv.id}/export.csv">eBilling worksheet (CSV)</a>`);
      if (['submitted', 'partial'].includes(inv.status) && !inv.paid_cents) actions.push(h`<button id="void" class="danger">Void</button>`);
    }
    actions.push(h`<button id="print">Print</button>`);
    const v = setView(h`${pageHead(`Invoice ${inv.invoice_number}`, h`${badge(inv.status)} · ${monthLabel(inv.service_month)}`, actions)}
      ${errors.length ? h`<div class="alert error no-print"><strong>${errors.length} issue(s) need attention before submitting.</strong> Units over authorization were not billed; resolve with the service coordinator.</div>` : ''}
      ${warnings.length ? h`<div class="alert warning no-print">${warnings.length} warning(s) — review the flagged lines below.</div>` : ''}
      <div class="card">
        <div class="doc-head">
          <div><div class="k">Vendor</div><strong>${d.organization_name || p.name}</strong><div>${p.name}</div><div>Vendor # <span class="mono">${p.vendor_number}</span></div>
            <div>Service code ${p.service_code}${p.subcode ? '-' + p.subcode : ''} · ${p.service_description}</div></div>
          <div><div class="k">Bill to</div><strong>${rc.name}</strong>${rc.address ? h`<div>${rc.address}</div>` : ''}${rc.billing_contact ? h`<div>Attn: ${rc.billing_contact}</div>` : ''}</div>
          <div><div class="k">Service month</div><strong>${monthLabel(inv.service_month)}</strong><div class="k">Invoice total</div><strong>${money(inv.total_cents)}</strong>
            ${inv.submitted_at ? h`<div class="k">Submitted</div><div>${inv.submitted_at.slice(0, 10)}</div>` : ''}</div>
        </div>
        <div class="table-wrap"><table><thead><tr><th>Consumer</th><th>UCI</th><th>Auth #</th><th class="num">Units</th><th class="num">Rate</th><th class="num">Amount</th><th class="num">Paid</th></tr></thead>
          <tbody>${lines.map((l) => h`<tr><td><strong>${fullName(l)}</strong><div class="daily">Days: ${daysList(l) || '—'}</div>
              ${l.flags.filter((f) => f.level !== 'info').map((f) => h`<div class="flag ${f.level} no-print">${f.message}</div>`)}</td>
            <td class="mono">${l.uci}</td><td class="mono">${l.auth_number}</td><td class="num">${units(l.units)}${l.unbilled_units ? h`<div class="muted">+${units(l.unbilled_units)} unbilled</div>` : ''}</td>
            <td class="num">${money(l.rate_cents)}</td><td class="num">${money(l.amount_cents)}</td><td class="num">${money(l.paid_cents)}</td></tr>`)}</tbody>
          <tfoot><tr><td colspan="3">Total · ${lines.length} consumer(s)</td><td class="num">${units(totalUnits)}</td><td></td><td class="num">${money(inv.total_cents)}</td><td class="num">${money(inv.paid_cents)}</td></tr></tfoot></table></div>
        ${inv.notes ? h`<p class="muted">${inv.notes}</p>` : ''}
        <p class="help">I certify that the services billed were provided as authorized and documented in accordance with Title 17, California Code of Regulations. Records supporting this invoice are available for audit.</p>
      </div>`);
    $('#print', v).addEventListener('click', () => window.print());
    $('#regen', v)?.addEventListener('click', async () => {
      try { await api('POST', '/api/invoices/generate', { program_id: inv.program_id, month: inv.service_month }); toast('Draft rebuilt from attendance.'); route(); } catch (ex) { toast(ex.message, true); }
    });
    $('#submit', v)?.addEventListener('click', () => confirmDialog('Mark invoice submitted',
      `Confirm this invoice (${money(inv.total_cents)}) has been entered in the regional center's eBilling system. Attendance for these consumers will be locked for ${monthLabel(inv.service_month)}.`,
      async () => { await api('POST', `/api/invoices/${inv.id}/submit`, {}); toast('Invoice submitted.'); route(); }, { label: 'Mark submitted', danger: false }));
    $('#del', v)?.addEventListener('click', () => confirmDialog('Delete draft', 'Delete this draft invoice? Attendance is not affected.',
      async () => { await api('DELETE', `/api/invoices/${inv.id}`, {}); toast('Draft deleted.'); location.hash = '#/invoices'; }, { label: 'Delete' }));
    $('#void', v)?.addEventListener('click', () => confirmDialog('Void invoice', 'Voiding unlocks attendance so the month can be corrected and rebilled.',
      async (reason) => { await api('POST', `/api/invoices/${inv.id}/void`, { reason }); toast('Invoice voided.'); route(); }, { label: 'Void invoice', reason: true }));
  }

  // ---------- payments ----------
  async function pagePayments() {
    const { payments } = await api('GET', '/api/payments');
    const v = setView(h`${pageHead('Payments', 'Regional center remittances and how they were applied', can('biller') ? h`<a class="btn primary" href="#/payments/new">Record payment</a>` : '')}
      <div class="card table-wrap">${payments.length ? h`<table><thead><tr><th>Date</th><th>Regional center</th><th>Method</th><th>Reference</th><th class="num">Amount</th><th class="num">Applied</th><th class="num">Unapplied</th></tr></thead>
      <tbody>${payments.map((p) => h`<tr class="clickable" data-href="#/payments/${p.id}"><td>${p.payment_date}</td><td>${p.rc_abbr || p.regional_center_name}</td><td>${p.method.toUpperCase()}</td>
        <td class="mono">${p.reference || '—'}</td><td class="num">${money(p.amount_cents)}</td><td class="num">${money(p.applied_cents)}</td>
        <td class="num">${p.amount_cents - p.applied_cents ? h`<span class="badge warn">${money(p.amount_cents - p.applied_cents)}</span>` : '—'}</td></tr>`)}</tbody></table>`
      : h`<div class="empty">No payments recorded.</div>`}</div>`);
    wireRowLinks(v);
  }

  async function pagePaymentNew() {
    if (!can('biller')) { setView(h`<div class="alert error">Your role cannot record payments.</div>`); return; }
    const v = setView(h`${pageHead('Record payment', 'Post a regional center remittance and apply it to invoice lines')}
      <div class="card"><form id="pay" class="form-grid">
        ${fieldHtml({ name: 'regional_center_id', label: 'Regional center', type: 'select', options: rcOptions(), required: true, placeholder: 'Select…' })}
        ${fieldHtml({ name: 'payment_date', label: 'Payment date', type: 'date', required: true }, state.me.today)}
        ${fieldHtml({ name: 'amount', label: 'Amount ($)', type: 'number', step: '0.01', min: 0, required: true })}
        ${fieldHtml({ name: 'method', label: 'Method', type: 'select', options: [['eft', 'EFT / direct deposit'], ['check', 'Check'], ['other', 'Other']] })}
        ${fieldHtml({ name: 'reference', label: 'Check / EFT reference' })}
        ${fieldHtml({ name: 'notes', label: 'Notes (e.g. remittance advice #, adjustment reasons)' })}
      </form></div>
      <div class="card"><div class="page-head"><h2>Apply to open invoice lines</h2><div class="toolbar"><button id="auto" type="button">Auto-apply oldest first</button></div></div>
        <div id="lines" class="muted">Select a regional center to load open invoice lines.</div>
        <div class="toolbar"><strong id="applied-sum"></strong><span class="spacer"></span><button class="primary" id="save" type="button">Save payment</button></div></div>`);
    const form = $('#pay', v);
    let lines = [];
    const sum = () => {
      const applied = $$('input[data-line]', v).reduce((s, i) => s + Math.round((Number(i.value) || 0) * 100), 0);
      const amt = Math.round((Number(form.amount.value) || 0) * 100);
      $('#applied-sum', v).textContent = `Applied ${money(applied)} of ${money(amt)} · Unapplied ${money(amt - applied)}`;
    };
    form.regional_center_id.addEventListener('change', async () => {
      const rcId = form.regional_center_id.value;
      if (!rcId) return;
      ({ lines } = await api('GET', '/api/open-lines?' + qs({ regional_center_id: rcId })));
      $('#lines', v).innerHTML = String(lines.length ? h`<div class="table-wrap"><table><thead><tr><th>Invoice</th><th>Month</th><th>Consumer</th><th>Auth #</th><th class="num">Billed</th><th class="num">Open</th><th class="num">Apply ($)</th></tr></thead>
        <tbody>${lines.map((l) => h`<tr><td class="mono">${l.invoice_number}</td><td>${monthLabel(l.service_month)}</td><td>${fullName(l)} <span class="muted mono">${l.uci}</span></td><td class="mono">${l.auth_number}</td>
          <td class="num">${money(l.amount_cents)}</td><td class="num">${money(l.open_cents)}</td><td class="num"><input data-line="${l.id}" type="number" step="0.01" min="0" max="${dollars(l.open_cents)}"></td></tr>`)}</tbody></table></div>`
        : h`<div class="empty">No open invoice lines for this regional center.</div>`);
      $$('input[data-line]', v).forEach((i) => i.addEventListener('input', sum));
      sum();
    });
    form.amount.addEventListener('input', sum);
    $('#auto', v).addEventListener('click', () => {
      let left = Math.round((Number(form.amount.value) || 0) * 100);
      for (const l of lines) {
        const inp = $(`input[data-line="${l.id}"]`, v);
        const take = Math.max(0, Math.min(left, l.open_cents));
        inp.value = take ? dollars(take) : '';
        left -= take;
      }
      sum();
    });
    $('#save', v).addEventListener('click', async () => {
      if (!form.reportValidity()) return;
      const allocations = $$('input[data-line]', v).filter((i) => Number(i.value) > 0).map((i) => ({ invoice_line_id: Number(i.dataset.line), amount: i.value }));
      try {
        const r = await api('POST', '/api/payments', { ...Object.fromEntries(new FormData(form)), allocations });
        toast(`Payment saved. ${money(r.applied_cents)} applied${r.unapplied_cents ? `, ${money(r.unapplied_cents)} unapplied` : ''}.`);
        location.hash = `#/payments/${r.id}`;
      } catch (ex) { toast(ex.message, true); }
    });
  }

  async function pagePayment(pid) {
    const { payment: p, allocations } = await api('GET', `/api/payments/${pid}`);
    const applied = allocations.reduce((s, a) => s + a.amount_cents, 0);
    const short = allocations.filter((a) => a.amount_cents < a.line_amount_cents);
    const v = setView(h`${pageHead(`Payment ${p.reference || '#' + p.id}`, `${p.regional_center_name} · ${p.payment_date} · ${p.method.toUpperCase()}`,
      can('biller') ? h`<button id="del" class="danger">Delete payment</button>` : '')}
      <div class="grid kpis">${kpi('Amount', money(p.amount_cents), '')}${kpi('Applied', money(applied), `${allocations.length} line(s)`)}${kpi('Unapplied', money(p.amount_cents - applied), p.amount_cents - applied ? 'Investigate or apply later' : 'Fully applied')}</div>
      ${short.length ? h`<div class="alert warning">${short.length} line(s) were paid less than billed. Follow up with the regional center for the remittance reason.</div>` : ''}
      <div class="card table-wrap"><table><thead><tr><th>Invoice</th><th>Month</th><th>Consumer</th><th>Auth #</th><th class="num">Billed</th><th class="num">Applied</th></tr></thead>
        <tbody>${allocations.map((a) => h`<tr><td><a href="#/invoices/${a.invoice_id}">${a.invoice_number}</a></td><td>${monthLabel(a.service_month)}</td><td>${fullName(a)}</td><td class="mono">${a.auth_number}</td>
          <td class="num">${money(a.line_amount_cents)}</td><td class="num">${money(a.amount_cents)}</td></tr>`)}</tbody></table>
        ${p.notes ? h`<p class="muted">${p.notes}</p>` : ''}</div>`);
    $('#del', v)?.addEventListener('click', () => confirmDialog('Delete payment', 'Remove this payment and its allocations? Invoice balances will be restored.',
      async () => { await api('DELETE', `/api/payments/${pid}`, {}); toast('Payment deleted.'); location.hash = '#/payments'; }, { label: 'Delete' }));
  }

  // ---------- reports ----------
  async function pageReports() {
    const { params } = hashParts();
    const tab = params.get('tab') || 'aging';
    const tabs = [['aging', 'A/R aging'], ['revenue', 'Revenue'], ['utilization', 'Authorization utilization']];
    const head = h`${pageHead('Reports')}<div class="toolbar">${tabs.map(([k, l]) => h`<a class="btn ${k === tab ? 'primary' : ''}" href="#/reports?tab=${k}">${l}</a>`)}</div>`;

    if (tab === 'aging') {
      const a = await api('GET', '/api/reports/aging');
      const v = setView(h`${head}<div class="card"><div class="page-head"><h2>Receivables aging (days since submission)</h2><button id="csv">Download CSV</button></div>${agingTable(a)}</div>
        ${a.rows.map((r) => h`<div class="card"><h3>${r.name}</h3><div class="table-wrap"><table><thead><tr><th>Invoice</th><th>Service month</th><th>Submitted</th><th>Bucket</th><th class="num">Billed</th><th class="num">Open</th></tr></thead>
          <tbody>${r.invoices.map((i) => h`<tr><td><a href="#/invoices/${i.id}">${i.invoice_number}</a></td><td>${monthLabel(i.service_month)}</td><td>${(i.submitted_at || '').slice(0, 10)}</td>
          <td>${a.buckets.find((b) => b.key === i.bucket).label}</td><td class="num">${money(i.total_cents)}</td><td class="num">${money(i.open_cents)}</td></tr>`)}</tbody></table></div></div>`)}`);
      $('#csv', v).addEventListener('click', () => downloadCsv('ar-aging.csv', [['Regional center', ...a.buckets.map((b) => b.label), 'Total'],
        ...a.rows.map((r) => [r.name, ...a.buckets.map((b) => dollars(r[b.key])), dollars(r.total)])]));
    } else if (tab === 'revenue') {
      const from = params.get('from') || '';
      const to = params.get('to') || '';
      const r = await api('GET', '/api/reports/revenue?' + qs({ from, to }));
      const v = setView(h`${head}<form class="toolbar" id="rf">From <input type="month" name="from" value="${from}"> to <input type="month" name="to" value="${to}"><button>Apply</button><button type="button" id="csv">Download CSV</button></form>
        <div class="card"><h2>Billed vs. collected by service month</h2><div class="table-wrap"><table><thead><tr><th>Service month</th><th class="num">Billed</th><th class="num">Collected</th><th class="num">Outstanding</th><th class="num">Collection rate</th></tr></thead>
          <tbody>${r.by_month.map((m) => h`<tr><td>${monthLabel(m.service_month)}</td><td class="num">${money(m.billed_cents)}</td><td class="num">${money(m.collected_cents)}</td>
          <td class="num">${money(m.billed_cents - m.collected_cents)}</td><td class="num">${m.billed_cents ? Math.round((m.collected_cents / m.billed_cents) * 100) + '%' : '—'}</td></tr>`)}</tbody></table></div></div>
        <div class="grid two"><div class="card"><h2>By service code</h2><table><thead><tr><th>Service</th><th class="num">Consumers</th><th class="num">Units</th><th class="num">Billed</th></tr></thead>
          <tbody>${r.by_service.map((s) => h`<tr><td>${s.service_code} · ${s.description}</td><td class="num">${s.consumers}</td><td class="num">${units(s.units)}</td><td class="num">${money(s.billed_cents)}</td></tr>`)}</tbody></table></div>
        <div class="card"><h2>By regional center</h2><table><thead><tr><th>Regional center</th><th class="num">Invoices</th><th class="num">Billed</th></tr></thead>
          <tbody>${r.by_regional_center.map((s) => h`<tr><td>${s.name}</td><td class="num">${s.invoices}</td><td class="num">${money(s.billed_cents)}</td></tr>`)}</tbody></table></div></div>`);
      $('#rf', v).addEventListener('submit', (e) => { e.preventDefault(); location.hash = '#/reports?' + qs({ tab: 'revenue', from: e.target.from.value, to: e.target.to.value }); });
      $('#csv', v).addEventListener('click', () => downloadCsv('revenue-by-month.csv', [['Service month', 'Billed', 'Collected'], ...r.by_month.map((m) => [m.service_month, dollars(m.billed_cents), dollars(m.collected_cents)])]));
    } else {
      const month = params.get('month') || state.me.today.slice(0, 7);
      const r = await api('GET', '/api/reports/utilization?' + qs({ month }));
      const unused = r.rows.reduce((s, x) => s + (x.unused_value_cents || 0), 0);
      const v = setView(h`${head}<form class="toolbar" id="uf"><input type="month" name="month" value="${month}"><button>Apply</button><button type="button" id="csv">Download CSV</button></form>
        <div class="alert info">Unused authorized value in ${monthLabel(month)}: <strong>${money(unused)}</strong>. Low utilization can signal attendance barriers (transportation, health, staffing) worth addressing in the consumer's IPP.</div>
        <div class="card table-wrap"><table><thead><tr><th>Consumer</th><th>Program</th><th>Auth #</th><th class="num">Authorized</th><th class="num">Used</th><th class="num">Utilization</th><th class="num">Unused value</th></tr></thead>
          <tbody>${r.rows.map((x) => h`<tr><td>${fullName(x)} <span class="muted mono">${x.uci}</span></td><td>${x.program_name}</td><td class="mono">${x.auth_number}</td>
            <td class="num">${units(x.units_authorized)} ${x.units_period === 'month' ? '/mo' : 'total'}</td><td class="num">${units(x.units_used)}</td>
            <td class="num">${x.utilization === null ? '—' : h`<span class="badge ${x.utilization > 1 ? 'bad' : x.utilization < 0.7 ? 'warn' : 'good'}">${Math.round(x.utilization * 100)}%</span>`}</td>
            <td class="num">${x.unused_value_cents === null ? '—' : money(x.unused_value_cents)}</td></tr>`)}</tbody></table></div>`);
      $('#uf', v).addEventListener('submit', (e) => { e.preventDefault(); location.hash = '#/reports?' + qs({ tab: 'utilization', month: e.target.month.value }); });
      $('#csv', v).addEventListener('click', () => downloadCsv(`utilization-${month}.csv`, [['Last name', 'First name', 'UCI', 'Program', 'Auth #', 'Authorized', 'Used'],
        ...r.rows.map((x) => [x.last_name, x.first_name, x.uci, x.program_name, x.auth_number, x.units_authorized, x.units_used])]));
    }
  }

  // ---------- settings ----------
  async function pageSettings() {
    const { params } = hashParts();
    const isAdmin = can('admin');
    const tab = params.get('tab') || (isAdmin ? 'programs' : 'password');
    const tabs = isAdmin
      ? [['programs', 'Programs & vendor numbers'], ['rcs', 'Regional centers'], ['codes', 'Service codes'], ['users', 'Users'], ['audit', 'Audit log'], ['password', 'My password']]
      : [['password', 'My password']];
    const head = h`${pageHead('Settings')}<div class="toolbar">${tabs.map(([k, l]) => h`<a class="btn ${k === tab ? 'primary' : ''}" href="#/settings?tab=${k}">${l}</a>`)}</div>`;

    if (tab === 'programs' && isAdmin) {
      const programs = state.meta.programs;
      const v = setView(h`${head}<div class="card"><div class="page-head"><div><h2>Programs</h2><div class="muted">Each vendored program: vendor number + service code (+ subcode) at one regional center.</div></div><button class="primary" id="add">Add program</button></div>
        ${programs.length ? h`<div class="table-wrap"><table><thead><tr><th>Program</th><th>Vendor #</th><th>Service code</th><th>Regional center</th><th>Unit</th><th class="num">Default rate</th><th>Status</th></tr></thead>
        <tbody>${programs.map((p) => h`<tr class="clickable" data-id="${p.id}"><td><strong>${p.name}</strong></td><td class="mono">${p.vendor_number}</td><td>${p.service_code}${p.subcode ? '-' + p.subcode : ''} · ${p.service_description}</td>
          <td>${p.rc_abbr || p.regional_center_name}</td><td>${unitLabel(p.unit_type)}</td><td class="num">${p.default_rate_cents ? money(p.default_rate_cents) : '—'}</td><td>${badge(p.active ? 'active' : 'inactive')}</td></tr>`)}</tbody></table></div>`
        : h`<div class="empty">No programs yet. Add your first vendored program to begin.</div>`}</div>`);
      const edit = (p) => formDialog({
        title: p ? 'Edit program' : 'Add program',
        fields: [
          { name: 'name', label: 'Program name', required: true, full: true },
          { name: 'vendor_number', label: 'Vendor number', required: true, help: 'As shown on your vendorization letter, e.g. H12345' },
          { name: 'regional_center_id', label: 'Vendoring regional center', type: 'select', options: rcOptions(), required: true, placeholder: 'Select…' },
          { name: 'service_code', label: 'Service code', type: 'select', required: true, placeholder: 'Select…', options: state.meta.service_codes.map((s) => [s.code, `${s.code} · ${s.description}`]) },
          { name: 'subcode', label: 'Subcode (optional)' },
          { name: 'unit_type', label: 'Billing unit', type: 'select', options: unitOptions(), required: true },
          { name: 'default_rate', label: 'Default rate ($)', type: 'number', step: '0.01', min: 0 },
          { name: 'full_day_min_hours', label: 'Full-day minimum hours', type: 'number', step: '0.25', min: 0, help: 'Day programs: warn when a full day is billed below this' },
          { name: 'bills_weekends', label: 'Program operates on weekends', type: 'checkbox' },
          { name: 'active', label: 'Active', type: 'checkbox' },
        ],
        values: p ? { ...p, default_rate: dollars(p.default_rate_cents) } : { active: true, unit_type: 'day' },
        onOpen: (form) => form.elements.service_code.addEventListener('change', () => {
          const sc = state.meta.service_codes.find((s) => s.code === form.elements.service_code.value);
          if (sc) form.elements.unit_type.value = sc.default_unit_type;
        }),
        onSubmit: async (vals) => {
          if (p) await api('PUT', `/api/programs/${p.id}`, vals); else await api('POST', '/api/programs', vals);
          await reloadMeta(); toast('Program saved.'); route();
        },
      });
      $('#add', v).addEventListener('click', () => edit(null));
      $$('tr[data-id]', v).forEach((tr) => tr.addEventListener('click', () => edit(programs.find((p) => p.id === Number(tr.dataset.id)))));
    } else if (tab === 'rcs' && isAdmin) {
      const rcs = state.meta.regional_centers;
      const v = setView(h`${head}<div class="card"><div class="page-head"><h2>Regional centers</h2><button id="add">Add</button></div><div class="table-wrap"><table><thead><tr><th>Name</th><th>Abbr.</th><th>Billing contact</th><th>Email</th><th>Phone</th></tr></thead>
        <tbody>${rcs.map((r) => h`<tr class="clickable" data-id="${r.id}"><td>${r.name}${r.active ? '' : h` <span class="badge">inactive</span>`}</td><td>${r.abbreviation || ''}</td><td>${r.billing_contact || '—'}</td><td>${r.billing_email || '—'}</td><td>${r.phone || '—'}</td></tr>`)}</tbody></table></div></div>`);
      const edit = (r) => formDialog({
        title: r ? r.name : 'Add regional center',
        fields: [
          { name: 'name', label: 'Name', required: true, full: true }, { name: 'abbreviation', label: 'Abbreviation' }, { name: 'phone', label: 'Phone' },
          { name: 'address', label: 'Remit / billing address', full: true }, { name: 'billing_contact', label: 'Accounting contact' }, { name: 'billing_email', label: 'Accounting email', type: 'email' },
          { name: 'active', label: 'Active', type: 'checkbox' },
        ],
        values: r || { active: true },
        onSubmit: async (vals) => {
          if (r) await api('PUT', `/api/regional-centers/${r.id}`, vals); else await api('POST', '/api/regional-centers', vals);
          await reloadMeta(); toast('Saved.'); route();
        },
      });
      $('#add', v).addEventListener('click', () => edit(null));
      $$('tr[data-id]', v).forEach((tr) => tr.addEventListener('click', () => edit(rcs.find((r) => r.id === Number(tr.dataset.id)))));
    } else if (tab === 'codes' && isAdmin) {
      const v = setView(h`${head}<div class="card"><div class="page-head"><div><h2>Service codes</h2><div class="muted">Confirm codes and units against each vendorization letter.</div></div><button id="add">Add / update code</button></div>
        <table><thead><tr><th>Code</th><th>Description</th><th>Default unit</th></tr></thead><tbody>${state.meta.service_codes.map((s) => h`<tr class="clickable" data-code="${s.code}"><td class="mono">${s.code}</td><td>${s.description}</td><td>${unitLabel(s.default_unit_type)}</td></tr>`)}</tbody></table></div>`);
      const edit = (s) => formDialog({
        title: s ? `Service code ${s.code}` : 'Add service code',
        fields: [{ name: 'code', label: 'Code', required: true }, { name: 'default_unit_type', label: 'Default unit', type: 'select', options: unitOptions() }, { name: 'description', label: 'Description', required: true, full: true }],
        values: s || {},
        onSubmit: async (vals) => { await api('POST', '/api/service-codes', vals); await reloadMeta(); toast('Saved.'); route(); },
      });
      $('#add', v).addEventListener('click', () => edit(null));
      $$('tr[data-code]', v).forEach((tr) => tr.addEventListener('click', () => edit(state.meta.service_codes.find((s) => s.code === tr.dataset.code))));
    } else if (tab === 'users' && isAdmin) {
      const { users } = await api('GET', '/api/users');
      const roleHelp = 'Admin: everything · Biller: consumers, authorizations, invoices, payments · Staff: attendance only · Viewer: read-only';
      const v = setView(h`${head}<div class="card"><div class="page-head"><div><h2>Users</h2><div class="muted">${roleHelp}</div></div><button class="primary" id="add">Add user</button></div>
        <table><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th></tr></thead><tbody>${users.map((u) => h`<tr class="clickable" data-id="${u.id}"><td>${u.full_name}</td><td class="mono">${u.username}</td><td>${u.role}</td><td>${badge(u.active ? 'active' : 'inactive')}</td></tr>`)}</tbody></table></div>`);
      const roles = [['staff', 'Staff (attendance)'], ['biller', 'Biller'], ['admin', 'Administrator'], ['viewer', 'Viewer (read-only)']];
      $('#add', v).addEventListener('click', () => formDialog({
        title: 'Add user',
        fields: [{ name: 'full_name', label: 'Full name', required: true }, { name: 'username', label: 'Username', required: true },
          { name: 'role', label: 'Role', type: 'select', options: roles }, { name: 'password', label: 'Temporary password', type: 'password', required: true, help: '10+ characters, letters and numbers' }],
        onSubmit: async (vals) => { await api('POST', '/api/users', vals); toast('User added.'); route(); },
      }));
      $$('tr[data-id]', v).forEach((tr) => tr.addEventListener('click', () => {
        const u = users.find((x) => x.id === Number(tr.dataset.id));
        formDialog({
          title: `Edit ${u.username}`,
          fields: [{ name: 'full_name', label: 'Full name', required: true }, { name: 'role', label: 'Role', type: 'select', options: roles },
            { name: 'active', label: 'Active', type: 'checkbox' }, { name: 'password', label: 'Reset password (optional)', type: 'password' }],
          values: u,
          onSubmit: async (vals) => { await api('PUT', `/api/users/${u.id}`, vals); toast('User updated.'); route(); },
        });
      }));
    } else if (tab === 'audit' && isAdmin) {
      const { entries } = await api('GET', '/api/audit?limit=500');
      setView(h`${head}<div class="card table-wrap"><h2>Audit log</h2><p class="muted">Every sign-in, record view, change and export is recorded for HIPAA accountability.</p>
        <table><thead><tr><th>When (UTC)</th><th>User</th><th>Action</th><th>Record</th><th>Detail</th></tr></thead>
        <tbody>${entries.map((e) => h`<tr><td>${e.at}</td><td>${e.user_name || '—'}</td><td>${e.action}</td><td>${e.entity}${e.entity_id ? ' #' + e.entity_id : ''}</td><td class="mono">${e.detail || ''}</td></tr>`)}</tbody></table></div>`);
    } else {
      const v = setView(h`${head}<div class="card auth-card"><h2>Change my password</h2><form id="pw" class="grid">
        <label class="field">Current password<input type="password" name="current_password" required autocomplete="current-password"></label>
        <label class="field">New password<input type="password" name="new_password" required minlength="10" autocomplete="new-password"></label>
        <button class="primary">Update password</button></form></div>`);
      $('#pw', v).addEventListener('submit', async (e) => {
        e.preventDefault();
        try { await api('POST', '/api/me/password', { current_password: e.target.current_password.value, new_password: e.target.new_password.value }); toast('Password updated.'); e.target.reset(); } catch (ex) { toast(ex.message, true); }
      });
    }
  }

  // Clear the attendance unsaved-changes guard whenever we navigate away.
  window.addEventListener('hashchange', () => { if (!location.hash.startsWith('#/attendance')) window.onbeforeunload = null; });

  boot();
})();
