'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openDb, tx, seed } = require('./lib/db');
const S = require('./lib/security');
const audit = require('./lib/audit');
const matching = require('./lib/matching');
const wf = require('./lib/workflow');
const view = require('./lib/view');
const docs = require('./lib/documents');
const { HttpError, dispCode } = S;

const PUBLIC_DIR = path.join(__dirname, 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/portal': ['portal.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/portal.js': ['portal.js', 'text/javascript; charset=utf-8'],
  '/cal.js': ['cal.js', 'text/javascript; charset=utf-8'],
  '/ui.js': ['ui.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const COOKIE = { cms: 'cms_sid', portal: 'portal_sid' };
const SESSION_MS = 8 * 3600e3;
const FOCUS = {
  SEIT: ['Watch every request, end to end (view only)', 'Overall survey progress and the calendar', 'Reports: approved, rejected and scheduled LCs', 'SEIT does not approve: the Chief releases the request to a surveyor'],
  CHIEF: ['Final approval: releases the request to a surveyor', 'Documents verified by the EE', 'Division-level progress and the calendar', 'Reports and escalations'],
  EE: ['Division permission, then verify the AEE-reviewed documents', 'Calendar: what is happening in your division, by date', 'Forward to the next authority, or reject / reschedule', 'Deadlines: AE 4 days, AEE 2 days'],
  AEE: ['Coordinate the request, then review the AE documents (2 days)', 'Forward to the next authority, or reject / reschedule', 'Calendar and reports for your division', 'Follow up on overdue AE documents'],
  AE: ['Prepare and upload the substation documents (max 4 days)', 'Forward to the AEE when the documents are ready', 'Substation availability and the calendar', 'Reject or reschedule if the substation cannot support the LC'],
  ADMIN: ['KPTCL and Office users', 'Roles, contact details and access', 'Password resets', 'Audit visibility (Admin cannot approve requests)'],
  PM: ['Overall progress and the calendar', 'Mark surveys completed after the report', 'Reports: approved, rejected and scheduled LCs', 'Escalations'],
  COORD: ['Create requests with remarks and LC documents', 'Calendar: every survey by date, with full report', 'Rejected LCs needing a revised LC', 'Assign a surveyor manually if nobody nearby accepts'],
  SURVEYOR: ['My offers', 'My schedule', 'Upcoming surveys', 'Report submission'],
};
const PORTAL_STATUS = {
  INTAKE_REVIEW: 'Received - being reviewed', EE_PERMISSION: 'In approval', AEE_COORDINATION: 'In approval',
  AE_SUBSTATION: 'In approval', AEE_REVISIT: 'In approval', EE_REVISIT: 'In approval', CHIEF_MONITOR: 'In approval',
  SEIT_APPROVAL: 'In approval', SURVEYOR_ASSIGNMENT: 'Finding a surveyor', SCHEDULED: 'Survey scheduled',
  PM_COMPLETION: 'Survey done - report in review',
  COMPLETED: 'Completed', LC_REJECTED: 'Being rescheduled', CLOSED: 'Not accepted',
};

function createApp(opts = {}) {
  const cfg = {
    offerTtlMs: opts.offerTtlMs ?? Number(process.env.OFFER_TTL_MS || 120000),
    maxFails: 5,
    lockMs: opts.lockMs ?? 15 * 60e3,
    secureCookies: opts.secureCookies ?? process.env.SECURE_COOKIES === '1',
  };
  const db = openDb(opts.dbPath || ':memory:');
  if (!db.prepare('SELECT 1 AS x FROM users LIMIT 1').get()) {
    seed(db, opts.seedPassword || process.env.SEED_PASSWORD || 'Demo@12345!');
    if (opts.demoRequests) require('./lib/demo').seedDemo(db, cfg); // a fresh demo database opens with realistic requests
  }
  const loginLimit = S.makeLimiter(opts.loginPerMin ?? 40, 60e3);
  const regLimit = S.makeLimiter(10, 3600e3);
  const portalReqLimit = S.makeLimiter(10, 3600e3);

  const routes = [];
  const route = (method, pattern, o, handler) => {
    const keys = [];
    const rx = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, rx, keys, ...o, handler });
  };

  // ---------- sessions ----------
  const parseCookies = (h) => Object.fromEntries(String(h || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0] && p[1]));
  function createSession(res, kind, userId) {
    const token = S.newToken();
    db.prepare('INSERT INTO sessions(token_hash,kind,user_id,expires) VALUES(?,?,?,?)').run(S.sha256(token), kind, userId, Date.now() + SESSION_MS);
    const flags = ['HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${SESSION_MS / 1000}`];
    if (cfg.secureCookies) flags.push('Secure');
    res.setHeader('Set-Cookie', `${COOKIE[kind]}=${token}; ${flags.join('; ')}`);
  }
  function clearSession(req, res, kind) {
    const t = parseCookies(req.headers.cookie)[COOKIE[kind]];
    if (t) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(S.sha256(t));
    res.setHeader('Set-Cookie', `${COOKIE[kind]}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  }
  function authenticate(req, kind) {
    const t = parseCookies(req.headers.cookie)[COOKIE[kind]];
    if (!t) return null;
    const s = db.prepare('SELECT * FROM sessions WHERE token_hash=? AND kind=? AND expires>?').get(S.sha256(t), kind, Date.now());
    if (!s) return null;
    return kind === 'cms'
      ? db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(s.user_id) || null
      : db.prepare('SELECT * FROM portal_users WHERE id=?').get(s.user_id) || null;
  }

  function doLogin(ctx, kind) {
    if (!loginLimit(ctx.ip)) throw new HttpError(429, 'Too many attempts. Try again later.');
    const id = S.str(kind === 'cms' ? ctx.body.username : ctx.body.email, 3, 120, 'Username');
    const pw = S.str(ctx.body.password, 1, 128, 'Password');
    const table = kind === 'cms' ? 'users' : 'portal_users';
    const col = kind === 'cms' ? 'username' : 'email';
    const row = db.prepare(`SELECT * FROM ${table} WHERE ${col}=?`).get(kind === 'cms' ? id : id.toLowerCase());
    const locked = row && row.locked_until > Date.now();
    const pwOk = S.verifyPassword(pw, row ? row.pw_hash : S.DUMMY_HASH); // always do the work: no timing hint
    const ok = !!row && !locked && pwOk && (kind === 'portal' || row.active === 1);
    if (!ok) {
      if (row && !locked) {
        const failed = row.failed + 1;
        db.prepare(`UPDATE ${table} SET failed=?, locked_until=? WHERE id=?`)
          .run(failed >= cfg.maxFails ? 0 : failed, failed >= cfg.maxFails ? Date.now() + cfg.lockMs : 0, row.id);
      }
      audit.append(db, { actor: id, role: row && kind === 'cms' ? row.role : 'ANON', action: 'login_failed', detail: { kind } });
      throw new HttpError(401, 'Invalid credentials, or the account is locked or disabled.');
    }
    db.prepare(`UPDATE ${table} SET failed=0, locked_until=0 WHERE id=?`).run(row.id);
    createSession(ctx.res, kind, row.id);
    audit.append(db, { actor: id, role: kind === 'cms' ? row.role : 'PUBLIC', action: 'login', detail: { kind } });
    return row;
  }

  // ---------- presenters ----------
  const subName = (id) => db.prepare('SELECT name FROM substations WHERE id=?').get(id)?.name;
  const userName = (id) => (id ? db.prepare('SELECT name FROM users WHERE id=?').get(id)?.name : null);
  // One shape for a request, used by the dashboard, the table, the calendar, notifications and the detail page.
  function present(user, r) {
    const st = wf.STAGES[r.stage];
    const dl = wf.deadline(r);
    return {
      id: r.id, code: r.code, display_code: dispCode(r.code, r.revision), revision: r.revision, title: r.title,
      substation: subName(r.substation_id), division: r.division, nodal_centre: r.nodal_centre || null, zone: r.zone || null,
      priority: r.priority, survey_type: r.survey_type, source: r.source,
      stage: r.stage, stage_label: st.label, group: wf.groupOf(r), owner_role: st.owner, forward_to: st.forward || null,
      owner_label: view.authorityLabel(db, st.owner, r), next_label: view.authorityLabel(db, view.nextRole(r), r),
      previous_stage: r.prev_stage ? wf.STAGES[r.prev_stage]?.label || null : null,
      next_stage: st.next && !(r.stage === 'CHIEF_MONITOR' && !r.sub) ? wf.STAGES[st.next].label : (r.stage === 'SCHEDULED' ? wf.STAGES.PM_COMPLETION.label : null),
      substage: wf.substage(r),
      backtrack: r.backtrack_reason ? { reason: r.backtrack_reason, by: userName(r.backtrack_by), from: r.backtrack_from ? wf.STAGES[r.backtrack_from].label : null } : null,
      survey_date: r.survey_date, date_proposed: !!r.date_proposed, surveyor: userName(r.surveyor_id), matching_exhausted: !!r.matching_exhausted,
      remarks: r.remarks, deadline: dl, return_note: r.return_note || null,
      rejection_reason: r.rejection_reason, rejected_stage: r.rejected_stage ? wf.STAGES[r.rejected_stage].label : null, rejected_stage_key: r.rejected_stage,
      rejected_by: userName(r.rejected_by), report: r.report,
      allowed_actions: wf.allowedActions(user, r), created_at: r.created_at, updated_at: r.updated_at, approved_at: r.approved_at,
    };
  }
  // Everything one person may know about one request: details, documents, who to call, the surveyor.
  const full = (user, r) => {
    const events = view.timeline(db, r);
    return {
      request: present(user, r), documents: docs.listFor(db, user, r),
      chain: user.role === 'SURVEYOR' ? [] : view.authorityChain(db, r),
      tracker: user.role === 'SURVEYOR' ? [] : view.tracker(db, r, audit.forRequest(db, r.id)),
      people: view.keyPeople(db, user, r), contacts: view.allContacts(db, user, r),
      activity: user.role === 'SURVEYOR' ? [] : events,
      last_actor: events.length ? events[events.length - 1].actor_name : null,
      surveyor_contact: wf.surveyorContact(db, user, r),
    };
  };
  const publicUser = (u) => ({
    id: u.id, username: u.username, name: u.name, role: u.role, division: u.division, email: u.email, phone: u.phone,
    substation: u.substation_id ? subName(u.substation_id) : null, active: !!u.active, zone: u.zone || null, nodal_centre: u.nodal_centre || null,
  });

  // ---------- CMS routes ----------
  route('POST', '/api/login', {}, (c) => { const u = doLogin(c, 'cms'); return { user: publicUser(u) }; });
  route('POST', '/api/logout', { auth: 'cms' }, (c) => { clearSession(c.req, c.res, 'cms'); return { ok: true }; });
  route('GET', '/api/me', { auth: 'cms' }, (c) => ({ user: publicUser(c.user), focus: FOCUS[c.user.role] || [], available: !!c.user.available }));
  route('GET', '/api/substations', { auth: 'cms' }, () => ({ substations: db.prepare('SELECT id,name,division,zone,circle,nodal_centre FROM substations ORDER BY id').all(), priorities: wf.PRIORITIES, survey_types: wf.SURVEY_TYPES }));

  route('GET', '/api/requests', { auth: 'cms' }, (c) => {
    matching.advanceAll(db, cfg); wf.escalateOverdue(db);
    return { requests: wf.listVisible(db, c.user).map((r) => present(c.user, r)) };
  });
  route('GET', '/api/requests/:id', { auth: 'cms' }, (c) => {
    const id = S.int(c.params.id, 'Request');
    matching.advance(db, cfg, id); wf.escalateOverdue(db);
    const r = wf.getVisible(db, c.user, id);
    if (!r) throw new HttpError(404, 'Request not found.');
    // Surveyors see their job, not the approval process behind it.
    return { ...full(c.user, r), history: c.user.role === 'SURVEYOR' ? [] : audit.forRequest(db, id) };
  });
  route('POST', '/api/requests', { auth: 'cms', roles: ['COORD'], maxBody: docs.BODY_LIMIT }, (c) => {
    const r = wf.createRequest(db, c.user, c.body);
    return { request: present(c.user, r) };
  });
  route('POST', '/api/requests/:id/:action', { auth: 'cms', maxBody: docs.BODY_LIMIT }, (c) => {
    const r = wf.act(db, cfg, c.user, S.int(c.params.id, 'Request'), c.params.action, c.body);
    return { request: present(c.user, r) };
  });

  route('GET', '/api/surveyors', { auth: 'cms', roles: ['COORD', 'PM'] }, (c) => {
    const date = c.query.get('date');
    const rows = db.prepare("SELECT id,name,available FROM users WHERE role='SURVEYOR' AND active=1 ORDER BY id").all();
    return { surveyors: rows.map((s) => ({ id: s.id, name: s.name, online: !!s.available,
      free: date ? !db.prepare('SELECT 1 FROM bookings WHERE surveyor_id=? AND date=?').get(s.id, date) : null })) };
  });
  route('GET', '/api/offers', { auth: 'cms', roles: ['SURVEYOR'] }, (c) => {
    matching.advanceAll(db, cfg);
    const rows = db.prepare(`SELECT o.id,o.status,o.distance_km,o.expires_at,r.code,r.revision,r.title,r.survey_date,s.name AS substation
      FROM offers o JOIN requests r ON r.id=o.request_id JOIN substations s ON s.id=r.substation_id
      WHERE o.surveyor_id=? ORDER BY o.id DESC LIMIT 50`).all(c.user.id);
    return { offers: rows.map((o) => ({ ...o, display_code: dispCode(o.code, o.revision) })) };
  });
  route('POST', '/api/offers/:id/respond', { auth: 'cms', roles: ['SURVEYOR'] }, (c) =>
    matching.respond(db, cfg, c.user, S.int(c.params.id, 'Offer'), c.body.accept === true));
  route('POST', '/api/surveyor/status', { auth: 'cms', roles: ['SURVEYOR'] }, (c) => {
    if (c.body.available === true) {
      const { lat, lon } = c.body;
      if (typeof lat !== 'number' || typeof lon !== 'number' || Math.abs(lat) > 90 || Math.abs(lon) > 180)
        throw new HttpError(400, 'A valid location is needed to go online.');
      db.prepare('UPDATE users SET available=1, lat=?, lon=? WHERE id=?').run(lat, lon, c.user.id);
    } else { // going offline erases the stored location (data minimisation)
      db.prepare('UPDATE users SET available=0, lat=NULL, lon=NULL WHERE id=?').run(c.user.id);
    }
    audit.append(db, { actor: c.user.username, role: c.user.role, action: c.body.available === true ? 'went_online' : 'went_offline', detail: {} });
    return { available: c.body.available === true };
  });

  const monthRx = /^\d{4}-(0[1-9]|1[0-2])$/;
  route('GET', '/api/calendar', { auth: 'cms', roles: ['SURVEYOR', 'COORD', 'PM'] }, (c) => {
    const month = c.query.get('month');
    if (!monthRx.test(month || '')) throw new HttpError(400, 'month must be YYYY-MM.');
    const sid = c.user.role === 'SURVEYOR' ? c.user.id : S.int(c.query.get('surveyor_id'), 'Surveyor');
    const rows = db.prepare(`SELECT b.date, r.code FROM bookings b JOIN requests r ON r.id=b.request_id
      WHERE b.surveyor_id=? AND b.date LIKE ? ORDER BY b.date`).all(sid, month + '-%');
    const next = db.prepare('SELECT MIN(date) AS d FROM bookings WHERE surveyor_id=? AND date>=?').get(sid, S.todayISO()).d;
    return { bookings: rows, next_booking: next };
  });
  route('GET', '/api/availability', { auth: 'cms', roles: ['SEIT', 'CHIEF', 'EE', 'AEE', 'AE', 'COORD', 'PM'] }, (c) => {
    const month = c.query.get('month');
    if (!monthRx.test(month || '')) throw new HttpError(400, 'month must be YYYY-MM.');
    const total = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='SURVEYOR' AND active=1").get().n;
    const rows = db.prepare(`SELECT b.date, COUNT(*) AS n FROM bookings b JOIN users u ON u.id=b.surveyor_id
      WHERE u.active=1 AND b.date LIKE ? GROUP BY b.date`).all(month + '-%');
    return { fully_booked: rows.filter((r) => r.n >= total).map((r) => r.date), surveyors: total };
  });

  // ---------- documents: opened only by people who may see that request and that document ----------
  route('GET', '/api/documents/:id', { auth: 'cms' }, (c) => {
    const d = db.prepare('SELECT * FROM documents WHERE id=?').get(S.int(c.params.id, 'Document'));
    const r = d && wf.getVisible(db, c.user, d.request_id);
    if (!d || !r || !docs.canOpen(c.user, r, d)) throw new HttpError(404, 'Document not found.');
    audit.append(db, { actor: c.user.username, role: c.user.role, action: 'document_opened', requestId: r.id, detail: { name: d.name } });
    // "View" opens PDFs and images in the browser (in a sandbox); everything else is a download.
    const inline = c.query.get('inline') === '1' && ['application/pdf', 'image/png', 'image/jpeg'].includes(d.mime);
    c.raw = { status: 200, body: Buffer.from(d.data), type: d.mime,
      headers: { 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${d.name.replace(/"/g, '')}"`, ...(inline ? { 'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:" } : {}) } };
    return null;
  });

  // ---------- calendar of surveys by date, and reports (everyone sees only what their role may see) ----------
  const VIEWERS = ['SEIT', 'CHIEF', 'EE', 'AEE', 'AE', 'COORD', 'PM'];
  const CATEGORY = { COMPLETED: 'done', LC_REJECTED: 'rejected', SCHEDULED: 'scheduled', PM_COMPLETION: 'scheduled', SURVEYOR_ASSIGNMENT: 'scheduled' }; // anything else is still pending approval
  const categoryOf = (stage) => CATEGORY[stage] || 'approval';
  const calendarRows = (user) => wf.listVisible(db, user).filter((r) => r.stage !== 'CLOSED');
  route('GET', '/api/schedule/month', { auth: 'cms', roles: VIEWERS }, (c) => {
    const month = c.query.get('month');
    if (!monthRx.test(month || '')) throw new HttpError(400, 'month must be YYYY-MM.');
    const days = {};
    for (const r of calendarRows(c.user).filter((x) => x.survey_date.startsWith(month + '-'))) {
      const d = (days[r.survey_date] ||= { date: r.survey_date, n: 0, approval: 0, scheduled: 0, rejected: 0, done: 0 });
      d.n += 1; d[categoryOf(r.stage)] += 1;
    }
    return { days: Object.values(days).sort((a, b) => a.date.localeCompare(b.date)) };
  });
  route('GET', '/api/schedule/day', { auth: 'cms', roles: VIEWERS }, (c) => {
    const date = c.query.get('date');
    if (!S.isoDate(date)) throw new HttpError(400, 'date must be YYYY-MM-DD.');
    return { date, items: calendarRows(c.user).filter((r) => r.survey_date === date).map((r) => ({ ...full(c.user, r), category: categoryOf(r.stage) })) };
  });
  route('GET', '/api/reports/rejected', { auth: 'cms', roles: VIEWERS }, (c) => {
    const visible = new Map(wf.listVisible(db, c.user).map((r) => [r.id, r]));
    const events = db.prepare("SELECT ts,actor,request_id,detail FROM audit WHERE action='rejected' ORDER BY id DESC").all()
      .filter((e) => visible.has(e.request_id)).map((e) => {
        const r = visible.get(e.request_id), d = JSON.parse(e.detail);
        return { request_id: r.id, code: r.code, display_code: dispCode(r.code, r.revision), title: r.title, substation: subName(r.substation_id),
          rejected_at: e.ts, rejected_by: db.prepare('SELECT name FROM users WHERE username=?').get(e.actor)?.name || e.actor,
          stage: wf.STAGES[d.stage]?.label || d.stage, reason: d.reason, kind: d.kind, tentative_date: d.tentative_date, now: wf.STAGES[r.stage].label, current_stage: r.stage };
      });
    return { rejections: events };
  });

  route('GET', '/api/notifications', { auth: 'cms' }, (c) => ({
    notifications: db.prepare('SELECT id,request_id,message,ts,is_read,category FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 100').all(c.user.id),
  }));
  // Reading is always the user's own act: one by one, or "mark all as read". Opening the page changes nothing.
  route('POST', '/api/notifications/read', { auth: 'cms' }, (c) => {
    db.prepare('UPDATE notifications SET is_read=1 WHERE user_id=?').run(c.user.id);
    return { ok: true };
  });
  route('POST', '/api/notifications/:id/read', { auth: 'cms' }, (c) => {
    db.prepare('UPDATE notifications SET is_read=1 WHERE user_id=? AND id=?').run(c.user.id, S.int(c.params.id, 'Notification'));
    return { ok: true };
  });
  route('GET', '/api/activity', { auth: 'cms' }, (c) => ({ events: view.activityFor(db, c.user, 12) }));

  // ---------- Admin: access management only. No request visibility, no approvals. ----------
  route('GET', '/api/admin/users', { auth: 'cms', roles: ['ADMIN'] }, () => ({
    users: db.prepare('SELECT * FROM users ORDER BY id').all().map(publicUser),
  }));
  route('POST', '/api/admin/users', { auth: 'cms', roles: ['ADMIN'] }, (c) => {
    const b = c.body;
    const username = S.str(b.username, 3, 32, 'Username').toLowerCase();
    if (!/^[a-z0-9_.-]+$/.test(username)) throw new HttpError(400, 'Username may use letters, digits, . _ -');
    if (!wf.ROLES.includes(b.role)) throw new HttpError(400, 'Unknown role.');
    const problem = S.passwordProblem(b.password);
    if (problem) throw new HttpError(400, problem);
    let division = null, substationId = null;
    if (['EE', 'AEE', 'AE'].includes(b.role)) {
      division = S.str(b.division, 3, 60, 'Division');
      if (!db.prepare('SELECT 1 FROM substations WHERE division=?').get(division)) throw new HttpError(400, 'Unknown division.');
    }
    let nodal = null;
    if (b.role === 'AEE' && b.nodal_centre) {
      nodal = S.str(b.nodal_centre, 3, 80, 'Nodal centre');
      if (!db.prepare('SELECT 1 FROM substations WHERE nodal_centre=? AND division=?').get(nodal, division)) throw new HttpError(400, 'Nodal centre is not in that division.');
    }
    if (b.role === 'AE') {
      substationId = S.int(b.substation_id, 'Substation');
      if (!db.prepare('SELECT 1 FROM substations WHERE id=? AND division=?').get(substationId, division)) throw new HttpError(400, 'Substation is not in that division.');
    }
    if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) throw new HttpError(409, 'Username already exists.');
    const email = b.email ? String(b.email).trim() : null, phone = b.phone ? String(b.phone).trim() : null;
    if (email && !S.emailOk(email)) throw new HttpError(400, 'Enter a valid email address.');
    if (phone && !S.phoneOk(phone)) throw new HttpError(400, 'Enter a valid phone number (digits and spaces, optional +).');
    const zone = division ? db.prepare('SELECT zone FROM substations WHERE division=? LIMIT 1').get(division)?.zone || null : null;
    db.prepare('INSERT INTO users(username,name,role,pw_hash,division,substation_id,email,phone,zone,nodal_centre) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(username, S.str(b.name, 2, 80, 'Name'), b.role, S.hashPassword(b.password), division, substationId, email, phone, zone, nodal);
    audit.append(db, { actor: c.user.username, role: c.user.role, action: 'user_created', detail: { username, role: b.role } });
    return { ok: true };
  });
  route('PATCH', '/api/admin/users/:id', { auth: 'cms', roles: ['ADMIN'] }, (c) => {
    const id = S.int(c.params.id, 'User');
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (!u) throw new HttpError(404, 'User not found.');
    if (typeof c.body.active === 'boolean') {
      if (id === c.user.id) throw new HttpError(400, 'You cannot disable your own account.');
      db.prepare('UPDATE users SET active=? WHERE id=?').run(c.body.active ? 1 : 0, id);
      if (!c.body.active) db.prepare("DELETE FROM sessions WHERE kind='cms' AND user_id=?").run(id);
      audit.append(db, { actor: c.user.username, role: c.user.role, action: c.body.active ? 'user_enabled' : 'user_disabled', detail: { username: u.username } });
    }
    if (c.body.role !== undefined) {
      if (!wf.ROLES.includes(c.body.role)) throw new HttpError(400, 'Unknown role.');
      if (id === c.user.id) throw new HttpError(400, 'You cannot change your own role.');
      db.prepare('UPDATE users SET role=? WHERE id=?').run(c.body.role, id);
      db.prepare("DELETE FROM sessions WHERE kind='cms' AND user_id=?").run(id);
      audit.append(db, { actor: c.user.username, role: c.user.role, action: 'role_changed', detail: { username: u.username, from: u.role, to: c.body.role } });
    }
    return { ok: true };
  });
  route('POST', '/api/admin/users/:id/reset-password', { auth: 'cms', roles: ['ADMIN'] }, (c) => {
    const id = S.int(c.params.id, 'User');
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (!u) throw new HttpError(404, 'User not found.');
    const temp = 'Tmp' + S.newToken().slice(0, 12) + '9a';
    db.prepare('UPDATE users SET pw_hash=?, failed=0, locked_until=0 WHERE id=?').run(S.hashPassword(temp), id);
    db.prepare("DELETE FROM sessions WHERE kind='cms' AND user_id=?").run(id);
    audit.append(db, { actor: c.user.username, role: c.user.role, action: 'password_reset', detail: { username: u.username } });
    return { temporary_password: temp };
  });
  route('GET', '/api/admin/audit', { auth: 'cms', roles: ['ADMIN'] }, () => ({ entries: audit.recent(db) }));
  route('GET', '/api/admin/audit/verify', { auth: 'cms', roles: ['ADMIN'] }, () => audit.verify(db));

  // ---------- Public portal: separate accounts, separate cookie, separate namespace ----------
  route('POST', '/portal/api/register', {}, (c) => {
    if (!regLimit(c.ip)) throw new HttpError(429, 'Too many sign-ups. Try again later.');
    const email = S.str(c.body.email, 5, 120, 'Email').toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email.');
    const problem = S.passwordProblem(c.body.password);
    if (problem) throw new HttpError(400, problem);
    if (db.prepare('SELECT 1 FROM portal_users WHERE email=?').get(email)) throw new HttpError(409, 'An account with this email already exists.');
    db.prepare('INSERT INTO portal_users(email,name,pw_hash) VALUES(?,?,?)').run(email, S.str(c.body.name, 2, 80, 'Name'), S.hashPassword(c.body.password));
    audit.append(db, { actor: `portal:${email}`, role: 'PUBLIC', action: 'portal_registered', detail: {} });
    return { ok: true };
  });
  route('POST', '/portal/api/login', {}, (c) => { const u = doLogin(c, 'portal'); return { user: { name: u.name, email: u.email } }; });
  route('POST', '/portal/api/logout', { auth: 'portal' }, (c) => { clearSession(c.req, c.res, 'portal'); return { ok: true }; });
  route('GET', '/portal/api/me', { auth: 'portal' }, (c) => ({ user: { name: c.user.name, email: c.user.email } }));
  route('GET', '/portal/api/substations', { auth: 'portal' }, () => ({ substations: db.prepare('SELECT id,name FROM substations ORDER BY id').all() }));
  route('GET', '/portal/api/requests', { auth: 'portal' }, (c) => ({
    requests: db.prepare('SELECT * FROM requests WHERE portal_user_id=? ORDER BY id DESC').all(c.user.id).map((r) => ({
      code: dispCode(r.code, r.revision), title: r.title, substation: subName(r.substation_id), survey_date: r.survey_date,
      status: PORTAL_STATUS[r.stage] || 'In progress',
    })),
  }));
  route('POST', '/portal/api/requests', { auth: 'portal' }, (c) => {
    if (!portalReqLimit('u' + c.user.id)) throw new HttpError(429, 'Request limit reached. Try again later.');
    const r = wf.createFromPortal(db, c.user, c.body);
    return { request: { code: dispCode(r.code, r.revision), status: PORTAL_STATUS[r.stage] } };
  });

  // ---------- plumbing ----------
  const HEADERS = {
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin', 'Cache-Control': 'no-store',
  };
  const send = (res, status, body, type = 'application/json; charset=utf-8', extra = {}) => {
    res.writeHead(status, { ...HEADERS, ...extra, 'Content-Type': type });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  function readBody(req, limit = 100e3) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (d) => { size += d.length; if (size > limit) { reject(new HttpError(413, 'Request too large.')); req.destroy(); } else chunks.push(d); });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const file = req.method === 'GET' && STATIC[url.pathname];
      if (file) return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, file[0])), file[1]);
      const match = routes.map((r) => ({ r, m: r.method === req.method && r.rx.exec(url.pathname) })).find((x) => x.m);
      if (!match) throw new HttpError(404, 'Not found.');
      const { r, m } = match;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const ctx = { req, res, params, query: url.searchParams, ip: req.socket.remoteAddress, body: {}, user: null };

      if (req.method !== 'GET') { // CSRF defences: custom header + same-origin + JSON only
        if (req.headers['x-requested-with'] !== 'poc-client') throw new HttpError(403, 'Missing request header.');
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Cross-origin request blocked.');
        const raw = await readBody(req, r.maxBody);
        if (raw) {
          if (!String(req.headers['content-type'] || '').includes('application/json')) throw new HttpError(415, 'JSON only.');
          try { ctx.body = JSON.parse(raw); } catch { throw new HttpError(400, 'Malformed JSON.'); }
          if (ctx.body === null || typeof ctx.body !== 'object' || Array.isArray(ctx.body)) throw new HttpError(400, 'JSON object expected.');
        }
      }
      if (r.auth) {
        ctx.user = authenticate(req, r.auth); // a portal cookie is useless on CMS routes and vice versa
        if (!ctx.user) throw new HttpError(401, 'Please sign in.');
        if (r.roles && !r.roles.includes(ctx.user.role)) {
          audit.append(db, { actor: ctx.user.username, role: ctx.user.role, action: 'forbidden', detail: { path: url.pathname } });
          throw new HttpError(403, 'Your role cannot do that.');
        }
      }
      const out = r.handler(ctx);
      if (ctx.raw) return send(res, ctx.raw.status, ctx.raw.body, ctx.raw.type, { 'X-Content-Type-Options': 'nosniff', ...ctx.raw.headers });
      return send(res, 200, out);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error('Unhandled error:', e); // details stay in the server log, never in the response
      return send(res, 500, { error: 'Something went wrong.' });
    }
  });

  const timer = setInterval(() => { try { matching.advanceAll(db, cfg); wf.escalateOverdue(db); } catch (e) { console.error(e); } }, 1000);
  timer.unref();
  return { server, db, cfg, close: () => { clearInterval(timer); server.closeAllConnections(); server.close(); } };
}

module.exports = { createApp };

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const app = createApp({ dbPath: process.env.DB_PATH || ':memory:', demoRequests: process.env.NO_DEMO !== '1' });
  app.server.listen(port, '127.0.0.1', () => {
    console.log(`\nSurvey PoC running\n  CMS module:    http://localhost:${port}/\n  Public portal: http://localhost:${port}/portal`);
    console.log('\nDemo CMS logins (password: ' + (process.env.SEED_PASSWORD || 'Demo@12345!') + ')');
    console.log('  coord1  ee_n  aee_n  ae_n1  chief1  seit1  sur1 sur2 sur3  pm1  admin1  (also ee_s aee_s aee_n2 aee_s2 ae_n2 ae_s1 ae_s2)\n');
  });
}
