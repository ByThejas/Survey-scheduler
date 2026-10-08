'use strict';
const audit = require('./audit');
const { tx } = require('./db');
const { HttpError, dispCode } = require('./security');

const SYS = { actor: 'system', role: 'SYSTEM' };

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// category: action (you must act) | approval (decisions and movement) | schedule | assignment | system
function notify(db, userIds, requestId, message, category = 'system') {
  const ins = db.prepare('INSERT INTO notifications(user_id,request_id,message,ts,category) VALUES(?,?,?,?,?)');
  for (const id of [...new Set(userIds)]) ins.run(id, requestId, message, Date.now(), category);
}

// The KPTCL chain for one request: SEIT and Chief (state-wide), EE and AEE of the division, AE of the substation.
function chainIds(db, req) {
  return db.prepare(`SELECT id FROM users WHERE active=1 AND (role='SEIT'
    OR (role='CHIEF' AND (zone=? OR zone IS NULL))
    OR (role='EE' AND division=?)
    OR (role='AEE' AND ((nodal_centre IS NOT NULL AND nodal_centre=?) OR (nodal_centre IS NULL AND division=?)))
    OR (role='AE' AND substation_id=?))`).all(req.zone || '', req.division, req.nodal_centre || '', req.division, req.substation_id).map((r) => r.id);
}
const officeIds = (db) => db.prepare("SELECT id FROM users WHERE active=1 AND role IN ('COORD','PM')").all().map((r) => r.id);

// Tell every authority who the surveyor is (name and phone) once a survey is scheduled.
function announceScheduled(db, req, surveyor) {
  const code = dispCode(req.code, req.revision);
  const phone = surveyor.phone ? `, phone ${surveyor.phone}` : '';
  notify(db, [...new Set([...chainIds(db, req), ...officeIds(db)])], req.id,
    `${code}: survey scheduled on ${req.survey_date}. Surveyor: ${surveyor.name}${phone}.`, 'schedule');
}

// Surveyors who are: active, online (consented to share location), free on the date,
// and not already offered this request. Nearest first.
function candidates(db, req) {
  const sub = db.prepare('SELECT lat,lon FROM substations WHERE id=?').get(req.substation_id);
  const rows = db.prepare(`SELECT id,name,lat,lon FROM users
    WHERE role='SURVEYOR' AND active=1 AND available=1 AND lat IS NOT NULL AND lon IS NOT NULL
      AND id NOT IN (SELECT surveyor_id FROM bookings WHERE date=?)
      AND id NOT IN (SELECT surveyor_id FROM offers WHERE request_id=?)`).all(req.survey_date, req.id);
  return rows
    .map((r) => ({ id: r.id, name: r.name, distance_km: haversineKm(sub.lat, sub.lon, r.lat, r.lon) }))
    .sort((a, b) => a.distance_km - b.distance_km || a.id - b.id);
}

function offerNext(db, cfg, req) {
  const c = candidates(db, req)[0];
  if (!c) {
    db.prepare('UPDATE requests SET matching_exhausted=1, updated_at=? WHERE id=?').run(Date.now(), req.id);
    audit.append(db, { ...SYS, action: 'matching_exhausted', requestId: req.id, detail: {} });
    const coords = db.prepare("SELECT id FROM users WHERE role='COORD' AND active=1").all().map((x) => x.id);
    notify(db, coords, req.id, `${dispCode(req.code, req.revision)}: no nearby surveyor accepted. Please assign one manually.`, 'action');
    return null;
  }
  const now = Date.now();
  const info = db.prepare('INSERT INTO offers(request_id,surveyor_id,status,distance_km,created_at,expires_at) VALUES(?,?,?,?,?,?)')
    .run(req.id, c.id, 'OFFERED', c.distance_km, now, now + cfg.offerTtlMs);
  audit.append(db, { ...SYS, action: 'offer_sent', requestId: req.id, detail: { surveyor: c.name, distance_km: +c.distance_km.toFixed(2) } });
  notify(db, [c.id], req.id, `${dispCode(req.code, req.revision)}: new survey offer for ${req.survey_date}.`, 'assignment');
  return Number(info.lastInsertRowid);
}

function startMatching(db, cfg, req) {
  db.prepare('UPDATE requests SET matching_exhausted=0 WHERE id=?').run(req.id);
  return offerNext(db, cfg, req);
}

// Expire stale offers and move to the next surveyor. Safe to call repeatedly.
function advance(db, cfg, requestId) {
  const req = db.prepare('SELECT * FROM requests WHERE id=?').get(requestId);
  if (!req || req.stage !== 'SURVEYOR_ASSIGNMENT') return;
  const expired = db.prepare("SELECT id,surveyor_id FROM offers WHERE request_id=? AND status='OFFERED' AND expires_at<=?")
    .all(requestId, Date.now());
  if (!expired.length) return;
  tx(db, () => {
    for (const o of expired) {
      db.prepare("UPDATE offers SET status='EXPIRED' WHERE id=?").run(o.id);
      audit.append(db, { ...SYS, action: 'offer_expired', requestId, detail: { surveyor_id: o.surveyor_id } });
    }
    const open = db.prepare("SELECT 1 FROM offers WHERE request_id=? AND status='OFFERED'").get(requestId);
    if (!open && !req.matching_exhausted) offerNext(db, cfg, req);
  });
}

function advanceAll(db, cfg) {
  const ids = db.prepare("SELECT DISTINCT request_id FROM offers WHERE status='OFFERED' AND expires_at<=?").all(Date.now());
  for (const r of ids) advance(db, cfg, r.request_id);
}

function book(db, surveyorId, date, requestId) {
  try {
    db.prepare('INSERT INTO bookings(surveyor_id,date,request_id) VALUES(?,?,?)').run(surveyorId, date, requestId);
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) throw new HttpError(409, 'This surveyor is already assigned on the selected date.');
    throw e;
  }
}

function respond(db, cfg, user, offerId, accept) {
  let offer = db.prepare('SELECT * FROM offers WHERE id=? AND surveyor_id=?').get(offerId, user.id);
  if (!offer) throw new HttpError(404, 'Offer not found.');
  advance(db, cfg, offer.request_id);
  offer = db.prepare('SELECT * FROM offers WHERE id=?').get(offerId);
  if (offer.status !== 'OFFERED') throw new HttpError(409, 'This offer is no longer open.');
  const req = db.prepare('SELECT * FROM requests WHERE id=?').get(offer.request_id);

  if (!accept) {
    tx(db, () => {
      db.prepare("UPDATE offers SET status='DECLINED' WHERE id=?").run(offerId);
      audit.append(db, { actor: user.username, role: user.role, action: 'offer_declined', requestId: req.id, detail: {} });
      offerNext(db, cfg, req);
    });
    return { status: 'DECLINED' };
  }
  const clash = db.prepare('SELECT 1 FROM bookings WHERE surveyor_id=? AND date=?').get(user.id, req.survey_date);
  if (clash) {
    tx(db, () => {
      db.prepare("UPDATE offers SET status='EXPIRED' WHERE id=?").run(offerId);
      offerNext(db, cfg, req);
    });
    throw new HttpError(409, 'This surveyor is already assigned on the selected date.');
  }
  tx(db, () => {
    book(db, user.id, req.survey_date, req.id);
    db.prepare("UPDATE offers SET status='ACCEPTED' WHERE id=?").run(offerId);
    db.prepare("UPDATE offers SET status='CANCELLED' WHERE request_id=? AND status='OFFERED'").run(req.id);
    db.prepare("UPDATE requests SET surveyor_id=?, stage='SCHEDULED', updated_at=? WHERE id=?").run(user.id, Date.now(), req.id);
    audit.append(db, { actor: user.username, role: user.role, action: 'offer_accepted', requestId: req.id, detail: { date: req.survey_date } });
    audit.append(db, { ...SYS, action: 'survey_scheduled', requestId: req.id, detail: { surveyor: user.name, date: req.survey_date } });
    announceScheduled(db, req, user);
  });
  return { status: 'ACCEPTED' };
}

module.exports = { chainIds, officeIds, announceScheduled, candidates, startMatching, offerNext, advance, advanceAll, respond, book, notify, haversineKm };
