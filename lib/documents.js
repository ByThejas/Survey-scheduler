'use strict';
const crypto = require('node:crypto');
const { HttpError, str } = require('./security');

// Files arrive as base64 inside JSON (the API stays JSON-only). Each file is checked three ways:
// the extension must be on the allow-list, the first bytes must match that type, and the size is capped.
const MAX_FILES = 4;
const MAX_BYTES = 2 * 1024 * 1024;
const TYPES = {
  pdf:  { mime: 'application/pdf', magic: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  png:  { mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47] },
  jpg:  { mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  jpeg: { mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', magic: [0x50, 0x4b, 0x03, 0x04] },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', magic: [0x50, 0x4b, 0x03, 0x04] },
};
const BODY_LIMIT = MAX_FILES * Math.ceil((MAX_BYTES * 4) / 3) + 100e3; // routes that take files

const cleanName = (n) => String(n).split(/[\\/]/).pop().replace(/[^A-Za-z0-9._() -]/g, '_').replace(/^\.+/, '').slice(0, 120);

// Validates and decodes. Throws a 400 with a plain message; never stores anything.
function parseFiles(files) {
  if (files === undefined || files === null) return [];
  if (!Array.isArray(files)) throw new HttpError(400, 'Files must be a list.');
  if (files.length > MAX_FILES) throw new HttpError(400, `You can attach up to ${MAX_FILES} files at a time.`);
  return files.map((f) => {
    if (!f || typeof f !== 'object') throw new HttpError(400, 'Invalid file.');
    const name = cleanName(str(f.name, 1, 200, 'File name'));
    const ext = (name.split('.').pop() || '').toLowerCase();
    const type = TYPES[ext];
    if (!name.includes('.') || !type) throw new HttpError(400, `"${name}": only PDF, PNG, JPG, DOCX and XLSX files are accepted.`);
    if (typeof f.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(f.data)) throw new HttpError(400, `"${name}": the file could not be read.`);
    const data = Buffer.from(f.data, 'base64');
    if (!data.length) throw new HttpError(400, `"${name}" is empty.`);
    if (data.length > MAX_BYTES) throw new HttpError(400, `"${name}" is larger than ${MAX_BYTES / 1024 / 1024} MB.`);
    if (!type.magic.every((b, i) => data[i] === b)) throw new HttpError(400, `"${name}" does not look like a real ${ext.toUpperCase()} file.`);
    return { name, mime: type.mime, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex'), data };
  });
}

// kind: 'LC' (coordinator's LC pack, seen by the whole chain) or 'AE_DOCS' (AE's substation documents).
// released: 0 = only the uploader's side, 1 = AEE and EE (during review), 2 = every authority (after loop 1).
function store(db, req, user, kind, parsed, released) {
  const ins = db.prepare(`INSERT INTO documents(request_id,revision,kind,released,name,mime,size,sha256,data,uploaded_by,uploaded_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  for (const f of parsed) ins.run(req.id, req.revision, kind, released, f.name, f.mime, f.size, f.sha256, f.data, user.id, Date.now());
  return parsed.length;
}

function release(db, req, from, to) {
  db.prepare("UPDATE documents SET released=? WHERE request_id=? AND revision=? AND kind='AE_DOCS' AND released=?").run(to, req.id, req.revision, from);
}

const countCurrent = (db, req, kind) =>
  db.prepare('SELECT COUNT(*) AS n FROM documents WHERE request_id=? AND revision=? AND kind=?').get(req.id, req.revision, kind).n;

// Who may open a document. The caller has already checked that the user may see the request itself.
function canOpen(user, req, doc) {
  if (user.role === 'SURVEYOR') return req.surveyor_id === user.id && doc.released >= 2;
  if (doc.kind === 'LC') return true;
  if (user.role === 'AE') return true; // AEs only ever see requests of their own substation
  if (user.role === 'AEE' || user.role === 'EE') return doc.released >= 1;
  return doc.released >= 2; // Chief, SEIT, Coordinator, PM
}

function listFor(db, user, req) {
  const rows = db.prepare(`SELECT d.id,d.revision,d.kind,d.released,d.name,d.size,d.uploaded_at,u.name AS by_name,u.role AS by_role
    FROM documents d JOIN users u ON u.id=d.uploaded_by WHERE d.request_id=? ORDER BY d.id`).all(req.id);
  return rows.filter((d) => canOpen(user, req, d)).map((d) => ({
    id: d.id, name: d.name, size: d.size, kind: d.kind, revision: d.revision, current: d.revision === req.revision,
    uploaded_by: d.by_name, uploaded_role: d.by_role, uploaded_at: d.uploaded_at,
  }));
}

module.exports = { MAX_FILES, MAX_BYTES, BODY_LIMIT, parseFiles, store, release, countCurrent, canOpen, listFor };
