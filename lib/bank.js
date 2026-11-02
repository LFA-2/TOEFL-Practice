// Item bank: adaptive selection, on-demand generation, attempt recording.
const { db, tx } = require('./db');
const { TASKS, scoreObjective, publicContent } = require('./tasks');
const skills = require('./skills');
const ai = require('./ai');
const { today } = require('./time');

const REUSE_AFTER_DAYS = 30;
const STRETCH = 0.25;            // aim slightly above current ability
const STOCK_PER_TYPE = 6;        // unseen items kept near the learner's level

const roundHalf = x => Math.round(x * 2) / 2;

function insertItems(type, difficulty, contents, source = 'ai') {
  const stmt = db.prepare('INSERT INTO items(type, difficulty, content, source) VALUES(?, ?, ?, ?)');
  return tx(() => contents.map(c => Number(stmt.run(type, difficulty, JSON.stringify(c), source).lastInsertRowid)));
}

function candidates(type, target, excludeIds = []) {
  const ex = excludeIds.length ? `AND i.id NOT IN (${excludeIds.map(Number).join(',')})` : '';
  return db.prepare(`
    SELECT i.id, i.difficulty, ABS(i.difficulty - ?) AS dist
    FROM items i
    WHERE i.type = ? ${ex}
      AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.item_id = i.id
                      AND a.created_at > datetime('now', '-${REUSE_AFTER_DAYS} days'))
    ORDER BY dist ASC, RANDOM()
    LIMIT 10`).all(target, type);
}

function getItem(id) {
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  if (!row) return null;
  return { ...row, content: JSON.parse(row.content) };
}

function toPublic(item) {
  return { id: item.id, type: item.type, difficulty: item.difficulty, content: publicContent(item.type, item.content) };
}

const generating = new Map(); // type -> promise, avoids duplicate calls

async function generateFor(type, band) {
  const key = `${type}:${band}`;
  if (!generating.has(key)) {
    const p = ai.generate(type, band)
      .then(contents => insertItems(type, band, contents))
      .finally(() => generating.delete(key));
    generating.set(key, p);
  }
  return generating.get(key);
}

// Pick the next item for this type. Generates one on demand if nothing suitable is left.
async function nextItem(type, excludeIds = []) {
  if (!TASKS[type]) throw new Error('unknown type');
  const target = skills.getSkill(type).rating + STRETCH;
  let c = candidates(type, target, excludeIds);
  if (!c.length || c[0].dist > 0.75) {
    try {
      await generateFor(type, Math.min(6, Math.max(1, roundHalf(target))));
      c = candidates(type, target, excludeIds);
    } catch (e) {
      if (!c.length) throw e; // fall back to a less well matched item if we have one
    }
  }
  if (!c.length) return null;
  return toPublic(getItem(c[0].id));
}

// Keep a few unseen items near the learner's level so the phone never waits on the API.
async function topUp(types = Object.keys(TASKS), log = () => {}) {
  for (const type of types) {
    const target = skills.getSkill(type).rating + STRETCH;
    const band = Math.min(6, Math.max(1, roundHalf(target)));
    const near = candidates(type, target).filter(c => c.dist <= 0.75).length;
    const perCall = type === 'bas' ? 5 : 1;
    const calls = Math.ceil(Math.max(0, STOCK_PER_TYPE - near) / perCall);
    for (let i = 0; i < calls; i++) {
      try { await generateFor(type, band); log(`${type} @${band}: +${perCall}`); }
      catch (e) { log(`${type} @${band}: ${e.message}`); break; }
    }
  }
}

function explainObjective(item, result) {
  const c = item.content;
  if (item.type === 'rdl' || item.type === 'acad') {
    return c.questions.map((q, i) => ({ ...result.detail[i], explain_zh: q.explain_zh, options: q.options, q: q.q }));
  }
  if (item.type === 'bas') return [{ ...result.detail[0], explain_zh: c.explain_zh || '' }];
  return result.detail;
}

async function submit({ itemId, response, seconds, mode = 'practice' }) {
  const item = getItem(itemId);
  if (!item) throw new Error('item not found');
  const type = item.type;
  let result, feedback;
  if (TASKS[type].ai) {
    const text = String(response.text || '');
    feedback = await ai.grade(type, item.content, text, seconds || 0);
    const raw = roundHalf(feedback.score);
    result = { score: raw / 5, raw, max: 5 };
  } else {
    result = scoreObjective(type, item.content, response);
    feedback = { detail: explainObjective(item, result) };
  }
  const before = skills.getSkill(type).rating;
  const rating = skills.update(type, item.difficulty, result);
  const id = Number(db.prepare(`INSERT INTO attempts(item_id, type, mode, response, score, raw_score, max_score, feedback, seconds, day)
                                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(itemId, type, mode, JSON.stringify(response), result.score, result.raw, result.max,
      JSON.stringify(feedback), Math.round(seconds || 0), today()).lastInsertRowid);
  topUp([type]).catch(() => {}); // refill in the background
  return { attemptId: id, type, score: result.score, raw: result.raw, max: result.max, feedback, rating, before };
}

function getAttempt(id) {
  const a = db.prepare('SELECT * FROM attempts WHERE id = ?').get(id);
  if (!a) return null;
  const item = getItem(a.item_id);
  return {
    ...a,
    response: JSON.parse(a.response),
    feedback: a.feedback ? JSON.parse(a.feedback) : null,
    item: { id: item.id, type: item.type, difficulty: item.difficulty, content: publicContent(item.type, item.content) },
  };
}

function history(limit = 50) {
  return db.prepare(`SELECT id, type, score, raw_score, max_score, seconds, day, created_at
                     FROM attempts ORDER BY id DESC LIMIT ?`).all(limit);
}

function stock() {
  return db.prepare(`SELECT type, COUNT(*) total,
                       SUM(NOT EXISTS (SELECT 1 FROM attempts a WHERE a.item_id = i.id)) unseen
                     FROM items i GROUP BY type`).all();
}

module.exports = { nextItem, submit, getAttempt, history, insertItems, topUp, stock, getItem };
