// Per-task ability estimates on the TOEFL 1-6 band scale.
const { db } = require('./db');
const { TASKS, SECTIONS } = require('./tasks');
const { today } = require('./time');

const START_RATING = 4.0; // ~TOEIC 800s; the diagnostic corrects it quickly

function getSkill(type) {
  return db.prepare('SELECT * FROM skills WHERE type = ?').get(type) || { type, rating: START_RATING, n: 0 };
}

function allSkills() {
  return Object.keys(TASKS).map(getSkill);
}

// Probability of answering an item of `difficulty` correctly at `rating`.
function expected(rating, difficulty) {
  return 1 / (1 + Math.exp(-1.6 * (rating - difficulty)));
}

// Objective tasks: Elo-style update toward observed proportion correct.
// AI-graded tasks: the 0-5 score maps to band (score + 1), and we move toward it.
function update(type, difficulty, outcome) {
  const s = getSkill(type);
  let rating;
  if (TASKS[type].ai) {
    const observedBand = 1 + outcome.raw;           // raw is 0..5
    const alpha = Math.max(0.3, 1 / (s.n + 1));
    rating = s.rating + alpha * (observedBand - s.rating);
  } else {
    const k = Math.max(0.25, 1.2 / Math.sqrt(1 + s.n / 3));
    rating = s.rating + k * (outcome.score - expected(s.rating, difficulty));
  }
  rating = Math.min(6, Math.max(1, rating));
  db.prepare(`INSERT INTO skills(type, rating, n, updated_at) VALUES(?, ?, 1, datetime('now'))
              ON CONFLICT(type) DO UPDATE SET rating = excluded.rating, n = skills.n + 1, updated_at = excluded.updated_at`)
    .run(type, rating);
  db.prepare('INSERT INTO skill_history(type, rating, day) VALUES(?, ?, ?)').run(type, rating, today());
  return rating;
}

const roundHalf = x => Math.round(x * 2) / 2;

// Section estimates weight each task type by how many points it carries on the real test.
const WEIGHTS = { ctw: 30, rdl: 10, acad: 10, bas: 10, email: 5, disc: 5 };

function estimates() {
  const skills = Object.fromEntries(allSkills().map(s => [s.type, s]));
  const sections = {};
  for (const [name, sec] of Object.entries(SECTIONS)) {
    const measured = sec.types.filter(t => skills[t].n > 0);
    if (!measured.length) { sections[name] = null; continue; }
    const w = measured.reduce((a, t) => a + WEIGHTS[t], 0);
    const v = measured.reduce((a, t) => a + WEIGHTS[t] * skills[t].rating, 0) / w;
    sections[name] = { band: roundHalf(v), exact: v };
  }
  const known = Object.values(sections).filter(Boolean);
  const overall = known.length ? roundHalf(known.reduce((a, s) => a + s.exact, 0) / known.length) : null;
  return { skills, sections, overall };
}

module.exports = { getSkill, allSkills, update, estimates, expected, START_RATING };
