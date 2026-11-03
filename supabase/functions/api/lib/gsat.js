// 學測翻譯: past papers and new sets, scored by the 大考中心 rules, with tutor-style feedback,
// follow-up questions and a phrase book reviewed with spaced repetition.
// Rows are scoped to the signed-in user by RLS; sets are shared in public.items (type 'gsat').
import { today, addDays, daysBetween } from './time.js';
import { getSetting, setSetting, tryLock, unlock } from './store.js';
import { HttpError } from './errors.js';
import { json } from './json.js';

export const MAX_PER_SENTENCE = 4;
const PART_POINTS = 2;
const DEDUCT = 0.5;
const REVIEW_BELOW = 7;       // sets scored under 7/8 come back for review
const REVIEW_AFTER_DAYS = 3;
const ASK_LIMIT = 8;          // follow-up questions per graded answer
export const PHRASE_STEPS = [1, 2, 4, 7, 14, 21, 45, 90];

const DEFAULTS = { timerMinutes: 0, dailySets: 2 };
export async function settings(db) { return { ...DEFAULTS, ...(await getSetting(db, 'gsat', {})) }; }
export async function saveSettings(db, b) {
  const s = await settings(db);
  const next = {
    timerMinutes: b.timerMinutes === undefined ? s.timerMinutes : Math.min(60, Math.max(0, Math.round(Number(b.timerMinutes)) || 0)),
    dailySets: b.dailySets === undefined ? s.dailySets : Math.min(6, Math.max(1, Math.round(Number(b.dailySets)) || 2)),
  };
  await setSetting(db, 'gsat', next);
  return next;
}

// ---------- scoring (CEEC rules, worked out from the error list) ----------
// Each sentence: 2 parts x 2 points. Every error -0.5 in its part, down to 0; an omitted part is 0.
// A repeated identical spelling/grammar error counts once. Capital and punctuation: -0.5 once each.
export function scoreSentence(answer, errors) {
  if (!String(answer || '').trim()) {
    return { points: 0, parts: [0, 0], errors: [], empty: true };
  }
  const deduct = [0, 0];
  const omitted = [false, false];
  const seen = new Set();
  let mech = 0; let capital = false; let punct = false;
  const out = errors.map(e => {
    const p = e.part === 2 ? 1 : 0;
    let cost = 0;
    if (e.type === 'capital') { if (!capital) { capital = true; cost = DEDUCT; mech += DEDUCT; } }
    else if (e.type === 'punct') { if (!punct) { punct = true; cost = DEDUCT; mech += DEDUCT; } }
    else if (e.type === 'omission') { if (!omitted[p]) { omitted[p] = true; cost = PART_POINTS; } }
    else {
      const k = (e.type === 'spelling' || e.type === 'grammar') && e.key ? `${e.type}:${e.key.toLowerCase()}` : null;
      if (!k || !seen.has(k)) {
        if (k) seen.add(k);
        cost = DEDUCT;
        deduct[p] += DEDUCT;
      }
    }
    return { ...e, cost };
  });
  const parts = [0, 1].map(p => (omitted[p] ? 0 : Math.max(0, PART_POINTS - deduct[p])));
  // an error past the floor of its part costs nothing more: show what was actually taken off
  for (const p of [0, 1]) {
    let left = omitted[p] ? 0 : PART_POINTS;
    for (const e of out) {
      if ((e.part === 2 ? 1 : 0) !== p || ['capital', 'punct'].includes(e.type)) continue;
      if (e.type === 'omission') continue;
      const take = Math.min(e.cost, left);
      e.cost = take; left -= take;
    }
  }
  const points = Math.max(0, parts[0] + parts[1] - mech);
  return { points, parts, errors: out };
}

// ---------- sets ----------
async function setById(db, id) {
  return db.one("select id, content, source, created_at from public.items where id = $1 and type = 'gsat'", [id]);
}

// Past papers first (new format 111+ newest first, then 93-110), then generated sets, oldest first.
async function nextUnseen(db) {
  return db.one(`select i.id from public.items i
                 where i.type = 'gsat' and not exists (select 1 from public.attempts a where a.item_id = i.id)
                 order by (i.content->>'source' = 'past') desc,
                          ((i.content->>'year')::int >= 111) desc nulls last,
                          (i.content->>'year')::int desc nulls last,
                          (i.content->>'set')::int nulls last, i.id
                 limit 1`);
}

// A set to review: best score under 7/8, last tried at least 3 days ago.
async function nextReview(db, day = today()) {
  return db.one(`select item_id as id from public.attempts where type = 'gsat'
                 group by item_id
                 having max(raw_score) < $1::float8 and max(day) <= $2
                 order by max(day) limit 1`, [REVIEW_BELOW, addDays(day, -REVIEW_AFTER_DAYS)]);
}

async function reviewDueCount(db, day = today()) {
  return (await db.one(`select count(*)::int as c from (select item_id from public.attempts where type = 'gsat'
                        group by item_id having max(raw_score) < $1::float8 and max(day) <= $2) t`,
  [REVIEW_BELOW, addDays(day, -REVIEW_AFTER_DAYS)])).c;
}

// The learner's most frequent recent mistakes, as short notes for the question writer.
async function weakSpots(db) {
  const rows = await db.q(`select feedback from public.attempts where type = 'gsat' order by id desc limit 15`);
  const notes = new Map();
  for (const r of rows) {
    for (const s of r.feedback?.sentences || []) {
      for (const e of s.errors || []) {
        if (!['grammar', 'word', 'spelling'].includes(e.type) || !e.why_zh) continue;
        const k = e.key || e.why_zh;
        notes.set(k, (notes.get(k) || { n: 0, text: `${e.original} → ${e.fix}（${e.why_zh}）` }));
        notes.get(k).n++;
      }
    }
  }
  return [...notes.values()].sort((a, b) => b.n - a.n).slice(0, 6).map(x => x.text);
}

// Generates new sets (one AI call makes three) unless another request of this user is doing it.
export async function generateSets(ctx, count = 3) {
  if (!(await tryLock(ctx.db, 'gsat:gen', 150))) throw new HttpError(409, '正在產生新題，請稍等幾秒再試。');
  try {
    const avoid = (await ctx.db.q(`select content->'prep'->>'topic_zh' as t from public.items
                                   where type = 'gsat' and content->>'source' = 'ai' order by id desc limit 15`)).map(r => r.t).filter(Boolean);
    const sets = await ctx.ai.gsatGenerate(count, await weakSpots(ctx.db), avoid, ctx.charge);
    const rows = await ctx.db.q(`insert into public.items (type, difficulty, content, source)
                                 select 'gsat', 3, x, 'ai' from jsonb_array_elements($1::jsonb) as x returning id`, [json(sets)]);
    return rows.map(r => r.id);
  } finally {
    await unlock(ctx.db, 'gsat:gen');
  }
}

// Makes sure a set has its scoring parts and reference answers (past papers get them on first use).
async function ensurePrep(ctx, item) {
  if (item.content.prep) return item;
  const sentences = item.content.sentences.map(s => s.zh);
  const prep = await ctx.ai.gsatPrepare(sentences, ctx.charge);
  await ctx.db.q('select public.gsat_set_prep($1::int, $2::jsonb)', [item.id, json(prep)]);
  return (await setById(ctx.db, item.id)) || { ...item, content: { ...item.content, prep } };
}

function publicSet(item) {
  const c = item.content;
  return {
    id: item.id,
    source: c.source,
    year: c.year || null,
    label: c.label || '',
    topic_zh: c.prep?.topic_zh || '',
    // hints are sent so the 提示 button works without another request; references stay on the server
    sentences: c.sentences.map((s, i) => ({ zh: s.zh, hints: c.prep?.sentences?.[i]?.hints || [] })),
  };
}

const unseenAi = db => db.one(`select i.id from public.items i where i.type = 'gsat' and i.content->>'source' = 'ai'
                                and not exists (select 1 from public.attempts a where a.item_id = i.id) order by i.id limit 1`);

// kind: auto (review if one is due, else the next new set) | review | new (past papers first) | ai (a generated set)
export async function nextSet(ctx, { id = null, kind = 'auto' } = {}) {
  let pick;
  if (id) pick = { id };
  else if (kind === 'review') pick = await nextReview(ctx.db);
  else if (kind === 'ai') pick = await unseenAi(ctx.db);
  else if (kind === 'new') pick = await nextUnseen(ctx.db);
  else pick = (await nextReview(ctx.db)) || (await nextUnseen(ctx.db));
  if (!pick && kind === 'review') throw new HttpError(404, '目前沒有需要複習的題目。');
  if (!pick) pick = { id: (await generateSets(ctx))[0] };
  const row = await setById(ctx.db, pick.id);
  if (!row) throw new HttpError(404, '找不到這組題目');
  return publicSet(await ensurePrep(ctx, row));
}

// ---------- answering ----------
export async function submit(ctx, { itemId, answers, hints = [], seconds = 0, rewriteOf = null }) {
  let item = await setById(ctx.db, itemId);
  if (!item) throw new HttpError(404, '找不到這組題目');
  item = await ensurePrep(ctx, item);
  const prep = item.content.prep;
  const n = prep.sentences.length;
  const ans = Array.from({ length: n }, (_, i) => String((Array.isArray(answers) && answers[i]) || '').trim().slice(0, 1000));
  const anyText = ans.some(Boolean);
  const fb = anyText ? await ctx.ai.gsatGrade(prep, ans, ctx.charge)
    : { summary_zh: '沒有作答內容。', sentences: prep.sentences.map(() => ({ errors: [], minimal_fix: '', better: [], comment_zh: '' })), phrases: [], pitfalls_zh: [], next_step_zh: '' };
  const scored = fb.sentences.map((s, i) => ({ ...s, ...scoreSentence(ans[i], s.errors) }));
  const total = scored.reduce((a, s) => a + s.points, 0);
  const max = n * MAX_PER_SENTENCE;
  const feedback = { ...fb, sentences: scored, refs: prep.sentences.map(s => s.refs), parts: prep.sentences.map(s => s.parts), chat: [] };
  const response = { answers: ans, hints: Array.isArray(hints) ? hints.map(Boolean) : [], rewriteOf: rewriteOf ? Number(rewriteOf) : null };
  const row = await ctx.db.one(`insert into public.attempts (item_id, type, mode, response, score, raw_score, max_score, feedback, seconds, day)
                                values ($1, 'gsat', $2, $3::jsonb, $4::float8, $5::float8, $6::float8, $7::jsonb, $8::int, $9) returning id`,
  [item.id, rewriteOf ? 'rewrite' : 'practice', json(response), total / max, total, max, json(feedback), Math.round(seconds || 0), today()]);
  // keep one unseen generated set ready once the past papers run out
  ctx.bg(async c => {
    if (!(await nextUnseen(c.db))) await generateSets(c).catch(() => {});
  });
  return getAttempt(ctx.db, row.id);
}

export async function getAttempt(db, id) {
  const a = await db.one(`select a.id, a.item_id, a.mode, a.response, a.raw_score, a.max_score, a.feedback, a.seconds, a.day,
                                 i.content
                          from public.attempts a join public.items i on i.id = a.item_id
                          where a.id = $1 and a.type = 'gsat'`, [id]);
  if (!a) return null;
  const phrases = new Set((await db.q('select phrase from public.gsat_phrases')).map(r => r.phrase.toLowerCase()));
  const fb = a.feedback || {};
  return {
    id: a.id, itemId: a.item_id, mode: a.mode, day: a.day, seconds: a.seconds,
    score: a.raw_score, max: a.max_score,
    set: { label: a.content.label || '', source: a.content.source, topic_zh: a.content.prep?.topic_zh || '', sentences: a.content.sentences.map(s => s.zh) },
    answers: a.response.answers || [], hints: a.response.hints || [], rewriteOf: a.response.rewriteOf || null,
    feedback: { ...fb, phrases: (fb.phrases || []).map(p => ({ ...p, saved: phrases.has(String(p.phrase).toLowerCase()) })) },
  };
}

export async function ask(ctx, attemptId, question) {
  const q = String(question || '').trim().slice(0, 500);
  if (!q) throw new HttpError(400, '請輸入問題');
  const a = await getAttempt(ctx.db, attemptId);
  if (!a) throw new HttpError(404, 'not found');
  const chat = a.feedback.chat || [];
  if (chat.length >= ASK_LIMIT) throw new HttpError(429, `每次批改最多可以追問 ${ASK_LIMIT} 題。`);
  const context = a.set.sentences.map((zh, i) => {
    const s = a.feedback.sentences?.[i] || {};
    return `Sentence ${i + 1}: ${zh}
  Learner wrote: ${a.answers[i] || '(blank)'}
  Score: ${s.points}/4. Errors: ${(s.errors || []).map(e => `${e.original} → ${e.fix} (${e.why_zh})`).join('; ') || 'none'}
  Minimal fix: ${s.minimal_fix || ''}
  References: ${(a.feedback.refs?.[i] || []).join(' / ')}`;
  }).join('\n');
  const answer = await ctx.ai.gsatAsk(context, chat, q, ctx.charge);
  const next = [...chat, { q, a: answer }];
  await ctx.db.q(`update public.attempts set feedback = jsonb_set(feedback, '{chat}', $2::jsonb) where id = $1 and type = 'gsat'`, [attemptId, json(next)]);
  return { chat: next };
}

// ---------- phrase book ----------
export async function addPhrase(db, attemptId, index) {
  const a = await getAttempt(db, attemptId);
  const p = a?.feedback?.phrases?.[index];
  if (!p) throw new HttpError(404, 'not found');
  await db.q(`insert into public.gsat_phrases (phrase, zh, example, example_zh, note, attempt_id, due_day)
              values ($1, $2, $3, $4, $5, $6, $7) on conflict (user_id, phrase) do nothing`,
  [p.phrase.slice(0, 200), p.zh.slice(0, 200), p.example.slice(0, 400), p.example_zh.slice(0, 400), p.note_zh.slice(0, 400), attemptId, addDays(today(), 1)]);
  return { ok: true };
}

export async function phraseList(db) {
  const day = today();
  const rows = await db.q(`select id, phrase, zh, example, example_zh, note, step, due_day, reps, lapses
                           from public.gsat_phrases order by due_day, id`);
  return { phrases: rows, due: rows.filter(r => r.due_day <= day).length };
}

export async function phraseReview(db, limit = 30) {
  return db.q(`select id, phrase, zh, example, example_zh, note, step from public.gsat_phrases
               where due_day <= $1 order by due_day, id limit $2::int`, [today(), limit]);
}

// A new phrase is first due the next day (step 0 = the 1-day interval). Right: move to the next
// interval (2, 4, 7 ... days). Wrong: back to step 0, due tomorrow.
export async function gradePhrase(db, id, result) {
  const p = await db.one('select id, step, lapses from public.gsat_phrases where id = $1', [id]);
  if (!p) throw new HttpError(404, 'not found');
  const day = today();
  const good = result === 'good';
  const step = good ? Math.min(PHRASE_STEPS.length - 1, p.step + 1) : 0;
  const due = addDays(day, PHRASE_STEPS[step]);
  await db.q(`update public.gsat_phrases set step = $2::int, lapses = lapses + $3::int, reps = reps + 1, last_day = $4, due_day = $5 where id = $1`,
    [id, step, good ? 0 : 1, day, due]);
  return { due, step };
}

export async function deletePhrase(db, id) {
  await db.q('delete from public.gsat_phrases where id = $1', [id]);
  return { ok: true };
}

// ---------- overview ----------
export async function todayPlan(db) {
  const day = today();
  const s = await settings(db);
  const done = (await db.one(`select count(*)::int as c from public.attempts where type = 'gsat' and day = $1 and mode = 'practice'`, [day])).c;
  const phrasesDue = (await db.one('select count(*)::int as c from public.gsat_phrases where due_day <= $1', [day])).c;
  return { day, settings: s, done, target: s.dailySets, reviewDue: await reviewDueCount(db, day), phrasesDue };
}

// Every set with the learner's best score, for the question bank page.
export async function bank(db) {
  return db.q(`select i.id, i.content->>'source' as source, (i.content->>'year')::int as year, i.content->>'label' as label,
                      i.content->'prep'->>'topic_zh' as topic, i.content->'sentences'->0->>'zh' as first,
                      (select max(a.raw_score) from public.attempts a where a.item_id = i.id) as best,
                      (select count(*)::int from public.attempts a where a.item_id = i.id) as tries
               from public.items i where i.type = 'gsat'
               order by (i.content->>'source' = 'past') desc, (i.content->>'year')::int desc nulls last, (i.content->>'set')::int nulls last, i.id desc`);
}

const ERROR_LABEL = { spelling: '拼字', grammar: '文法', word: '用字', omission: '漏譯', capital: '大寫', punct: '標點' };

export async function progress(db) {
  const rows = await db.q(`select a.id, a.item_id, a.mode, a.raw_score, a.max_score, a.day, a.seconds, a.feedback,
                                  i.content->>'label' as label, i.content->'sentences'->0->>'zh' as first
                           from public.attempts a join public.items i on i.id = a.item_id
                           where a.type = 'gsat' order by a.id`);
  const counts = {};
  for (const r of rows.slice(-20)) {
    for (const s of r.feedback?.sentences || []) {
      for (const e of s.errors || []) counts[e.type] = (counts[e.type] || 0) + 1;
    }
  }
  const totalErr = Object.values(counts).reduce((x, y) => x + y, 0);
  const practice = rows.filter(r => r.mode === 'practice');
  const last10 = practice.slice(-10).map(r => Number(r.raw_score));
  const past = await db.one(`select count(*)::int as total,
                               count(*) filter (where exists (select 1 from public.attempts a where a.item_id = i.id))::int as done
                             from public.items i where i.type = 'gsat' and i.content->>'source' = 'past'`);
  return {
    n: practice.length,
    recentAvg: last10.length ? last10.reduce((x, y) => x + y, 0) / last10.length : null,
    best: practice.length ? Math.max(...practice.map(r => Number(r.raw_score))) : null,
    trend: practice.slice(-30).map(r => Number(r.raw_score)),
    errors: Object.entries(counts).sort((x, y) => y[1] - x[1]).map(([type, c]) => ({ type, label: ERROR_LABEL[type] || type, count: c, share: c / totalErr })),
    past,
    history: rows.slice().reverse().slice(0, 50).map(r => ({ id: r.id, mode: r.mode, score: r.raw_score, max: r.max_score, day: r.day, seconds: r.seconds,
      label: r.label, first: r.first })),
  };
}

export { daysBetween };
