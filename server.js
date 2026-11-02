#!/usr/bin/env node
// TOEFL Coach — zero-dependency server (Node >= 22.13).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./lib/config');
const { setSetting, db } = require('./lib/db');
const auth = require('./lib/auth');
const bank = require('./lib/bank');
const plan = require('./lib/plan');
const skills = require('./lib/skills');
const { TASKS, SECTIONS } = require('./lib/tasks');
const { AiError } = require('./lib/ai');
const { seedIfEmpty } = require('./lib/seed');
const vocab = require('./lib/vocab');

const PUBLIC = path.join(config.root, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
};

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(data);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 200_000) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
}

function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'forbidden' });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
  const ext = path.extname(file);
  const st = fs.statSync(file);
  const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  // Code and styles are always revalidated, so a `git pull` + restart reaches every browser at once.
  // Icons rarely change and may be cached for a day.
  const headers = {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': ext === '.png' ? 'public, max-age=86400' : 'no-cache',
    etag,
    'x-content-type-options': 'nosniff',
  };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

const routes = {
  'GET /api/me': (req) => ({ authed: auth.isAuthed(req), needsPassword: !!config.password }),

  'POST /api/login': async (req, res) => {
    const { password } = await readJson(req);
    const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress;
    const r = auth.checkPassword(ip, password);
    if (r.locked) return send(res, 429, { error: '嘗試次數過多，請 15 分鐘後再試。' });
    if (!r.ok) return send(res, 401, { error: '密碼不正確。' });
    send(res, 200, { ok: true }, { 'set-cookie': auth.cookieHeader(req, auth.makeToken(), auth.MAX_AGE) });
  },

  'POST /api/logout': (req, res) => send(res, 200, { ok: true }, { 'set-cookie': auth.cookieHeader(req, '', 0) }),

  'GET /api/meta': () => ({ tasks: TASKS, sections: SECTIONS }),

  'GET /api/today': () => ({ plan: plan.getPlan(), estimates: skills.estimates(), vocabSettings: vocab.settings() }),

  'GET /api/next': async (req, res, url) => {
    const type = url.searchParams.get('type');
    if (!TASKS[type]) return send(res, 400, { error: 'unknown type' });
    const exclude = (url.searchParams.get('exclude') || '').split(',').filter(Boolean).map(Number);
    const item = await bank.nextItem(type, exclude);
    if (!item) return send(res, 503, { error: '題庫沒有可用的題目，而且無法產生新題。' });
    return item;
  },

  'POST /api/submit': async (req) => {
    const body = await readJson(req);
    return bank.submit({
      itemId: Number(body.itemId),
      response: body.response || {},
      seconds: Number(body.seconds) || 0,
      mode: body.mode === 'diagnostic' ? 'diagnostic' : 'practice',
    });
  },

  'GET /api/attempt': (req, res, url) => {
    const a = bank.getAttempt(Number(url.searchParams.get('id')));
    return a || send(res, 404, { error: 'not found' });
  },

  'GET /api/dashboard': () => {
    const est = skills.estimates();
    const hist = db.prepare('SELECT type, rating, day FROM skill_history ORDER BY id').all();
    const daily = db.prepare(`SELECT day, COUNT(*) n, SUM(seconds) secs FROM attempts GROUP BY day ORDER BY day DESC LIMIT 30`).all();
    return { estimates: est, history: hist, daily, recent: bank.history(30), stock: bank.stock(), settings: plan.settings() };
  },

  // ---------- vocabulary ----------
  'GET /api/vocab/screen': () => vocab.screenBatch(20),

  'POST /api/vocab/mark': async (req) => {
    const b = await readJson(req);
    return vocab.mark(Number(b.id), String(b.how));
  },

  'GET /api/vocab/review': () => vocab.reviewQueue(30),

  'POST /api/vocab/grade': async (req) => {
    const b = await readJson(req);
    return vocab.grade(Number(b.id), b.mode === 'spell' ? 'spell' : 'recall', String(b.result));
  },

  'GET /api/vocab/list': (req, res, url) => ({
    words: vocab.list({ status: url.searchParams.get('status') === 'known' ? 'known' : 'learning', q: url.searchParams.get('q') || '' }),
    stats: vocab.stats(),
  }),

  'POST /api/settings': async (req, res) => {
    const b = await readJson(req);
    if (b.vocabNewPerDay !== undefined) {
      vocab.saveSettings({ newPerDay: Math.min(150, Math.max(5, Math.round(Number(b.vocabNewPerDay)) || 60)) });
    }
    const s = plan.settings();
    const next = {
      examDate: /^\d{4}-\d{2}-\d{2}$/.test(b.examDate) ? b.examDate : s.examDate,
      target: Math.min(6, Math.max(1, Number(b.target) || s.target)),
      minutesWeekday: Math.min(300, Math.max(15, Number(b.minutesWeekday) || s.minutesWeekday)),
      minutesWeekend: Math.min(300, Math.max(15, Number(b.minutesWeekend) || s.minutesWeekend)),
    };
    setSetting('plan', next);
    plan.resetToday();
    return { ...next, vocabNewPerDay: vocab.settings().newPerDay };
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const key = `${req.method} ${url.pathname}`;
  try {
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
    const handler = routes[key];
    if (!handler) return send(res, 404, { error: 'not found' });
    const open = key === 'GET /api/me' || key === 'POST /api/login';
    if (!open && !auth.isAuthed(req)) return send(res, 401, { error: 'login required' });
    const out = await handler(req, res, url);
    if (out !== undefined && !res.headersSent) send(res, 200, out);
  } catch (e) {
    if (res.headersSent) return res.end();
    const status = e.status || (e instanceof AiError ? 502 : 500);
    if (status >= 500) console.error(`[${key}]`, e);
    send(res, status, { error: e.message || 'server error' });
  }
});

seedIfEmpty();
server.listen(config.port, config.host, () => {
  console.log(`TOEFL Coach listening on http://${config.host}:${config.port}`);
  if (!config.password) console.warn('WARNING: APP_PASSWORD is not set — anyone who can reach this port can use the app.');
  if (!config.anthropicKey && !config.aiMock) console.warn('WARNING: ANTHROPIC_API_KEY is not set — only the built-in starter items work.');
});
