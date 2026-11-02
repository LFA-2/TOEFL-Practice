// TOEFL Coach API, runtime-independent: takes a web Request, returns a web Response.
// index.ts wires it to Deno (Supabase Edge Functions); test/dev-server.js wires it to Node for local testing.
//
// deps = {
//   getUser(token)  -> { id, email } | null     verifies a Supabase access token
//   runAs(uid, fn)  -> fn(query) in one transaction with RLS applied as that user
//   ai              -> makeAi(...) result
//   waitUntil(p)    -> keep the worker alive for background work
//   allowedOrigins  -> list of browser origins allowed by CORS ('*' = any)
// }
import { TASKS, SECTIONS } from './lib/tasks.js';
import { HttpError, AiError } from './lib/errors.js';
import * as bank from './lib/bank.js';
import * as plan from './lib/plan.js';
import * as skills from './lib/skills.js';
import * as vocab from './lib/vocab.js';
import { Json } from './lib/json.js';

// ---------- database wrapper ----------
// Parameters are sent untyped; queries cast them where the type matters.
function param(v) {
  if (v === undefined || v === null) return null;
  if (v instanceof Json) return v; // bound later by index.ts (or the test server) as jsonb
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return `{${v.map(x => (typeof x === 'number' ? x : `"${String(x).replace(/["\\]/g, '\\$&')}"`)).join(',')}}`;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

function makeDb(run) {
  const bound = query => {
    const db = {
      q: (text, params = []) => query(text, params.map(param)),
      one: async (text, params) => (await db.q(text, params))[0],
      tx: fn => fn(db), // already inside a transaction
    };
    return db;
  };
  return {
    q: (text, params = []) => run(query => query(text, params.map(param))),
    one: async (text, params = []) => (await run(query => query(text, params.map(param))))[0],
    tx: fn => run(query => fn(bound(query))),
  };
}

// ---------- helpers ----------
const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });

async function readJson(req) {
  const text = await req.text();
  if (text.length > 200_000) throw new HttpError(413, 'body too large');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'invalid JSON'); }
}

const QUOTA_MSG = '今天的 AI 次數已經用完了，明天再試。已經產生好的題目和單字卡仍然可以使用。';

export function createHandler(deps) {
  const userCache = new Map();     // token -> { user, exp }
  const approvedCache = new Map(); // uid -> exp (only approved users are cached)

  async function userFor(req) {
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token || token.split('.').length !== 3) return null; // the publishable key is not a user token
    const hit = userCache.get(token);
    if (hit && hit.exp > Date.now()) return hit.user;
    const user = await deps.getUser(token, req.headers.get('apikey'));
    if (userCache.size > 500) userCache.clear();
    if (user) userCache.set(token, { user, exp: Date.now() + 60_000 });
    return user;
  }

  function context(uid) {
    const db = makeDb(fn => deps.runAs(uid, fn));
    const ctx = {
      uid,
      db,
      ai: deps.ai,
      async charge() {
        try {
          await db.q('select public.consume_ai_call()');
        } catch (e) {
          if (/AI_QUOTA_GLOBAL/.test(e.message)) throw new HttpError(429, '今天全站的 AI 次數已經用完了，明天再試。');
          if (/AI_QUOTA/.test(e.message)) throw new HttpError(429, QUOTA_MSG);
          if (/NOT_APPROVED/.test(e.message)) throw new HttpError(403, '帳號尚未核准。');
          throw e;
        }
      },
      // Work that continues after the response (generation, refills). Errors are logged, not shown.
      bg(fn) {
        const p = Promise.resolve().then(() => fn(context(uid))).catch(e => console.error('[background]', e.message));
        deps.waitUntil(p);
        return p;
      },
    };
    return ctx;
  }

  async function isApproved(ctx) {
    const exp = approvedCache.get(ctx.uid);
    if (exp && exp > Date.now()) return true;
    const row = await ctx.db.one('select approved from public.profiles where id = $1', [ctx.uid]);
    if (row?.approved) approvedCache.set(ctx.uid, Date.now() + 60_000);
    return !!row?.approved;
  }

  const routes = {
    'GET /meta': () => ({ tasks: TASKS, sections: SECTIONS }),

    'GET /today': async ctx => {
      const [p, estimates, vocabSettings] = await ctx.db.tx(async db =>
        [await plan.getPlan(db), await skills.estimates(db), await vocab.settings(db)]);
      return { plan: p, estimates, vocabSettings };
    },

    'GET /next': async (ctx, url) => {
      const type = url.searchParams.get('type');
      if (!TASKS[type]) throw new HttpError(400, 'unknown type');
      const exclude = (url.searchParams.get('exclude') || '').split(',').filter(Boolean).map(Number);
      const item = await bank.nextItem(ctx, type, exclude);
      if (!item) throw new HttpError(503, '題庫沒有可用的題目，而且無法產生新題。');
      return item;
    },

    'POST /submit': async (ctx, url, body) => bank.submit(ctx, {
      itemId: Number(body.itemId),
      response: body.response || {},
      seconds: Number(body.seconds) || 0,
      mode: body.mode === 'diagnostic' ? 'diagnostic' : 'practice',
    }),

    'GET /attempt': async (ctx, url) => {
      const a = await bank.getAttempt(ctx.db, Number(url.searchParams.get('id')));
      if (!a) throw new HttpError(404, 'not found');
      return a;
    },

    // Past email / academic discussion answers with their grading, newest first.
    'GET /writing': (ctx, url) => {
      const t = url.searchParams.get('type');
      const types = t === 'email' || t === 'disc' ? [t] : ['email', 'disc'];
      const before = Number(url.searchParams.get('before')) || null;
      return ctx.db.tx(async db => ({
        ...(await bank.writingHistory(db, { types, before, limit: 20 })),
        // only needed for the first page
        stats: before ? null : await bank.writingStats(db, ['email', 'disc']),
        target: before ? null : (await plan.settings(db)).target,
      }));
    },

    'GET /dashboard': ctx => ctx.db.tx(async db => ({
      estimates: await skills.estimates(db),
      history: await db.q('select type, rating, day from public.skill_history order by id'),
      daily: await db.q('select day, count(*)::int as n, coalesce(sum(seconds), 0)::int as secs from public.attempts group by day order by day desc limit 30'),
      recent: await bank.history(db, 30),
      stock: await bank.stock(db),
      settings: await plan.settings(db),
      usage: (await db.one('select public.ai_quota_status() as s')).s,
    })),

    // ---------- vocabulary ----------
    'GET /vocab/screen': ctx => vocab.screenBatch(ctx, 20),
    'POST /vocab/mark': (ctx, url, b) => vocab.mark(ctx, Number(b.id), String(b.how)),
    'GET /vocab/review': ctx => vocab.reviewQueue(ctx, 30),
    'GET /vocab/quiz': (ctx, url) =>
      vocab.freeQuiz(ctx, Math.min(50, Math.max(5, Number(url.searchParams.get('n')) || 20)), url.searchParams.get('hard') === '1'),
    'POST /vocab/grade': (ctx, url, b) => vocab.grade(ctx, Number(b.id), b.mode === 'type' ? 'type' : 'choice', String(b.result), b.free === true),
    'GET /vocab/list': (ctx, url) => ctx.db.tx(async db => ({
      words: await vocab.list(db, { status: url.searchParams.get('status') === 'known' ? 'known' : 'learning', q: url.searchParams.get('q') || '',
        onlyHard: url.searchParams.get('hard') === '1' }),
      stats: await vocab.stats(db),
    })),

    'POST /settings': (ctx, url, b) => ctx.db.tx(async db => {
      if (b.vocabNewPerDay !== undefined) {
        await vocab.saveSettings(db, { newPerDay: Math.min(150, Math.max(5, Math.round(Number(b.vocabNewPerDay)) || 60)) });
      }
      const s = await plan.settings(db);
      const next = {
        examDate: /^\d{4}-\d{2}-\d{2}$/.test(b.examDate) ? b.examDate : s.examDate,
        target: Math.min(6, Math.max(1, Number(b.target) || s.target)),
        minutesWeekday: Math.min(300, Math.max(15, Number(b.minutesWeekday) || s.minutesWeekday)),
        minutesWeekend: Math.min(300, Math.max(15, Number(b.minutesWeekend) || s.minutesWeekend)),
      };
      await plan.saveSettings(db, next);
      await plan.resetToday(db);
      return { ...next, vocabNewPerDay: (await vocab.settings(db)).newPerDay };
    }),
  };

  function corsHeaders(req) {
    const origin = req.headers.get('origin') || '';
    const allowed = deps.allowedOrigins.includes('*') || deps.allowedOrigins.includes(origin);
    return {
      'access-control-allow-origin': allowed ? origin || '*' : deps.allowedOrigins[0] || '',
      'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-max-age': '86400',
      vary: 'origin',
    };
  }

  return async function handle(req) {
    const cors = corsHeaders(req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    // The function is mounted at .../functions/v1/api; keep only what follows "/api".
    const path = url.pathname.replace(/^.*?\/api(?=\/|$)/, '') || '/';
    const key = `${req.method} ${path}`;
    try {
      const user = await userFor(req);
      if (key === 'GET /me') {
        if (!user) return json(200, { authed: false }, cors);
        const mctx = context(user.id);
        const approved = await isApproved(mctx);
        const usage = approved ? (await mctx.db.one('select public.ai_quota_status() as s')).s : null;
        return json(200, { authed: true, email: user.email, approved, usage }, cors);
      }
      const handler = routes[key];
      if (!handler) return json(404, { error: 'not found' }, cors);
      if (!user) return json(401, { error: 'login required' }, cors);
      const ctx = context(user.id);
      if (!(await isApproved(ctx))) return json(403, { error: '帳號尚未核准。', pending: true }, cors);
      const body = req.method === 'POST' ? await readJson(req) : {};
      return json(200, await handler(ctx, url, body), cors);
    } catch (e) {
      const status = e.status || (e instanceof AiError ? 502 : 500);
      if (status >= 500) console.error(`[${key}]`, e);
      return json(status, { error: status === 500 ? `伺服器錯誤：${e.message}` : e.message || 'error' }, cors);
    }
  };
}
