// Local stand-in for Supabase, for testing without an internet connection:
//   - serves public/ (with a config.js pointing at this server)
//   - fakes the Supabase Auth endpoints the app uses (signup, password login, refresh, user, logout)
//   - runs the real Edge Function handler (supabase/functions/api/app.js) against a local Postgres
//
// Needs a local Postgres with test/supabase-shim.sql and the migrations applied.
// Usage: PGSOCKET=/path/to/socket/.s.PGSQL.5432 PGDATABASE=toefl PORT=3999 [AI_MOCK=1 | AI_BASE=http://...] node test/dev-server.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHandler } from '../supabase/functions/api/app.js';
import { makeAi } from '../supabase/functions/api/lib/ai.js';

const require = createRequire(import.meta.url);
const { connect } = require('./pg-mini.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3999);
const BASE = `http://127.0.0.1:${PORT}`;
const pgOpts = { socketPath: process.env.PGSOCKET, database: process.env.PGDATABASE || 'toefl' };

async function asSuper(text, params = []) {
  const c = await connect(pgOpts);
  try { return await c.query(text, params); } finally { c.end(); }
}

async function runAs(uid, fn) {
  const c = await connect(pgOpts);
  try {
    await c.simple('begin');
    await c.query(`select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)`,
      [JSON.stringify({ sub: uid, role: 'authenticated' })]);
    const out = await fn((text, params) => c.query(text, params));
    await c.simple('commit');
    return out;
  } catch (e) {
    await c.simple('rollback').catch(() => {});
    throw e;
  } finally { c.end(); }
}

// ---------- fake auth ----------
const tokens = new Map();  // access token -> { id, email, exp }
const refresh = new Map(); // refresh token -> { id, email }
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
function session(user) {
  const exp = Math.floor(Date.now() / 1000) + Number(process.env.TOKEN_TTL || 3600);
  const access = `${b64({ alg: 'none' })}.${b64({ sub: user.id, email: user.email, exp })}.sig${Math.random().toString(36).slice(2)}`;
  const rt = Math.random().toString(36).slice(2);
  tokens.set(access, { ...user, exp });
  refresh.set(rt, user);
  return { access_token: access, token_type: 'bearer', expires_in: exp - Math.floor(Date.now() / 1000), expires_at: exp, refresh_token: rt, user: { id: user.id, email: user.email } };
}

async function authRoute(req, url, body) {
  const p = url.pathname.replace('/auth/v1', '');
  if (req.method === 'POST' && p === '/signup') {
    const email = String(body.email || '').toLowerCase();
    if (String(body.password || '').length < 6) return [422, { code: 422, error_code: 'weak_password', msg: 'Password should be at least 6 characters.' }];
    const exists = await asSuper('select id from auth.users where email = $1', [email]);
    if (exists.length) return [422, { code: 422, error_code: 'user_already_exists', msg: 'User already registered' }];
    const [u] = await asSuper('insert into auth.users (email, encrypted_password) values ($1, $2) returning id, email', [email, body.password]);
    if (process.env.CONFIRM_EMAIL === '1') return [200, { id: u.id, email: u.email, confirmation_sent_at: new Date().toISOString() }];
    return [200, session(u)];
  }
  if (req.method === 'POST' && p === '/token') {
    const grant = url.searchParams.get('grant_type');
    if (grant === 'password') {
      const [u] = await asSuper('select id, email from auth.users where email = $1 and encrypted_password = $2', [String(body.email || '').toLowerCase(), body.password]);
      if (!u) return [400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' }];
      return [200, session(u)];
    }
    if (grant === 'refresh_token') {
      const u = refresh.get(body.refresh_token);
      if (!u) return [400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' }];
      refresh.delete(body.refresh_token);
      return [200, session(u)];
    }
  }
  if (req.method === 'GET' && p === '/user') {
    const t = tokens.get((req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!t || t.exp < Date.now() / 1000) return [401, { code: 401, msg: 'invalid JWT' }];
    return [200, { id: t.id, email: t.email }];
  }
  if (req.method === 'POST' && p === '/logout') {
    tokens.delete((req.headers.authorization || '').replace(/^Bearer /, ''));
    return [204, null];
  }
  return [404, { msg: 'not found' }];
}

// ---------- the real handler ----------
const pending = new Set();
const handle = createHandler({
  getUser: async token => { const t = tokens.get(token); return t && t.exp > Date.now() / 1000 ? { id: t.id, email: t.email } : null; },
  runAs,
  ai: makeAi({ aiMock: process.env.AI_MOCK === '1', anthropicKey: process.env.AI_BASE ? 'test-key' : '', apiBase: process.env.AI_BASE || '' }),
  waitUntil: p => { pending.add(p); p.finally(() => pending.delete(p)); },
  allowedOrigins: ['*'],
});

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  try {
    if (url.pathname.startsWith('/functions/v1/api')) {
      const r = await handle(new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw }));
      res.writeHead(r.status, Object.fromEntries(r.headers));
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, apikey, content-type' };
    if (url.pathname.startsWith('/auth/v1')) {
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
      const [status, body] = await authRoute(req, url, raw ? JSON.parse(raw) : {});
      res.writeHead(status, { 'content-type': 'application/json', ...cors });
      return res.end(body === null ? '' : JSON.stringify(body));
    }
    // test helpers
    if (url.pathname === '/dev/approve') {
      await asSuper('update public.profiles set approved = true where email = $1', [url.searchParams.get('email')]);
      res.writeHead(200); return res.end('ok');
    }
    if (url.pathname === '/dev/idle') { // wait for background work to finish
      while (pending.size) await Promise.allSettled([...pending]);
      res.writeHead(200); return res.end('idle');
    }
    if (url.pathname === '/config.js') {
      res.writeHead(200, { 'content-type': MIME['.js'] });
      return res.end(`window.TOEFL_CONFIG = { supabaseUrl: '${BASE}', publishableKey: 'sb_publishable_local' };\n`);
    }
    let file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    res.writeHead(500); res.end(String(e.message));
  }
}).listen(PORT, '127.0.0.1', () => console.log(`dev server on ${BASE}`));
