'use strict';
const { sha256 } = require('./security');

// Append-only, hash-chained log: each entry commits to the one before it,
// so editing or deleting an old row is detectable.
function append(db, { actor, role, action, requestId = null, detail = {} }) {
  const last = db.prepare('SELECT hash FROM audit ORDER BY id DESC LIMIT 1').get();
  const prev = last ? last.hash : 'GENESIS';
  const ts = Date.now();
  const d = JSON.stringify(detail);
  const hash = sha256([prev, ts, actor, role, action, requestId ?? '', d].join('|'));
  db.prepare('INSERT INTO audit(ts,actor,role,action,request_id,detail,prev_hash,hash) VALUES(?,?,?,?,?,?,?,?)')
    .run(ts, actor, role, action, requestId, d, prev, hash);
}

function verify(db) {
  const rows = db.prepare('SELECT * FROM audit ORDER BY id').all();
  let prev = 'GENESIS';
  for (const r of rows) {
    const expect = sha256([prev, r.ts, r.actor, r.role, r.action, r.request_id ?? '', r.detail].join('|'));
    if (r.prev_hash !== prev || r.hash !== expect) return { ok: false, checked: rows.length, brokenAtId: r.id };
    prev = r.hash;
  }
  return { ok: true, checked: rows.length, brokenAtId: null };
}

function forRequest(db, requestId) {
  return db.prepare('SELECT ts,actor,role,action,detail FROM audit WHERE request_id=? ORDER BY id').all(requestId)
    .map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
}

function recent(db, limit = 200) {
  return db.prepare('SELECT id,ts,actor,role,action,request_id,detail FROM audit ORDER BY id DESC LIMIT ?').all(limit)
    .map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
}

module.exports = { append, verify, forRequest, recent };
