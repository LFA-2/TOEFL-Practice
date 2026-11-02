// Claude API calls: item generation and grading of written responses.
// Runs only inside the Edge Function: the API key never reaches the browser.
import { buildCtw } from './tasks.js';
import { respond as mockRespond } from './ai-mock.js';
import { AiError } from './errors.js';

const CEFR = { 1: 'A1', 2: 'A2', 3: 'B1', 4: 'B2', 5: 'C1', 6: 'C2' };
const cefrFor = band => CEFR[Math.min(6, Math.max(1, Math.round(band)))];

// Structured output: the API is forced to call a "submit" tool, so the result arrives as an
// already-parsed object instead of JSON text the model might mistype (a missing comma etc.).
const GENERIC_SCHEMA = { type: 'object', additionalProperties: true };

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
  if (data.stop_reason === 'max_tokens') throw new AiError('AI 回應太長被截斷');
  const tool = data.content.find(b => b.type === 'tool_use');
  if (tool && tool.input && typeof tool.input === 'object') return tool.input;
  return parseJson(data.content.filter(b => b.type === 'text').map(b => b.text).join(''));
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

// `charge` counts one call against the user's daily quota (throws when the quota is used up).
async function askJson(opts, validate, charge) {
  if (charge) await charge();
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const obj = await callClaudeJson(opts);
      validate(obj);
      return obj;
    } catch (e) {
      lastErr = e;
      if (e instanceof AiError && /API_KEY|401|403|credit|balance/i.test(e.message)) break;
      console.error(`[ai] attempt ${i + 1} failed:`, e.message);
    }
  }
  if (lastErr instanceof AiError) throw new AiError(`${lastErr.message}。已自動重試，仍然失敗，請稍後再試。`);
  throw new AiError(`AI 回應處理失敗（${lastErr.message}），請稍後再試。`);
}

const must = (cond, msg) => { if (!cond) throw new AiError(`AI output invalid: ${msg}`); };
const validQuestions = (qs, n) => {
  must(Array.isArray(qs) && qs.length >= n, 'questions');
  for (const q of qs) {
    must(typeof q.q === 'string' && Array.isArray(q.options) && q.options.length === 4, 'question shape');
    must(Number.isInteger(q.answer) && q.answer >= 0 && q.answer < 4, 'answer index');
  }
};

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
    validate: o => must(typeof o.passage === 'string' && o.passage.split(/\s+/).length >= 50, 'passage'),
    build: o => buildCtw(o.passage.trim()),
  }),
  rdl: band => ({
    prompt: `Write one "Read in Daily Life" set at CEFR ${cefrFor(band)}.
- A short everyday text: pick one of email, text message, notice, sign, menu, schedule, social media post, flyer, product label.
- Length: ${band < 3 ? '20-50' : band < 5 ? '60-110' : '100-150'} words.
- 3 multiple-choice questions (4 options each, one correct) testing detail, inference, and purpose.
JSON: {"genre": string, "text": string, "questions": [{"q": string, "options": [4 strings], "answer": 0-3, "explain_zh": string}]}`,
    validate: o => { must(typeof o.text === 'string', 'text'); validQuestions(o.questions, 2); },
    build: o => o,
  }),
  acad: band => ({
    prompt: `Write one "Read an Academic Passage" set at CEFR ${cefrFor(band)}.
- An introductory-textbook style passage of 170-210 words with a title.
- 5 multiple-choice questions (4 options, one correct), covering: main idea, a key detail, an inference, vocabulary in context, and the rhetorical purpose of a sentence.
JSON: {"title": string, "passage": string, "questions": [{"q": string, "options": [4 strings], "answer": 0-3, "explain_zh": string}]}`,
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
    validate: o => {
      must(Array.isArray(o.items) && o.items.length >= 3, 'items');
      for (const it of o.items) must(Array.isArray(it.answer) && it.answer.length >= 3 && typeof it.context === 'string', 'bas item');
    },
    build: o => o.items, // several items per call
  }),
  email: band => ({
    prompt: `Write one "Write an Email" prompt at CEFR ${cefrFor(band)} difficulty.
- A realistic situation (university, workplace, community, landlord, club, store) where the learner must write an email.
- Give the recipient and exactly 3 things the email must do (e.g. explain, request, suggest).
JSON: {"scenario": string, "to": string, "points": [3 strings]}`,
    validate: o => must(typeof o.scenario === 'string' && Array.isArray(o.points) && o.points.length === 3, 'email'),
    build: o => o,
  }),
  disc: band => ({
    prompt: `Write one "Write for an Academic Discussion" prompt at CEFR ${cefrFor(band)} difficulty.
- A professor posts a question in an online class discussion (course name given), 60-100 words, ending in a clear question that invites an opinion.
- Two students reply with different views, 40-70 words each.
JSON: {"course": string, "professor": string, "students": [{"name": string, "post": string}, {"name": string, "post": string}]}`,
    validate: o => must(typeof o.professor === 'string' && Array.isArray(o.students) && o.students.length === 2, 'disc'),
    build: o => o,
  }),
};

// Returns an array of item contents (bas returns several at once).
async function generate(type, band, charge) {
  const g = GEN[type](band);
  const obj = await askJson({ system: GEN_SYSTEM, prompt: g.prompt, maxTokens: 3000 }, g.validate, charge);
  const built = g.build(obj);
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
  return askJson({ system: GRADE_SYSTEM, prompt: gradePrompt(type, content, text, seconds), maxTokens: 3000 },
    o => must(typeof o.score === 'number' && o.score >= 0 && o.score <= 5, 'score'), charge);
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

const STR = { type: 'string' };
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

async function vocabCards(words, charge) {
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
JSON: {"cards": [{"w", "pos", "zh", "example", "example_zh", "collocations", "family", "tip_zh", "quiz": {"sentence", "distractors": [{"w", "why_zh"}], "synonyms"}}]}`;
  const schema = { type: 'object', required: ['cards'], properties: { cards: { type: 'array', items: { type: 'object',
    required: ['w', 'pos', 'zh', 'example', 'quiz'],
    properties: { w: STR, pos: STR, zh: STR, example: STR, example_zh: STR, tip_zh: STR,
      collocations: { type: 'array', items: STR },
      family: { type: 'array', items: { type: 'object', properties: { w: STR, pos: STR } } },
      quiz: QUIZ_SCHEMA } } } } };
  const out = await askJson({ system: VOCAB_SYSTEM, prompt, maxTokens: 800 + 520 * words.length, model: config.vocabModel, schema },
    o => must(Array.isArray(o.cards) && o.cards.length >= 1, 'cards'), charge);
  return out.cards.map(c => {
    const w = String(c.w || '').toLowerCase();
    const { quiz, ...card } = c;
    return validQuiz(w, quiz) ? { ...card, quiz: cleanQuiz(quiz) } : card; // a bad quiz is regenerated later
  });
}

// Quiz questions for words that already have a card (cards made before quizzes existed, or a bad quiz).
async function vocabQuizzes(items, charge) {
  const prompt = `For each word below, write a quiz question. The meaning given is the one to test.
${items.map(i => `- ${i.word} (${i.pos || ''} ${i.zh || ''})`).join('\n')}
For each word:
${QUIZ_SPEC}
JSON: {"quizzes": [{"w": string, "quiz": {"sentence", "distractors": [{"w", "why_zh"}], "synonyms"}}]}`;
  const schema = { type: 'object', required: ['quizzes'], properties: { quizzes: { type: 'array',
    items: { type: 'object', required: ['w', 'quiz'], properties: { w: STR, quiz: QUIZ_SCHEMA } } } } };
  const out = await askJson({ system: VOCAB_SYSTEM, prompt, maxTokens: 600 + 320 * items.length, model: config.vocabModel, schema },
    o => must(Array.isArray(o.quizzes) && o.quizzes.length >= 1, 'quizzes'), charge);
  const res = new Map();
  for (const q of out.quizzes) {
    const w = String(q.w || '').toLowerCase();
    if (validQuiz(w, q.quiz)) res.set(w, cleanQuiz(q.quiz));
  }
  return res;
}

export function makeAi(env) {
  Object.assign(config, env);
  return { generate, grade, vocabCandidates, vocabCards, vocabQuizzes };
}

export { AiError, cefrFor };
