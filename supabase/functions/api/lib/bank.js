// Item bank: adaptive selection, on-demand generation, attempt recording.
// Items are shared by all approved users; attempts are private (RLS).
import { TASKS, scoreObjective, publicContent } from './tasks.js';
import * as skills from './skills.js';
import { today } from './time.js';
import { tryLock, unlock, sleep } from './store.js';
import { HttpError } from './errors.js';
import { json } from './json.js';

const REUSE_AFTER_DAYS = 30;
const STRETCH = 0.25;   // aim slightly above current ability
const STOCK_PER_TYPE = 2; // unseen items kept near the learner's level (each refill costs one AI call)

const roundHalf = x => Math.round(x * 2) / 2;
const bandFor = target => Math.min(6, Math.max(1, roundHalf(target)));

export async function insertItems(db, type, difficulty, contents, source = 'ai') {
  const rows = await db.q(`insert into public.items (type, difficulty, content, source)
                           select $1, $2::float8, x, $3 from jsonb_array_elements($4::jsonb) as x
                           returning id`, [type, difficulty, source, json(contents)]);
  return rows.map(r => r.id);
}

async function candidates(db, type, target, excludeIds = []) {
  return db.q(`
    select i.id, i.difficulty, abs(i.difficulty - $1::float8) as dist
    from public.items i
    where i.type = $2 and not (i.id = any($3::int[]))
      and not exists (select 1 from public.attempts a where a.item_id = i.id
                      and a.created_at > now() - interval '${REUSE_AFTER_DAYS} days')
    order by dist asc, random()
    limit 10`, [target, type, excludeIds.map(Number).filter(Number.isFinite)]);
}

async function getItem(db, id) {
  return db.one('select id, type, difficulty, content, source from public.items where id = $1', [id]);
}

function toPublic(item) {
  return { id: item.id, type: item.type, difficulty: item.difficulty, content: publicContent(item.type, item.content) };
}

// Generates items for this type, unless another request of this user is already doing it.
async function generateFor(ctx, type, band) {
  const lock = `gen:${type}`;
  if (!(await tryLock(ctx.db, lock, 150))) return false;
  try {
    const contents = await ctx.ai.generate(type, band, ctx.charge);
    await insertItems(ctx.db, type, band, contents);
    return true;
  } finally {
    await unlock(ctx.db, lock);
  }
}

// Pick the next item for this type. Generates one on demand if nothing suitable is left.
export async function nextItem(ctx, type, excludeIds = []) {
  if (!TASKS[type]) throw new HttpError(400, 'unknown type');
  const target = (await skills.getSkill(ctx.db, type)).rating + STRETCH;
  let c = await candidates(ctx.db, type, target, excludeIds);
  if (!c.length || c[0].dist > 0.75) {
    try {
      const started = await generateFor(ctx, type, bandFor(target));
      // someone else is generating: wait for it rather than paying twice
      for (let i = 0; !started && !c.length && i < 45; i++) {
        await sleep(2000);
        c = await candidates(ctx.db, type, target, excludeIds);
      }
      c = await candidates(ctx.db, type, target, excludeIds);
    } catch (e) {
      if (!c.length) throw e; // fall back to a less well matched item if we have one
    }
  }
  if (!c.length) return null;
  return toPublic(await getItem(ctx.db, c[0].id));
}

// Keep a couple of unseen items near the learner's level so the next session starts instantly.
// At most one AI call per run, because every call counts against the daily quota.
export async function topUp(ctx, type) {
  const target = (await skills.getSkill(ctx.db, type)).rating + STRETCH;
  const near = (await candidates(ctx.db, type, target)).filter(c => c.dist <= 0.75).length;
  if (near < STOCK_PER_TYPE) await generateFor(ctx, type, bandFor(target));
}

function explainObjective(item, result) {
  const c = item.content;
  if (item.type === 'rdl' || item.type === 'acad') {
    return c.questions.map((q, i) => ({ ...result.detail[i], explain_zh: q.explain_zh, options: q.options, q: q.q }));
  }
  if (item.type === 'bas') return [{ ...result.detail[0], explain_zh: c.explain_zh || '' }];
  return result.detail;
}

export async function submit(ctx, { itemId, response, seconds, mode = 'practice' }) {
  const item = await getItem(ctx.db, itemId);
  if (!item) throw new HttpError(404, 'item not found');
  const type = item.type;
  let result, feedback;
  if (TASKS[type].ai) {
    const text = String(response.text || '');
    feedback = await ctx.ai.grade(type, item.content, text, seconds || 0, text.trim() ? ctx.charge : null);
    const raw = roundHalf(feedback.score);
    result = { score: raw / 5, raw, max: 5 };
  } else {
    result = scoreObjective(type, item.content, response);
    feedback = { detail: explainObjective(item, result) };
  }
  const before = (await skills.getSkill(ctx.db, type)).rating;
  const rating = await skills.update(ctx.db, type, item.difficulty, result);
  const row = await ctx.db.one(`insert into public.attempts (item_id, type, mode, response, score, raw_score, max_score, feedback, seconds, day)
                                values ($1, $2, $3, $4::jsonb, $5::float8, $6::float8, $7::float8, $8::jsonb, $9::int, $10)
                                returning id`,
    [itemId, type, mode, json(response), result.score, result.raw, result.max,
      json(feedback), Math.round(seconds || 0), today()]);
  ctx.bg(c => topUp(c, type)); // refill after the response is sent
  return { attemptId: row.id, type, score: result.score, raw: result.raw, max: result.max, feedback, rating, before };
}

export async function getAttempt(db, id) {
  const a = await db.one(`select id, item_id, type, mode, response, score, raw_score, max_score, feedback, seconds, day
                          from public.attempts where id = $1`, [id]);
  if (!a) return null;
  const item = await getItem(db, a.item_id);
  return { ...a, item: { id: item.id, type: item.type, difficulty: item.difficulty, content: publicContent(item.type, item.content) } };
}

export async function history(db, limit = 50) {
  return db.q(`select id, type, score, raw_score, max_score, seconds, day
               from public.attempts order by id desc limit $1::int`, [limit]);
}

export async function stock(db) {
  return db.q(`select type, count(*)::int as total,
                 (count(*) filter (where not exists (select 1 from public.attempts a where a.item_id = i.id)))::int as unseen
               from public.items i group by type`);
}
