// End-to-end API test against test/dev-server.mjs (AI_MOCK=1). Run on a freshly reset database.
// Usage: BASE=http://127.0.0.1:3999 node test/api-test.mjs
import assert from 'node:assert/strict';

const BASE = process.env.BASE || 'http://127.0.0.1:3999';
const FN = `${BASE}/functions/v1/api`;
let failures = 0;
const step = async (name, fn) => {
  try { await fn(); console.log('ok  ', name); } catch (e) { failures++; console.log('FAIL', name, '\n     ', e.message); }
};

async function signup(email) {
  const r = await fetch(`${BASE}/auth/v1/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'secret123' }) });
  return (await r.json()).access_token;
}
function client(token) {
  return async (path, body) => {
    const r = await fetch(FN + path, body === undefined ? { headers: { authorization: `Bearer ${token}` } }
      : { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    return { status: r.status, data };
  };
}
const idle = () => fetch(`${BASE}/dev/idle`);
const approve = email => fetch(`${BASE}/dev/approve?email=${encodeURIComponent(email)}`);

const a = client(await signup('a@x.com'));
const b = client(await signup('b@x.com'));
const anon = client('');

await step('anonymous: /me says not signed in, data routes need login', async () => {
  assert.deepEqual((await anon('/me')).data, { authed: false });
  assert.equal((await anon('/today')).status, 401);
});

await step('new account is pending until approved', async () => {
  const me = (await a('/me')).data;
  assert.equal(me.authed, true); assert.equal(me.approved, false);
  const t = await a('/today');
  assert.equal(t.status, 403); assert.equal(t.data.pending, true);
});

await approve('a@x.com');

await step('approved: /me shows quota, /today builds the diagnostic plan', async () => {
  const me = (await a('/me')).data;
  assert.equal(me.approved, true);
  assert.deepEqual(me.usage, { used: 0, limit: 30 });
  const t = (await a('/today')).data;
  assert.equal(t.plan.diagnostic, true);
  assert.ok(t.plan.tasks.length >= 6);
  assert.equal(t.vocabSettings.newPerDay, 60);
});

let ctwItem;
await step('next item comes from the seeded bank (no AI call)', async () => {
  const r = await a('/next?type=ctw');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  ctwItem = r.data;
  assert.ok(ctwItem.content.tokens.length > 5);
  assert.equal(ctwItem.content.answers, undefined, 'answers must not be sent');
});

await step('submit scores, records the attempt, updates skill', async () => {
  const r = await a('/submit', { itemId: ctwItem.id, response: { blanks: ['x'] }, seconds: 40, mode: 'diagnostic' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.max, 10);
  assert.equal(typeof r.data.attemptId, 'number');
  const at = await a(`/attempt?id=${r.data.attemptId}`);
  assert.equal(at.data.item.id, ctwItem.id);
  await idle();
});

await step('writing task graded by (mock) AI and charged to the quota', async () => {
  const it = (await a('/next?type=email')).data;
  const r = await a('/submit', { itemId: it.id, response: { text: 'Dear Professor, I am writing to ask ...' }, seconds: 300 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.raw, 3.5);
  await idle();
  const me = (await a('/me')).data;
  assert.ok(me.usage.used >= 1, `used ${me.usage.used}`);
});

await step('writing record lists past email / discussion answers with feedback, paged', async () => {
  const disc = (await a('/next?type=disc')).data;
  const r = await a('/submit', { itemId: disc.id, response: { text: 'I think online classes help students because they can review lectures.' }, seconds: 500 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await idle();
  const all = (await a('/writing')).data;
  assert.equal(all.items.length, 2, JSON.stringify(all));
  assert.equal(all.items[0].type, 'disc'); // newest first
  assert.equal(all.items[1].type, 'email');
  assert.equal(all.items[0].words, 11);
  assert.ok(all.items[0].prompt && all.items[0].summary, 'prompt and summary preview');
  assert.equal(all.stats.email.n, 1); assert.equal(all.stats.disc.n, 1);
  assert.equal(all.stats.disc.recentAvg, 3.5);
  assert.equal(typeof all.target, 'number');
  const email = (await a('/writing?type=email')).data;
  assert.deepEqual(email.items.map(x => x.type), ['email']);
  const page2 = (await a(`/writing?before=${all.items[0].id}`)).data;
  assert.deepEqual(page2.items.map(x => x.id), [all.items[1].id]);
  assert.equal(page2.more, false);
  const full = (await a(`/attempt?id=${all.items[0].id}`)).data;
  assert.equal(full.response.text.startsWith('I think'), true);
  assert.equal(typeof full.feedback.summary_zh, 'string');
});

await step('listening: each type is generated, hides answers, and is scored', async () => {
  for (const [type, nq] of [['lcr', 1], ['conv', 2], ['ann', 2], ['talk', 4]]) {
    const it = await a(`/next?type=${type}`);
    assert.equal(it.status, 200, `${type}: ${JSON.stringify(it.data)}`);
    const c = it.data.content;
    assert.ok(Array.isArray(c.script) && c.script.length >= 1 && c.script[0].t, `${type} script`);
    assert.ok(['f', 'm'].includes(c.script[0].v), `${type} voice`);
    assert.equal(c.questions.length, nq, `${type} questions`);
    assert.equal(c.questions[0].answer, undefined, `${type} answer must not be sent`);
    const r = await a('/submit', { itemId: it.data.id, response: { answers: c.questions.map(() => 0), plays: 2 }, seconds: 60 });
    assert.equal(r.status, 200, `${type} submit: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.max, nq);
    assert.ok(r.data.feedback.detail[0].explain_zh, `${type} explanation`);
    await idle();
  }
  const conv = (await a('/next?type=conv')).data.content;
  assert.notEqual(conv.script[0].v, conv.script[1].v, 'two voices in a conversation');
});

await step('speaking: listen and repeat is scored per sentence without AI', async () => {
  const before = (await a('/me')).data.usage.used;
  const it = (await a('/next?type=rep')).data;
  const s = it.content.sentences;
  assert.equal(s.length, 7);
  const typed = s.map((x, i) => (i === 0 ? x.t : i === 1 ? x.t.split(' ').slice(0, -1).join(' ') : ''));
  const r = await a('/submit', { itemId: it.id, response: { answers: typed }, seconds: 120 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.max, 5);
  assert.equal(r.data.feedback.detail[0].points, 5);
  assert.ok(r.data.feedback.detail[1].points < 5 && r.data.feedback.detail[1].points > 0);
  assert.equal(r.data.feedback.detail[2].points, 0);
  assert.ok(r.data.feedback.detail[1].marks.some(m => !m.ok), 'missed word marked');
  await idle();
  // generation (1) + the background refill of the next item (1); the scoring itself is free
  assert.equal((await a('/me')).data.usage.used - before, 2);
});

await step('speaking: interview answers are graded together in one AI call', async () => {
  const it = (await a('/next?type=interview')).data;
  assert.equal(it.content.questions.length, 4);
  const before = (await a('/me')).data.usage.used;
  const r = await a('/submit', { itemId: it.id, response: { answers: ['I study in the library because it is quiet.', 'Alone.', '', 'Yes.'] }, seconds: 300 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.raw, 3);
  assert.equal(r.data.feedback.per_question.length, 4);
  await idle();
  // grading all four answers (1) + the background refill of the next item (1)
  assert.equal((await a('/me')).data.usage.used - before, 2);
  const rec = (await a('/writing?type=interview')).data;
  assert.equal(rec.items.length, 1);
  assert.equal(rec.items[0].words, 11);
  assert.ok(rec.items[0].prompt.length > 5);
  assert.equal(rec.stats.interview.n, 1);
});

await step('estimates: speaking is shown but left out of the overall', async () => {
  const t = (await a('/today')).data;
  const sec = t.estimates.sections;
  assert.ok(sec.listening && sec.speaking && sec.reading && sec.writing);
  assert.equal(sec.speaking.typed, true);
  const expected = Math.round(((sec.reading.exact + sec.listening.exact + sec.writing.exact) / 3) * 2) / 2;
  assert.equal(t.estimates.overall, expected);
});

await step('history by type is paged and the dashboard counts each type', async () => {
  const d = (await a('/dashboard')).data;
  assert.equal(d.byType.lcr.n, 1);
  assert.equal(d.byType.email.n, 1);
  const h = (await a('/history?type=lcr')).data;
  assert.equal(h.items.length, 1);
  assert.equal(h.items[0].type, 'lcr');
  assert.equal((await a('/history?type=nope')).status, 400);
});

await step('daily plan: once every type is measured, it has listening and speaking, in test order', async () => {
  for (const type of ['rdl', 'acad', 'bas']) {
    const it = (await a(`/next?type=${type}`)).data;
    const response = type === 'bas' ? { order: it.content.chunks } : { answers: it.content.questions.map(() => 0) };
    assert.equal((await a('/submit', { itemId: it.id, response, seconds: 30 })).status, 200);
    await idle();
  }
  await a('/settings', {}); // rebuilds today's plan
  const p = (await a('/today')).data.plan;
  assert.equal(p.diagnostic, false);
  const sections = { lcr: 'l', conv: 'l', ann: 'l', talk: 'l', rep: 's', interview: 's' };
  assert.ok(p.tasks.some(t => sections[t.type] === 'l'), JSON.stringify(p.tasks));
  assert.ok(p.tasks.some(t => sections[t.type] === 's'), JSON.stringify(p.tasks));
  const order = ['ctw', 'rdl', 'acad', 'lcr', 'conv', 'ann', 'talk', 'rep', 'interview', 'bas', 'email', 'disc'];
  const idx = p.tasks.map(t => order.indexOf(t.type));
  assert.deepEqual(idx, [...idx].sort((x, y) => x - y), 'reading, listening, speaking, writing');
});

let screen;
await step('vocab screening fills the pool via AI', async () => {
  const r = await a('/vocab/screen');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  screen = r.data;
  assert.equal(screen.words.length, 20);
  assert.equal(screen.target, 60);
});

await step('fewer than a full batch: cards are made when review starts', async () => {
  for (const w of screen.words.slice(0, 5)) await a('/vocab/mark', { id: w.id, how: 'unknown' });
  const r = await a('/vocab/mark', { id: screen.words[5].id, how: 'known' });
  assert.equal(r.data.picked, 5); assert.equal(r.data.screened, 6);
  await a('/vocab/mark', { id: screen.words[5].id, how: 'undo' });
  await idle();
});

await step('review: choice first, then typing the same day; free quiz does not advance', async () => {
  let q = (await a('/vocab/review')).data;
  assert.equal(q.items.length, 0); assert.equal(q.waitingForCards, 5);
  await idle();
  q = (await a('/vocab/review')).data;
  assert.equal(q.items.length, 5, JSON.stringify(q).slice(0, 300));
  assert.equal(q.waitingForCards, 0);
  assert.ok(q.items.every(i => i.mode === 'choice' && i.firstTime && i.card.quiz));
  const w = q.items[0];
  let g = (await a('/vocab/grade', { id: w.id, mode: 'choice', result: 'good' })).data;
  assert.equal(g.due_day, q.items[0].due_day, 'still due today');
  q = (await a('/vocab/review')).data;
  const again = q.items.find(i => i.id === w.id);
  assert.equal(again.mode, 'type');
  g = (await a('/vocab/grade', { id: w.id, mode: 'type', result: 'good' })).data;
  assert.notEqual(g.due_day, w.due_day, 'moves to tomorrow');
  const free = (await a('/vocab/quiz?n=5')).data;
  assert.equal(free.items.length, 5);
  const before = free.items[0];
  const fg = (await a('/vocab/grade', { id: before.id, mode: before.mode, result: 'good', free: true })).data;
  assert.equal(fg.due_day, before.due_day);
});

await step('word book and stats', async () => {
  const r = (await a('/vocab/list')).data;
  assert.equal(r.words.length, 5);
  assert.equal(r.stats.learning, 5);
  assert.ok(r.stats.pool >= 14);
});

await step('settings save and reset the plan', async () => {
  const r = await a('/settings', { examDate: '2027-01-29', target: 5, minutesWeekday: 60, minutesWeekend: 90, vocabNewPerDay: 40 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.vocabNewPerDay, 40);
  const t = (await a('/today')).data;
  assert.equal(t.plan.settings.examDate, '2027-01-29');
});

await step('dashboard', async () => {
  const d = (await a('/dashboard')).data;
  assert.ok(d.recent.length >= 2);
  assert.ok(d.daily[0].n >= 2);
  assert.equal(typeof d.daily[0].secs, 'number');
  assert.ok(d.stock.some(s => s.type === 'ctw' && typeof s.unseen === 'number'));
});

await approve('b@x.com');

await step("another user cannot see or change the first user's data", async () => {
  const words = (await a('/vocab/list')).data.words;
  const list = (await b('/vocab/list')).data;
  assert.equal(list.words.length, 0);
  assert.equal(list.stats.pool, 0);
  const g = await b('/vocab/grade', { id: words[0].id, mode: 'type', result: 'again' });
  assert.equal(g.status, 404);
  const m = await b('/vocab/mark', { id: words[0].id, how: 'known' });
  assert.equal(m.status, 404);
  const at = await b(`/attempt?id=1`);
  assert.equal(at.status, 404);
  const d = (await b('/dashboard')).data;
  assert.equal(d.recent.length, 0);
  const w = (await b('/writing')).data;
  assert.equal(w.items.length, 0, 'writing record is private');
  assert.equal(w.stats.email.n, 0);
  // shared bank: generated items are visible to b
  assert.ok(d.stock.find(s => s.type === 'email').total >= 2);
});

await step('quota: calls stop at the limit with a clear message', async () => {
  const me = (await b('/me')).data;
  let r;
  for (let i = me.usage.used; i <= me.usage.limit; i++) {
    const it = (await b('/next?type=email')).data;
    r = await b('/submit', { itemId: it.id, response: { text: 'An answer.' }, seconds: 60 });
    await idle();
    if (r.status !== 200) break;
  }
  assert.equal(r.status, 429, JSON.stringify(r.data));
  assert.match(r.data.error, /AI 次數/);
  const after = (await b('/me')).data.usage;
  assert.equal(after.used, after.limit);
  // non-AI work still works
  const t = await b('/today');
  assert.equal(t.status, 200);
});

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
