'use strict';
const audit = require('./audit');
const matching = require('./matching');
const docs = require('./documents');
const { tx } = require('./db');
const { HttpError, isFutureDate, str, int, todayISO, addDaysISO, daysBetween, dispCode } = require('./security');

const ROLES = ['SEIT', 'CHIEF', 'EE', 'AEE', 'AE', 'ADMIN', 'PM', 'COORD', 'SURVEYOR'];
const KPTCL_ROLES = ['SEIT', 'CHIEF', 'EE', 'AEE', 'AE'];

// One source of truth for the process: who owns each stage and where it goes next.
// SEIT approves nothing: SEIT watches every request (read-only). The Chief's approval releases the request to a surveyor.
// dueDays = the longest an owner may keep the request (AE prepares documents: 4 days; AEE reviews them: 2 days).
const STAGES = {
  INTAKE_REVIEW:       { label: 'Pending Intake Screening', owner: 'COORD' },
  EE_PERMISSION:       { label: 'Pending EE Review', owner: 'EE', next: 'AEE_COORDINATION', forward: 'AEE', dueDays: 2 },
  AEE_COORDINATION:    { label: 'Pending AEE Review', owner: 'AEE', next: 'AE_SUBSTATION', forward: 'AE', dueDays: 2 },
  AE_SUBSTATION:       { label: 'Pending AE Action', owner: 'AE', next: 'AEE_REVISIT', forward: 'AEE', dueDays: 4 },
  AEE_REVISIT:         { label: 'Pending AEE Document Review', owner: 'AEE', next: 'EE_REVISIT', forward: 'EE', dueDays: 2 },
  EE_REVISIT:          { label: 'Pending EE Verification', owner: 'EE', next: 'CHIEF_MONITOR', forward: 'Chief', dueDays: 2 },
  CHIEF_MONITOR:       { label: 'Pending Chief Approval', owner: 'CHIEF', next: 'SURVEYOR_ASSIGNMENT', forward: 'Surveyor', dueDays: 2 },
  SURVEYOR_ASSIGNMENT: { label: 'Awaiting Surveyor', owner: 'COORD' },
  SCHEDULED:           { label: 'Survey Scheduled', owner: 'SURVEYOR' },
  PM_COMPLETION:       { label: 'Report Submitted', owner: 'PM', dueDays: 2 },
  COMPLETED:           { label: 'Completed', owner: null },
  LC_REJECTED:         { label: 'Rejected: Revision Needed', owner: 'COORD' },
  CLOSED:              { label: 'Closed', owner: null },
};
const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];
const SURVEY_TYPES = ['Line inspection', 'Substation condition survey', 'Equipment inspection', 'Thermography survey'];
// The one place that decides which list a request belongs to, so tiles, tables, the calendar and reports always agree.
const GROUP_OF = { COMPLETED: 'completed', LC_REJECTED: 'rejected', CLOSED: 'rejected', SURVEYOR_ASSIGNMENT: 'scheduled', SCHEDULED: 'scheduled' };
const groupOf = (req) => GROUP_OF[req.stage] || 'review';
const REJECTABLE = ['EE_PERMISSION', 'AEE_COORDINATION', 'AE_SUBSTATION'];

// Two-step stages. sub=0 is the first step, sub=1 the second.
//   AE:    1 = approve the LC (reject still possible)   2 = prepare documents and forward to the AEE
//   Chief: 1 = LC received and sent to review           2 = LC verified, proceed to the survey
function substage(req) {
  if (req.stage === 'AE_SUBSTATION') return { step: req.sub ? 2 : 1, of: 2, label: req.sub ? 'Prepare documents and forward to AEE' : 'Approve the request' };
  if (req.stage === 'CHIEF_MONITOR') return { step: req.sub ? 2 : 1, of: 2, label: req.sub ? 'Verified: proceed to survey' : 'Receive the request for review' };
  return null;
}
// Stages that count as "LC approved" for the reports (the Chief has approved).
const APPROVED_STAGES = ['SURVEYOR_ASSIGNMENT', 'SCHEDULED', 'PM_COMPLETION', 'COMPLETED'];

// Which requests a person may even see. Fail closed: unknown role sees nothing.
// Scope follows the authority: Chief = zone, EE = division, AEE = nodal centre, AE = substation.
function visibleWhere(user) {
  switch (user.role) {
    case 'SEIT': case 'COORD': case 'PM': return { sql: '1=1', args: [] };
    case 'CHIEF': return user.zone ? { sql: '(zone=? OR zone IS NULL)', args: [user.zone] } : { sql: '1=1', args: [] };
    case 'EE': return { sql: 'division=?', args: [user.division] };
    case 'AEE': return user.nodal_centre ? { sql: 'nodal_centre=?', args: [user.nodal_centre] } : { sql: 'division=?', args: [user.division] };
    case 'AE': return { sql: 'substation_id=?', args: [user.substation_id] };
    case 'SURVEYOR':
      return { sql: "(surveyor_id=? OR id IN (SELECT request_id FROM offers WHERE surveyor_id=? AND status='OFFERED'))", args: [user.id, user.id] };
    default: return { sql: '0=1', args: [] }; // ADMIN and anything unknown: no operational requests
  }
}
// Active users of one role who hold the authority for this request (the AEE of its nodal centre, the EE of its division...).
function holders(db, role, req) {
  const q = (where, ...args) => db.prepare(`SELECT * FROM users WHERE role=? AND active=1 AND ${where} ORDER BY id`).all(role, ...args);
  switch (role) {
    case 'CHIEF': return q('(zone=? OR zone IS NULL)', req.zone || '');
    case 'EE': return q('division=?', req.division);
    case 'AEE': return q('((nodal_centre IS NOT NULL AND nodal_centre=?) OR (nodal_centre IS NULL AND division=?))', req.nodal_centre || '', req.division);
    case 'AE': return q('substation_id=?', req.substation_id);
    default: return q('1=1');
  }
}
const listVisible = (db, user) => {
  const w = visibleWhere(user);
  return db.prepare(`SELECT * FROM requests WHERE ${w.sql} ORDER BY id DESC`).all(...w.args);
};
const getVisible = (db, user, id) => {
  const w = visibleWhere(user);
  return db.prepare(`SELECT * FROM requests WHERE id=? AND ${w.sql}`).get(id, ...w.args);
};

function allowedActions(user, req) {
  const st = STAGES[req.stage];
  if (!st || st.owner !== user.role) return [];
  switch (req.stage) {
    case 'INTAKE_REVIEW': return ['accept_intake', 'decline_intake'];
    case 'AE_SUBSTATION': return req.sub ? ['upload_documents', 'approve'] : ['approve_lc', 'reject', 'reschedule'];
    case 'EE_PERMISSION': case 'AEE_COORDINATION': return ['approve', 'reject', 'reschedule'];
    case 'AEE_REVISIT': case 'EE_REVISIT': return ['approve', 'backtrack'];
    case 'CHIEF_MONITOR': return req.sub ? ['approve'] : ['start_review'];
    case 'SURVEYOR_ASSIGNMENT': return ['assign'];
    case 'SCHEDULED': return req.surveyor_id === user.id ? ['submit_report'] : [];
    case 'PM_COMPLETION': return ['complete', 'return_report'];
    case 'LC_REJECTED': return ['resubmit'];
    default: return [];
  }
}

function ownersOf(db, req) {
  const st = STAGES[req.stage];
  if (!st || !st.owner) return [];
  if (st.owner === 'SURVEYOR') return req.surveyor_id ? [{ id: req.surveyor_id }] : [];
  if (['CHIEF', 'EE', 'AEE', 'AE'].includes(st.owner)) return holders(db, st.owner, req);
  return db.prepare('SELECT id FROM users WHERE role=? AND active=1').all(st.owner);
}
// Users of the given roles who hold the authority for this request.
const scopeIds = (db, req, roles) => roles.flatMap((r) => holders(db, r, req).map((u) => u.id));
const label = (req) => dispCode(req.code, req.revision);
const notifyOwners = (db, req, text) =>
  matching.notify(db, ownersOf(db, req).map((o) => o.id), req.id, `${label(req)}: ${text}`, 'action');

// Optional free text (remarks): empty is fine, too long is not.
function optText(v, max, field) {
  if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) return null;
  return str(v, 1, max, field);
}

function insertRequest(db, { source, portalUserId = null, createdBy = null, actor, substationId, surveyDate, title, stage, remarks = null, files = [], priority = 'Medium', surveyType = SURVEY_TYPES[1] }) {
  const sub = db.prepare('SELECT * FROM substations WHERE id=?').get(substationId);
  if (!sub) throw new HttpError(400, 'Unknown substation.');
  if (!isFutureDate(surveyDate)) throw new HttpError(400, 'Choose a valid date after today.');
  if (!PRIORITIES.includes(priority)) throw new HttpError(400, 'Priority must be Low, Medium, High or Critical.');
  if (!SURVEY_TYPES.includes(surveyType)) throw new HttpError(400, 'Unknown survey type.');
  title = str(title, 3, 120, 'Title');
  return tx(db, () => {
    const next = db.prepare('SELECT COALESCE(MAX(id),0)+1 AS n FROM requests').get().n;
    const code = `SR-${1000 + next}`;
    const now = Date.now();
    const info = db.prepare(`INSERT INTO requests(code,title,substation_id,division,nodal_centre,zone,priority,survey_type,source,portal_user_id,created_by,stage,survey_date,created_at,updated_at,remarks)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(code, title, sub.id, sub.division, sub.nodal_centre, sub.zone, priority, surveyType, source, portalUserId, createdBy, stage, surveyDate, now, now, remarks);
    const req = db.prepare('SELECT * FROM requests WHERE id=?').get(Number(info.lastInsertRowid));
    if (files.length && createdBy) docs.store(db, req, { id: createdBy }, 'LC', files, 2);
    // a request that starts with a clock (EE review) gets its due date straight away
    const days = STAGES[stage].dueDays;
    if (days) db.prepare('UPDATE requests SET stage_due=? WHERE id=?').run(addDaysISO(todayISO(), days), req.id);
    audit.append(db, { actor: actor.name, role: actor.role, action: source === 'portal' ? 'request_received_from_portal' : 'request_created', requestId: req.id,
      detail: { substation: sub.name, survey_date: surveyDate, remarks, priority, survey_type: surveyType, documents: files.map((f) => f.name) } });
    const fresh = db.prepare('SELECT * FROM requests WHERE id=?').get(req.id);
    notifyOwners(db, fresh, source === 'portal' ? 'new public request needs screening.' : 'new survey request awaiting your review.');
    return fresh;
  });
}

const requireLc = (f) => { if (!f.length) throw new HttpError(400, 'Attach at least one supporting document.'); return f; };
const createRequest = (db, user, b) => insertRequest(db, {
  source: 'internal', createdBy: user.id, actor: { name: user.username, role: user.role },
  substationId: int(b.substation_id, 'Substation'), surveyDate: b.survey_date, title: b.title, stage: 'EE_PERMISSION',
  remarks: optText(b.remarks, 500, 'Remarks'), files: requireLc(docs.parseFiles(b.files)),
  priority: b.priority || 'Medium', surveyType: b.survey_type || SURVEY_TYPES[1],
});
// The portal can only drop a request into intake; it can never approve or move anything.
const createFromPortal = (db, portalUser, b) => insertRequest(db, {
  source: 'portal', portalUserId: portalUser.id, actor: { name: `portal:${portalUser.email}`, role: 'PUBLIC' },
  substationId: int(b.substation_id, 'Substation'), surveyDate: b.survey_date, title: b.title, stage: 'INTAKE_REVIEW',
});

// Actions whose comment is kept in the audit trail (approve, accept, forward, assign, complete...).
const COMMENT_ACTIONS = ['approve', 'approve_lc', 'start_review', 'accept_intake', 'assign', 'complete', 'resubmit'];

function act(db, cfg, user, id, action, body = {}) {
  const found = getVisible(db, user, id);
  if (!found) throw new HttpError(404, 'Request not found.');
  if (!allowedActions(user, found).includes(action))
    throw new HttpError(403, 'You cannot do that on this request at its current stage.');
  const who = { actor: user.username, role: user.role, requestId: found.id };
  // Validate everything that can fail BEFORE the transaction opens.
  const files = ['approve', 'upload_documents', 'resubmit'].includes(action) ? docs.parseFiles(body.files) : [];
  if (action === 'resubmit') requireLc(files);
  const remarks = COMMENT_ACTIONS.includes(action) ? optText(body.remarks, 500, 'Comment') : null;
  const everyone = () => [...new Set([...matching.chainIds(db, found), ...matching.officeIds(db)])].filter((i) => i !== user.id);

  const set = (fields) => {
    const f = { ...fields };
    if (f.stage) { // entering a stage starts its clock, if it has one, and its first step
      if (f.sub === undefined) f.sub = 0;
      f.prev_stage = found.stage;
      const days = STAGES[f.stage].dueDays;
      f.stage_due = days ? addDaysISO(todayISO(), days) : null;
      f.overdue_notified = 0;
    }
    const keys = Object.keys(f);
    db.prepare(`UPDATE requests SET ${[...keys.map((k) => `${k}=?`), 'updated_at=?'].join(',')} WHERE id=?`)
      .run(...keys.map((k) => f[k]), Date.now(), found.id);
    return db.prepare('SELECT * FROM requests WHERE id=?').get(found.id);
  };

  return tx(db, () => {
    let req;
    switch (action) {
      case 'upload_documents': { // AE saves documents while still preparing them (no forwarding yet)
        if (!files.length) throw new HttpError(400, 'Choose at least one file to upload.');
        docs.store(db, found, user, 'AE_DOCS', files, 0);
        req = set({});
        audit.append(db, { ...who, action: 'documents_uploaded', detail: { files: files.map((f) => f.name) } });
        break;
      }
      case 'approve_lc': { // AE, step 1: the request is approved. From here nobody can reject it; the 4-day document clock starts now.
        req = set({ sub: 1, stage_due: addDaysISO(todayISO(), STAGES.AE_SUBSTATION.dueDays), overdue_notified: 0 });
        audit.append(db, { ...who, action: 'lc_approved', detail: { remarks } });
        matching.notify(db, scopeIds(db, found, ['AEE', 'EE']), found.id,
          `${label(req)}: ${user.name} approved the request and is preparing the documents (due ${req.stage_due}).`, 'approval');
        break;
      }
      case 'start_review': { // Chief, step 1: the request is received and goes into review
        req = set({ sub: 1 });
        audit.append(db, { ...who, action: 'review_started', detail: { remarks } });
        matching.notify(db, everyone(), found.id, `${label(req)}: the Chief has received the request and sent it to review.`, 'approval');
        break;
      }
      case 'backtrack': { // AEE or EE send it back to the AE for corrections; the EE may skip the AEE, who is told
        const reason = str(body.reason, 5, 500, 'Reason');
        req = set({ stage: 'AE_SUBSTATION', sub: 1, backtrack_reason: reason, backtrack_by: user.id, backtrack_from: found.stage });
        audit.append(db, { ...who, action: 'backtracked', detail: { from: found.stage, reason } });
        const text = `${label(req)}: sent back to the AE by ${user.name} (${user.role}). Reason: ${reason}`;
        matching.notify(db, scopeIds(db, found, ['AE']), found.id, `${text} Please correct and forward again within ${STAGES.AE_SUBSTATION.dueDays} days.`, 'action');
        matching.notify(db, scopeIds(db, found, found.stage === 'EE_REVISIT' ? ['AEE'] : ['EE']).filter((i) => i !== user.id), found.id, text, 'approval');
        break;
      }
      case 'approve': {
        const next = STAGES[found.stage].next;
        if (found.stage === 'AE_SUBSTATION') {
          if (files.length) docs.store(db, found, user, 'AE_DOCS', files, 0);
          if (docs.countCurrent(db, found, 'AE_DOCS') < 1) throw new HttpError(400, 'Upload at least one document before forwarding to the AEE.');
          docs.release(db, found, 0, 1); // the AEE and EE can now read them
        }
        if (found.stage === 'EE_REVISIT') docs.release(db, found, 1, 2); // end of loop 1: every authority can read them
        const extra = found.stage === 'CHIEF_MONITOR' ? { approved_at: Date.now() } : {};
        req = set({ stage: next, ...extra, ...(found.stage === 'AE_SUBSTATION' ? { backtrack_reason: null, backtrack_by: null, backtrack_from: null } : {}) });
        audit.append(db, { ...who, action: 'approved', detail: { from: found.stage, to: next, remarks, documents: files.map((f) => f.name) } });
        if (next === 'SURVEYOR_ASSIGNMENT') matching.startMatching(db, cfg, req);
        else notifyOwners(db, req, `awaiting your action: ${STAGES[next].label}.${STAGES[next].dueDays ? ` Please finish within ${STAGES[next].dueDays} days.` : ''}`);
        break;
      }
      case 'reject': {
        const reason = str(body.reason, 5, 500, 'Reason for rejection');
        req = set({ stage: 'LC_REJECTED', rejection_reason: reason, rejected_by: user.id, rejected_stage: found.stage,
          date_proposed: 0, revision: found.revision + 1 });
        audit.append(db, { ...who, action: 'rejected', detail: { stage: found.stage, reason, kind: 'REJECT' } });
        // Share the rejection with the whole chain, the coordinator and the PM.
        matching.notify(db, [...new Set([...matching.chainIds(db, found), ...matching.officeIds(db)])], found.id,
          `${label(req)}: rejected at "${STAGES[found.stage].label}" by ${user.name}. Reason: ${reason} The coordinator will prepare a revised request and propose a date.`, 'approval');
        break;
      }
      case 'reschedule': { // a different business action from rejection: the request stays where it is, only the survey date moves
        const reason = str(body.reason, 5, 500, 'Reason');
        if (!isFutureDate(body.new_date)) throw new HttpError(400, 'Pick a new survey date after today.');
        const old = found.survey_date;
        req = set({ survey_date: body.new_date, date_proposed: 1 });
        audit.append(db, { ...who, action: 'rescheduled', detail: { from_date: old, to_date: body.new_date, reason, stage: found.stage } });
        matching.notify(db, everyone(), found.id, `${label(req)}: survey date moved from ${old} to ${body.new_date} by ${user.name}. Reason: ${reason}`, 'schedule');
        break;
      }
      case 'accept_intake':
        req = set({ stage: 'EE_PERMISSION' });
        audit.append(db, { ...who, action: 'intake_accepted', detail: { remarks } });
        notifyOwners(db, req, 'survey request awaiting your review.');
        break;
      case 'decline_intake': {
        const reason = str(body.reason, 5, 500, 'Reason');
        req = set({ stage: 'CLOSED', rejection_reason: reason });
        audit.append(db, { ...who, action: 'intake_declined', detail: { reason } });
        break;
      }
      case 'resubmit': { // the revised request: new date, optional comment, supporting documents
        const date = body.survey_date ?? found.survey_date;
        if (!isFutureDate(date)) throw new HttpError(400, 'Confirm a valid date after today.');
        req = set({ stage: 'EE_PERMISSION', survey_date: date, rejected_stage: null, date_proposed: 1, ...(remarks ? { remarks } : {}) });
        if (files.length) docs.store(db, req, user, 'LC', files, 2);
        audit.append(db, { ...who, action: 'new_lc_submitted', detail: { confirmed_date: date, revision: req.revision, remarks, documents: files.map((f) => f.name) } });
        notifyOwners(db, req, `revised request submitted for ${date}; awaiting your review.`);
        break;
      }
      case 'assign': { // coordinator override / fallback when nobody nearby accepts
        const s = db.prepare("SELECT * FROM users WHERE id=? AND role='SURVEYOR' AND active=1").get(int(body.surveyor_id, 'Surveyor'));
        if (!s) throw new HttpError(400, 'Unknown surveyor.');
        matching.book(db, s.id, found.survey_date, found.id); // 409 if already booked that day
        db.prepare("UPDATE offers SET status='CANCELLED' WHERE request_id=? AND status='OFFERED'").run(found.id);
        req = set({ stage: 'SCHEDULED', surveyor_id: s.id });
        audit.append(db, { ...who, action: 'manual_assign', detail: { surveyor: s.name, date: found.survey_date, remarks } });
        matching.notify(db, [s.id], found.id, `${label(req)}: you are assigned a survey on ${found.survey_date}.`, 'assignment');
        matching.announceScheduled(db, req, s);
        break;
      }
      case 'submit_report': {
        const report = str(body.report, 10, 2000, 'Report');
        req = set({ stage: 'PM_COMPLETION', report });
        audit.append(db, { ...who, action: 'report_submitted', detail: {} });
        notifyOwners(db, req, 'survey report submitted; awaiting your review.');
        break;
      }
      case 'return_report': { // PM sends the report back to the surveyor for correction
        const reason = str(body.reason, 5, 500, 'Reason');
        req = set({ stage: 'SCHEDULED', return_note: reason });
        audit.append(db, { ...who, action: 'report_returned', detail: { reason } });
        matching.notify(db, [found.surveyor_id], found.id, `${label(req)}: your report was returned for correction. ${reason}`, 'action');
        break;
      }
      case 'complete':
        req = set({ stage: 'COMPLETED' });
        audit.append(db, { ...who, action: 'completed', detail: { remarks } });
        matching.notify(db, everyone(), req.id, `${label(req)}: survey completed.`, 'approval');
        break;
      default: throw new HttpError(400, 'Unknown action.');
    }
    return req;
  });
}

// When any authority overruns its time, the people above them and the coordinator are told - once.
const ABOVE = { EE: ['CHIEF'], AEE: ['EE'], AE: ['AEE', 'EE'], CHIEF: ['SEIT'], PM: ['COORD'] };
function escalateOverdue(db) {
  const late = db.prepare(`SELECT * FROM requests WHERE stage_due IS NOT NULL AND stage_due < ? AND overdue_notified=0`).all(todayISO());
  for (const r of late) {
    if (!STAGES[r.stage].dueDays) continue;
    tx(db, () => {
      db.prepare('UPDATE requests SET overdue_notified=1 WHERE id=?').run(r.id);
      const above = ABOVE[STAGES[r.stage].owner] || [];
      const ids = [...scopeIds(db, r, above), ...db.prepare("SELECT id FROM users WHERE active=1 AND role='COORD'").all().map((x) => x.id)];
      const everyone = [...new Set([...ids, ...ownersOf(db, r).map((o) => o.id)])];
      matching.notify(db, everyone, r.id, `${label(r)}: deadline missed. "${STAGES[r.stage].label}" was due on ${r.stage_due}.`, 'system');
      audit.append(db, { actor: 'system', role: 'SYSTEM', action: 'deadline_missed', requestId: r.id, detail: { stage: r.stage, due: r.stage_due } });
    });
  }
}

// How much time is left at a stage that has a clock. state: on_track | due_soon | overdue.
function deadline(req) {
  if (!req.stage_due || !STAGES[req.stage].dueDays) return null;
  const left = daysBetween(todayISO(), req.stage_due);
  return { due: req.stage_due, days_left: left, overdue: left < 0, max_days: STAGES[req.stage].dueDays, state: left < 0 ? 'overdue' : left <= 1 ? 'due_soon' : 'on_track' };
}

// Surveyors only get the people they actually work with.
const surveyorContact = (db, user, req) => {
  if (!req.surveyor_id || user.role === 'SURVEYOR') return null;
  return db.prepare('SELECT id,name,email,phone FROM users WHERE id=?').get(req.surveyor_id) || null;
};

module.exports = {
  ROLES, KPTCL_ROLES, STAGES, REJECTABLE, APPROVED_STAGES, PRIORITIES, SURVEY_TYPES, substage, groupOf, holders, scopeIds, ownersOf,
  listVisible, getVisible, visibleWhere, allowedActions,
  createRequest, createFromPortal, act, escalateOverdue, deadline, surveyorContact,
};
