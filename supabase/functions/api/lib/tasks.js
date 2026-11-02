// Task-type catalogue for the 2026 TOEFL iBT format, plus objective scoring.
//   ai:    graded by Claude (costs one AI call per submission)
//   max5:  scored 0-5 like the real rubric (shown as "x/5"); otherwise right/total
//   audio: the item is played with text-to-speech in the browser

const TASKS = {
  ctw:   { section: 'reading', name: 'Complete the Words', zh: '單字填空', unitMinutes: 3, sessionSize: 2, ai: false },
  rdl:   { section: 'reading', name: 'Read in Daily Life', zh: '日常閱讀', unitMinutes: 3, sessionSize: 2, ai: false },
  acad:  { section: 'reading', name: 'Read an Academic Passage', zh: '學術文章', unitMinutes: 7, sessionSize: 1, ai: false },
  lcr:   { section: 'listening', name: 'Listen and Choose a Response', zh: '選擇回應', unitMinutes: 0.6, sessionSize: 5, ai: false, audio: true },
  conv:  { section: 'listening', name: 'Listen to a Conversation', zh: '聽對話', unitMinutes: 3, sessionSize: 1, ai: false, audio: true },
  ann:   { section: 'listening', name: 'Listen to an Announcement', zh: '聽公告', unitMinutes: 2, sessionSize: 1, ai: false, audio: true },
  talk:  { section: 'listening', name: 'Listen to an Academic Talk', zh: '學術講座', unitMinutes: 5, sessionSize: 1, ai: false, audio: true },
  rep:   { section: 'speaking', name: 'Listen and Repeat', zh: '聽後複述', unitMinutes: 4, sessionSize: 1, ai: false, max5: true, audio: true, typed: true },
  interview: { section: 'speaking', name: 'Take an Interview', zh: '模擬面試', unitMinutes: 9, sessionSize: 1, ai: true, max5: true, audio: true, typed: true, answerSeconds: 90 },
  bas:   { section: 'writing', name: 'Build a Sentence', zh: '句子重組', unitMinutes: 1, sessionSize: 5, ai: false, timeLimit: 41 },
  email: { section: 'writing', name: 'Write an Email', zh: '寫電子郵件', unitMinutes: 10, sessionSize: 1, ai: true, max5: true, timeLimit: 7 * 60 },
  disc:  { section: 'writing', name: 'Academic Discussion', zh: '學術討論', unitMinutes: 13, sessionSize: 1, ai: true, max5: true, timeLimit: 10 * 60 },
};

const SECTIONS = {
  reading:   { zh: '閱讀', types: ['ctw', 'rdl', 'acad'] },
  listening: { zh: '聽力', types: ['lcr', 'conv', 'ann', 'talk'] },
  // Typed, not spoken: shown on its own and left out of the overall estimate.
  speaking:  { zh: '口說', types: ['rep', 'interview'], typed: true },
  writing:   { zh: '寫作', types: ['bas', 'email', 'disc'] },
};

// Listening sets are multiple choice, scored like the reading sets.
const MC_TYPES = ['rdl', 'acad', 'lcr', 'conv', 'ann', 'talk'];

// ---------- Listen and Repeat scoring ----------
// Words are compared without case, punctuation or apostrophes ("dont" = "don't").
const normWord = w => w.toLowerCase().replace(/[’'`]/g, '').replace(/[^a-z0-9]+/g, '');

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

// Marks which words of the target sentence appear, in order, in what was typed (longest common subsequence).
function matchedWords(target, given) {
  const L = Array.from({ length: target.length + 1 }, () => new Array(given.length + 1).fill(0));
  for (let i = target.length - 1; i >= 0; i--) {
    for (let j = given.length - 1; j >= 0; j--) {
      L[i][j] = target[i] === given[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  const ok = new Array(target.length).fill(false);
  for (let i = 0, j = 0; i < target.length && j < given.length;) {
    if (target[i] === given[j]) { ok[i] = true; i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++;
  }
  return ok;
}

// 0-5 points per sentence from word accuracy; one slip in a long sentence still earns a 4.
const repPoints = acc => (acc >= 0.97 ? 5 : acc >= 0.85 ? 4 : acc >= 0.7 ? 3 : acc >= 0.5 ? 2 : acc >= 0.25 ? 1 : 0);

function scoreSentence(sentence, typed) {
  const tokens = sentence.split(/\s+/).filter(Boolean);
  const target = tokens.map(normWord);
  const given = String(typed || '').split(/\s+/).map(normWord).filter(Boolean);
  const keep = target.map(w => w !== ''); // a lone dash or symbol is not a word
  const t = target.filter((_, i) => keep[i]);
  const acc = t.length ? Math.max(0, 1 - editDistance(t, given) / t.length) : 1;
  const okT = matchedWords(t, given);
  let k = 0;
  const marks = tokens.map((w, i) => ({ w, ok: keep[i] ? okT[k++] : true }));
  return { target: sentence, given: String(typed || ''), acc: Math.round(acc * 100) / 100, points: repPoints(acc), marks };
}

// ---------- Complete the Words ----------
// First sentence stays intact; afterwards every second word loses its second half,
// until 10 blanks have been made (the C-test style ETS uses).
function buildCtw(passage, maxBlanks = 10) {
  const sentenceEnd = passage.search(/[.!?](\s|$)/);
  const headEnd = sentenceEnd === -1 ? 0 : sentenceEnd + 1;
  const head = passage.slice(0, headEnd);
  const rest = passage.slice(headEnd);
  const parts = rest.split(/(\s+)/); // keep whitespace tokens
  const tokens = [{ t: head }];
  const answers = [];
  let wordIdx = 0;
  for (const part of parts) {
    if (!part) continue;
    if (/^\s+$/.test(part)) { tokens.push({ t: part }); continue; }
    const m = part.match(/^([^A-Za-z]*)([A-Za-z][A-Za-z'-]*[A-Za-z]|[A-Za-z])([^A-Za-z]*)$/);
    wordIdx++;
    if (!m || answers.length >= maxBlanks || wordIdx % 2 === 1 || m[2].length < 2 || /[-']/.test(m[2])) {
      tokens.push({ t: part });
      continue;
    }
    const [, pre, word, post] = m;
    const keep = Math.floor(word.length / 2);
    if (pre) tokens.push({ t: pre });
    tokens.push({ b: answers.length, prefix: word.slice(0, keep), len: word.length - keep });
    answers.push(word);
    if (post) tokens.push({ t: post });
  }
  // merge adjacent text tokens
  const merged = [];
  for (const tok of tokens) {
    const last = merged[merged.length - 1];
    if (tok.t !== undefined && last && last.t !== undefined) last.t += tok.t;
    else merged.push(tok);
  }
  return { passage, tokens: merged, answers };
}

// ---------- Objective scoring ----------
function scoreObjective(type, content, response) {
  if (type === 'ctw') {
    const filled = Array.isArray(response.blanks) ? response.blanks : [];
    const detail = content.answers.map((word, i) => {
      const keep = Math.floor(word.length / 2);
      const given = String(filled[i] || '').trim().toLowerCase();
      // exact spelling of the missing letters, as on the real test
      const ok = given === word.slice(keep).toLowerCase();
      return { ok, answer: word, given };
    });
    const correct = detail.filter(d => d.ok).length;
    return { score: correct / detail.length, raw: correct, max: detail.length, detail };
  }
  if (type === 'rep') {
    const typed = Array.isArray(response.answers) ? response.answers : [];
    const detail = content.sentences.map((s, i) => scoreSentence(s.t, typed[i]));
    const raw = Math.round((detail.reduce((a, d) => a + d.points, 0) / detail.length) * 2) / 2;
    return { score: raw / 5, raw, max: 5, detail };
  }
  if (MC_TYPES.includes(type)) {
    const picks = Array.isArray(response.answers) ? response.answers : [];
    const detail = content.questions.map((q, i) => ({ ok: picks[i] === q.answer, answer: q.answer, picked: picks[i] ?? null }));
    const correct = detail.filter(d => d.ok).length;
    return { score: correct / detail.length, raw: correct, max: detail.length, detail };
  }
  if (type === 'bas') {
    const order = Array.isArray(response.order) ? response.order : [];
    const norm = a => a.map(s => String(s).trim().toLowerCase()).join(' ');
    const ok = norm(order) === norm(content.answer);
    return { score: ok ? 1 : 0, raw: ok ? 1 : 0, max: 1, detail: [{ ok, answer: content.answer.join(' ') }] };
  }
  throw new Error(`not an objective type: ${type}`);
}

function hash(s) {
  let h = 7;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 1000003;
  return h;
}

// Which chunks of a Build a Sentence answer are printed in place (not draggable).
// Short replies get one fixed chunk, longer ones two; never all of them.
function basFixed(answer) {
  const n = answer.length;
  const count = n >= 7 ? 2 : n >= 4 ? 1 : 0;
  const fixed = new Set();
  let h = hash(answer.join(' '));
  while (fixed.size < count) { fixed.add(h % n); h = Math.floor(h / 7) + 13; }
  return fixed;
}

// Lowercase the first letter of a word chunk, keeping "I" and acronyms such as "TOEFL".
// Proper nouns are lowercased too, so generated content should avoid starting a blank chunk with one.
function lowerLead(s) {
  if (/^I\b/.test(s) || /^[A-Z]{2,}/.test(s)) return s;
  return s.replace(/^(\s*)([A-Z])/, (_, sp, c) => sp + c.toLowerCase());
}

// Strip answers before sending an item to the browser.
function publicContent(type, content) {
  if (type === 'ctw') return { tokens: content.tokens };
  // Listening scripts have to reach the browser for text-to-speech; the page shows them only after answering.
  if (MC_TYPES.includes(type)) {
    const { questions, ...rest } = content;
    return { ...rest, questions: questions.map(q => ({ q: q.q, options: q.options })) };
  }
  if (type === 'bas') {
    // Like the real task: some chunks are printed in place, the rest are blanks filled from a word bank.
    const fixed = basFixed(content.answer);
    const template = content.answer.map((c, i) => (fixed.has(i) ? { t: c } : { blank: true }));
    // Draggable chunks are lowercase, as on the real test (only "I" and acronyms keep their capital).
    const chunks = [...content.answer.filter((_, i) => !fixed.has(i)), ...(content.extra ? [content.extra] : [])].map(lowerLead);
    let seed = hash(chunks.join('|'));
    for (let i = chunks.length - 1; i > 0; i--) { // deterministic shuffle so a reload shows the same order
      seed = (seed * 9301 + 49297) % 233280;
      const j = Math.floor((seed / 233280) * (i + 1));
      [chunks[i], chunks[j]] = [chunks[j], chunks[i]];
    }
    return { context: content.context, speaker: content.speaker, template, chunks, end: content.end || '.' };
  }
  return content; // email / disc / rep / interview have no hidden answers
}

export { TASKS, SECTIONS, MC_TYPES, buildCtw, scoreObjective, publicContent, scoreSentence };
