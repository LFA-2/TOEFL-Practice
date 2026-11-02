// Claude API calls: item generation and grading of written responses.
const config = require('./config');
const { buildCtw } = require('./tasks');
const mock = require('./ai-mock');

const CEFR = { 1: 'A1', 2: 'A2', 3: 'B1', 4: 'B2', 5: 'C1', 6: 'C2' };
const cefrFor = band => CEFR[Math.min(6, Math.max(1, Math.round(band)))];

class AiError extends Error {}

async function callClaude({ system, prompt, maxTokens = 2500 }) {
  if (config.aiMock) return mock.respond(system, prompt);
  if (!config.anthropicKey) throw new AiError('尚未設定 ANTHROPIC_API_KEY，請在 .env 裡加上 API key。');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new AiError(`Claude API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

function parseJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new AiError('AI 回應不是 JSON');
  return JSON.parse(text.slice(start, end + 1));
}

async function askJson(opts, validate) {
  let lastErr;
  for (let i = 0; i < 2; i++) {
    try {
      const obj = parseJson(await callClaude(opts));
      validate(obj);
      return obj;
    } catch (e) {
      lastErr = e;
      if (e instanceof AiError && /API_KEY|401|403/.test(e.message)) break;
    }
  }
  throw lastErr;
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
Explanations meant for the learner ("explain_zh") must be in Traditional Chinese (Taiwan usage).`;

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
async function generate(type, band) {
  const g = GEN[type](band);
  const obj = await askJson({ system: GEN_SYSTEM, prompt: g.prompt, maxTokens: 3000 }, g.validate);
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
Write all explanations in Traditional Chinese (Taiwan usage); quote and rewrite English text in English.
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

async function grade(type, content, text, seconds) {
  if (!text.trim()) {
    return { score: 0, summary_zh: '沒有作答內容。', strengths_zh: [], corrections: [], upgrade: [], model_answer: '', next_focus_zh: '' };
  }
  return askJson({ system: GRADE_SYSTEM, prompt: gradePrompt(type, content, text, seconds), maxTokens: 3000 },
    o => must(typeof o.score === 'number' && o.score >= 0 && o.score <= 5, 'score'));
}

module.exports = { generate, grade, AiError, cefrFor };
