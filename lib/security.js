'use strict';
const crypto = require('node:crypto');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// Password hashing: scrypt with a per-password random salt, constant-time compare.
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64);
  return `s1$${salt.toString('hex')}$${h.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [v, s, h] = String(stored).split('$');
  if (v !== 's1' || !s || !h) return false;
  const calc = crypto.scryptSync(String(pw), Buffer.from(s, 'hex'), 64);
  const exp = Buffer.from(h, 'hex');
  return exp.length === calc.length && crypto.timingSafeEqual(calc, exp);
}
// Used so that "unknown user" takes as long as "wrong password".
const DUMMY_HASH = hashPassword('dummy-password-for-timing-only');

function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters.';
  if (pw.length > 128) return 'Password is too long.';
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/\d/.test(pw)) return 'Password needs upper-case, lower-case and a digit.';
  return null;
}

const newToken = () => crypto.randomBytes(32).toString('hex');

// Simple in-memory sliding-window limiter (production: shared store / gateway).
function makeLimiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    arr.push(now);
    hits.set(key, arr);
    return arr.length <= max;
  };
}

// India Standard Time "today" (the system stores and shows IST dates).
const todayISO = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const isoDate = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; // rejects 2026-13-45, 2026-02-31
};
const isFutureDate = (s) => isoDate(s) && s > todayISO();
const addDaysISO = (iso, n) => new Date(new Date(iso + 'T00:00:00Z').getTime() + n * 86400e3).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400e3);
// A rejected LC keeps its number but is shown as revised: SR-1003 -> "SR-1003 (Revised)", then "(Revised 2)".
const dispCode = (code, revision) => (revision > 0 ? `${code} (Revised${revision > 1 ? ' ' + revision : ''})` : code);
const emailOk = (v) => typeof v === 'string' && v.length <= 120 && /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(v);
const phoneOk = (v) => typeof v === 'string' && /^\+?[0-9][0-9 ]{6,16}$/.test(v);

function str(v, min, max, field = 'Value') {
  if (typeof v !== 'string') throw new HttpError(400, `${field} is required.`);
  const t = v.trim();
  if (t.length < min || t.length > max) throw new HttpError(400, `${field} must be ${min}-${max} characters.`);
  return t;
}
function int(v, field = 'Value') {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${field} is invalid.`);
  return n;
}

module.exports = {
  HttpError, sha256, hashPassword, verifyPassword, DUMMY_HASH, passwordProblem,
  newToken, makeLimiter, todayISO, isoDate, isFutureDate, addDaysISO, daysBetween, dispCode, emailOk, phoneOk, str, int,
};
