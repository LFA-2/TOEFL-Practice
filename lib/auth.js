// Single-user password login with an HMAC-signed cookie.
const crypto = require('node:crypto');
const config = require('./config');
const { getSetting, setSetting } = require('./db');

const COOKIE = 'toefl_session';
const MAX_AGE = 180 * 24 * 3600; // seconds

function secret() {
  if (config.sessionSecret) return config.sessionSecret;
  let s = getSetting('session_secret');
  if (!s) { s = crypto.randomBytes(32).toString('hex'); setSetting('session_secret', s); }
  return s;
}

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

function makeToken() {
  const payload = `v1.${Math.floor(Date.now() / 1000) + MAX_AGE}`;
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (!token) return false;
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const payload = token.slice(0, i);
  const sig = Buffer.from(token.slice(i + 1));
  const expect = Buffer.from(sign(payload));
  if (sig.length !== expect.length || !crypto.timingSafeEqual(sig, expect)) return false;
  const exp = Number(payload.split('.')[1]);
  return exp > Date.now() / 1000;
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(p => p.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}

function isAuthed(req) {
  if (!config.password) return true; // no password configured: open (local dev only)
  return verifyToken(parseCookies(req.headers.cookie)[COOKIE]);
}

// naive brute-force protection: 10 failures per 15 minutes per IP
const failures = new Map();
function checkPassword(ip, password) {
  const now = Date.now();
  const f = (failures.get(ip) || []).filter(t => now - t < 15 * 60_000);
  if (f.length >= 10) return { ok: false, locked: true };
  const a = Buffer.from(String(password || ''));
  const b = Buffer.from(config.password);
  const ok = config.password !== '' && a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) { f.push(now); failures.set(ip, f); }
  return { ok, locked: false };
}

function cookieHeader(req, value, maxAge) {
  const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted;
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

module.exports = { isAuthed, checkPassword, makeToken, cookieHeader, MAX_AGE };
