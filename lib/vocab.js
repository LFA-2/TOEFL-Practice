// Vocabulary: daily screening of candidate words, AI study cards, spaced review.
const { db, getSetting, setSetting, tx } = require('./db');
const ai = require('./ai');
const { today, daysBetween } = require('./time');

db.exec(`
CREATE TABLE IF NOT EXISTS words (
  id          INTEGER PRIMARY KEY,
  word        TEXT NOT NULL UNIQUE,
  topic       TEXT,
  band        REAL,
  status      TEXT NOT NULL DEFAULT 'pool',   -- pool | known | learning
  mark        TEXT,                           -- fuzzy | unknown (how it was marked)
  card        TEXT,                           -- JSON study card, null until generated
  step        INTEGER NOT NULL DEFAULT 0,     -- index into STEPS
  due_day     TEXT,
  reps        INTEGER NOT NULL DEFAULT 0,
  lapses      INTEGER NOT NULL DEFAULT 0,
  marked_day  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_words_status ON words(status, due_day);
CREATE INDEX IF NOT EXISTS idx_words_marked ON words(marked_day);

CREATE TABLE IF NOT EXISTS word_reviews (
  id       INTEGER PRIMARY KEY,
  word_id  INTEGER NOT NULL REFERENCES words(id),
  day      TEXT NOT NULL,
  mode     TEXT NOT NULL,                     -- choice | type (older: recall | spell)
  result   TEXT NOT NULL,                     -- again | hard | good
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reviews_day ON word_reviews(day);
`);
// v0.3: free-quiz answers are logged but do not count toward the daily review
if (!db.prepare('PRAGMA table_info(word_reviews)').all().some(c => c.name === 'free')) {
  db.exec('ALTER TABLE word_reviews ADD COLUMN free INTEGER NOT NULL DEFAULT 0');
}

// Review intervals in days: 1, 2, 7, 21 as commonly recommended, then longer.
const STEPS = [1, 2, 4, 7, 14, 21, 45, 90];
const POOL_MIN = 40;
const CARD_BATCH = 15;

const DEFAULTS = { newPerDay: 60 };
function settings() { return { ...DEFAULTS, ...getSetting('vocab', {}) }; }
function saveSettings(s) { setSetting('vocab', { ...settings(), ...s }); }

function addDays(day, n) {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------- difficulty adapts to how many words you already know ----------
function currentBand() {
  const band = getSetting('vocab_band', 4.5);
  const recent = db.prepare(`SELECT status FROM words WHERE marked_day IS NOT NULL ORDER BY marked_day DESC, id DESC LIMIT 80`).all();
  if (recent.length < 40) return band;
  const knownRate = recent.filter(r => r.status === 'known').length / recent.length;
  let next = band;
  if (knownRate > 0.75) next = Math.min(6, band + 0.25);   // mostly known: go harder
  if (knownRate < 0.35) next = Math.max(3.5, band - 0.25); // mostly unknown: ease off
  if (next !== band) setSetting('vocab_band', next);
  return next;
}

// ---------- screening ----------
let refilling = null;
async function refillPool() {
  if (refilling) return refilling;
  refilling = (async () => {
    const band = currentBand();
    const recentWords = db.prepare('SELECT word FROM words ORDER BY id DESC LIMIT 250').all().map(r => r.word);
    const words = await ai.vocabCandidates(band, recentWords);
    const ins = db.prepare('INSERT OR IGNORE INTO words(word, topic, band) VALUES(?, ?, ?)');
    tx(() => { for (const w of words) ins.run(w.w, w.topic, band); });
  })().finally(() => { refilling = null; });
  return refilling;
}

function poolCount() {
  return db.prepare("SELECT COUNT(*) c FROM words WHERE status = 'pool'").get().c;
}

function pickedToday(day = today()) {
  return db.prepare("SELECT COUNT(*) c FROM words WHERE status = 'learning' AND marked_day = ?").get(day).c;
}

function screenedToday(day = today()) {
  return db.prepare('SELECT COUNT(*) c FROM words WHERE marked_day = ?').get(day).c;
}

async function screenBatch(size = 20) {
  if (poolCount() < size) await refillPool();
  if (poolCount() < POOL_MIN) refillPool().catch(() => {}); // top up in the background
  const words = db.prepare("SELECT id, word FROM words WHERE status = 'pool' ORDER BY RANDOM() LIMIT ?").all(size);
  return { words, picked: pickedToday(), screened: screenedToday(), target: settings().newPerDay };
}

function mark(id, how) {
  const day = today();
  const w = db.prepare('SELECT * FROM words WHERE id = ?').get(id);
  if (!w) throw Object.assign(new Error('word not found'), { status: 404 });
  if (how === 'known') {
    db.prepare("UPDATE words SET status = 'known', mark = NULL, marked_day = ?, due_day = NULL WHERE id = ?").run(day, id);
  } else if (how === 'fuzzy' || how === 'unknown') {
    // first review today, right after screening
    db.prepare("UPDATE words SET status = 'learning', mark = ?, marked_day = ?, step = 0, due_day = ? WHERE id = ?").run(how, day, day, id);
    scheduleCards();
  } else if (how === 'undo') {
    db.prepare("UPDATE words SET status = 'pool', mark = NULL, marked_day = NULL, due_day = NULL WHERE id = ?").run(id);
  } else {
    throw Object.assign(new Error('bad mark'), { status: 400 });
  }
  return { picked: pickedToday(), screened: screenedToday(), target: settings().newPerDay };
}

// ---------- study cards ----------
let carding = null;
let lastCardFailure = 0;
function scheduleCards() {
  if (!carding) {
    carding = ensureCards()
      .catch(e => { lastCardFailure = Date.now(); console.error('[vocab cards]', e.message); })
      .finally(() => { carding = null; });
  }
  return carding;
}

async function ensureCards(limit = 200) {
  const upd = db.prepare('UPDATE words SET card = ? WHERE id = ?');
  // 1. full cards (with quiz) for words that have none
  for (let left = limit; left > 0;) {
    const missing = db.prepare("SELECT id, word FROM words WHERE status = 'learning' AND card IS NULL ORDER BY due_day, id LIMIT ?")
      .all(Math.min(CARD_BATCH, left));
    if (!missing.length) break;
    left -= missing.length;
    const cards = await ai.vocabCards(missing.map(m => m.word));
    const byWord = new Map(cards.map(c => [String(c.w || '').toLowerCase(), c]));
    let saved = 0;
    tx(() => {
      for (const m of missing) {
        const c = byWord.get(m.word);
        if (c && c.zh) { upd.run(JSON.stringify(c), m.id); saved++; }
      }
    });
    if (!saved) throw new Error('AI returned no usable cards');
  }
  // 2. quiz questions for cards made without one (older cards, or a quiz that failed validation)
  for (let left = limit, tries = 0; left > 0 && tries < 20; tries++) {
    const noQuiz = db.prepare(`SELECT id, word, card FROM words WHERE status = 'learning' AND card IS NOT NULL
                               AND json_extract(card, '$.quiz') IS NULL ORDER BY due_day, id LIMIT ?`).all(Math.min(CARD_BATCH, left));
    if (!noQuiz.length) break;
    left -= noQuiz.length;
    const items = noQuiz.map(r => { const c = JSON.parse(r.card); return { id: r.id, word: r.word, pos: c.pos, zh: c.zh, card: c }; });
    const quizzes = await ai.vocabQuizzes(items);
    if (!quizzes.size) throw new Error('AI returned no usable quiz questions');
    tx(() => { for (const it of items) if (quizzes.has(it.word)) upd.run(JSON.stringify({ ...it.card, quiz: quizzes.get(it.word) }), it.id); });
  }
}

// ---------- review ----------
const HARD_LAPSES = 4; // words missed this often are flagged as hard

function parseWord(w) {
  return { id: w.id, word: w.word, topic: w.topic, mark: w.mark, step: w.step, reps: w.reps, lapses: w.lapses,
    hard: w.lapses >= HARD_LAPSES, due_day: w.due_day, card: w.card ? JSON.parse(w.card) : null };
}

// Question type by stage: multiple choice while new or just missed, typing from Chinese once familiar.
function modeFor(w, missedToday) {
  if (w.reps === 0 || missedToday) return 'choice';
  if (w.reps === 1) return 'type';
  return w.reps % 3 === 2 ? 'choice' : 'type';
}

const hasQuiz = r => !!(r.card && JSON.parse(r.card).quiz);
const ready = r => !!r.card; // a card is enough: without a quiz question the word gets a typing question

async function withQuizData(select) {
  let rows = select();
  // Missing cards are always fetched; missing quiz questions are retried at most every 10 minutes after a failure.
  const quizRetryOk = Date.now() - lastCardFailure > 10 * 60_000;
  if (rows.some(r => !r.card) || (quizRetryOk && rows.some(r => !hasQuiz(r)))) {
    await scheduleCards(); // errors are logged inside; we fall back to typing questions
    rows = select();
  }
  return rows;
}

const finalMode = (r, mode) => (mode === 'choice' && !hasQuiz(r) ? 'type' : mode);

function missedTodaySet(day) {
  return new Set(db.prepare("SELECT word_id FROM word_reviews WHERE day = ? AND result = 'again' AND free = 0").all(day).map(r => r.word_id));
}

async function reviewQueue(limit = 30) {
  const day = today();
  const rows = await withQuizData(() =>
    db.prepare("SELECT * FROM words WHERE status = 'learning' AND due_day <= ? ORDER BY due_day, step, id LIMIT ?").all(day, limit));
  const missed = missedTodaySet(day);
  return {
    items: rows.filter(ready).map(r => ({ ...parseWord(r), mode: finalMode(r, modeFor(r, missed.has(r.id))), firstTime: r.reps === 0 })),
    waitingForCards: rows.filter(r => !ready(r)).length,
    ...reviewProgress(day),
  };
}

// Free quiz: any learning words, weighted toward weak ones. Does not depend on what is due.
async function freeQuiz(n = 20, onlyHard = false) {
  const rows = await withQuizData(() => db.prepare(`SELECT * FROM words WHERE status = 'learning' ${onlyHard ? `AND lapses >= ${HARD_LAPSES}` : ''}
      ORDER BY (lapses * 2 - step) + (ABS(RANDOM()) % 6) DESC LIMIT ?`).all(n));
  const items = rows.filter(ready).map(r => ({ ...parseWord(r), mode: finalMode(r, Math.random() < 0.5 ? 'choice' : 'type'), firstTime: false }));
  return { items, waitingForCards: rows.filter(r => !ready(r)).length };
}

function reviewProgress(day = today()) {
  const dueNow = db.prepare("SELECT COUNT(*) c FROM words WHERE status = 'learning' AND due_day <= ?").get(day).c;
  const reviewed = db.prepare('SELECT COUNT(DISTINCT word_id) c FROM word_reviews WHERE day = ? AND free = 0').get(day).c;
  const reviewedStillDue = db.prepare(`SELECT COUNT(DISTINCT r.word_id) c FROM word_reviews r JOIN words w ON w.id = r.word_id
                                       WHERE r.day = ? AND r.free = 0 AND w.status = 'learning' AND w.due_day <= ?`).get(day, day).c;
  const target = reviewed + dueNow - reviewedStillDue;
  return { due: dueNow, target, done: target - dueNow };
}

// result: good = right; hard = right with a hint, or a near-synonym; again = wrong.
function grade(id, mode, result, free = false) {
  const day = today();
  const w = db.prepare('SELECT * FROM words WHERE id = ?').get(id);
  if (!w || w.status !== 'learning') throw Object.assign(new Error('word not in review'), { status: 404 });
  if (!['again', 'hard', 'good'].includes(result)) throw Object.assign(new Error('bad result'), { status: 400 });
  let { step, lapses } = w;
  let due = w.due_day;
  if (free) {
    // Free quiz: a miss sends the word back to tomorrow; a right answer leaves the schedule alone.
    if (result === 'again') { step = 0; lapses += 1; due = addDays(day, STEPS[0]); }
  } else {
    const missedToday = db.prepare("SELECT COUNT(*) c FROM word_reviews WHERE word_id = ? AND day = ? AND result = 'again' AND free = 0").get(id, day).c;
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
  tx(() => {
    db.prepare(`UPDATE words SET step = ?, lapses = ?, reps = reps + ?, due_day = ? WHERE id = ?`).run(step, lapses, free ? 0 : 1, due, id);
    db.prepare('INSERT INTO word_reviews(word_id, day, mode, result, free) VALUES(?, ?, ?, ?, ?)').run(id, day, mode, result, free ? 1 : 0);
  });
  return { id, due_day: due, step, hard: lapses >= HARD_LAPSES, ...reviewProgress(day) };
}

// ---------- word book ----------
function list({ status = 'learning', q = '', onlyHard = false } = {}) {
  const rows = db.prepare(`SELECT * FROM words WHERE status = ? AND word LIKE ? ${onlyHard ? `AND lapses >= ${HARD_LAPSES}` : ''}
                           ORDER BY marked_day DESC, word LIMIT 500`)
    .all(status, `%${q.toLowerCase().replace(/[%_]/g, '')}%`);
  return rows.map(parseWord);
}

function stats() {
  const c = s => db.prepare('SELECT COUNT(*) c FROM words WHERE status = ?').get(s).c;
  const mature = db.prepare("SELECT COUNT(*) c FROM words WHERE status = 'learning' AND step >= 4").get().c;
  const hard = db.prepare(`SELECT COUNT(*) c FROM words WHERE status = 'learning' AND lapses >= ${HARD_LAPSES}`).get().c;
  return { learning: c('learning'), known: c('known'), pool: c('pool'), mature, hard, band: getSetting('vocab_band', 4.5) };
}

// Estimated minutes for the daily plan.
function planTasks(day = today()) {
  const s = settings();
  const picked = pickedToday(day);
  const rp = reviewProgress(day);
  // future-dated estimate when building tomorrow's plan
  const dueEstimate = day === today() ? rp.target
    : db.prepare("SELECT COUNT(*) c FROM words WHERE status = 'learning' AND due_day <= ?").get(day).c + s.newPerDay;
  return {
    screen: { target: s.newPerDay, done: Math.min(picked, s.newPerDay), minutes: Math.round(s.newPerDay * 8 / 60) + 2 },
    review: { target: rp.target, done: rp.done, due: rp.due, minutes: Math.max(3, Math.round(dueEstimate * 12 / 60)) },
  };
}

module.exports = { screenBatch, mark, reviewQueue, freeQuiz, grade, list, stats, settings, saveSettings, planTasks, refillPool, scheduleCards, addDays, STEPS, daysBetween };
