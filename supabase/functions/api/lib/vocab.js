// Vocabulary: daily screening of candidate words, AI study cards, spaced review.
// All rows belong to the signed-in user (RLS); AI work runs in the background where possible.
import { today, addDays } from './time.js';
import { getSetting, setSetting, tryLock, unlock, isLocked, sleep } from './store.js';
import { HttpError } from './errors.js';
import { json } from './json.js';

// Review intervals in days.
export const STEPS = [1, 2, 4, 7, 14, 21, 45, 90];
const POOL_MIN = 40;
const CARD_BATCH = 10;     // words per AI call
const CARD_PARALLEL = 3;   // calls at once, so a batch finishes well inside the Edge Function time limit
const HARD_LAPSES = 4;     // words missed this often are flagged as hard
const FAIL_PAUSE = 120;    // seconds without automatic retries after card generation fails

const DEFAULTS = { newPerDay: 60 };
export async function settings(db) { return { ...DEFAULTS, ...(await getSetting(db, 'vocab', {})) }; }
export async function saveSettings(db, s) { await setSetting(db, 'vocab', { ...(await settings(db)), ...s }); }

const count = async (db, sql, params = []) => (await db.one(sql, params)).c;

// ---------- difficulty adapts to how many words you already know ----------
async function currentBand(db) {
  const band = await getSetting(db, 'vocab_band', 4.5);
  const recent = await db.q(`select status from public.words where marked_day is not null
                             order by marked_day desc, id desc limit 80`);
  if (recent.length < 40) return band;
  const knownRate = recent.filter(r => r.status === 'known').length / recent.length;
  let next = band;
  if (knownRate > 0.75) next = Math.min(6, band + 0.25);   // mostly known: go harder
  if (knownRate < 0.35) next = Math.max(3.5, band - 0.25); // mostly unknown: ease off
  if (next !== band) await setSetting(db, 'vocab_band', next);
  return next;
}

// ---------- screening ----------
const poolCount = db => count(db, "select count(*)::int as c from public.words where status = 'pool'");

async function refillPool(ctx) {
  if (!(await tryLock(ctx.db, 'pool', 150))) return false;
  try {
    const band = await currentBand(ctx.db);
    const recentWords = (await ctx.db.q('select word from public.words order by id desc limit 250')).map(r => r.word);
    const words = await ctx.ai.vocabCandidates(band, recentWords, ctx.charge);
    await ctx.db.q(`insert into public.words (word, topic, band)
                    select x->>'w', x->>'topic', $2::float8 from jsonb_array_elements($1::jsonb) as x
                    on conflict (user_id, word) do nothing`, [json(words), band]);
    return true;
  } finally {
    await unlock(ctx.db, 'pool');
  }
}

const pickedToday = (db, day) =>
  count(db, "select count(*)::int as c from public.words where status = 'learning' and marked_day = $1", [day]);
const screenedToday = (db, day) => count(db, 'select count(*)::int as c from public.words where marked_day = $1', [day]);

export async function screenBatch(ctx, size = 20) {
  const day = today();
  if ((await poolCount(ctx.db)) < size) {
    const started = await refillPool(ctx);
    // another request is already fetching words: wait for it
    for (let i = 0; !started && i < 45 && (await poolCount(ctx.db)) < size; i++) await sleep(2000);
  }
  if ((await poolCount(ctx.db)) < POOL_MIN) ctx.bg(c => refillPool(c)); // top up after responding
  const words = await ctx.db.q("select id, word from public.words where status = 'pool' order by random() limit $1::int", [size]);
  return { words, picked: await pickedToday(ctx.db, day), screened: await screenedToday(ctx.db, day), target: (await settings(ctx.db)).newPerDay };
}

export async function mark(ctx, id, how) {
  const day = today();
  const db = ctx.db;
  const w = await db.one('select id from public.words where id = $1', [id]);
  if (!w) throw new HttpError(404, 'word not found');
  if (how === 'known') {
    await db.q("update public.words set status = 'known', mark = null, marked_day = $1, due_day = null where id = $2", [day, id]);
  } else if (how === 'fuzzy' || how === 'unknown') {
    // first review today, right after screening
    await db.q("update public.words set status = 'learning', mark = $1, marked_day = $2, step = 0, due_day = $2 where id = $3", [how, day, id]);
    // Cards are made in full batches (one AI call per CARD_BATCH words); leftovers are made when review starts.
    const waiting = await count(db, "select count(*)::int as c from public.words where status = 'learning' and card is null");
    if (waiting >= CARD_BATCH) ctx.bg(c => makeCards(c, { fullBatchesOnly: true }));
  } else if (how === 'undo') {
    await db.q("update public.words set status = 'pool', mark = null, marked_day = null, due_day = null where id = $1", [id]);
  } else {
    throw new HttpError(400, 'bad mark');
  }
  return { picked: await pickedToday(db, day), screened: await screenedToday(db, day), target: (await settings(db)).newPerDay };
}

// ---------- study cards ----------
const NO_QUIZ = "(card -> 'quiz' is null or jsonb_typeof(card -> 'quiz') = 'null')";

// Generates missing cards (and missing quiz questions) for up to CARD_BATCH * CARD_PARALLEL words.
// Only one run per user at a time; after a failure, automatic retries pause for FAIL_PAUSE seconds.
export async function makeCards(ctx, { fullBatchesOnly = false } = {}) {
  const db = ctx.db;
  if (await isLocked(db, 'cards_fail')) return;
  if (!(await tryLock(db, 'cards', 150))) return;
  try {
    const missing = await db.q(`select id, word from public.words where status = 'learning' and card is null
                                order by due_day, id limit $1::int`, [CARD_BATCH * CARD_PARALLEL]);
    const batches = [];
    for (let i = 0; i < missing.length; i += CARD_BATCH) batches.push(missing.slice(i, i + CARD_BATCH));
    if (fullBatchesOnly && batches.length && batches[batches.length - 1].length < CARD_BATCH) batches.pop();
    const results = await Promise.allSettled(batches.map(async batch => {
      const cards = await ctx.ai.vocabCards(batch.map(m => m.word), ctx.charge);
      const byWord = new Map(cards.map(c => [String(c.w || '').toLowerCase(), c]));
      const rows = batch.map(m => ({ id: m.id, card: byWord.get(m.word) })).filter(r => r.card && r.card.zh);
      if (!rows.length) throw new Error('AI returned no usable cards');
      await saveCards(db, rows);
    }));
    const failed = results.find(r => r.status === 'rejected');

    // quiz questions for cards made without one (a quiz that failed validation)
    if (!failed && !fullBatchesOnly) {
      const noQuiz = await db.q(`select id, word, card from public.words where status = 'learning' and card is not null
                                 and ${NO_QUIZ} order by due_day, id limit $1::int`, [CARD_BATCH]);
      if (noQuiz.length) {
        const items = noQuiz.map(r => ({ id: r.id, word: r.word, pos: r.card.pos, zh: r.card.zh, card: r.card }));
        const quizzes = await ctx.ai.vocabQuizzes(items, ctx.charge);
        if (!quizzes.size) throw new Error('AI returned no usable quiz questions');
        await saveCards(db, items.filter(it => quizzes.has(it.word)).map(it => ({ id: it.id, card: { ...it.card, quiz: quizzes.get(it.word) } })));
      }
    }
    if (failed) throw failed.reason;
    await setSetting(db, 'vocab_card_error', null);
  } catch (e) {
    await setSetting(db, 'vocab_card_error', { message: e.message, at: new Date().toISOString() });
    await db.q(`insert into public.user_locks (name, until) values ('cards_fail', now() + make_interval(secs => $1::int))
                on conflict (user_id, name) do update set until = excluded.until`, [FAIL_PAUSE]);
    throw e;
  } finally {
    await unlock(db, 'cards');
  }
}

async function saveCards(db, rows) {
  await db.q(`update public.words w set card = x.card
              from jsonb_to_recordset($1::jsonb) as x(id int, card jsonb) where w.id = x.id`, [json(rows)]);
}

// ---------- review ----------
function parseWord(w) {
  return { id: w.id, word: w.word, topic: w.topic, mark: w.mark, step: w.step, reps: w.reps, lapses: w.lapses,
    hard: w.lapses >= HARD_LAPSES, due_day: w.due_day, card: w.card || null };
}

// Question type by stage: multiple choice while new or just missed, typing from Chinese once familiar.
function modeFor(w, missedToday) {
  if (w.reps === 0 || missedToday) return 'choice';
  if (w.reps === 1) return 'type';
  return w.reps % 3 === 2 ? 'choice' : 'type';
}

const hasQuiz = r => !!(r.card && r.card.quiz);
const ready = r => !!r.card; // a card is enough: without a quiz question the word gets a typing question
const finalMode = (r, mode) => (mode === 'choice' && !hasQuiz(r) ? 'type' : mode);

// Starts card generation in the background when something is missing, and reports why words are waiting.
async function cardStatus(ctx, rows) {
  const needCards = rows.some(r => !r.card);
  if (needCards || rows.some(r => r.card && !hasQuiz(r))) ctx.bg(c => makeCards(c));
  if (!needCards || !(await isLocked(ctx.db, 'cards_fail'))) return null;
  const err = await getSetting(ctx.db, 'vocab_card_error', null);
  return err ? err.message : '單字卡產生失敗';
}

async function missedTodaySet(db, day) {
  const rows = await db.q("select distinct word_id from public.word_reviews where day = $1 and result = 'again' and not free", [day]);
  return new Set(rows.map(r => r.word_id));
}

export async function reviewQueue(ctx, limit = 30) {
  const day = today();
  const rows = await ctx.db.q(`select * from public.words where status = 'learning' and due_day <= $1
                               order by due_day, step, id limit $2::int`, [day, limit]);
  const missed = await missedTodaySet(ctx.db, day);
  return {
    items: rows.filter(ready).map(r => ({ ...parseWord(r), mode: finalMode(r, modeFor(r, missed.has(r.id))), firstTime: r.reps === 0 })),
    waitingForCards: rows.filter(r => !ready(r)).length,
    cardError: await cardStatus(ctx, rows),
    ...(await reviewProgress(ctx.db, day)),
  };
}

// Free quiz: any learning words, weighted toward weak ones. Does not depend on what is due.
export async function freeQuiz(ctx, n = 20, onlyHard = false) {
  const rows = await ctx.db.q(`select * from public.words where status = 'learning' ${onlyHard ? `and lapses >= ${HARD_LAPSES}` : ''}
                               order by (lapses * 2 - step) + floor(random() * 6) desc limit $1::int`, [n]);
  const items = rows.filter(ready).map(r => ({ ...parseWord(r), mode: finalMode(r, Math.random() < 0.5 ? 'choice' : 'type'), firstTime: false }));
  return { items, waitingForCards: rows.filter(r => !ready(r)).length, cardError: await cardStatus(ctx, rows) };
}

export async function reviewProgress(db, day = today()) {
  const r = await db.one(`select
      (select count(*)::int from public.words where status = 'learning' and due_day <= $1) as due,
      (select count(distinct word_id)::int from public.word_reviews where day = $1 and not free) as reviewed,
      (select count(distinct r.word_id)::int from public.word_reviews r join public.words w on w.id = r.word_id
        where r.day = $1 and not r.free and w.status = 'learning' and w.due_day <= $1) as still_due`, [day]);
  const target = r.reviewed + r.due - r.still_due;
  return { due: r.due, target, done: target - r.due };
}

// result: good = right; hard = right with a hint, or a near-synonym; again = wrong.
export async function grade(ctx, id, mode, result, free = false) {
  const db = ctx.db;
  const day = today();
  const w = await db.one('select * from public.words where id = $1', [id]);
  if (!w || w.status !== 'learning') throw new HttpError(404, 'word not in review');
  if (!['again', 'hard', 'good'].includes(result)) throw new HttpError(400, 'bad result');
  let { step, lapses } = w;
  let due = w.due_day;
  if (free) {
    // Free quiz: a miss sends the word back to tomorrow; a right answer leaves the schedule alone.
    if (result === 'again') { step = 0; lapses += 1; due = addDays(day, STEPS[0]); }
  } else {
    const missedToday = await count(db, `select count(*)::int as c from public.word_reviews
                                         where word_id = $1 and day = $2 and result = 'again' and not free`, [id, day]);
    if (result === 'again') {
      // see it once more later today if this is the first miss today, otherwise tomorrow
      step = 0; lapses += 1;
      due = missedToday ? addDays(day, 1) : day;
    } else if (w.marked_day === day && w.reps === 0 && !missedToday) {
      due = day;                                 // picked today: choice first, then typing later today
    } else if (result === 'hard') {
      due = addDays(day, STEPS[step]);           // same interval again
    } else if (w.marked_day === day || missedToday) {
      due = addDays(day, STEPS[0]);              // picked today, or relearning: back tomorrow
    } else {
      step = Math.min(STEPS.length - 1, step + 1);
      due = addDays(day, STEPS[step]);
    }
  }
  await db.tx(async t => {
    await t.q('update public.words set step = $1::int, lapses = $2::int, reps = reps + $3::int, due_day = $4 where id = $5',
      [step, lapses, free ? 0 : 1, due, id]);
    await t.q('insert into public.word_reviews (word_id, day, mode, result, free) values ($1, $2, $3, $4, $5::boolean)',
      [id, day, mode, result, free]);
  });
  return { id, due_day: due, step, hard: lapses >= HARD_LAPSES, ...(await reviewProgress(db, day)) };
}

// ---------- word book ----------
export async function list(db, { status = 'learning', q = '', onlyHard = false } = {}) {
  const rows = await db.q(`select * from public.words where status = $1 and word like $2 ${onlyHard ? `and lapses >= ${HARD_LAPSES}` : ''}
                           order by marked_day desc nulls last, word limit 500`,
    [status, `%${q.toLowerCase().replace(/[%_\\]/g, '')}%`]);
  return rows.map(parseWord);
}

export async function stats(db) {
  const r = await db.one(`select
      count(*) filter (where status = 'learning')::int as learning,
      count(*) filter (where status = 'known')::int as known,
      count(*) filter (where status = 'pool')::int as pool,
      count(*) filter (where status = 'learning' and step >= 4)::int as mature,
      count(*) filter (where status = 'learning' and lapses >= ${HARD_LAPSES})::int as hard
    from public.words`);
  return { ...r, band: await getSetting(db, 'vocab_band', 4.5) };
}

// Estimated minutes for the daily plan.
export async function planTasks(db, day = today()) {
  const s = await settings(db);
  const picked = await pickedToday(db, day);
  const rp = await reviewProgress(db, day);
  // future-dated estimate when building tomorrow's plan
  const dueEstimate = day === today() ? rp.target
    : (await count(db, "select count(*)::int as c from public.words where status = 'learning' and due_day <= $1", [day])) + s.newPerDay;
  return {
    screen: { target: s.newPerDay, done: Math.min(picked, s.newPerDay), minutes: Math.round(s.newPerDay * 8 / 60) + 2 },
    review: { target: rp.target, done: rp.done, due: rp.due, minutes: Math.max(3, Math.round(dueEstimate * 12 / 60)) },
  };
}
