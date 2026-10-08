'use strict';
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('./security');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS substations(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, division TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL);
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL,
  pw_hash TEXT NOT NULL, division TEXT, substation_id INTEGER REFERENCES substations(id),
  active INTEGER NOT NULL DEFAULT 1, failed INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0,
  available INTEGER NOT NULL DEFAULT 0, lat REAL, lon REAL, email TEXT, phone TEXT);
CREATE TABLE IF NOT EXISTS portal_users(
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, pw_hash TEXT NOT NULL,
  failed INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, user_id INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS requests(
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
  substation_id INTEGER NOT NULL REFERENCES substations(id), division TEXT NOT NULL,
  source TEXT NOT NULL, portal_user_id INTEGER, created_by INTEGER,
  stage TEXT NOT NULL, survey_date TEXT NOT NULL, surveyor_id INTEGER,
  rejection_reason TEXT, rejected_by INTEGER, rejected_stage TEXT,
  matching_exhausted INTEGER NOT NULL DEFAULT 0, report TEXT, qc_note TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  remarks TEXT, revision INTEGER NOT NULL DEFAULT 0, stage_due TEXT, overdue_notified INTEGER NOT NULL DEFAULT 0,
  date_proposed INTEGER NOT NULL DEFAULT 1, approved_at INTEGER);
-- LC documents (coordinator) and substation documents (AE). Files live in the database for the PoC;
-- production would use an object store with malware scanning (see README).
CREATE TABLE IF NOT EXISTS documents(
  id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES requests(id), revision INTEGER NOT NULL,
  kind TEXT NOT NULL, released INTEGER NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
  sha256 TEXT NOT NULL, data BLOB NOT NULL, uploaded_by INTEGER NOT NULL, uploaded_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS offers(
  id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES requests(id), surveyor_id INTEGER NOT NULL,
  status TEXT NOT NULL, distance_km REAL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
-- The database itself refuses a double booking: one surveyor, one date.
CREATE TABLE IF NOT EXISTS bookings(
  id INTEGER PRIMARY KEY, surveyor_id INTEGER NOT NULL, date TEXT NOT NULL, request_id INTEGER NOT NULL,
  UNIQUE(surveyor_id, date));
CREATE TABLE IF NOT EXISTS notifications(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, request_id INTEGER, message TEXT NOT NULL,
  ts INTEGER NOT NULL, is_read INTEGER NOT NULL DEFAULT 0, category TEXT NOT NULL DEFAULT 'system');
CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, actor TEXT NOT NULL, role TEXT NOT NULL, action TEXT NOT NULL,
  request_id INTEGER, detail TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL);
`;

// Adds columns introduced after the first version, so an older database file keeps working.
const ADDED = {
  users: [['email', 'TEXT'], ['phone', 'TEXT'], ['zone', 'TEXT'], ['nodal_centre', 'TEXT']],
  notifications: [['category', "TEXT NOT NULL DEFAULT 'system'"]],
  substations: [['zone', 'TEXT'], ['circle', 'TEXT'], ['nodal_centre', 'TEXT']],
  requests: [['nodal_centre', 'TEXT'], ['zone', 'TEXT'], ['priority', "TEXT NOT NULL DEFAULT 'Medium'"], ['survey_type', "TEXT NOT NULL DEFAULT 'Substation condition survey'"], ['prev_stage', 'TEXT'], ['return_note', 'TEXT'],
    ['sub', 'INTEGER NOT NULL DEFAULT 0'], ['backtrack_reason', 'TEXT'], ['backtrack_by', 'INTEGER'], ['backtrack_from', 'TEXT'], ['remarks', 'TEXT'], ['revision', 'INTEGER NOT NULL DEFAULT 0'], ['stage_due', 'TEXT'],
    ['overdue_notified', 'INTEGER NOT NULL DEFAULT 0'], ['date_proposed', 'INTEGER NOT NULL DEFAULT 1'], ['approved_at', 'INTEGER']],
};
function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON;');
  db.exec(SCHEMA);
  for (const [table, cols] of Object.entries(ADDED)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [name, type] of cols) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
  // Older files: copy the hierarchy onto requests that were created before it existed.
  db.exec(`UPDATE requests SET zone=(SELECT zone FROM substations s WHERE s.id=requests.substation_id),
    nodal_centre=(SELECT nodal_centre FROM substations s WHERE s.id=requests.substation_id) WHERE zone IS NULL AND nodal_centre IS NULL`);
  return db;
}

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
}

// Demo data only. Names are fictional; coordinates are around Bengaluru for the distance demo.
// Hierarchy: Zone > Circle > Division > Nodal Centre > Substation.  Chief = zone, EE = division, AEE = nodal centre, AE = substation.
const ZONE = 'Bengaluru Transmission Zone';
function seed(db, password) {
  const pw = hashPassword(password);
  const sub = db.prepare('INSERT INTO substations(name,division,lat,lon,zone,circle,nodal_centre) VALUES(?,?,?,?,?,?,?)');
  sub.run('220/66 kV Hebbal Substation', 'North Division', 13.0400, 77.5900, ZONE, 'Bengaluru North Circle', 'North Nodal Centre'); // id 1
  sub.run('220/66 kV Yelahanka Substation', 'North Division', 13.0200, 77.5200, ZONE, 'Bengaluru North Circle', 'North-East Nodal Centre'); // id 2
  sub.run('220/66 kV Banashankari Substation', 'South Division', 12.9000, 77.6000, ZONE, 'Bengaluru South Circle', 'South Nodal Centre'); // id 3
  sub.run('66/11 kV Jayanagar Substation', 'South Division', 12.8600, 77.6700, ZONE, 'Bengaluru South Circle', 'South-West Nodal Centre'); // id 4
  const u = db.prepare('INSERT INTO users(username,name,role,pw_hash,division,substation_id,available,lat,lon,email,phone,zone,nodal_centre) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const N = 'North Division', S = 'South Division';
  let n = 0; // fictional contact details: example.org addresses and a 90000 00xxx number series
  const add = (username, name, role, division, subId, avail, lat, lon, zone = null, nodal = null) => {
    n += 1;
    u.run(username, name, role, pw, division, subId, avail, lat, lon, `${username}@kptcl-demo.example.org`, `+91 90000 00${String(1000 + n).slice(1)}`, zone, nodal);
  };
  add('seit1', 'SEIT Office', 'SEIT', null, null, 0, null, null);
  add('chief1', 'Chief Bengaluru', 'CHIEF', null, null, 0, null, null, ZONE);
  add('ee_n', 'EE North', 'EE', N, null, 0, null, null, ZONE);
  add('ee_s', 'EE South', 'EE', S, null, 0, null, null, ZONE);
  add('aee_n', 'AEE North', 'AEE', N, null, 0, null, null, ZONE, 'North Nodal Centre');
  add('aee_s', 'AEE South', 'AEE', S, null, 0, null, null, ZONE, 'South Nodal Centre');
  add('ae_n1', 'AE Hebbal', 'AE', N, 1, 0, null, null, ZONE);
  add('ae_n2', 'AE Yelahanka', 'AE', N, 2, 0, null, null, ZONE);
  add('ae_s1', 'AE Banashankari', 'AE', S, 3, 0, null, null, ZONE);
  add('admin1', 'Admin', 'ADMIN', null, null, 0, null, null);
  add('pm1', 'Project Manager', 'PM', null, null, 0, null, null);
  add('coord1', 'Project Coordinator', 'COORD', null, null, 0, null, null);
  add('sur1', 'Surveyor 1', 'SURVEYOR', null, null, 1, 13.0300, 77.5800); // near Hebbal
  add('sur2', 'Surveyor 2', 'SURVEYOR', null, null, 1, 12.9200, 77.6100); // near Banashankari
  add('sur3', 'Surveyor 3', 'SURVEYOR', null, null, 1, 13.1000, 77.5500); // further north
  add('aee_n2', 'AEE North-East', 'AEE', N, null, 0, null, null, ZONE, 'North-East Nodal Centre');
  add('aee_s2', 'AEE South-West', 'AEE', S, null, 0, null, null, ZONE, 'South-West Nodal Centre');
  add('ae_s2', 'AE Jayanagar', 'AE', S, 4, 0, null, null, ZONE);
}

module.exports = { openDb, tx, seed };
