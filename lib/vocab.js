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
  mode     TEXT NOT NULL,                     -- recall | spell
  result   TEXT NOT NULL,                     -- again | hard | good
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reviews_day ON word_reviews(day);
`);

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
function scheduleCards() {
  if (!carding) carding = ensureCards().catch(e => console.error('[vocab cards]', e.message)).finally(() => { carding = null; });
  return carding;
}

async function ensureCards(limit = 200) {
  for (;;) {
    const missing = db.prepare("SELECT id, word FROM words WHERE status = 'learning' AND card IS NULL ORDER BY due_day, id LIMIT ?")
      .all(Math.min(CARD_BATCH, limit));
    if (!missing.length || limit <= 0) return;
    limit -= missing.length;
    const cards = await ai.vocabCards(missing.map(m => m.word));
    const byWord = new Map(cards.map(c => [String(c.w || '').toLowerCase(), c]));
    const upd = db.prepare('UPDATE words SET card = ? WHERE id = ?');
    let saved = 0;
    tx(() => {
      for (const m of missing) {
        const c = byWord.get(m.word);
        if (c && c.zh) { upd.run(JSON.stringify(c), m.id); saved++; }
      }
    });
    if (!saved) throw new Error('AI returned no usable cards');
  }
}

// ---------- review ----------
function parseWord(w) {
  return { id: w.id, word: w.word, topic: w.topic, mark: w.mark, step: w.step, reps: w.reps, lapses: w.lapses,
    due_day: w.due_day, card: w.card ? JSON.parse(w.card) : null };
}

// spelling every other review, and always after a lapse
function modeFor(w) {
  if (w.reps === 0) return 'recall';
  return (w.reps % 2 === 1 || w.lapses > 0 && w.step <= 1) ? 'spell' : 'recall';
}

async function reviewQueue(limit = 30) {
  const day = today();
  const due = () => db.prepare("SELECT * FROM words WHERE status = 'learning' AND due_day <= ? ORDER BY due_day, step, id LIMIT ?").all(day, limit);
  let rows = due();
  if (rows.some(r => !r.card)) {
    await scheduleCards();
    rows = due();
  }
  return {
    items: rows.filter(r => r.card).map(r => ({ ...parseWord(r), mode: modeFor(r) })),
    waitingForCards: rows.filter(r => !r.card).length,
    ...reviewProgress(day),
  };
}

function reviewProgress(day = today()) {
  const dueNow = db.prepare("SELECT COUNT(*) c FROM words WHERE status = 'learning' AND due_day <= ?").get(day).c;
  const reviewed = db.prepare('SELECT COUNT(DISTINCT word_id) c FROM word_reviews WHERE day = ?').get(day).c;
  const reviewedStillDue = db.prepare(`SELECT COUNT(DISTINCT r.word_id) c FROM word_reviews r JOIN words w ON w.id = r.word_id
                                       WHERE r.day = ? AND w.status = 'learning' AND w.due_day <= ?`).get(day, day).c;
  const target = reviewed + dueNow - reviewedStillDue;
  return { due: dueNow, target, done: target - dueNow };
}

function grade(id, mode, result) {
  const day = today();
  const w = db.prepare('SELECT * FROM words WHERE id = ?').get(id);
  if (!w || w.status !== 'learning') throw Object.assign(new Error('word not in review'), { status: 404 });
  if (!['again', 'hard', 'good'].includes(result)) throw Object.assign(new Error('bad result'), { status: 400 });
  let { step, lapses } = w;
  let due;
  const missedToday = db.prepare("SELECT COUNT(*) c FROM word_reviews WHERE word_id = ? AND day = ? AND result = 'again'").get(id, day).c;
  if (result === 'again') {
    // see it once more later today if this is the first miss today, otherwise tomorrow
    step = 0; lapses += 1;
    due = missedToday ? addDays(day, 1) : day;
  } else if (result === 'hard') {
    due = addDays(day, STEPS[step]);           // same interval again
  } else if (w.marked_day === day && w.reps === 0 || missedToday) {
    due = addDays(day, STEPS[0]);              // just picked, or relearning: back tomorrow
  } else {
    step = Math.min(STEPS.length - 1, step + 1);
    due = addDays(day, STEPS[step]);
  }
  tx(() => {
    db.prepare('UPDATE words SET step = ?, lapses = ?, reps = reps + 1, due_day = ? WHERE id = ?').run(step, lapses, due, id);
    db.prepare('INSERT INTO word_reviews(word_id, day, mode, result) VALUES(?, ?, ?, ?)').run(id, day, mode, result);
  });
  return { id, due_day: due, step, ...reviewProgress(day) };
}

// ---------- word book ----------
function list({ status = 'learning', q = '' } = {}) {
  const rows = db.prepare(`SELECT * FROM words WHERE status = ? AND word LIKE ? ORDER BY marked_day DESC, word LIMIT 500`)
    .all(status, `%${q.toLowerCase().replace(/[%_]/g, '')}%`);
  return rows.map(parseWord);
}

function stats() {
  const c = s => db.prepare('SELECT COUNT(*) c FROM words WHERE status = ?').get(s).c;
  const mature = db.prepare("SELECT COUNT(*) c FROM words WHERE status = 'learning' AND step >= 4").get().c;
  return { learning: c('learning'), known: c('known'), pool: c('pool'), mature, band: getSetting('vocab_band', 4.5) };
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

module.exports = { screenBatch, mark, reviewQueue, grade, list, stats, settings, saveSettings, planTasks, refillPool, scheduleCards, addDays, STEPS, daysBetween };
