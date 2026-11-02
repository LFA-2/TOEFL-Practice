// Task-type catalogue for the 2026 TOEFL iBT format, plus objective scoring.

const TASKS = {
  ctw:   { section: 'reading', name: 'Complete the Words', zh: '單字填空', unitMinutes: 3, sessionSize: 2, ai: false },
  rdl:   { section: 'reading', name: 'Read in Daily Life', zh: '日常閱讀', unitMinutes: 3, sessionSize: 2, ai: false },
  acad:  { section: 'reading', name: 'Read an Academic Passage', zh: '學術文章', unitMinutes: 7, sessionSize: 1, ai: false },
  bas:   { section: 'writing', name: 'Build a Sentence', zh: '句子重組', unitMinutes: 1, sessionSize: 5, ai: false },
  email: { section: 'writing', name: 'Write an Email', zh: '寫電子郵件', unitMinutes: 10, sessionSize: 1, ai: true, timeLimit: 7 * 60 },
  disc:  { section: 'writing', name: 'Academic Discussion', zh: '學術討論', unitMinutes: 13, sessionSize: 1, ai: true, timeLimit: 10 * 60 },
};

const SECTIONS = {
  reading:   { zh: '閱讀', types: ['ctw', 'rdl', 'acad'] },
  listening: { zh: '聽力', types: [] },
  speaking:  { zh: '口說', types: [] },
  writing:   { zh: '寫作', types: ['bas', 'email', 'disc'] },
};

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
      // accept either the missing half or the whole word
      const ok = given === word.slice(keep).toLowerCase() || given === word.toLowerCase();
      return { ok, answer: word };
    });
    const correct = detail.filter(d => d.ok).length;
    return { score: correct / detail.length, raw: correct, max: detail.length, detail };
  }
  if (type === 'rdl' || type === 'acad') {
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

// Strip answers before sending an item to the browser.
function publicContent(type, content) {
  if (type === 'ctw') return { tokens: content.tokens };
  if (type === 'rdl' || type === 'acad') {
    const { questions, ...rest } = content;
    return { ...rest, questions: questions.map(q => ({ q: q.q, options: q.options })) };
  }
  if (type === 'bas') {
    const chunks = [...content.answer, ...(content.extra ? [content.extra] : [])];
    // deterministic shuffle so a reload shows the same order
    let seed = chunks.join('|').length * 7919;
    for (let i = chunks.length - 1; i > 0; i--) {
      seed = (seed * 9301 + 49297) % 233280;
      const j = Math.floor((seed / 233280) * (i + 1));
      [chunks[i], chunks[j]] = [chunks[j], chunks[i]];
    }
    return { context: content.context, speaker: content.speaker, chunks, end: content.end || '.' };
  }
  return content; // email / disc have no hidden answers
}

module.exports = { TASKS, SECTIONS, buildCtw, scoreObjective, publicContent };
