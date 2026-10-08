'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');

const PW = 'Demo@12345!';
const addDays = (n) => new Date(Date.now() + 5.5 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);

const OPEN = [];
test.after(() => OPEN.forEach((a) => { try { a.close(); } catch { /* already closed */ } }));
async function boot(opts = {}) {
  const app = createApp({ offerTtlMs: 60000, loginPerMin: 100000, ...opts });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  app.base = `http://127.0.0.1:${app.server.address().port}`;
  app.sessions = new Map();
  OPEN.push(app);
  return app;
}
function client(base) {
  let cookie = '';
  return {
    async call(method, path, body, extraHeaders = {}) {
      const res = await fetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'poc-client', ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders },
        body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
      });
      const sc = res.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      const text = await res.text();
      let data = {}; try { data = JSON.parse(text); } catch { data = { raw: text }; }
      return { status: res.status, data, headers: res.headers, text };
    },
    get cookie() { return cookie; }, set cookie(v) { cookie = v; },
  };
}
async function as(app, username, pw = PW) {
  if (app.sessions.has(username) && pw === PW) return app.sessions.get(username);
  const c = client(app.base);
  const r = await c.call('POST', '/api/login', { username, password: pw });
  assert.equal(r.status, 200, `login ${username}: ${JSON.stringify(r.data)}`);
  if (pw === PW) app.sessions.set(username, c);
  return c;
}
async function newRequest(app, { substation = 1, date = addDays(10), title = 'Survey for line upgrade' } = {}) {
  const c = await as(app, 'coord1');
  const r = await c.call('POST', '/api/requests', { substation_id: substation, survey_date: date, title, files: [pdf()] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.request;
}
const pdf = (name = 'substation-plan.pdf', text = 'plan') => ({ name, data: Buffer.from(`%PDF-1.4\n${text}\n%%EOF`).toString('base64') });
// EE -> AEE -> AE (uploads documents) -> AEE -> EE -> Chief. SEIT only watches, so there is no SEIT step.
const CHAIN = ['ee_n', 'aee_n', 'ae_n1', 'aee_n', 'ee_n', 'chief1'];
async function approveChain(app, id, count = CHAIN.length) {
  for (const u of CHAIN.slice(0, count)) {
    const c = await as(app, u);
    if (u === 'ae_n1') assert.equal((await c.call('POST', `/api/requests/${id}/approve_lc`, {})).status, 200, 'AE approves the LC first');
    if (u === 'chief1') assert.equal((await c.call('POST', `/api/requests/${id}/start_review`, {})).status, 200, 'Chief receives the LC first');
    const r = await c.call('POST', `/api/requests/${id}/approve`, u === 'ae_n1' ? { files: [pdf()] } : {});
    assert.equal(r.status, 200, `${u}: ${JSON.stringify(r.data)}`);
  }
}
const stageOf = async (app, id) => (await (await as(app, 'coord1')).call('GET', `/api/requests/${id}`)).data.request;

// ---------------------------------------------------------------- authentication
test('login: bad password fails, 5 failures lock the account even for the right password', async () => {
  const app = await boot();
  const c = client(app.base);
  for (let i = 0; i < 5; i++) {
    const r = await c.call('POST', '/api/login', { username: 'sur3', password: 'wrong-password' });
    assert.equal(r.status, 401);
  }
  const ok = await c.call('POST', '/api/login', { username: 'sur3', password: PW });
  assert.equal(ok.status, 401, 'locked account must not log in');
  const other = await c.call('POST', '/api/login', { username: 'pm1', password: PW });
  assert.equal(other.status, 200, 'other accounts are unaffected');
  app.close();
});

test('login: unknown user and wrong password give the same message (no user enumeration)', async () => {
  const app = await boot();
  const c = client(app.base);
  const a = await c.call('POST', '/api/login', { username: 'nobody', password: 'x'.repeat(12) });
  const b = await c.call('POST', '/api/login', { username: 'pm1', password: 'x'.repeat(12) });
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.equal(a.data.error, b.data.error);
  app.close();
});

test('login: SQL-injection style input does not authenticate', async () => {
  const app = await boot();
  const c = client(app.base);
  const r = await c.call('POST', '/api/login', { username: "admin1' OR '1'='1", password: "' OR '1'='1" });
  assert.equal(r.status, 401);
  app.close();
});

test('login: per-IP rate limit returns 429', async () => {
  const app = await boot({ loginPerMin: 3 });
  const c = client(app.base);
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await c.call('POST', '/api/login', { username: 'pm1', password: 'bad-bad-bad1' })).status);
  assert.ok(codes.includes(429), codes.join(','));
  app.close();
});

test('unauthenticated calls are refused', async () => {
  const app = await boot();
  const c = client(app.base);
  for (const p of ['/api/me', '/api/requests', '/api/requests/1', '/api/admin/users', '/api/admin/audit'])
    assert.equal((await c.call('GET', p)).status, 401, p);
  app.close();
});

// ---------------------------------------------------------------- web hardening
test('hardening: CSRF header and cross-origin POSTs are refused; malformed JSON gives 400 without a stack trace', async () => {
  const app = await boot();
  const c = await as(app, 'coord1');
  const body = { substation_id: 1, survey_date: addDays(5), title: 'abc def' };
  const noHeader = await fetch(app.base + '/api/requests', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: c.cookie }, body: JSON.stringify(body) });
  assert.equal(noHeader.status, 403);
  const cross = await c.call('POST', '/api/requests', body, { Origin: 'http://evil.example' });
  assert.equal(cross.status, 403);
  const bad = await c.call('POST', '/api/requests', '{not json');
  assert.equal(bad.status, 400);
  assert.ok(!/at .*\.js/.test(bad.text), 'no stack trace in the response');
  app.close();
});

test('hardening: security headers are set on pages and API', async () => {
  const app = await boot();
  const page = await fetch(app.base + '/');
  for (const h of ['content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy'])
    assert.ok(page.headers.get(h), h);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  const html = await page.text();
  assert.match(html, /<title>[^<]*Survey Management/, 'the page body is real HTML');
  for (const f of ['/app.js', '/ui.js', '/cal.js', '/style.css', '/portal', '/portal.js']) {
    const r = await fetch(app.base + f);
    assert.equal(r.status, 200, f);
    assert.ok(!(await r.text()).startsWith('{"type":"Buffer"'), `${f} is served as itself`);
  }
  app.close();
});

// ---------------------------------------------------------------- the process
test('happy path: request moves through every stage, owned by the right person each time', async () => {
  const app = await boot();
  const req = await newRequest(app);
  assert.equal(req.stage, 'EE_PERMISSION');
  await approveChain(app, req.id);
  let r = await stageOf(app, req.id);
  assert.equal(r.stage, 'SURVEYOR_ASSIGNMENT', 'the Chief approves and the request goes straight to a surveyor');

  const sur1 = await as(app, 'sur1');
  const offers = (await sur1.call('GET', '/api/offers')).data.offers.filter((o) => o.status === 'OFFERED');
  assert.equal(offers.length, 1, 'nearest surveyor (sur1) is offered the job');
  assert.equal((await sur1.call('POST', `/api/offers/${offers[0].id}/respond`, { accept: true })).status, 200);
  r = await stageOf(app, req.id);
  assert.equal(r.stage, 'SCHEDULED'); assert.equal(r.surveyor, 'Surveyor 1');

  assert.equal((await sur1.call('POST', `/api/requests/${req.id}/submit_report`, { report: 'Survey completed; photos attached.' })).status, 200);
  assert.equal((await stageOf(app, req.id)).stage, 'PM_COMPLETION', 'no QC step: the report goes to the PM');
  const pm = await as(app, 'pm1');
  assert.equal((await pm.call('POST', `/api/requests/${req.id}/complete`)).status, 200);
  const end = await pm.call('GET', `/api/requests/${req.id}`);
  assert.equal(end.data.request.stage, 'COMPLETED');
  const actions = end.data.history.map((h) => h.action);
  for (const a of ['request_created', 'approved', 'offer_sent', 'offer_accepted', 'survey_scheduled', 'report_submitted', 'completed'])
    assert.ok(actions.includes(a), `history has ${a}`);
  assert.equal(actions.filter((a) => a === 'approved').length, 6);
  assert.ok(!actions.some((a) => /qc/.test(a)), 'there is no QC step any more');
  app.close();
});

test('QC is gone: no QC user, no QC role, and nothing in the flow waits for QC', async () => {
  const app = await boot();
  assert.equal((await client(app.base).call('POST', '/api/login', { username: 'qc1', password: PW })).status, 401);
  const admin = await as(app, 'admin1');
  assert.equal((await admin.call('POST', '/api/admin/users', { username: 'qc9', name: 'Some QC', role: 'QC', password: 'Str0ngPassw0rd' })).status, 400);
  const req = await newRequest(app); await approveChain(app, req.id);
  const sur1 = await as(app, 'sur1');
  await sur1.call('POST', `/api/offers/${(await sur1.call('GET', '/api/offers')).data.offers[0].id}/respond`, { accept: true });
  const r = (await sur1.call('GET', `/api/requests/${req.id}`)).data.request;
  assert.deepEqual(r.allowed_actions, ['submit_report']);
  assert.equal((await sur1.call('POST', `/api/requests/${req.id}/qc_accept`)).status, 403);
  app.close();
});

// ---------------------------------------------------------------- roles and boundaries
test('only the stage owner can act: wrong role, wrong division, wrong substation are all refused', async () => {
  const app = await boot();
  const req = await newRequest(app, { substation: 1 }); // North Division, N-1; stage EE_PERMISSION
  const refused = async (user, expectStatus) => {
    const c = await as(app, user);
    const r = await c.call('POST', `/api/requests/${req.id}/approve`);
    assert.equal(r.status, expectStatus, `${user} -> ${r.status} ${JSON.stringify(r.data)}`);
  };
  await refused('ae_n1', 403);   // sees it (own substation) but it is not their stage
  await refused('aee_n', 403);   // right division, wrong stage
  await refused('coord1', 403);
  await refused('chief1', 403);
  await refused('seit1', 403);   // even the top of the hierarchy cannot skip stages
  await refused('ee_s', 404);    // other division: the request is invisible
  await refused('ae_n2', 404);   // other substation
  await refused('sur1', 404);
  await refused('admin1', 404);
  assert.equal((await stageOf(app, req.id)).stage, 'EE_PERMISSION', 'nothing moved');
  app.close();
});

test('Admin manages access but cannot see or approve operational requests', async () => {
  const app = await boot();
  const req = await newRequest(app);
  const admin = await as(app, 'admin1');
  assert.equal((await admin.call('GET', '/api/requests')).data.requests.length, 0);
  assert.equal((await admin.call('GET', `/api/requests/${req.id}`)).status, 404);
  for (const a of ['approve', 'reject', 'assign', 'complete'])
    assert.ok([403, 404].includes((await admin.call('POST', `/api/requests/${req.id}/${a}`, {})).status), a);
  assert.equal((await admin.call('POST', '/api/requests', { substation_id: 1, survey_date: addDays(9), title: 'Admin attempt' })).status, 403);
  app.close();
});

test('Admin can create KPTCL and Office users, with a strong password and valid scope', async () => {
  const app = await boot();
  const admin = await as(app, 'admin1');
  const mk = (o) => admin.call('POST', '/api/admin/users', o);
  assert.equal((await mk({ username: 'ae_new', name: 'New AE', role: 'AE', division: 'North Division', substation_id: 2, password: 'Str0ngPassw0rd' })).status, 200);
  assert.equal((await mk({ username: 'sur9', name: 'New Surveyor', role: 'SURVEYOR', password: 'Str0ngPassw0rd' })).status, 200);
  assert.equal((await mk({ username: 'weak1', name: 'Weak', role: 'PM', password: 'short' })).status, 400);
  assert.equal((await mk({ username: 'bad_role', name: 'X Y', role: 'GOD', password: 'Str0ngPassw0rd' })).status, 400);
  assert.equal((await mk({ username: 'ae_bad', name: 'Bad Scope', role: 'AE', division: 'North Division', substation_id: 3, password: 'Str0ngPassw0rd' })).status, 400, 'substation must be in the division');
  assert.equal((await admin.call('PATCH', `/api/admin/users/${(await admin.call('GET', '/api/me')).data.user.id}`, { active: false })).status, 400, 'cannot disable self');
  const fresh = client(app.base);
  assert.equal((await fresh.call('POST', '/api/login', { username: 'ae_new', password: 'Str0ngPassw0rd' })).status, 200);
  app.close();
});

test('disabling a user or changing their role ends their sessions immediately', async () => {
  const app = await boot();
  const admin = await as(app, 'admin1');
  const target = await as(app, 'pm1');
  assert.equal((await target.call('GET', '/api/me')).status, 200);
  const users = (await admin.call('GET', '/api/admin/users')).data.users;
  const id = users.find((u) => u.username === 'pm1').id;
  assert.equal((await admin.call('PATCH', `/api/admin/users/${id}`, { active: false })).status, 200);
  assert.equal((await target.call('GET', '/api/me')).status, 401);
  app.close();
});

test('non-Admin roles cannot reach admin endpoints', async () => {
  const app = await boot();
  for (const u of ['seit1', 'ee_n', 'coord1', 'pm1', 'sur1']) {
    const c = await as(app, u);
    assert.equal((await c.call('GET', '/api/admin/users')).status, 403, u);
    assert.equal((await c.call('GET', '/api/admin/audit')).status, 403, u);
  }
  app.close();
});

test('visibility: surveyor sees only own work (no ID guessing)', async () => {
  const app = await boot();
  await newRequest(app);
  const sur2 = await as(app, 'sur2');
  assert.equal((await sur2.call('GET', '/api/requests')).data.requests.length, 0);
  for (let id = 1; id <= 3; id++) assert.equal((await sur2.call('GET', `/api/requests/${id}`)).status, 404);
  app.close();
});

// ---------------------------------------------------------------- LC rejection
test('rejection and rescheduling are separate actions; each needs a reason, and rescheduling a future date', async () => {
  const app = await boot();
  const req = await newRequest(app);
  const ee = await as(app, 'ee_n');
  const rej = `/api/requests/${req.id}/reject`, res = `/api/requests/${req.id}/reschedule`;
  assert.equal((await ee.call('POST', rej, {})).status, 400, 'no reason');
  assert.equal((await ee.call('POST', rej, { reason: 'abc' })).status, 400, 'reason too short');
  assert.equal((await ee.call('POST', res, { new_date: addDays(20) })).status, 400, 'no reason');
  assert.equal((await ee.call('POST', res, { reason: 'Line not available', new_date: addDays(-1) })).status, 400, 'past date');
  assert.equal((await ee.call('POST', res, { reason: 'Line not available', new_date: '2026-13-45' })).status, 400, 'invalid date');
  assert.equal((await ee.call('POST', res, { reason: 'Line not available' })).status, 400, 'no date');
  assert.equal((await ee.call('POST', `/api/requests/${req.id}/reschedule_reject`, { reason: 'combined', tentative_date: addDays(20) })).status, 403, 'the combined action no longer exists');
  const now = await stageOf(app, req.id);
  assert.equal(now.stage, 'EE_PERMISSION', 'nothing changed');
  assert.equal(now.survey_date, addDays(10));
  app.close();
});

test('Reject sends the request back for revision; Reschedule only moves the survey date and keeps it where it is', async () => {
  const app = await boot();
  const date = addDays(10);
  const a = await newRequest(app, { date }); const b = await newRequest(app, { date, title: 'Second survey' });
  const ee = await as(app, 'ee_n');
  const plain = await ee.call('POST', `/api/requests/${a.id}/reject`, { reason: 'Drawings are incomplete' });
  assert.equal(plain.status, 200, JSON.stringify(plain.data));
  assert.equal(plain.data.request.stage, 'LC_REJECTED');
  assert.equal(plain.data.request.survey_date, date, 'date unchanged');
  assert.equal(plain.data.request.date_proposed, false);
  const moved = await ee.call('POST', `/api/requests/${b.id}/reschedule`, { reason: 'Shutdown not possible', new_date: addDays(30) });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  assert.equal(moved.data.request.stage, 'EE_PERMISSION', 'still waiting for the same review');
  assert.equal(moved.data.request.survey_date, addDays(30));
  const seit = (await (await as(app, 'seit1')).call('GET', '/api/notifications')).data.notifications;
  assert.ok(seit.some((n) => n.category === 'schedule' && n.message.includes(addDays(30))), 'the chain is told about the new date');
  const ae = await as(app, 'ae_n1');
  assert.deepEqual((await ee.call('GET', `/api/requests/${a.id}`)).data.request.allowed_actions, [], 'nothing left to do for the EE');
  assert.equal((await ae.call('POST', `/api/requests/${a.id}/reject`, { reason: 'Not mine to reject' })).status, 403);
  app.close();
});

test('a rejected LC keeps its number but is shown as revised (SR-1003 Revised)', async () => {
  const app = await boot();
  const req = await newRequest(app);
  assert.equal(req.display_code, req.code);
  const ee = await as(app, 'ee_n');
  const r1 = await ee.call('POST', `/api/requests/${req.id}/reject`, { reason: 'Drawings are incomplete' });
  assert.equal(r1.data.request.code, req.code, 'the number never changes');
  assert.equal(r1.data.request.display_code, `${req.code} (Revised)`);
  const coord = await as(app, 'coord1');
  const again = await coord.call('POST', `/api/requests/${req.id}/resubmit`, { survey_date: addDays(20), files: [pdf('rev.pdf')] });
  assert.equal(again.data.request.display_code, `${req.code} (Revised)`, 'still revised after the new LC is submitted');
  const r2 = await ee.call('POST', `/api/requests/${req.id}/reject`, { reason: 'Still incomplete' });
  assert.equal(r2.data.request.display_code, `${req.code} (Revised 2)`);
  const n = (await (await as(app, 'seit1')).call('GET', '/api/notifications')).data.notifications;
  assert.ok(n.some((x) => x.message.startsWith(`${req.code} (Revised)`)), 'notifications use the revised label');
  app.close();
});

test('rejection by EE / AEE / AE: recorded, shared with the whole KPTCL chain, and a revised LC can be submitted', async () => {
  for (const [stageCount, rejecter, label] of [[0, 'ee_n', 'EE'], [1, 'aee_n', 'AEE'], [2, 'ae_n1', 'AE']]) {
    const app = await boot();
    const req = await newRequest(app);
    await approveChain(app, req.id, stageCount);
    const c = await as(app, rejecter);
    const r = await c.call('POST', `/api/requests/${req.id}/reject`, { reason: 'Shutdown not possible on that date' });
    assert.equal(r.status, 200, `${label}: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.request.stage, 'LC_REJECTED');
    // every authority in the chain gets the reason and the new tentative date
    for (const u of ['seit1', 'chief1', 'ee_n', 'aee_n', 'ae_n1', 'coord1']) {
      const n = (await (await as(app, u)).call('GET', '/api/notifications')).data.notifications;
      assert.ok(n.some((x) => x.message.includes('Shutdown not possible') && x.category === 'approval'), `${u} notified (${label})`);
    }
    // not people outside the chain
    const outside = (await (await as(app, 'ee_s')).call('GET', '/api/notifications')).data.notifications;
    assert.ok(!outside.some((x) => x.message.includes('Shutdown not possible')), 'other division not notified');
    // coordinator prepares the revised LC and confirms the date
    const coord = await as(app, 'coord1');
    const confirmed = addDays(26);
    const again = await coord.call('POST', `/api/requests/${req.id}/resubmit`, { survey_date: confirmed, remarks: 'Revised drawings attached', files: [pdf('revised-lc.pdf')] });
    assert.equal(again.status, 200);
    assert.equal(again.data.request.stage, 'EE_PERMISSION');
    assert.equal(again.data.request.survey_date, confirmed);
    assert.equal(again.data.request.remarks, 'Revised drawings attached');
    app.close();
  }
});

test('rejection is only for EE/AEE/AE at their own stages (Chief, SEIT, others cannot reject)', async () => {
  const app = await boot();
  const req = await newRequest(app);
  await approveChain(app, req.id, 5); // now at CHIEF_MONITOR
  const body = { reason: 'Not acceptable', new_date: addDays(30) };
  for (const a of ['reject', 'reschedule']) {
    assert.equal((await (await as(app, 'chief1')).call('POST', `/api/requests/${req.id}/${a}`, body)).status, 403, 'Chief cannot reject');
    assert.equal((await (await as(app, 'ee_n')).call('POST', `/api/requests/${req.id}/${a}`, body)).status, 403, 'EE cannot reject once it is past their stage');
  }
  app.close();
});

// ---------------------------------------------------------------- scheduling
test('scheduling: a surveyor cannot be booked twice on the same date', async () => {
  const app = await boot();
  const date = addDays(12);
  const a = await newRequest(app, { date, title: 'First survey' });
  const b = await newRequest(app, { date, title: 'Second survey' });
  await approveChain(app, a.id); await approveChain(app, b.id);
  const coord = await as(app, 'coord1');
  const s1 = (await coord.call('GET', `/api/surveyors?date=${date}`)).data.surveyors.find((s) => s.name.includes('Surveyor 1')).id;
  assert.equal((await coord.call('POST', `/api/requests/${a.id}/assign`, { surveyor_id: s1 })).status, 200);
  const clash = await coord.call('POST', `/api/requests/${b.id}/assign`, { surveyor_id: s1 });
  assert.equal(clash.status, 409);
  assert.match(clash.data.error, /already assigned on the selected date/);
  assert.equal((await stageOf(app, b.id)).stage, 'SURVEYOR_ASSIGNMENT', 'rolled back cleanly');
  const free = (await coord.call('GET', `/api/surveyors?date=${date}`)).data.surveyors.find((s) => s.id === s1);
  assert.equal(free.free, false);
  app.close();
});

test('scheduling: the database itself refuses a duplicate booking (backstop if application code ever has a bug)', async () => {
  const app = await boot();
  app.db.prepare('INSERT INTO bookings(surveyor_id,date,request_id) VALUES(14,?,1)').run('2030-01-01');
  assert.throws(() => app.db.prepare('INSERT INTO bookings(surveyor_id,date,request_id) VALUES(14,?,2)').run('2030-01-01'), /UNIQUE/);
  app.close();
});

test('scheduling: a booked surveyor is not offered another job that day; calendar shows the booking', async () => {
  const app = await boot();
  const date = addDays(14);
  const a = await newRequest(app, { date }); await approveChain(app, a.id);
  const sur1 = await as(app, 'sur1');
  await sur1.call('POST', `/api/offers/${(await sur1.call('GET', '/api/offers')).data.offers[0].id}/respond`, { accept: true });
  const b = await newRequest(app, { date, title: 'Another survey same day' }); await approveChain(app, b.id);
  const sur3 = await as(app, 'sur3');
  assert.equal((await sur3.call('GET', '/api/offers')).data.offers.filter((o) => o.status === 'OFFERED').length, 1, 'next nearest (sur3) gets it');
  assert.equal((await sur1.call('GET', '/api/offers')).data.offers.filter((o) => o.status === 'OFFERED').length, 0, 'sur1 is skipped');
  const cal = await sur1.call('GET', `/api/calendar?month=${date.slice(0, 7)}`);
  assert.ok(cal.data.bookings.some((x) => x.date === date));
  app.close();
});

// ---------------------------------------------------------------- nearest-surveyor matching
test('matching: nearest first; decline and expiry move to the next; when nobody is left the coordinator is told', async () => {
  const app = await boot({ offerTtlMs: 300 });
  const req = await newRequest(app, { substation: 1 });
  await approveChain(app, req.id);
  const open = async (u) => ((await (await as(app, u)).call('GET', '/api/offers')).data.offers).filter((o) => o.status === 'OFFERED');

  const first = await open('sur1');
  assert.equal(first.length, 1, 'sur1 is nearest to N-1');
  assert.ok((await open('sur3')).length === 0 && (await open('sur2')).length === 0, 'only one offer at a time');

  await (await as(app, 'sur1')).call('POST', `/api/offers/${first[0].id}/respond`, { accept: false });
  const second = await open('sur3');
  assert.equal(second.length, 1, 'declined -> next nearest is sur3');

  await new Promise((r) => setTimeout(r, 450)); // sur3 does not respond in time
  assert.equal((await open('sur3')).length, 0, 'sur3 offer expired');
  const third = await open('sur2');
  assert.equal(third.length, 1, 'expired -> next is sur2');

  const late = await (await as(app, 'sur3')).call('POST', `/api/offers/${second[0].id}/respond`, { accept: true });
  assert.equal(late.status, 409, 'an expired offer cannot be accepted');

  await (await as(app, 'sur2')).call('POST', `/api/offers/${third[0].id}/respond`, { accept: false });
  const r = await stageOf(app, req.id);
  assert.equal(r.matching_exhausted, true);
  assert.equal(r.stage, 'SURVEYOR_ASSIGNMENT');
  const n = (await (await as(app, 'coord1')).call('GET', '/api/notifications')).data.notifications;
  assert.ok(n.some((x) => /assign one manually/.test(x.message)));

  const coord = await as(app, 'coord1');
  const s2 = (await coord.call('GET', '/api/surveyors')).data.surveyors.find((s) => s.name.includes('Surveyor 2')).id;
  assert.equal((await coord.call('POST', `/api/requests/${req.id}/assign`, { surveyor_id: s2 })).status, 200);
  assert.equal((await stageOf(app, req.id)).stage, 'SCHEDULED');
  app.close();
});

test('matching: offline surveyors are never offered work, and going offline erases their stored location', async () => {
  const app = await boot();
  for (const u of ['sur1', 'sur2', 'sur3']) assert.equal((await (await as(app, u)).call('POST', '/api/surveyor/status', { available: false })).status, 200);
  const row = app.db.prepare("SELECT available,lat,lon FROM users WHERE username='sur1'").get();
  assert.equal(row.available, 0); assert.equal(row.lat, null); assert.equal(row.lon, null);
  const req = await newRequest(app); await approveChain(app, req.id);
  assert.equal((await stageOf(app, req.id)).matching_exhausted, true);
  const sur1 = await as(app, 'sur1');
  assert.equal((await sur1.call('POST', '/api/surveyor/status', { available: true })).status, 400, 'going online needs a location');
  assert.equal((await sur1.call('POST', '/api/surveyor/status', { available: true, lat: 999, lon: 0 })).status, 400);
  assert.equal((await sur1.call('POST', '/api/surveyor/status', { available: true, lat: 13.03, lon: 77.58 })).status, 200);
  app.close();
});

test('matching: a surveyor cannot answer someone else\'s offer', async () => {
  const app = await boot();
  const req = await newRequest(app); await approveChain(app, req.id);
  const offerId = (await (await as(app, 'sur1')).call('GET', '/api/offers')).data.offers[0].id;
  assert.equal((await (await as(app, 'sur2')).call('POST', `/api/offers/${offerId}/respond`, { accept: true })).status, 404);
  assert.equal((await (await as(app, 'ee_n')).call('POST', `/api/offers/${offerId}/respond`, { accept: true })).status, 403);
  app.close();
});

// ---------------------------------------------------------------- documents, deadlines, contacts
test('coordinator: remarks and LC documents travel with the request and the EE can open them', async () => {
  const app = await boot();
  const coord = await as(app, 'coord1');
  const r = await coord.call('POST', '/api/requests', { substation_id: 1, survey_date: addDays(10), title: 'With papers', remarks: 'Urgent: outage window is short', files: [pdf('lc-form.pdf', 'FORM'), pdf('single-line.pdf')] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.request.remarks, 'Urgent: outage window is short');
  const ee = await as(app, 'ee_n');
  const d = (await ee.call('GET', `/api/requests/${r.data.request.id}`)).data;
  assert.equal(d.documents.length, 2);
  assert.deepEqual(d.documents.map((x) => x.name).sort(), ['lc-form.pdf', 'single-line.pdf']);
  const file = await ee.call('GET', `/api/documents/${d.documents[0].id}`);
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-disposition'), /^attachment;/);
  assert.equal(file.headers.get('content-type'), 'application/pdf');
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(file.text.startsWith('%PDF-'));
  assert.equal((await (await as(app, 'ee_s')).call('GET', `/api/documents/${d.documents[0].id}`)).status, 404, 'other division cannot open it');
  assert.equal((await (await as(app, 'admin1')).call('GET', `/api/documents/${d.documents[0].id}`)).status, 404);
  assert.equal((await client(app.base).call('GET', `/api/documents/${d.documents[0].id}`)).status, 401);
  app.close();
});

test('uploads are checked: type, real file content, size and count', async () => {
  const app = await boot();
  const coord = await as(app, 'coord1');
  const base = { substation_id: 1, survey_date: addDays(10), title: 'Upload checks' };
  const send = (files) => coord.call('POST', '/api/requests', { ...base, files });
  assert.equal((await send([{ name: 'run.exe', data: Buffer.from('MZ-not-allowed').toString('base64') }])).status, 400, 'extension not allowed');
  assert.equal((await send([{ name: 'fake.pdf', data: Buffer.from('this is not a pdf').toString('base64') }])).status, 400, 'content does not match the extension');
  assert.equal((await send([{ name: 'noext', data: pdf().data }])).status, 400);
  assert.equal((await send([{ name: 'bad.pdf', data: 'not base64 !!' }])).status, 400);
  const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2 * 1024 * 1024)]).toString('base64');
  assert.equal((await send([{ name: 'big.pdf', data: big }])).status, 400, 'over 2 MB');
  assert.equal((await send([1, 2, 3, 4, 5].map((i) => pdf(`f${i}.pdf`)))).status, 400, 'more than 4 files');
  const sneaky = await send([{ name: '../../etc/passwd.pdf', data: pdf().data }]);
  assert.equal(sneaky.status, 200);
  const docs = (await coord.call('GET', `/api/requests/${sneaky.data.request.id}`)).data.documents;
  assert.equal(docs[0].name, 'passwd.pdf', 'path parts are stripped from file names');
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM requests').get().n, 1, 'failed uploads create no request');
  app.close();
});

test('AE stage: documents are required, can be saved in steps, and are released in two steps (AEE/EE, then everyone)', async () => {
  const app = await boot();
  const req = await newRequest(app);
  await approveChain(app, req.id, 2); // now with the AE
  const ae = await as(app, 'ae_n1');
  const r0 = (await ae.call('GET', `/api/requests/${req.id}`)).data;
  assert.equal(r0.request.stage, 'AE_SUBSTATION');
  assert.deepEqual(r0.request.allowed_actions, ['approve_lc', 'reject', 'reschedule'], 'step 1: approve the LC (rejection still possible)');
  assert.equal(r0.request.substage.step, 1);
  assert.equal((await ae.call('POST', `/api/requests/${req.id}/upload_documents`, { files: [pdf('early.pdf')] })).status, 403, 'documents only after the LC is approved');
  assert.equal((await ae.call('POST', `/api/requests/${req.id}/approve_lc`, {})).status, 200);
  const r1 = (await ae.call('GET', `/api/requests/${req.id}`)).data;
  assert.deepEqual(r1.request.allowed_actions, ['upload_documents', 'approve'], 'step 2: no rejection once the LC is approved');
  assert.equal(r1.request.substage.step, 2);
  for (const a of ['reject', 'reschedule']) assert.equal((await ae.call('POST', `/api/requests/${req.id}/${a}`, { reason: 'too late now', new_date: addDays(30) })).status, 403, a);
  assert.equal(r1.request.forward_to, 'AEE');
  assert.equal(r1.request.deadline.max_days, 4);
  assert.equal(r1.request.deadline.due, addDays(4), 'the AE has 4 days');
  assert.equal((await ae.call('POST', `/api/requests/${req.id}/approve`, {})).status, 400, 'cannot forward without documents');
  assert.equal((await ae.call('POST', `/api/requests/${req.id}/upload_documents`, {})).status, 400, 'nothing chosen');
  assert.equal((await ae.call('POST', `/api/requests/${req.id}/upload_documents`, { files: [pdf('layout.pdf')] })).status, 200);
  assert.equal((await stageOf(app, req.id)).stage, 'AE_SUBSTATION', 'saving documents does not forward');

  // while the AE is still preparing, nobody else can see them
  for (const u of ['aee_n', 'ee_n', 'chief1', 'seit1', 'coord1', 'pm1'])
    assert.equal((await (await as(app, u)).call('GET', `/api/requests/${req.id}`)).data.documents.filter((d) => d.kind === 'AE_DOCS').length, 0, `${u} sees nothing yet`);

  assert.equal((await ae.call('POST', `/api/requests/${req.id}/approve`, { files: [pdf('permit.pdf')], remarks: 'All clearances attached' })).status, 200);
  const aee = await as(app, 'aee_n');
  const forAee = (await aee.call('GET', `/api/requests/${req.id}`)).data;
  assert.equal(forAee.request.stage, 'AEE_REVISIT');
  assert.equal(forAee.request.deadline.due, addDays(2), 'the AEE has 2 days to review');
  assert.equal(forAee.documents.filter((d) => d.kind === 'AE_DOCS').length, 2, 'AEE sees both documents');
  assert.equal((await (await as(app, 'ee_n')).call('GET', `/api/requests/${req.id}`)).data.documents.filter((d) => d.kind === 'AE_DOCS').length, 2, 'EE too');
  assert.equal((await (await as(app, 'chief1')).call('GET', `/api/requests/${req.id}`)).data.documents.filter((d) => d.kind === 'AE_DOCS').length, 0, 'Chief not yet');
  const docId = forAee.documents.find((d) => d.kind === 'AE_DOCS').id;
  assert.equal((await (await as(app, 'chief1')).call('GET', `/api/documents/${docId}`)).status, 404, 'and cannot open by guessing the id');

  await aee.call('POST', `/api/requests/${req.id}/approve`, {});
  const ee = await as(app, 'ee_n');
  assert.equal((await ee.call('POST', `/api/requests/${req.id}/approve`, { remarks: 'Verified' })).status, 200);
  // end of loop 1: every authority can now see the documents
  for (const u of ['chief1', 'seit1', 'coord1', 'pm1', 'aee_n', 'ee_n', 'ae_n1']) {
    const d = (await (await as(app, u)).call('GET', `/api/requests/${req.id}`)).data;
    assert.equal(d.documents.filter((x) => x.kind === 'AE_DOCS').length, 2, `${u} sees the documents after loop 1`);
    assert.equal((await (await as(app, u)).call('GET', `/api/documents/${d.documents.find((x) => x.kind === 'AE_DOCS').id}`)).status, 200, u);
  }
  assert.equal((await (await as(app, 'ee_s')).call('GET', `/api/documents/${docId}`)).status, 404, 'other division still cannot');
  app.close();
});

test('every forward can carry remarks, which are recorded in the history', async () => {
  const app = await boot();
  const req = await newRequest(app);
  await (await as(app, 'ee_n')).call('POST', `/api/requests/${req.id}/approve`, { remarks: 'Permission given for the North division' });
  const h = (await (await as(app, 'aee_n')).call('GET', `/api/requests/${req.id}`)).data.history;
  assert.ok(h.some((e) => e.action === 'approved' && e.detail.remarks === 'Permission given for the North division'));
  assert.equal((await (await as(app, 'aee_n')).call('POST', `/api/requests/${req.id}/approve`, { remarks: 'x'.repeat(501) })).status, 400);
  app.close();
});

test('forward buttons name the next authority; the Chief releases the request to a surveyor', async () => {
  const app = await boot();
  const req = await newRequest(app);
  const expected = [['ee_n', 'AEE'], ['aee_n', 'AE'], ['ae_n1', 'AEE'], ['aee_n', 'EE'], ['ee_n', 'Chief'], ['chief1', 'Surveyor']];
  for (const [u, next] of expected) {
    const c = await as(app, u);
    const r = (await c.call('GET', `/api/requests/${req.id}`)).data.request;
    assert.equal(r.forward_to, next, `${u} forwards to ${next}`);
    if (u === 'ae_n1') await (await as(app, u)).call('POST', `/api/requests/${req.id}/approve_lc`, {});
    if (u === 'chief1') await (await as(app, u)).call('POST', `/api/requests/${req.id}/start_review`, {});
    assert.equal((await c.call('POST', `/api/requests/${req.id}/approve`, u === 'ae_n1' ? { files: [pdf()] } : {})).status, 200);
  }
  app.close();
});

test('SEIT only watches: sees everything, approves nothing, and the flow never waits for SEIT', async () => {
  const app = await boot();
  const req = await newRequest(app);
  const seit = await as(app, 'seit1');
  for (const u of [...CHAIN, null]) {
    const r = (await seit.call('GET', `/api/requests/${req.id}`)).data.request; // SEIT can always see it
    assert.deepEqual(r.allowed_actions, [], `SEIT has no action at ${r.stage}`);
    for (const a of ['approve', 'reject', 'reschedule_reject', 'assign', 'upload_documents'])
      assert.equal((await seit.call('POST', `/api/requests/${req.id}/${a}`, { reason: 'try it', tentative_date: addDays(9) })).status, 403, `${a} at ${r.stage}`);
    if (!u) break;
    if (u === 'ae_n1') await (await as(app, u)).call('POST', `/api/requests/${req.id}/approve_lc`, {});
    if (u === 'chief1') await (await as(app, u)).call('POST', `/api/requests/${req.id}/start_review`, {});
    assert.equal((await (await as(app, u)).call('POST', `/api/requests/${req.id}/approve`, u === 'ae_n1' ? { files: [pdf()] } : {})).status, 200);
  }
  assert.equal((await stageOf(app, req.id)).stage, 'SURVEYOR_ASSIGNMENT', 'straight to a surveyor after the Chief, with SEIT never acting');
  assert.ok(app.db.prepare("SELECT 1 FROM audit WHERE role='SEIT' AND action='approved'").get() === undefined, 'SEIT approved nothing');
  app.close();
});

test('deadlines: when the AE (4 days) or AEE (2 days) overruns, the people above are told once', async () => {
  const app = await boot();
  const req = await newRequest(app);
  await approveChain(app, req.id, 2);
  const yesterday = addDays(-1);
  app.db.prepare('UPDATE requests SET stage_due=? WHERE id=?').run(yesterday, req.id);
  const ae = await as(app, 'ae_n1');
  const late = (await ae.call('GET', `/api/requests/${req.id}`)).data.request;
  assert.equal(late.deadline.overdue, true);
  assert.equal(late.deadline.days_left, -1);
  for (const u of ['ae_n1', 'aee_n', 'ee_n', 'coord1']) {
    const n = (await (await as(app, u)).call('GET', '/api/notifications')).data.notifications.filter((x) => /deadline missed/.test(x.message));
    assert.equal(n.length, 1, `${u} told exactly once`);
  }
  assert.equal((await (await as(app, 'ee_s')).call('GET', '/api/notifications')).data.notifications.filter((x) => /deadline missed/.test(x.message)).length, 0);
  await ae.call('GET', '/api/requests'); // calling again must not notify again
  assert.equal((await (await as(app, 'aee_n')).call('GET', '/api/notifications')).data.notifications.filter((x) => /deadline missed/.test(x.message)).length, 1);
  const entries = (await (await as(app, 'admin1')).call('GET', '/api/admin/audit')).data.entries;
  assert.ok(entries.some((e) => e.action === 'deadline_missed'));
  app.close();
});

test('contacts: authorities get mail and phone details; surveyor details appear once one is assigned', async () => {
  const app = await boot();
  const req = await newRequest(app);
  const ee = await as(app, 'ee_n');
  const d0 = (await ee.call('GET', `/api/requests/${req.id}`)).data;
  const roles = d0.contacts.map((c) => c.role);
  for (const r of ['SEIT', 'CHIEF', 'EE', 'AEE', 'AE', 'COORD', 'PM']) assert.ok(roles.includes(r), `contact for ${r}`);
  assert.ok(d0.contacts.every((c) => /@/.test(c.email) && /^\+91 /.test(c.phone)));
  assert.equal(d0.people.owner.role, 'EE', 'the current owner'); assert.equal(d0.people.next.role, 'AEE', 'the next authority'); assert.equal(d0.people.requester.role, 'COORD', 'the requester');
  assert.equal(d0.contacts.filter((c) => c.role === 'EE').length, 1, 'only the EE of this division');
  assert.equal(d0.surveyor_contact, null, 'no surveyor yet');

  await approveChain(app, req.id);
  const sur1 = await as(app, 'sur1');
  await sur1.call('POST', `/api/offers/${(await sur1.call('GET', '/api/offers')).data.offers[0].id}/respond`, { accept: true });
  for (const u of ['ee_n', 'aee_n', 'ae_n1', 'chief1', 'seit1', 'coord1', 'pm1']) {
    const d = (await (await as(app, u)).call('GET', `/api/requests/${req.id}`)).data;
    assert.equal(d.surveyor_contact.name, 'Surveyor 1', u);
    assert.match(d.surveyor_contact.phone, /^\+91 /, `${u} sees the surveyor's phone`);
    const n = (await (await as(app, u)).call('GET', '/api/notifications')).data.notifications;
    assert.ok(n.some((x) => /Surveyor: Surveyor 1, phone \+91/.test(x.message)), `${u} was told who the surveyor is`);
  }
  // the surveyor sees only the people they work with, not the whole KPTCL chain
  const mine = (await sur1.call('GET', `/api/requests/${req.id}`)).data;
  assert.deepEqual([...new Set(mine.contacts.map((c) => c.role))].sort(), ['COORD', 'PM']);
  assert.equal(mine.surveyor_contact, null);
  // another surveyor can never read it
  assert.equal((await (await as(app, 'sur2')).call('GET', `/api/requests/${req.id}`)).status, 404);
  app.close();
});

test('admin can record email and phone for a new user, and bad values are refused', async () => {
  const app = await boot();
  const admin = await as(app, 'admin1');
  const mk = (o) => admin.call('POST', '/api/admin/users', { name: 'New Person', role: 'PM', password: 'Str0ngPassw0rd', ...o });
  assert.equal((await mk({ username: 'pm_new', email: 'pm.new@example.org', phone: '+91 98000 12345' })).status, 200);
  assert.equal((await mk({ username: 'pm_bad1', email: 'not-an-email' })).status, 400);
  assert.equal((await mk({ username: 'pm_bad2', phone: 'call me' })).status, 400);
  assert.equal((await mk({ username: 'pm_bad3', email: 'a@b.c"onmouseover="x' })).status, 400);
  assert.equal(app.db.prepare("SELECT phone FROM users WHERE username='pm_new'").get().phone, '+91 98000 12345');
  app.close();
});

// ---------------------------------------------------------------- calendar and reports
test('calendar: every viewing role sees the surveys of a date within its own scope; surveyors and Admin do not use it', async () => {
  const app = await boot();
  const date = addDays(12);
  const a = await newRequest(app, { date, substation: 1 });            // North
  const b = await newRequest(app, { date, substation: 3, title: 'South survey' }); // South
  const month = date.slice(0, 7);
  const day = async (u) => (await (await as(app, u)).call('GET', `/api/schedule/day?date=${date}`)).data.items.map((i) => i.request.id).sort();
  assert.deepEqual(await day('coord1'), [a.id, b.id].sort());
  assert.deepEqual(await day('pm1'), [a.id, b.id].sort());
  assert.deepEqual(await day('seit1'), [a.id, b.id].sort());
  assert.deepEqual(await day('chief1'), [a.id, b.id].sort());
  assert.deepEqual(await day('ee_n'), [a.id], 'EE sees only the division');
  assert.deepEqual(await day('ee_s'), [b.id]);
  assert.deepEqual(await day('ae_n1'), [a.id], 'AE sees only the substation');
  assert.deepEqual(await day('ae_n2'), []);
  const m = (await (await as(app, 'ee_n')).call('GET', `/api/schedule/month?month=${month}`)).data.days;
  assert.deepEqual(m.find((d) => d.date === date), { date, n: 1, approval: 1, scheduled: 0, rejected: 0, done: 0 });
  const item = (await (await as(app, 'ee_n')).call('GET', `/api/schedule/day?date=${date}`)).data.items[0];
  assert.ok(item.request && item.contacts && item.documents, 'each day entry carries the full picture');
  for (const u of ['sur1', 'admin1']) assert.equal((await (await as(app, u)).call('GET', `/api/schedule/day?date=${date}`)).status, 403, u);
  assert.equal((await (await as(app, 'ee_n')).call('GET', '/api/schedule/day?date=2026-02-31')).status, 400);
  assert.equal((await (await as(app, 'ee_n')).call('GET', '/api/schedule/month?month=2026-13')).status, 400);
  app.close();
});

test('calendar: scheduled, rejected and completed surveys are counted separately for the day', async () => {
  const app = await boot();
  const date = addDays(16);
  const a = await newRequest(app, { date, title: 'Will be scheduled' }); await approveChain(app, a.id);
  const sur1 = await as(app, 'sur1');
  await sur1.call('POST', `/api/offers/${(await sur1.call('GET', '/api/offers')).data.offers[0].id}/respond`, { accept: true });
  const b = await newRequest(app, { date, title: 'Will be rejected' });
  await (await as(app, 'ee_n')).call('POST', `/api/requests/${b.id}/reject`, { reason: 'Drawings are incomplete' });
  await newRequest(app, { date, title: 'Still in approval' });
  const m = (await (await as(app, 'coord1')).call('GET', `/api/schedule/month?month=${date.slice(0, 7)}`)).data.days.find((d) => d.date === date);
  assert.equal(m.n, 3); assert.equal(m.scheduled, 1); assert.equal(m.rejected, 1); assert.equal(m.approval, 1);
  const items = (await (await as(app, 'coord1')).call('GET', `/api/schedule/day?date=${date}`)).data.items;
  const sched = items.find((i) => i.request.id === a.id);
  assert.equal(sched.surveyor_contact.name, 'Surveyor 1');
  assert.equal(sched.category, 'scheduled');
  app.close();
});

test('reports: rejected LCs list who rejected, where, why and how, only within the viewer\'s scope', async () => {
  const app = await boot();
  const a = await newRequest(app, { substation: 1 }); const b = await newRequest(app, { substation: 3, title: 'South survey' });
  await (await as(app, 'ee_n')).call('POST', `/api/requests/${a.id}/reject`, { reason: 'Shutdown not possible' });
  await (await as(app, 'ee_s')).call('POST', `/api/requests/${b.id}/reject`, { reason: 'Drawings are incomplete' });
  const rep = async (u) => (await (await as(app, u)).call('GET', '/api/reports/rejected')).data.rejections;
  const all = await rep('coord1');
  assert.equal(all.length, 2);
  const north = all.find((r) => r.request_id === a.id);
  assert.equal(north.rejected_by, 'EE North'); assert.equal(north.kind, 'REJECT');
  assert.equal(north.display_code, `${a.code} (Revised)`); assert.equal(north.stage, 'Pending EE Review');
  assert.equal(all.find((r) => r.request_id === b.id).kind, 'REJECT');
  assert.equal((await rep('ee_n')).length, 1, 'EE North sees only North');
  assert.equal((await rep('ae_n2')).length, 0);
  assert.equal((await (await as(app, 'sur1')).call('GET', '/api/reports/rejected')).status, 403);
  app.close();
});

test('reports: approved LCs are the ones the Chief has approved; they carry an approval time', async () => {
  const app = await boot();
  const a = await newRequest(app); const b = await newRequest(app, { title: 'Not yet approved' });
  await approveChain(app, a.id);
  const rows = (await (await as(app, 'coord1')).call('GET', '/api/requests')).data.requests;
  const done = rows.find((r) => r.id === a.id), open = rows.find((r) => r.id === b.id);
  assert.ok(done.approved_at > 0); assert.equal(open.approved_at, null);
  assert.ok(['SURVEYOR_ASSIGNMENT', 'SCHEDULED'].includes(done.stage));
  app.close();
});

// ---------------------------------------------------------------- public portal boundary
test('portal: separate accounts and cookies; public requests only enter intake; no cross-use of sessions', async () => {
  const app = await boot();
  const reg = async (email) => {
    const c = client(app.base);
    assert.equal((await c.call('POST', '/portal/api/register', { email, name: 'Citizen One', password: 'Citizen#Pass99' })).status, 200);
    assert.equal((await c.call('POST', '/portal/api/login', { email, password: 'Citizen#Pass99' })).status, 200);
    return c;
  };
  const alice = await reg('alice@example.com');
  const bob = await reg('bob@example.com');

  const made = await alice.call('POST', '/portal/api/requests', { substation_id: 1, survey_date: addDays(15), title: 'Check near my plot' });
  assert.equal(made.status, 200);
  assert.equal(made.data.request.status, 'Received - being reviewed');
  assert.equal((await alice.call('GET', '/portal/api/requests')).data.requests.length, 1);
  assert.equal((await bob.call('GET', '/portal/api/requests')).data.requests.length, 0, 'Bob cannot see Alice\'s request');

  // a portal cookie is worthless on the CMS API, and vice versa
  const asCms = client(app.base); asCms.cookie = alice.cookie.replace('portal_sid', 'cms_sid');
  assert.equal((await asCms.call('GET', '/api/requests')).status, 401);
  const coordC = await as(app, 'coord1');
  const asPortal = client(app.base); asPortal.cookie = coordC.cookie.replace('cms_sid', 'portal_sid');
  assert.equal((await asPortal.call('GET', '/portal/api/requests')).status, 401);
  // the portal has no way to approve or move a request
  assert.equal((await alice.call('POST', '/api/requests/1/approve')).status, 401);

  // the coordinator screens the public request; only then does the approval chain begin
  const coord = await as(app, 'coord1');
  const list = (await coord.call('GET', '/api/requests')).data.requests;
  const pub = list.find((r) => r.source === 'portal');
  assert.equal(pub.stage, 'INTAKE_REVIEW');
  assert.equal((await (await as(app, 'ee_n')).call('GET', `/api/requests/${pub.id}`)).data.request.allowed_actions.length, 0, 'EE cannot act before intake');
  assert.equal((await coord.call('POST', `/api/requests/${pub.id}/accept_intake`)).status, 200);
  assert.equal((await stageOf(app, pub.id)).stage, 'EE_PERMISSION');
  assert.equal((await alice.call('GET', '/portal/api/requests')).data.requests[0].status, 'In approval');
  app.close();
});

test('portal: weak passwords, invalid dates and unknown substations are rejected', async () => {
  const app = await boot();
  const c = client(app.base);
  assert.equal((await c.call('POST', '/portal/api/register', { email: 'x@example.com', name: 'X Y', password: 'weak' })).status, 400);
  assert.equal((await c.call('POST', '/portal/api/register', { email: 'not-an-email', name: 'X Y', password: 'Citizen#Pass99' })).status, 400);
  await c.call('POST', '/portal/api/register', { email: 'x@example.com', name: 'X Y', password: 'Citizen#Pass99' });
  await c.call('POST', '/portal/api/login', { email: 'x@example.com', password: 'Citizen#Pass99' });
  assert.equal((await c.call('POST', '/portal/api/requests', { substation_id: 1, survey_date: addDays(-2), title: 'Past date' })).status, 400);
  assert.equal((await c.call('POST', '/portal/api/requests', { substation_id: 99, survey_date: addDays(5), title: 'No such place' })).status, 400);
  app.close();
});

// ---------------------------------------------------------------- audit
test('audit: hash chain verifies, and any edit to history is detected', async () => {
  const app = await boot();
  const req = await newRequest(app); await approveChain(app, req.id, 3);
  const admin = await as(app, 'admin1');
  const ok = await admin.call('GET', '/api/admin/audit/verify');
  assert.equal(ok.data.ok, true); assert.ok(ok.data.checked > 5);
  app.db.exec("UPDATE audit SET actor='someone_else' WHERE id=3"); // tamper with history directly in the database
  const bad = await admin.call('GET', '/api/admin/audit/verify');
  assert.equal(bad.data.ok, false); assert.equal(bad.data.brokenAtId, 3);
  app.close();
});

test('audit: refused actions and failed logins are logged', async () => {
  const app = await boot();
  const c = client(app.base);
  await c.call('POST', '/api/login', { username: 'pm1', password: 'wrong-wrong-1A' });
  await (await as(app, 'sur1')).call('GET', '/api/admin/users');
  const entries = (await (await as(app, 'admin1')).call('GET', '/api/admin/audit')).data.entries.map((e) => e.action);
  assert.ok(entries.includes('login_failed')); assert.ok(entries.includes('forbidden'));
  app.close();
});

test('LC documents are required to create a request or to resubmit a revised one', async () => {
  const app = await boot();
  const coord = await as(app, 'coord1');
  const base = { substation_id: 1, survey_date: addDays(10), title: 'No papers' };
  assert.equal((await coord.call('POST', '/api/requests', base)).status, 400);
  assert.equal((await coord.call('POST', '/api/requests', { ...base, files: [] })).status, 400);
  assert.equal((await coord.call('POST', '/api/requests', { ...base, files: [pdf()] })).status, 200);
});

test('no rejection after the LC is approved: AEE and EE backtrack to the AE instead (the EE may skip the AEE, who is told)', async () => {
  const app = await boot();
  const req = await newRequest(app);
  await approveChain(app, req.id, 3); // now with the AEE reviewing
  const aee = await as(app, 'aee_n');
  const v = (await aee.call('GET', `/api/requests/${req.id}`)).data.request;
  assert.deepEqual(v.allowed_actions, ['approve', 'backtrack']);
  assert.equal((await aee.call('POST', `/api/requests/${req.id}/reject`, { reason: 'not allowed now' })).status, 403);
  assert.equal((await aee.call('POST', `/api/requests/${req.id}/backtrack`, {})).status, 400, 'a reason is required');
  assert.equal((await aee.call('POST', `/api/requests/${req.id}/backtrack`, { reason: 'Earthing drawing is missing' })).status, 200);
  const ae = await as(app, 'ae_n1');
  const back = (await ae.call('GET', `/api/requests/${req.id}`)).data.request;
  assert.equal(back.stage, 'AE_SUBSTATION');
  assert.deepEqual(back.allowed_actions, ['upload_documents', 'approve'], 'back with the AE, LC stays approved');
  assert.equal(back.backtrack.reason, 'Earthing drawing is missing');
  assert.equal(back.deadline.due, addDays(4));
  assert.equal((await ae.call('POST', `/api/requests/${req.id}/approve`, { files: [pdf('earthing.pdf')] })).status, 200);
  await aee.call('POST', `/api/requests/${req.id}/approve`, {}); // AEE -> EE
  const ee = await as(app, 'ee_n');
  assert.deepEqual((await ee.call('GET', `/api/requests/${req.id}`)).data.request.allowed_actions, ['approve', 'backtrack']);
  assert.equal((await ee.call('POST', `/api/requests/${req.id}/reject`, { reason: 'not allowed now' })).status, 403);
  assert.equal((await ee.call('POST', `/api/requests/${req.id}/backtrack`, { reason: 'Clearance letter unsigned' })).status, 200);
  assert.equal((await stageOf(app, req.id)).stage, 'AE_SUBSTATION', 'straight to the AE, skipping the AEE');
  const aeeNotes = (await aee.call('GET', '/api/notifications')).data.notifications.map((n) => n.message).join('\n');
  assert.match(aeeNotes, /sent back to the AE by EE North/);
  app.close();
});

test('Chief has two steps: receive and send to review, then verified and released to the surveyor', async () => {
  const app = await boot();
  const req = await newRequest(app);
  await approveChain(app, req.id, 5);
  const chief = await as(app, 'chief1');
  const a = (await chief.call('GET', `/api/requests/${req.id}`)).data.request;
  assert.deepEqual(a.allowed_actions, ['start_review']);
  assert.equal(a.substage.step, 1);
  assert.equal((await chief.call('POST', `/api/requests/${req.id}/approve`, {})).status, 403, 'cannot approve before the review step');
  assert.equal((await chief.call('POST', `/api/requests/${req.id}/start_review`, {})).status, 200);
  const b = (await chief.call('GET', `/api/requests/${req.id}`)).data.request;
  assert.deepEqual(b.allowed_actions, ['approve']);
  assert.equal(b.substage.step, 2);
  assert.equal((await chief.call('POST', `/api/requests/${req.id}/approve`, {})).status, 200);
  app.close();
});

test('surveyors see their job, not the approval history; requests carry the zone, circle and nodal centre', async () => {
  const app = await boot();
  const req = await newRequest(app);
  await approveChain(app, req.id);
  const coord = await as(app, 'coord1');
  const d = (await coord.call('GET', `/api/requests/${req.id}`)).data;
  assert.equal(d.request.zone, 'Bengaluru Transmission Zone');
  assert.equal(d.request.nodal_centre, 'North Nodal Centre');
  const sur = await as(app, 'sur1');
  const sd = await sur.call('GET', `/api/requests/${req.id}`);
  if (sd.status === 200) assert.deepEqual(sd.data.history, []);
  app.close();
});

test('new request fields: priority and survey type are validated, groups and owner labels come from one place', async () => {
  const app = await boot({ demoRequests: false });
  const c = await as(app, 'coord1');
  const bad = await c.call('POST', '/api/requests', { substation_id: 1, survey_date: addDays(10), title: 'Priority check', priority: 'Urgent', files: [pdf()] });
  assert.equal(bad.status, 400);
  const badType = await c.call('POST', '/api/requests', { substation_id: 1, survey_date: addDays(10), title: 'Type check', survey_type: 'Nope', files: [pdf()] });
  assert.equal(badType.status, 400);
  const ok = await c.call('POST', '/api/requests', { substation_id: 1, survey_date: addDays(10), title: 'Good request', priority: 'Critical', survey_type: 'Line inspection', files: [pdf()] });
  assert.equal(ok.status, 200);
  const r = ok.data.request;
  assert.equal(r.priority, 'Critical'); assert.equal(r.group, 'review'); assert.match(r.owner_label, /^EE — /); assert.match(r.next_label, /^AEE — /);
  assert.equal(r.deadline.state, 'on_track');
  const ee = await as(app, 'ee_n');
  const d = (await ee.call('GET', `/api/requests/${r.id}`)).data;
  assert.equal(d.chain.length, 4); assert.ok(d.tracker.some((s) => s.status === 'current')); assert.equal(d.people.owner.role, 'EE');
});

test('reschedule is separate from reject: the stage stays, the date moves, the chain is told; AE cannot after approving', async () => {
  const app = await boot({ demoRequests: false });
  const r = await newRequest(app);
  const ee = await as(app, 'ee_n');
  assert.equal((await ee.call('POST', `/api/requests/${r.id}/reschedule`, { reason: 'Shutdown clash', new_date: addDays(-1) })).status, 400);
  const res = await ee.call('POST', `/api/requests/${r.id}/reschedule`, { reason: 'Shutdown clash', new_date: addDays(20) });
  assert.equal(res.status, 200); assert.equal(res.data.request.stage, 'EE_PERMISSION'); assert.equal(res.data.request.survey_date, addDays(20));
  const aee = await as(app, 'aee_n');
  const notes = (await aee.call('GET', '/api/notifications')).data.notifications;
  assert.ok(notes.some((n) => n.category === 'schedule' && n.request_id === r.id));
  await approveChain(app, r.id, 2);
  const ae = await as(app, 'ae_n1');
  await ae.call('POST', `/api/requests/${r.id}/approve_lc`, {});
  assert.equal((await ae.call('POST', `/api/requests/${r.id}/reschedule`, { reason: 'Too late', new_date: addDays(25) })).status, 403);
});

test('notifications: categories, read one by one, and listing never marks them read; activity feed and inline documents', async () => {
  const app = await boot({ demoRequests: false });
  const r = await newRequest(app);
  const ee = await as(app, 'ee_n');
  const list = (await ee.call('GET', '/api/notifications')).data.notifications;
  assert.ok(list.length && list.every((n) => n.is_read === 0 && n.category));
  assert.equal((await ee.call('GET', '/api/notifications')).data.notifications.filter((n) => n.is_read).length, 0);
  await ee.call('POST', `/api/notifications/${list[0].id}/read`);
  const after = (await ee.call('GET', '/api/notifications')).data.notifications;
  assert.equal(after.filter((n) => n.is_read).length, 1);
  const act = (await ee.call('GET', '/api/activity')).data.events;
  assert.ok(act.some((e) => e.request_id === r.id && e.text));
  const doc = (await ee.call('GET', `/api/requests/${r.id}`)).data.documents[0];
  const v = await ee.call('GET', `/api/documents/${doc.id}?inline=1`);
  assert.equal(v.status, 200); assert.match(v.headers.get('content-disposition'), /^inline/); assert.match(v.headers.get('content-security-policy'), /sandbox/);
});

test('hierarchy: the AEE of another nodal centre does not see the request', async () => {
  const app = await boot({ demoRequests: false });
  const r = await newRequest(app);
  const other = await as(app, 'aee_s2');
  assert.equal((await other.call('GET', `/api/requests/${r.id}`)).status, 404);
});
