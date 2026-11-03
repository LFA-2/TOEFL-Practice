// Claude API calls: item generation and grading of written responses.
// Runs only inside the Edge Function: the API key never reaches the browser.
import { buildCtw } from './tasks.js';
import { respond as mockRespond } from './ai-mock.js';
import { AiError } from './errors.js';

const CEFR = { 1: 'A1', 2: 'A2', 3: 'B1', 4: 'B2', 5: 'C1', 6: 'C2' };
const cefrFor = band => CEFR[Math.min(6, Math.max(1, Math.round(band)))];

// Structured output: the model is asked to call a "submit" tool, so the result arrives as an
// already-parsed object instead of JSON text the model might mistype (a missing comma etc.).
// Every call passes a typed schema: with a loose one the model tends to send arrays and numbers as strings.
const GENERIC_SCHEMA = { type: 'object', additionalProperties: true };
const STR = { type: 'string' };
const STRS = { type: 'array', items: STR };
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', required, properties });

// Tool input sometimes still carries a nested array or object as a JSON string ("[{...}]"); parse those back.
// Such strings are not always valid JSON (a slip, or cut off), so this is lenient: small slips are repaired,
// and from a broken array every complete element is kept.
function revive(v) {
  if (Array.isArray(v)) return v.map(revive);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revive(x)]));
  if (typeof v === 'string' && /^\s*[[{]/.test(v)) {
    const parsed = lenientParse(v);
    return parsed === undefined ? v : revive(parsed);
  }
  return v;
}

const repairJson = raw => raw
  .replace(/}\s*{/g, '},{')            // missing comma between objects
  .replace(/"\s*\n\s*"/g, '",\n"')     // missing comma between strings on separate lines
  .replace(/,\s*([}\]])/g, '$1');      // trailing commas

function lenientParse(text) {
  const t = text.trim();
  try { return JSON.parse(t); } catch { /* try harder */ }
  try { return JSON.parse(repairJson(t)); } catch { /* try harder */ }
  if (t.startsWith('[')) {
    const items = salvageArray(t);
    if (items.length) return items;
  }
  return undefined;
}

// The complete top-level elements of a JSON array that may be cut off or broken further on.
function salvageArray(text) {
  const out = [];
  let depth = 0; let inStr = false; let esc = false; let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; if (depth === 1 && start === -1) start = i; continue; }
    if (ch === '[' || ch === '{') {
      if (depth === 1 && start === -1) start = i;
      depth++;
    } else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 1 && start !== -1) {
        const piece = text.slice(start, i + 1);
        try { out.push(JSON.parse(piece)); } catch { try { out.push(JSON.parse(repairJson(piece))); } catch { /* skip a broken element */ } }
        start = -1;
      }
      if (depth <= 0) break;
    }
  }
  return out;
}

// A list field that arrived as a single value becomes a one-item list; missing becomes empty.
const asList = v => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]);

// Multiple-choice answer index: accepts 2, "2", "C" or "c".
function toIndex(a) {
  if (typeof a === 'string') {
    const t = a.trim();
    if (/^[A-Da-d]$/.test(t)) return t.toUpperCase().charCodeAt(0) - 65;
    if (/^\d+$/.test(t)) return Number(t);
  }
  return a;
}

// Filled in by makeAi(): { anthropicKey, model, vocabModel, apiBase, aiMock }
const config = { anthropicKey: '', model: 'claude-sonnet-5-5', vocabModel: 'claude-haiku-5-5', apiBase: 'https://api.anthropic.com', aiMock: false };

async function callClaudeJson({ system, prompt, maxTokens = 2500, model = config.model, schema = GENERIC_SCHEMA }) {
  if (config.aiMock) return parseJson(await mockRespond(system, prompt));
  if (!config.anthropicKey) throw new AiError('伺服器尚未設定 ANTHROPIC_API_KEY（Supabase secrets）。');
  const res = await fetch(`${config.apiBase}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      tools: [{ name: 'submit', description: 'Submit the result as the JSON object described in the request.', input_schema: schema }],
      tool_choice: { type: 'auto' }, // some models reject forcing a tool; the text fallback in parseJson covers a plain reply
      messages: [{ role: 'user', content: `${prompt}\n\nSubmit the result by calling the submit tool.` }],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const body = await res.text();
    if (/credit balance/i.test(body)) throw new AiError('Claude API 餘額不足（credit balance），請到 Anthropic Console 儲值');
    if (res.status === 401) throw new AiError('Claude API key 無效（401），請檢查 ANTHROPIC_API_KEY');
    if (res.status === 529 || res.status === 503) throw new AiError(`Claude 伺服器忙碌中（${res.status}）`);
    if (res.status === 429) throw new AiError('Claude API 請求太頻繁（429）');
    throw new AiError(`Claude API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  if (data.stop_reason === 'max_tokens') throw Object.assign(new AiError('AI 回應太長被截斷'), { truncated: true });
  const tool = data.content.find(b => b.type === 'tool_use');
  if (tool && tool.input && typeof tool.input === 'object') return revive(tool.input);
  return revive(parseJson(data.content.filter(b => b.type === 'text').map(b => b.text).join('')));
}

// Fallback for text replies: strip code fences and repair the usual small slips before giving up.
function parseJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new AiError('AI 回應不是 JSON');
  const raw = text.slice(start, end + 1);
  try { return JSON.parse(raw); } catch { /* try a repair below */ }
  const repaired = raw
    .replace(/}\s*{/g, '},{')                    // missing comma between objects
    .replace(/"\s*\n\s*"/g, '",\n"')              // missing comma between strings on separate lines
    .replace(/,\s*([}\]])/g, '$1');               // trailing commas
  try { return JSON.parse(repaired); } catch (e) {
    console.error('[ai] unparseable response:', raw.slice(0, 500));
    throw new AiError(`AI 回傳的格式有誤（${e.message}）`);
  }
}

// The model sometimes wraps the answer in an extra layer ({"result": {...}} or {"input": {...}}).
// Try the object itself first, then each nested object, before giving up.
function validateUnwrapped(got, validate) {
  const tries = [got];
  for (let o = got, depth = 0; o && typeof o === 'object' && !Array.isArray(o) && depth < 3; depth++) {
    const inner = Object.values(o).filter(v => v && typeof v === 'object' && !Array.isArray(v));
    if (inner.length !== 1) break;
    tries.push(inner[0]);
    o = inner[0];
  }
  let first;
  for (const t of tries) {
    try { validate(t); return t; } catch (e) { first ??= e; }
  }
  const keys = got && typeof got === 'object' ? Object.keys(got).join(',') : typeof got;
  console.error(`[ai] rejected output, top-level keys: ${keys}; start: ${JSON.stringify(got).slice(0, 300)}`);
  throw first;
}

// `charge` counts one call against the user's daily quota (throws when the quota is used up).
const MAX_OUTPUT_TOKENS = 16000;

async function askJson(opts, validate, charge) {
  if (charge) await charge();
  // which job this is, for the logs: the first line of the prompt
  const label = String(opts.prompt || '').split('\n')[0].slice(0, 60);
  let lastErr;
  let maxTokens = opts.maxTokens || 2500;
  for (let i = 0; i < 3; i++) {
    try {
      const got = await callClaudeJson({ ...opts, maxTokens });
      return validateUnwrapped(got, validate);
    } catch (e) {
      lastErr = e;
      if (e instanceof AiError && /API_KEY|401|403|credit|balance/i.test(e.message)) break;
      console.error(`[ai] attempt ${i + 1} failed (${label}; max_tokens ${maxTokens}):`, e.message);
      // the same limit would cut it off again: give the next attempt twice the room
      if (e.truncated) {
        if (maxTokens >= MAX_OUTPUT_TOKENS) break;
        maxTokens = Math.min(MAX_OUTPUT_TOKENS, maxTokens * 2);
      }
    }
  }
  if (lastErr instanceof AiError) throw new AiError(`${lastErr.message}。已自動重試，仍然失敗，請稍後再試。`);
  throw new AiError(`AI 回應處理失敗（${lastErr.message}），請稍後再試。`);
}

const must = (cond, msg) => { if (!cond) throw new AiError(`AI output invalid: ${msg}`); };
const validQuestions = (qs, n) => {
  must(Array.isArray(qs) && qs.length >= n, 'questions');
  for (const q of qs) {
    must(q && typeof q.q === 'string' && Array.isArray(q.options) && q.options.length === 4, 'question shape');
    q.answer = toIndex(q.answer);
    must(Number.isInteger(q.answer) && q.answer >= 0 && q.answer < 4, 'answer index');
    q.options = q.options.map(String);
    q.explain_zh = String(q.explain_zh || '');
  }
};

const QUESTION = obj({ q: STR, options: { ...STRS, minItems: 4, maxItems: 4 }, answer: { type: 'integer', minimum: 0, maximum: 3 }, explain_zh: STR });
const QUESTIONS = { type: 'array', items: QUESTION };

// ---------------- Generation ----------------
const GEN_SYSTEM = `You write practice items for the 2026 TOEFL iBT (the redesigned format introduced January 2026).
Items must be original, factually sound, natural North American English, and match the requested CEFR level.
Return ONLY one JSON object, no markdown fences, no commentary.
Explanations meant for the learner ("explain_zh") must be in Traditional Chinese with Taiwan usage, never Simplified characters or mainland terms.`;

const GEN = {
  ctw: band => ({
    prompt: `Write one academic paragraph for the "Complete the Words" task at CEFR ${cefrFor(band)}.
- 70-90 words, 4-6 sentences, on a university-level topic (science, history, social science, arts, technology).
- The first sentence should be a self-contained topic sentence.
- Avoid proper nouns, numbers, and hyphenated words after the first sentence.
JSON: {"topic": string, "passage": string}`,
    schema: obj({ topic: STR, passage: STR }, ['passage']),
    validate: o => must(typeof o.passage === 'string' && o.passage.split(/\s+/).length >= 50, 'passage'),
    build: o => buildCtw(o.passage.trim()),
  }),
  rdl: band => ({
    prompt: `Write one "Read in Daily Life" set at CEFR ${cefrFor(band)}.
- A short everyday text: pick one of email, text message, notice, sign, menu, schedule, social media post, flyer, product label.
- Length: ${band < 3 ? '20-50' : band < 5 ? '60-110' : '100-150'} words.
- 3 multiple-choice questions (4 options each, one correct) testing detail, inference, and purpose.
JSON: {"genre": string, "text": string, "questions": [{"q": string, "options": [4 strings], "answer": 0-3, "explain_zh": string}]}`,
    schema: obj({ genre: STR, text: STR, questions: QUESTIONS }, ['text', 'questions']),
    validate: o => { must(typeof o.text === 'string', 'text'); validQuestions(o.questions, 2); },
    build: o => o,
  }),
  acad: band => ({
    prompt: `Write one "Read an Academic Passage" set at CEFR ${cefrFor(band)}.
- An introductory-textbook style passage of 170-210 words with a title.
- 5 multiple-choice questions (4 options, one correct), covering: main idea, a key detail, an inference, vocabulary in context, and the rhetorical purpose of a sentence.
JSON: {"title": string, "passage": string, "questions": [{"q": string, "options": [4 strings], "answer": 0-3, "explain_zh": string}]}`,
    schema: obj({ title: STR, passage: STR, questions: QUESTIONS }, ['passage', 'questions']),
    validate: o => { must(typeof o.passage === 'string', 'passage'); validQuestions(o.questions, 5); },
    build: o => o,
  }),
  bas: band => ({
    prompt: `Write 5 different "Build a Sentence" items at CEFR ${cefrFor(band)}.
Each item is a short campus or daily-life exchange: speaker A says something; the learner rebuilds speaker B's reply from word chunks.
- The reply is ${band < 4 ? '6-9' : '9-14'} words, split into ${band < 4 ? '4-5' : '5-7'} chunks of 1-3 words, in the correct order.
- Test grammar such as question word order, embedded questions, auxiliaries, prepositions, relative clauses.
- Optionally one "extra" distractor chunk that does not belong (or null).
- "end" is the final punctuation of the reply ("." or "?").
JSON: {"items": [{"speaker": "name of A", "context": "what A says", "answer": [chunks in correct order], "extra": string|null, "end": "."|"?", "explain_zh": string}]}`,
    schema: obj({ items: { type: 'array', items: obj({ speaker: STR, context: STR, answer: STRS,
      extra: { type: ['string', 'null'] }, end: { type: 'string', enum: ['.', '?'] }, explain_zh: STR }, ['context', 'answer']) } }),
    validate: o => {
      must(Array.isArray(o.items), 'items');
      // drop malformed items rather than failing the whole batch
      o.items = o.items.filter(it => it && typeof it.context === 'string' && Array.isArray(it.answer) && it.answer.length >= 3
        && it.answer.every(c => typeof c === 'string' && c.trim()));
      must(o.items.length >= 3, 'items');
    },
    build: o => o.items.map(it => ({
      speaker: String(it.speaker || 'A'),
      context: it.context,
      answer: it.answer.map(c => c.trim()),
      extra: typeof it.extra === 'string' && it.extra.trim() ? it.extra.trim() : null,
      end: it.end === '?' ? '?' : '.',
      explain_zh: String(it.explain_zh || ''),
    })), // several items per call
  }),
  // ---------- Listening ----------
  lcr: band => ({
    prompt: `Write 5 different "Listen and Choose a Response" items at CEFR ${cefrFor(band)}.
Each item: one person says one short sentence in a campus or daily-life situation (a question, request, offer, complaint or piece of news), ${band < 4 ? '5-10' : '8-16'} words, natural spoken North American English.
The learner hears it once and picks the most natural reply from 4 written options. Exactly one option is right.
Wrong options must be tempting: reuse words from the sentence, answer a different question (where vs when), use the wrong tense or person, or sound polite but not fit.
Vary the situations and sentence types across the 5 items. "voice" is "f" or "m".
JSON: {"items": [{"voice": "f"|"m", "says": string, "options": [4 strings], "answer": 0-3, "explain_zh": string}]}`,
    schema: obj({ items: { type: 'array', items: obj({ voice: { type: 'string', enum: ['f', 'm'] }, says: STR, options: { ...STRS, minItems: 4, maxItems: 4 },
      answer: { type: 'integer', minimum: 0, maximum: 3 }, explain_zh: STR }, ['says', 'options', 'answer']) } }),
    validate: o => {
      must(Array.isArray(o.items), 'items');
      o.items = o.items.filter(it => {
        if (!it || typeof it.says !== 'string' || !it.says.trim()) return false;
        try { validQuestions([{ q: '', options: it.options, answer: it.answer, explain_zh: it.explain_zh }], 1); } catch { return false; }
        it.answer = toIndex(it.answer);
        return true;
      });
      must(o.items.length >= 3, 'items');
    },
    build: o => o.items.map(it => {
      const v = it.voice === 'm' ? 'm' : 'f';
      return { script: [{ s: v === 'm' ? 'Man' : 'Woman', v, t: it.says.trim() }],
        questions: [{ q: '', options: it.options.map(String), answer: it.answer, explain_zh: String(it.explain_zh || '') }] };
    }),
  }),
  conv: band => ({
    prompt: `Write one "Listen to a Conversation" set at CEFR ${cefrFor(band)}.
- Two people talk in a campus situation (two students, or a student and an office worker, librarian, advisor or professor).
- 8-12 turns, ${band < 4 ? '120-170' : '170-230'} words in total, natural spoken English (some "well", "actually", "oh, I see"), with a clear problem or purpose.
- Give the two speakers different genders so their voices sound different ("voice": "f" or "m").
- Then 2 multiple-choice questions (4 options, one correct): one on the main purpose or problem, one on a detail, an inference, or what a speaker will probably do next.
JSON: {"title": short English title, "speakers": [{"name": string, "role": string, "voice": "f"|"m"}, {...}], "turns": [{"speaker": name, "text": string}], "questions": [{"q": string, "options": [4 strings], "answer": 0-3, "explain_zh": string}]}`,
    schema: obj({ title: STR, speakers: { type: 'array', minItems: 2, maxItems: 2, items: obj({ name: STR, role: STR, voice: { type: 'string', enum: ['f', 'm'] } }) },
      turns: { type: 'array', items: obj({ speaker: STR, text: STR }) }, questions: QUESTIONS }, ['speakers', 'turns', 'questions']),
    validate: o => {
      o.speakers = asList(o.speakers).filter(s => s && typeof s.name === 'string');
      o.turns = asList(o.turns).filter(t => t && typeof t.text === 'string' && t.text.trim());
      must(o.speakers.length >= 2 && o.turns.length >= 4, 'conversation');
      validQuestions(o.questions, 2);
    },
    build: o => {
      const [a, b] = o.speakers;
      const voiceA = a.voice === 'm' ? 'm' : 'f';
      const voiceB = b.voice === 'f' || b.voice === 'm' ? (b.voice === voiceA ? (voiceA === 'f' ? 'm' : 'f') : b.voice) : (voiceA === 'f' ? 'm' : 'f');
      const voice = { [a.name]: voiceA, [b.name]: voiceB };
      return {
        title: String(o.title || ''),
        speakers: [{ name: a.name, role: String(a.role || ''), v: voiceA }, { name: b.name, role: String(b.role || ''), v: voiceB }],
        // a turn whose speaker name doesn't match (e.g. "Student") takes turns with the other voice
        script: o.turns.map((t, i) => ({ s: String(t.speaker || (i % 2 ? b.name : a.name)), v: voice[t.speaker] || (i % 2 ? voiceB : voiceA), t: t.text.trim() })),
        questions: o.questions.slice(0, 3),
      };
    },
  }),
  ann: band => ({
    prompt: `Write one "Listen to an Announcement" set at CEFR ${cefrFor(band)}.
- One speaker makes an announcement on campus or at the start of a class (a schedule change, an event, a new rule, a reminder about an assignment), ${band < 4 ? '70-100' : '100-140'} words, spoken style.
- Then 2 multiple-choice questions (4 options, one correct): the main purpose, and a detail or what listeners should do.
JSON: {"title": short English title, "speaker": {"role": string, "voice": "f"|"m"}, "text": string, "questions": [{"q": string, "options": [4 strings], "answer": 0-3, "explain_zh": string}]}`,
    schema: obj({ title: STR, speaker: obj({ role: STR, voice: { type: 'string', enum: ['f', 'm'] } }), text: STR, questions: QUESTIONS }, ['text', 'questions']),
    validate: o => { must(typeof o.text === 'string' && o.text.split(/\s+/).length >= 40, 'announcement'); validQuestions(o.questions, 2); },
    build: o => {
      const v = o.speaker?.voice === 'm' ? 'm' : 'f';
      return { title: String(o.title || ''), role: String(o.speaker?.role || ''), script: [{ s: String(o.speaker?.role || 'Speaker'), v, t: o.text.trim() }],
        questions: o.questions.slice(0, 3) };
    },
  }),
  talk: band => ({
    prompt: `Write one "Listen to an Academic Talk" set at CEFR ${cefrFor(band)}.
- A professor speaks in an introductory university course (science, history, social science, arts or technology), ${band < 4 ? '170-220' : '230-300'} words, spoken lecture style ("So, today...", "Now, you might wonder...").
- One clear main idea with an example or two; define any technical term the first time it is used.
- Then 4 multiple-choice questions (4 options, one correct): main idea, a key detail, why the professor mentions something (function), and an inference.
JSON: {"title": short English title, "course": string, "voice": "f"|"m", "text": string, "questions": [{"q": string, "options": [4 strings], "answer": 0-3, "explain_zh": string}]}`,
    schema: obj({ title: STR, course: STR, voice: { type: 'string', enum: ['f', 'm'] }, text: STR, questions: QUESTIONS }, ['text', 'questions']),
    validate: o => { must(typeof o.text === 'string' && o.text.split(/\s+/).length >= 100, 'talk'); validQuestions(o.questions, 4); },
    build: o => {
      const v = o.voice === 'm' ? 'm' : 'f';
      return { title: String(o.title || ''), course: String(o.course || ''), script: [{ s: 'Professor', v, t: o.text.trim() }], questions: o.questions.slice(0, 5) };
    },
  }),

  // ---------- Speaking (typed) ----------
  rep: band => ({
    prompt: `Write one "Listen and Repeat" set at CEFR ${cefrFor(band)}.
- A short situation, for example a guide showing new students around the campus library, a lab, a museum or a dorm.
- The guide says 7 sentences, one at a time, that the learner must repeat exactly. They get longer: from ${band < 4 ? '4-6 words up to 10-12' : '6-8 words up to 14-18'} words.
- Natural spoken sentences that fit the situation in order. No numerals (write "three", not "3"), no abbreviations, no names that are hard to spell.
JSON: {"situation": one English sentence describing the situation, "situation_zh": the same in Traditional Chinese, "voice": "f"|"m", "sentences": [7 strings]}`,
    schema: obj({ situation: STR, situation_zh: STR, voice: { type: 'string', enum: ['f', 'm'] }, sentences: { ...STRS, minItems: 7, maxItems: 7 } }, ['sentences']),
    validate: o => {
      o.sentences = asList(o.sentences).map(String).map(s => s.trim()).filter(Boolean);
      must(o.sentences.length >= 5, 'sentences');
    },
    build: o => {
      const v = o.voice === 'm' ? 'm' : 'f';
      return { situation: String(o.situation || ''), situation_zh: String(o.situation_zh || ''), sentences: o.sentences.slice(0, 7).map(t => ({ v, t })) };
    },
  }),
  interview: band => ({
    prompt: `Write one "Take an Interview" set at CEFR ${cefrFor(band)}.
- A researcher interviews the learner for a study (topics such as campus life, study habits, technology, work, travel, the environment, community).
- "intro": one or two sentences the interviewer says first, explaining the study.
- 4 questions, asked one at a time, 12-35 words each, moving from personal experience, to an opinion with reasons, to a comparison or a hypothetical, to a broader issue.
JSON: {"topic": short English topic, "topic_zh": the topic in Traditional Chinese, "voice": "f"|"m", "intro": string, "questions": [4 strings]}`,
    schema: obj({ topic: STR, topic_zh: STR, voice: { type: 'string', enum: ['f', 'm'] }, intro: STR, questions: { ...STRS, minItems: 4, maxItems: 4 } }, ['intro', 'questions']),
    validate: o => {
      o.questions = asList(o.questions).map(String).map(s => s.trim()).filter(Boolean);
      must(o.questions.length >= 4, 'interview questions');
    },
    build: o => ({ topic: String(o.topic || ''), topic_zh: String(o.topic_zh || ''), v: o.voice === 'm' ? 'm' : 'f',
      intro: String(o.intro || ''), questions: o.questions.slice(0, 4) }),
  }),

  email: band => ({
    prompt: `Write one "Write an Email" prompt at CEFR ${cefrFor(band)} difficulty.
- A realistic situation (university, workplace, community, landlord, club, store) where the learner must write an email.
- Give the recipient and exactly 3 things the email must do (e.g. explain, request, suggest).
JSON: {"scenario": string, "to": string, "points": [3 strings]}`,
    schema: obj({ scenario: STR, to: STR, points: { ...STRS, minItems: 3, maxItems: 3 } }),
    validate: o => {
      o.points = asList(o.points).map(String);
      must(typeof o.scenario === 'string' && o.points.length >= 3, 'email');
      o.points = o.points.slice(0, 3);
    },
    build: o => ({ scenario: o.scenario, to: String(o.to || ''), points: o.points }),
  }),
  disc: band => ({
    prompt: `Write one "Write for an Academic Discussion" prompt at CEFR ${cefrFor(band)} difficulty.
- A professor posts a question in an online class discussion (course name given), 60-100 words, ending in a clear question that invites an opinion.
- Two students reply with different views, 40-70 words each.
JSON: {"course": string, "professor": string, "students": [{"name": string, "post": string}, {"name": string, "post": string}]}`,
    schema: obj({ course: STR, professor: STR, students: { type: 'array', minItems: 2, maxItems: 2, items: obj({ name: STR, post: STR }) } }),
    validate: o => {
      o.students = asList(o.students).filter(s => s && typeof s.post === 'string');
      must(typeof o.professor === 'string' && o.students.length >= 2, 'disc');
      o.students = o.students.slice(0, 2).map(s => ({ name: String(s.name || 'Student'), post: s.post }));
    },
    build: o => ({ course: String(o.course || ''), professor: o.professor, students: o.students }),
  }),
};

// Returns an array of item contents (bas returns several at once).
async function generate(type, band, charge) {
  const g = GEN[type](band);
  // a full reading passage with 5 explained questions needs more room than 3000
  const out = await askJson({ system: GEN_SYSTEM, prompt: g.prompt, maxTokens: 8000, schema: g.schema }, g.validate, charge);
  const built = g.build(out);
  return Array.isArray(built) ? built : [built];
}

// ---------------- Grading ----------------
const GRADE_SYSTEM = `You are an experienced TOEFL iBT writing rater using the 2026 format, scoring on ETS's 0-5 scale.
Rubric (holistic):
5 = fully successful: fully addresses the task, well elaborated, clear organization, varied and precise language, at most minor errors.
4 = generally successful: addresses the task well, some lapses in elaboration or occasional noticeable errors.
3 = partially successful: addresses the task but with limited development, or frequent errors that sometimes obscure meaning.
2 = mostly unsuccessful: limited relevance or development, many errors.
1 = unsuccessful: little relevant content, language barely communicates.
0 = blank, off-topic, or copied from the prompt.
Score in steps of 0.5. Be accurate rather than generous: the learner is aiming for an overall band 5.0 and needs a truthful estimate.
Write all explanations in Traditional Chinese with Taiwan usage (never Simplified characters or mainland terms); quote and rewrite English text in English.
Return ONLY one JSON object, no markdown fences.`;

const GRADE_SCHEMA = `JSON:
{"score": number 0-5,
 "summary_zh": "2-3 sentences: overall judgement and the single biggest thing holding the score back",
 "task_zh": "did it do what the task asked? (for email: each of the 3 points)",
 "strengths_zh": [up to 3 strings],
 "corrections": [up to 8 items {"original": exact quote from the response, "revised": corrected English, "why_zh": short reason}],
 "upgrade": [up to 4 items {"original": a plain phrase from the response, "better": a more precise or academic alternative}],
 "model_answer": "a rewrite of the learner's response at score 5, keeping their ideas",
 "next_focus_zh": "one concrete thing to practise next time"}`;

const GRADE_TOOL_SCHEMA = obj({
  score: { type: 'number', minimum: 0, maximum: 5 },
  summary_zh: STR, task_zh: STR, strengths_zh: STRS,
  corrections: { type: 'array', items: obj({ original: STR, revised: STR, why_zh: STR }) },
  upgrade: { type: 'array', items: obj({ original: STR, better: STR }) },
  model_answer: STR, next_focus_zh: STR,
}, ['score', 'summary_zh']);

function gradePrompt(type, content, text, seconds) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (type === 'email') {
    return `Task: Write an Email (time limit 7 minutes; typical strong responses are 100-150 words).
Situation: ${content.scenario}
Recipient: ${content.to}
The email must: ${content.points.map((p, i) => `(${i + 1}) ${p}`).join(' ')}

Learner's response (${words} words, written in ${Math.round(seconds / 60)} min):
"""
${text}
"""
${GRADE_SCHEMA}`;
  }
  return `Task: Write for an Academic Discussion (time limit 10 minutes; strong responses are 100+ words and add a new idea rather than repeating the students).
Course: ${content.course}
Professor: ${content.professor}
${content.students.map(s => `${s.name}: ${s.post}`).join('\n')}

Learner's response (${words} words, written in ${Math.round(seconds / 60)} min):
"""
${text}
"""
${GRADE_SCHEMA}`;
}

async function grade(type, content, text, seconds, charge) {
  if (!text.trim()) {
    return { score: 0, summary_zh: '沒有作答內容。', strengths_zh: [], corrections: [], upgrade: [], model_answer: '', next_focus_zh: '' };
  }
  const fb = await askJson({ system: GRADE_SYSTEM, prompt: gradePrompt(type, content, text, seconds), maxTokens: 3000, schema: GRADE_TOOL_SCHEMA },
    o => {
      // The score may arrive as a string ("3.5", "4/5") or slightly out of range; accept and clamp it.
      let raw = o.score;
      if (raw && typeof raw === 'object') raw = Object.values(raw).find(v => typeof v === 'number' || typeof v === 'string'); // {"score": {"value": 4}}
      const n = typeof raw === 'number' ? raw : parseFloat(String(raw ?? '').match(/\d+(\.\d+)?/)?.[0]);
      must(Number.isFinite(n), 'score');
      o.score = Math.min(5, Math.max(0, n));
    }, charge);
  const s = v => (v === undefined || v === null ? '' : String(v));
  return {
    score: fb.score,
    summary_zh: s(fb.summary_zh),
    task_zh: s(fb.task_zh),
    strengths_zh: asList(fb.strengths_zh).map(s),
    corrections: asList(fb.corrections).filter(c => c && typeof c === 'object')
      .map(c => ({ original: s(c.original), revised: s(c.revised), why_zh: s(c.why_zh) })),
    upgrade: asList(fb.upgrade).filter(u => u && typeof u === 'object')
      .map(u => ({ original: s(u.original), better: s(u.better) })),
    model_answer: s(fb.model_answer),
    next_focus_zh: s(fb.next_focus_zh),
  };
}

// ---------------- Speaking: Take an Interview (typed) ----------------
const INTERVIEW_SYSTEM = `You are an experienced TOEFL iBT speaking rater for the 2026 "Take an Interview" task, scoring on ETS's 0-5 scale.
The learner TYPED their answers instead of speaking, so you cannot judge pronunciation, intonation or fluency.
Judge the answers as if they were a transcript of speech: relevance to each question, development (reasons, examples, detail), coherence, and range and accuracy of grammar and vocabulary.
Do not penalize a natural spoken style (contractions, "I mean", short sentences). On the real test each answer is spoken for 45 seconds (about 80-110 words); here each was typed in 90 seconds, so 50-80 words is a full answer.
5 = all four answers relevant and well developed, precise language, few errors. 4 = generally well developed, some lapses. 3 = relevant but limited development or frequent errors. 2 = minimal development or many errors. 1 = barely relevant or very little. 0 = no answer.
Score in steps of 0.5. Be accurate rather than generous: the learner is aiming for an overall band 5.0.
Write all explanations in Traditional Chinese with Taiwan usage (never Simplified characters or mainland terms); quote and rewrite English in English.
Return ONLY one JSON object, no markdown fences.`;

const INTERVIEW_SCHEMA = obj({
  score: { type: 'number', minimum: 0, maximum: 5 },
  summary_zh: STR,
  per_question: { type: 'array', items: obj({ comment_zh: STR, better: STR }) },
  strengths_zh: STRS,
  corrections: { type: 'array', items: obj({ original: STR, revised: STR, why_zh: STR }) },
  upgrade: { type: 'array', items: obj({ original: STR, better: STR }) },
  next_focus_zh: STR,
}, ['score', 'summary_zh', 'per_question']);

async function gradeInterview(content, answers, charge) {
  if (!answers.some(a => a.trim())) {
    return { score: 0, summary_zh: '沒有作答內容。', per_question: content.questions.map(() => ({ comment_zh: '沒有作答。', better: '' })),
      strengths_zh: [], corrections: [], upgrade: [], next_focus_zh: '' };
  }
  const prompt = `Interview topic: ${content.topic}
Interviewer: ${content.intro}
${content.questions.map((q, i) => {
    const a = answers[i] || '';
    const words = a.trim().split(/\s+/).filter(Boolean).length;
    return `Question ${i + 1}: ${q}\nLearner's answer (${words} words):\n"""\n${a.trim() || '(no answer)'}\n"""`;
  }).join('\n\n')}

JSON:
{"score": number 0-5 for the whole interview,
 "summary_zh": "2-3 sentences: overall judgement and the single biggest thing holding the score back",
 "per_question": [exactly ${content.questions.length} items in order {"comment_zh": "1-2 sentences on this answer", "better": "a stronger spoken answer of 60-90 words that keeps the learner's idea"}],
 "strengths_zh": [up to 3 strings],
 "corrections": [up to 8 items {"original": exact quote from an answer, "revised": corrected English, "why_zh": short reason}],
 "upgrade": [up to 4 items {"original": a plain phrase from an answer, "better": a more natural or precise alternative}],
 "next_focus_zh": "one concrete thing to practise next time"}`;
  const fb = await askJson({ system: INTERVIEW_SYSTEM, prompt, maxTokens: 4000, schema: INTERVIEW_SCHEMA }, o => {
    let raw = o.score;
    if (raw && typeof raw === 'object') raw = Object.values(raw).find(v => typeof v === 'number' || typeof v === 'string');
    const n = typeof raw === 'number' ? raw : parseFloat(String(raw ?? '').match(/\d+(\.\d+)?/)?.[0]);
    must(Number.isFinite(n), 'score');
    o.score = Math.min(5, Math.max(0, n));
  }, charge);
  const s = v => (v === undefined || v === null ? '' : String(v));
  const per = asList(fb.per_question).map(p => (p && typeof p === 'object' ? { comment_zh: s(p.comment_zh), better: s(p.better) } : { comment_zh: s(p), better: '' }));
  return {
    score: fb.score,
    summary_zh: s(fb.summary_zh),
    per_question: content.questions.map((_, i) => per[i] || { comment_zh: '', better: '' }),
    strengths_zh: asList(fb.strengths_zh).map(s),
    corrections: asList(fb.corrections).filter(c => c && typeof c === 'object').map(c => ({ original: s(c.original), revised: s(c.revised), why_zh: s(c.why_zh) })),
    upgrade: asList(fb.upgrade).filter(u => u && typeof u === 'object').map(u => ({ original: s(u.original), better: s(u.better) })),
    next_focus_zh: s(fb.next_focus_zh),
  };
}

// ---------------- 學測翻譯 ----------------
const GSAT_SYSTEM = `You are a senior high school English teacher in Taiwan and an experienced rater of the 學測 (GSAT) English 中譯英 section, which is scored by the 大考中心 (CEEC) rules:
- Each sentence is worth 4 points, split into 2 parts of 2 points each (part 1 = the first half of the meaning, part 2 = the second half). Parts are scored independently.
- Each error costs 0.5 point within its part, down to 0 for that part. A part whose meaning is entirely missing or wrong scores 0.
- The same spelling or grammar error repeated counts only once.
- A missing capital at the start of the sentence costs 0.5 once; unsuitable punctuation costs 0.5 once.
- Any accurate, grammatical translation is acceptable; there is no single correct answer. Do not count style preferences or less elegant but correct wording as errors.
- Target vocabulary is mostly at levels 1-4 of the 大考中心 word list (some level 5).
Write every explanation in Traditional Chinese with Taiwan usage (never Simplified characters or mainland terms), in the warm, clear voice of a good tutor. Quote and rewrite English in English.
Return ONLY one JSON object, no markdown fences.`;

const GSAT_PREP_ITEM = obj({
  parts: { ...STRS, minItems: 2, maxItems: 2 },
  refs: { ...STRS, minItems: 1, maxItems: 3 },
  hints: { type: 'array', items: obj({ zh: STR, en: STR }) },
  focus_zh: STR,
}, ['parts', 'refs']);

function cleanPrepSentence(p, zh) {
  const parts = asList(p?.parts).map(String).map(s => s.trim()).filter(Boolean);
  const refs = asList(p?.refs).map(String).map(s => s.trim()).filter(Boolean);
  must(refs.length >= 1, 'refs');
  return {
    zh,
    parts: parts.length >= 2 ? parts.slice(0, 2) : [zh, ''],
    refs: refs.slice(0, 3),
    hints: asList(p?.hints).filter(h => h && typeof h === 'object' && h.en).slice(0, 3).map(h => ({ zh: String(h.zh || ''), en: String(h.en) })),
    focus_zh: String(p?.focus_zh || ''),
  };
}

// Scoring parts, reference translations and hints for a past-paper set (saved once, shared).
async function gsatPrepare(sentences, charge) {
  const prompt = `Prepare this 學測 translation set for practice and scoring.
${sentences.map((s, i) => `Sentence ${i + 1}: ${s}`).join('\n')}

For each sentence:
- "parts": the Chinese sentence split into the 2 scoring parts (2 points each), as a rater would split it, each a contiguous piece of the original Chinese.
- "refs": 2 natural reference translations a strong student could write (vocabulary at 大考 levels 1-4 where possible).
- "hints": 1-3 key words or phrases a student is likely to need, as {"zh": Chinese, "en": English}.
- "focus_zh": the grammar or sentence pattern this sentence tests, in a few Traditional Chinese words (e.g. 現在完成式、分詞構句).
JSON: {"topic_zh": short topic, "sentences": [{"parts": [2 strings], "refs": [strings], "hints": [{"zh", "en"}], "focus_zh": string}]}`;
  const schema = obj({ topic_zh: STR, sentences: { type: 'array', items: GSAT_PREP_ITEM } }, ['sentences']);
  const out = await askJson({ system: GSAT_SYSTEM, prompt, maxTokens: 3000, schema }, o => {
    must(Array.isArray(o.sentences) && o.sentences.length >= sentences.length, 'sentences');
    must(o.sentences.slice(0, sentences.length).every(x => x && asList(x.refs).length), 'refs');
  }, charge);
  return { topic_zh: String(out.topic_zh || ''), sentences: sentences.map((zh, i) => cleanPrepSentence(out.sentences[i], zh)) };
}

// New sets in the 學測 style; `focus` lists the learner's frequent mistakes to practise.
async function gsatGenerate(count, focus, avoid, charge) {
  const prompt = `Write ${count} new 學測 中譯英 practice sets in the style of the 111-115 學測 papers.
- Each set: 2 related Chinese sentences on one topic (society, technology, environment, health, school life, culture, Taiwan), 18-35 Chinese characters each, written in natural Taiwanese Mandarin.
- Each set should test one or two useful patterns: present perfect, participle construction, relative clause, passive voice, comparison, not only... but also, it is ... that/to, cause and effect, concession (although / despite), etc.
- Vocabulary needed should be mostly at 大考 levels 1-4.
${focus.length ? `- This learner often makes these mistakes; make some sets give practice on them: ${focus.join('; ')}` : ''}
${avoid.length ? `- Avoid these topics, already used: ${avoid.join('、')}` : ''}
For each sentence also give "parts" (the 2 scoring halves of the Chinese), "refs" (2 reference translations), "hints" (1-3 key words {"zh","en"}) and "focus_zh" (the pattern tested).
JSON: {"sets": [{"topic_zh": string, "sentences": [{"zh": string, "parts": [2 strings], "refs": [strings], "hints": [{"zh","en"}], "focus_zh": string}]}]}`;
  const schema = obj({ sets: { type: 'array', items: obj({ topic_zh: STR,
    sentences: { type: 'array', minItems: 2, maxItems: 2, items: obj({ zh: STR, ...GSAT_PREP_ITEM.properties }, ['zh', 'parts', 'refs']) } }, ['sentences']) } });
  const out = await askJson({ system: GSAT_SYSTEM, prompt, maxTokens: 6000, schema }, o => {
    must(Array.isArray(o.sets), 'sets');
    o.sets = o.sets.filter(st => st && Array.isArray(st.sentences) && st.sentences.length >= 2
      && st.sentences.every(x => x && typeof x.zh === 'string' && x.zh.trim() && asList(x.refs).length));
    must(o.sets.length >= 1, 'sets');
  }, charge);
  return out.sets.map(st => {
    const ss = st.sentences.slice(0, 2).map(x => cleanPrepSentence(x, x.zh.trim()));
    return { source: 'ai', label: st.topic_zh ? `新題・${String(st.topic_zh).slice(0, 20)}` : '新題', sentences: ss.map(x => ({ zh: x.zh })),
      prep: { topic_zh: String(st.topic_zh || ''), sentences: ss } };
  });
}

const GSAT_ERROR_TYPES = ['spelling', 'grammar', 'word', 'omission', 'capital', 'punct'];

const GSAT_GRADE_SCHEMA = obj({
  summary_zh: STR,
  sentences: { type: 'array', items: obj({
    errors: { type: 'array', items: obj({
      part: { type: 'integer', minimum: 1, maximum: 2 },
      type: { type: 'string', enum: GSAT_ERROR_TYPES },
      original: STR, fix: STR, why_zh: STR, key: STR,
    }, ['part', 'type', 'original', 'fix', 'why_zh']) },
    minimal_fix: STR,
    better: { type: 'array', items: obj({ en: STR, note_zh: STR }) },
    comment_zh: STR,
  }, ['errors', 'minimal_fix']) },
  phrases: { type: 'array', items: obj({ phrase: STR, zh: STR, example: STR, example_zh: STR, note_zh: STR, used: { type: 'boolean' } }, ['phrase', 'zh']) },
  pitfalls_zh: STRS,
  next_step_zh: STR,
}, ['summary_zh', 'sentences']);

// Finds the errors and writes the tutoring. The points are worked out from the errors in code (gsat.js).
async function gsatGrade(prep, answers, charge) {
  const prompt = `Score and teach this 學測 translation answer.
${prep.sentences.map((s, i) => `Sentence ${i + 1}: ${s.zh}
  Part 1: ${s.parts[0]}
  Part 2: ${s.parts[1]}
  Reference translations (others are fine too): ${s.refs.join(' / ')}
  Learner's translation: """${answers[i] || ''}"""`).join('\n\n')}

For each sentence list every error that costs points under the CEEC rules:
- "part": 1 or 2, the part the error is in.
- "type": spelling | grammar | word (wrong or unnatural word choice, a missing or extra word or detail) | omission (the meaning of that whole part is missing or entirely wrong) | capital (sentence does not start with a capital) | punct (unsuitable punctuation).
- "original": the exact words from the learner's sentence ("" for an omission); "fix": the corrected words; "why_zh": a short tutor-style explanation.
- "key": a short id that is the same for a repeated identical mistake (e.g. "spell:enviroment", "sv-agreement:people-is").
Do not invent errors: a correct alternative translation has no errors. Count each mistake once.
Also for each sentence: "minimal_fix" (the learner's sentence corrected with as few changes as possible, keeping their structure), "better" (1-2 more natural versions with a short "note_zh" on what makes them better), "comment_zh" (1-2 sentences).
For the whole set:
- "phrases": 3-5 phrases or sentence patterns from this set worth memorising for the exam (e.g. "take ... for granted", "strike a balance between A and B"), each with "zh", an "example" sentence, "example_zh", a short "note_zh" on usage, and "used": true if the learner already used it correctly.
- "pitfalls_zh": up to 3 common traps in this set (Chinglish such as "there have", a missing subject, tense, countable nouns).
- "summary_zh": 2-3 sentences of overall feedback; "next_step_zh": one concrete thing to do next time.
JSON: {"summary_zh", "sentences": [{"errors": [{"part", "type", "original", "fix", "why_zh", "key"}], "minimal_fix", "better": [{"en", "note_zh"}], "comment_zh"}], "phrases": [{"phrase", "zh", "example", "example_zh", "note_zh", "used"}], "pitfalls_zh": [strings], "next_step_zh"}`;
  const fb = await askJson({ system: GSAT_SYSTEM, prompt, maxTokens: 5000, schema: GSAT_GRADE_SCHEMA }, o => {
    must(Array.isArray(o.sentences) && o.sentences.length >= prep.sentences.length, 'sentences');
  }, charge);
  const s = v => (v === undefined || v === null ? '' : String(v));
  return {
    summary_zh: s(fb.summary_zh),
    sentences: prep.sentences.map((_, i) => {
      const x = fb.sentences[i] && typeof fb.sentences[i] === 'object' ? fb.sentences[i] : {};
      return {
        errors: asList(x.errors).filter(e => e && typeof e === 'object').map(e => ({
          part: Number(e.part) === 2 ? 2 : 1,
          type: GSAT_ERROR_TYPES.includes(e.type) ? e.type : 'word',
          original: s(e.original), fix: s(e.fix), why_zh: s(e.why_zh), key: s(e.key),
        })),
        minimal_fix: s(x.minimal_fix),
        better: asList(x.better).filter(b => b && typeof b === 'object' && b.en).slice(0, 2).map(b => ({ en: s(b.en), note_zh: s(b.note_zh) })),
        comment_zh: s(x.comment_zh),
      };
    }),
    phrases: asList(fb.phrases).filter(p => p && typeof p === 'object' && p.phrase).slice(0, 6)
      .map(p => ({ phrase: s(p.phrase).trim(), zh: s(p.zh), example: s(p.example), example_zh: s(p.example_zh), note_zh: s(p.note_zh), used: p.used === true })),
    pitfalls_zh: asList(fb.pitfalls_zh).map(s).slice(0, 3),
    next_step_zh: s(fb.next_step_zh),
  };
}

// A follow-up question to the tutor about one graded answer.
async function gsatAsk(context, chat, question, charge) {
  const prompt = `A student practising 學測 translation is asking about their graded answer.
${context}
${chat.length ? `Earlier questions in this conversation:\n${chat.map(c => `Q: ${c.q}\nA: ${c.a}`).join('\n')}\n` : ''}
The student now asks: """${question}"""
Answer like a patient tutor in Traditional Chinese (Taiwan usage), 2-6 sentences, with a short English example when it helps. If the student proposes an alternative wording, say plainly whether it is acceptable on the exam and why. Stay on English and this exam.
JSON: {"answer_zh": string}`;
  const out = await askJson({ system: GSAT_SYSTEM, prompt, maxTokens: 1200, schema: obj({ answer_zh: STR }) },
    o => must(typeof o.answer_zh === 'string' && o.answer_zh.trim(), 'answer'), charge);
  return out.answer_zh.trim();
}

// ---------------- Vocabulary ----------------
const VOCAB_SYSTEM = `You help a Taiwanese university student build vocabulary for the 2026 TOEFL iBT.
All Chinese must be Traditional Chinese with Taiwan usage (e.g. 資訊, 軟體, 品質; never Simplified characters or mainland terms).
Return ONLY one JSON object, no markdown fences, no commentary.`;

const VOCAB_TOPICS = 'biology, geology and earth science, astronomy, environmental science, psychology, sociology, economics, history and archaeology, anthropology, art and architecture, linguistics, technology, campus life, and verbs/adjectives used in academic argument';

async function vocabCandidates(band, avoid, charge, count = 80) {
  const prompt = `List ${count} different English words worth learning for the TOEFL iBT, at about CEFR ${cefrFor(band)}${band % 1 ? '+' : ''} difficulty.
- Mix: roughly half general academic vocabulary (Academic Word List style), the rest topic words spread across: ${VOCAB_TOPICS}.
- Single words only, base/dictionary form, lowercase. No phrases, no proper nouns, no British-only spellings.
- Prefer words that actually appear in TOEFL reading and listening and that a learner at this level often misspells or does not know.
${avoid.length ? `- Do NOT include any of these: ${avoid.join(', ')}` : ''}
JSON: {"words": [{"w": string, "topic": string}]}`;
  const schema = { type: 'object', required: ['words'], properties: { words: { type: 'array',
    items: { type: 'object', required: ['w'], properties: { w: { type: 'string' }, topic: { type: 'string' } } } } } };
  const out = await askJson({ system: VOCAB_SYSTEM, prompt, maxTokens: 4000, model: config.vocabModel, schema },
    o => must(Array.isArray(o.words) && o.words.length >= 10, 'words'), charge);
  return out.words
    .map(x => ({ w: String(x.w || '').trim().toLowerCase(), topic: String(x.topic || '').slice(0, 40) }))
    .filter(x => /^[a-z]+$/.test(x.w) && x.w.length >= 3);
}

const QUIZ_SPEC = `- "quiz": a fill-in-the-blank multiple-choice question for this word:
  - "sentence": a NEW natural academic or campus sentence (12-22 words), different from "example", where the word appears exactly once in exactly this spelling, replaced by ___ (three underscores)
  - "distractors": exactly 3 wrong options, each a real English word with the same part of speech. Mix two kinds: near-synonyms that do NOT fit this sentence (wrong collocation, nuance or register), and easily confused look-alikes (e.g. adapt/adopt, affect/effect). Each must be clearly wrong in this sentence. For each give "why_zh": one short Traditional Chinese reason it does not fit.
  - "synonyms": 1-4 words that mean nearly the same as the target word (used to recognise close answers), may be empty`;

const QUIZ_SCHEMA = { type: 'object', required: ['sentence', 'distractors'], properties: {
  sentence: STR,
  distractors: { type: 'array', items: { type: 'object', required: ['w', 'why_zh'], properties: { w: STR, why_zh: STR } } },
  synonyms: { type: 'array', items: STR } } };

function validQuiz(word, q) {
  if (!q || typeof q.sentence !== 'string' || !q.sentence.includes('___')) return false;
  if (!Array.isArray(q.distractors) || q.distractors.length < 3) return false;
  const ds = q.distractors.map(d => String(d.w || '').trim().toLowerCase());
  return ds.every(d => /^[a-z-]+$/.test(d) && d !== word) && new Set(ds).size === ds.length;
}

function cleanQuiz(q) {
  return {
    sentence: q.sentence.trim(),
    distractors: q.distractors.slice(0, 3).map(d => ({ w: String(d.w).trim().toLowerCase(), why_zh: String(d.why_zh || '') })),
    synonyms: (q.synonyms || []).map(x => String(x).trim().toLowerCase()).filter(x => /^[a-z-]+$/.test(x)).slice(0, 4),
  };
}

// Word lists are split into small calls: ten cards in one reply came close to the output limit, and the
// model then sometimes sent the list as one long (and broken) string. The batch is still charged once.
const VOCAB_CHUNK = 5;

async function inChunks(list, charge, fn) {
  if (charge) await charge();
  const chunks = [];
  for (let i = 0; i < list.length; i += VOCAB_CHUNK) chunks.push(list.slice(i, i + VOCAB_CHUNK));
  const results = await Promise.allSettled(chunks.map(c => fn(c)));
  const ok = results.filter(r => r.status === 'fulfilled').map(r => r.value);
  const bad = results.filter(r => r.status === 'rejected');
  if (!ok.length) throw bad[0].reason;
  if (bad.length) console.error(`[ai] ${bad.length} of ${chunks.length} parts failed, keeping the rest:`, bad[0].reason.message);
  return ok;
}

async function vocabCards(words, charge) {
  return (await inChunks(words, charge, vocabCardsPart)).flat();
}

async function vocabCardsPart(words) {
  const prompt = `Write a study card for each word: ${words.join(', ')}
For each word:
- "pos": part of speech abbreviation (n. / v. / adj. / adv.); if several, the one most common in academic English
- "zh": the Traditional Chinese meaning(s) most relevant to academic English, at most 20 characters
- "example": one natural academic sentence (12-22 words) that uses the word in exactly this spelling (do not inflect it)
- "example_zh": Traditional Chinese translation of the example
- "collocations": 2-3 common collocations, e.g. "conduct research"
- "family": other useful forms, e.g. [{"w": "analysis", "pos": "n."}]
- "tip_zh": a short spelling or usage tip in Traditional Chinese, or "" if none
${QUIZ_SPEC}
JSON: {"cards": [{"w", "pos", "zh", "example", "example_zh", "collocations", "family", "tip_zh", "quiz": {"sentence", "distractors": [{"w", "why_zh"}], "synonyms"}}]}
"cards" must be a real JSON array of objects, not a string. Keep every field short.`;
  const schema = { type: 'object', required: ['cards'], properties: { cards: { type: 'array', items: { type: 'object',
    required: ['w', 'pos', 'zh', 'example', 'quiz'],
    properties: { w: STR, pos: STR, zh: STR, example: STR, example_zh: STR, tip_zh: STR,
      collocations: { type: 'array', items: STR },
      family: { type: 'array', items: { type: 'object', properties: { w: STR, pos: STR } } },
      quiz: QUIZ_SCHEMA } } } } };
  const out = await askJson({ system: VOCAB_SYSTEM, prompt, maxTokens: 1000 + 700 * words.length, model: config.vocabModel, schema },
    o => must(Array.isArray(o.cards) && o.cards.length >= 1, 'cards'), null);
  return out.cards.filter(c => c && typeof c === 'object').map(c => {
    const w = String(c.w || '').toLowerCase();
    const { quiz, ...rest } = c;
    const card = {
      ...rest,
      collocations: asList(rest.collocations).map(String),
      family: asList(rest.family).map(f => (f && typeof f === 'object' ? { w: String(f.w || ''), pos: String(f.pos || '') } : { w: String(f), pos: '' })).filter(f => f.w),
    };
    return validQuiz(w, quiz) ? { ...card, quiz: cleanQuiz(quiz) } : card; // a bad quiz is regenerated later
  });
}

// Quiz questions for words that already have a card (cards made before quizzes existed, or a bad quiz).
async function vocabQuizzes(items, charge) {
  const maps = await inChunks(items, charge, vocabQuizzesPart);
  return new Map(maps.flatMap(m => [...m]));
}

async function vocabQuizzesPart(items) {
  const prompt = `For each word below, write a quiz question. The meaning given is the one to test.
${items.map(i => `- ${i.word} (${i.pos || ''} ${i.zh || ''})`).join('\n')}
For each word:
${QUIZ_SPEC}
JSON: {"quizzes": [{"w": string, "quiz": {"sentence", "distractors": [{"w", "why_zh"}], "synonyms"}}]}
"quizzes" must be a real JSON array of objects, not a string.`;
  const schema = { type: 'object', required: ['quizzes'], properties: { quizzes: { type: 'array',
    items: { type: 'object', required: ['w', 'quiz'], properties: { w: STR, quiz: QUIZ_SCHEMA } } } } };
  const out = await askJson({ system: VOCAB_SYSTEM, prompt, maxTokens: 800 + 450 * items.length, model: config.vocabModel, schema },
    o => must(Array.isArray(o.quizzes) && o.quizzes.length >= 1, 'quizzes'), null);
  const res = new Map();
  for (const q of out.quizzes) {
    const w = String(q.w || '').toLowerCase();
    if (validQuiz(w, q.quiz)) res.set(w, cleanQuiz(q.quiz));
  }
  return res;
}

export function makeAi(env) {
  Object.assign(config, env);
  return { generate, grade, gradeInterview, vocabCandidates, vocabCards, vocabQuizzes, gsatPrepare, gsatGenerate, gsatGrade, gsatAsk };
}

export { AiError, cefrFor };
