'use strict';
// Everything the screens need to answer four questions about a request:
// what is it, who has it now, what must they do, and where does it go next.
// Authority (who owns it: Chief > EE > AEE > AE) and workflow (the stage it is in) are kept apart on purpose.
const wf = require('./workflow');
const audit = require('./audit');
const { dispCode } = require('./security');

const TITLE = { SEIT: 'SEIT', CHIEF: 'Chief', EE: 'Executive Engineer', AEE: 'Assistant Executive Engineer', AE: 'Assistant Engineer',
  COORD: 'Project Coordinator', PM: 'Project Manager', SURVEYOR: 'Surveyor', ADMIN: 'Administrator' };
const SHORT = { CHIEF: 'Chief', EE: 'EE', AEE: 'AEE', AE: 'AE', COORD: 'Project Coordinator', PM: 'Project Manager', SURVEYOR: 'Surveyor', SEIT: 'SEIT' };

const substationName = (db, req) => db.prepare('SELECT name FROM substations WHERE id=?').get(req.substation_id)?.name || 'Not available';
// "EE — North Division", "AEE — North Nodal Centre", "AE — Hebbal Substation", "Chief — Bengaluru Transmission Zone"
function scopeOf(db, role, req) {
  switch (role) {
    case 'CHIEF': return req.zone || 'All zones';
    case 'EE': return req.division;
    case 'AEE': return req.nodal_centre || req.division;
    case 'AE': return substationName(db, req);
    default: return null;
  }
}
function authorityLabel(db, role, req) {
  if (!role) return null;
  if (role === 'SURVEYOR') {
    const n = req.surveyor_id ? db.prepare('SELECT name FROM users WHERE id=?').get(req.surveyor_id)?.name : null;
    return n ? `Surveyor — ${n}` : 'Surveyor (not yet assigned)';
  }
  const scope = scopeOf(db, role, req);
  return scope ? `${SHORT[role]} — ${scope}` : SHORT[role];
}

// Who gets it after the current owner is done.
function nextRole(req) {
  switch (req.stage) {
    case 'INTAKE_REVIEW': return 'EE';
    case 'LC_REJECTED': return 'EE';
    case 'SURVEYOR_ASSIGNMENT': return 'SURVEYOR';
    case 'SCHEDULED': return 'PM';
    case 'PM_COMPLETION': return null;
    default: { const n = wf.STAGES[req.stage].next; return n ? wf.STAGES[n].owner : null; }
  }
}

const person = (u, role, req, db) => u && ({ id: u.id, name: u.name, role: u.role, title: TITLE[u.role] || u.role,
  scope: scopeOf(db, u.role, req), email: u.email, phone: u.phone });
function personFor(db, role, req) {
  if (!role) return null;
  let u;
  if (role === 'SURVEYOR') u = req.surveyor_id ? db.prepare('SELECT * FROM users WHERE id=?').get(req.surveyor_id) : null;
  else u = wf.holders(db, role, req)[0];
  return person(u, role, req, db) || null;
}
function requester(db, req) {
  if (req.created_by) return person(db.prepare('SELECT * FROM users WHERE id=?').get(req.created_by), 'COORD', req, db);
  if (req.portal_user_id) {
    const p = db.prepare('SELECT name,email FROM portal_users WHERE id=?').get(req.portal_user_id);
    return p ? { name: p.name, role: 'PUBLIC', title: 'Public requester', scope: null, email: p.email, phone: null } : null;
  }
  return null;
}

// The authority chain: Chief > EE > AEE > AE, with who holds each seat for this request. Not a timeline.
function authorityChain(db, req) {
  const cur = wf.STAGES[req.stage].owner, nxt = nextRole(req);
  return ['CHIEF', 'EE', 'AEE', 'AE'].map((role) => {
    const p = personFor(db, role, req);
    return { role, short: SHORT[role], title: role === 'CHIEF' ? 'Zone head' : { EE: 'Division head', AEE: 'Nodal centre head', AE: 'Substation engineer' }[role],
      scope: scopeOf(db, role, req), name: p ? p.name : 'Not assigned', state: role === cur ? 'current' : role === nxt ? 'next' : '' };
  });
}

// ---- workflow tracker: the lifecycle of the request, one meaningful step per stage (no numbering) ----
const STEPS = [
  { key: 'CREATED', title: 'Request created', role: 'COORD', action: 'Submitted with supporting documents' },
  { key: 'INTAKE_REVIEW', title: 'Intake screening', role: 'COORD', action: 'Screen the public request', portalOnly: true },
  { key: 'EE_PERMISSION', title: 'EE review', role: 'EE', action: 'Review and give division permission' },
  { key: 'AEE_COORDINATION', title: 'AEE review', role: 'AEE', action: 'Review and coordinate with the substation' },
  { key: 'AE_SUBSTATION', title: 'AE action', role: 'AE', action: 'Approve the request and prepare substation documents' },
  { key: 'AEE_REVISIT', title: 'AEE document review', role: 'AEE', action: 'Review the AE documents' },
  { key: 'EE_REVISIT', title: 'EE verification', role: 'EE', action: 'Verify the documents' },
  { key: 'CHIEF_MONITOR', title: 'Chief approval', role: 'CHIEF', action: 'Receive, review and approve' },
  { key: 'SURVEYOR_ASSIGNMENT', title: 'Surveyor assignment', role: 'SURVEYOR', action: 'Nearest available surveyor accepts' },
  { key: 'SCHEDULED', title: 'Survey', role: 'SURVEYOR', action: 'Carry out the survey and submit the report' },
  { key: 'PM_COMPLETION', title: 'Report review', role: 'PM', action: 'Review the report and complete' },
  { key: 'COMPLETED', title: 'Completed', role: null, action: 'Request closed with its report' },
];

// When each stage was finished, taken from the audit trail (last time it was left).
function stageDates(events, req) {
  const d = { CREATED: req.created_at };
  for (const e of events) {
    if (e.action === 'approved') d[e.detail.from] = e.ts;
    else if (e.action === 'intake_accepted') d.INTAKE_REVIEW = e.ts;
    else if (e.action === 'offer_accepted' || e.action === 'manual_assign') d.SURVEYOR_ASSIGNMENT = e.ts;
    else if (e.action === 'report_submitted') d.SCHEDULED = e.ts;
    else if (e.action === 'completed') { d.PM_COMPLETION = e.ts; d.COMPLETED = e.ts; }
  }
  return d;
}

function tracker(db, req, events) {
  const steps = STEPS.filter((s) => !s.portalOnly || req.source === 'portal');
  const dates = stageDates(events, req);
  const keys = steps.map((s) => s.key);
  let cur = keys.indexOf(req.stage), rejectedAt = -1;
  if (req.stage === 'LC_REJECTED') { rejectedAt = keys.indexOf(req.rejected_stage); cur = rejectedAt; }
  if (req.stage === 'CLOSED') { rejectedAt = keys.indexOf('INTAKE_REVIEW'); cur = rejectedAt; }
  if (req.stage === 'COMPLETED') cur = keys.length;
  return steps.map((s, i) => {
    let status = i < cur ? 'done' : i === cur ? 'current' : 'upcoming';
    if (i === rejectedAt) status = 'rejected';
    if (s.key === 'COMPLETED' && req.stage === 'COMPLETED') status = 'done';
    return { key: s.key, title: s.title, authority: s.key === 'CREATED' ? 'Project Coordinator' : s.key === 'COMPLETED' ? null : authorityLabel(db, s.role, req),
      action: s.action, status, date: status === 'done' ? dates[s.key] || null : null, sub: status === 'current' ? wf.substage(req) : null };
  });
}

// ---- readable activity ----
const stageOwnerShort = (stage) => SHORT[wf.STAGES[stage]?.owner] || '';
function describe(e, db) {
  const d = e.detail || {};
  const who = e.actor_name;
  const t = (text, extra = {}) => ({ text, result: null, decision: null, comment: null, ...extra });
  switch (e.action) {
    case 'request_created': return t('Survey request created', { result: 'Sent to EE review', comment: d.remarks || null });
    case 'request_received_from_portal': return t('Public survey request received', { result: 'Waiting for intake screening', comment: d.remarks || null });
    case 'intake_accepted': return t(`${who} accepted the public request`, { result: 'Sent to EE review', decision: 'Approved', comment: d.remarks || null });
    case 'intake_declined': return t(`${who} declined the public request`, { decision: 'Rejected', comment: d.reason });
    case 'approved': return t(`${who} approved and forwarded to ${stageOwnerShort(d.to) || 'the next stage'}`, { result: `Moved to ${wf.STAGES[d.to]?.label || d.to}`, decision: 'Approved', comment: d.remarks || null });
    case 'lc_approved': return t(`${who} approved the request`, { result: 'Preparing documents; rejection is no longer possible', decision: 'Approved', comment: d.remarks || null });
    case 'review_started': return t(`${who} received the request and sent it to review`, { result: 'Under Chief review', comment: d.remarks || null });
    case 'documents_uploaded': return t(`${who} saved documents`, { result: (d.files || []).join(', ') });
    case 'rejected': return t(`${who} rejected the request`, { result: 'Revision needed from the Project Coordinator', decision: 'Rejected', comment: d.reason });
    case 'rescheduled': return t(`${who} rescheduled the survey`, { result: `${d.from_date} → ${d.to_date}`, decision: 'Rescheduled', comment: d.reason });
    case 'backtracked': return t(`${who} sent the request back to the AE`, { result: `Returned from ${wf.STAGES[d.from]?.label || d.from}`, decision: 'Returned for correction', comment: d.reason });
    case 'new_lc_submitted': return t(`${who} submitted the revised request`, { result: 'Back with the EE', comment: d.remarks || null });
    case 'offer_sent': return t(`Survey offered to ${d.surveyor} (nearest available surveyor)`);
    case 'offer_declined': return t(`${who} declined the survey offer`);
    case 'offer_expired': return t('A survey offer expired and went to the next surveyor');
    case 'offer_accepted': return t(`${who} accepted the survey`, { result: 'Survey will be scheduled' });
    case 'survey_scheduled': return t(`Survey scheduled for ${d.date}`, { result: `Surveyor: ${d.surveyor}` });
    case 'manual_assign': return t(`${who} assigned ${d.surveyor}`, { result: `Survey scheduled for ${d.date}`, comment: d.remarks || null });
    case 'matching_exhausted': return t('No nearby surveyor accepted', { result: 'The coordinator must assign one' });
    case 'report_submitted': return t(`${who} submitted the survey report`, { result: 'Report under review' });
    case 'report_returned': return t(`${who} returned the report for correction`, { decision: 'Returned for correction', comment: d.reason });
    case 'completed': return t(`${who} marked the request completed`, { result: 'Completed', decision: 'Approved', comment: d.remarks || null });
    case 'deadline_missed': return t(`Deadline missed at "${wf.STAGES[d.stage]?.label || d.stage}"`, { result: `Was due ${d.due}` });
    default: return t(e.action.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()));
  }
}
const HIDDEN = new Set(['document_opened']);
function enrich(db, rows) {
  const names = new Map(db.prepare('SELECT username,name FROM users').all().map((u) => [u.username, u.name]));
  return rows.filter((e) => !HIDDEN.has(e.action)).map((e) => {
    const actor_name = e.actor === 'system' ? 'System' : names.get(e.actor) || String(e.actor).replace(/^portal:/, '');
    const x = { ...e, actor_name };
    return { ts: e.ts, actor_name, actor_role: e.role, action: e.action, request_id: e.request_id, ...describe(x, db) };
  });
}
const timeline = (db, req) => enrich(db, audit.forRequest(db, req.id));

// Recent movement across everything this user may see.
function activityFor(db, user, limit = 10) {
  const w = wf.visibleWhere(user);
  const ids = db.prepare(`SELECT id FROM requests WHERE ${w.sql}`).all(...w.args).map((r) => r.id);
  if (!ids.length) return [];
  const rows = db.prepare(`SELECT id,ts,actor,role,action,request_id,detail FROM audit WHERE request_id IN (${ids.map(() => '?').join(',')}) AND action<>'document_opened' ORDER BY id DESC LIMIT ?`)
    .all(...ids, limit).map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
  const reqs = new Map(db.prepare(`SELECT id,code,revision,title FROM requests WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((r) => [r.id, r]));
  return enrich(db, rows).map((e) => ({ ...e, display_code: dispCode(reqs.get(e.request_id).code, reqs.get(e.request_id).revision), title: reqs.get(e.request_id).title }));
}

// Contacts that matter right now. Everyone else is behind "View all contacts".
function keyPeople(db, user, req) {
  if (user.role === 'SURVEYOR') return { owner: null, next: null, requester: requester(db, req), surveyor: null };
  const cur = wf.STAGES[req.stage].owner;
  return { owner: personFor(db, cur, req), next: personFor(db, nextRole(req), req), requester: requester(db, req), surveyor: personFor(db, req.surveyor_id ? 'SURVEYOR' : null, req) };
}
function allContacts(db, user, req) {
  const out = [];
  const add = (role) => { const p = personFor(db, role, req); if (p && !out.some((x) => x.id === p.id)) out.push(p); };
  if (user.role === 'SURVEYOR') { add('COORD'); add('PM'); return out; }
  ['SEIT', 'CHIEF', 'EE', 'AEE', 'AE', 'COORD', 'PM'].forEach(add);
  return out;
}

module.exports = { TITLE, SHORT, authorityLabel, nextRole, authorityChain, tracker, timeline, enrich, activityFor, keyPeople, allContacts, personFor };
