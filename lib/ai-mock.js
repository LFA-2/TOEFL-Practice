// Canned AI responses for offline development (AI_MOCK=1). Never used in production.
let counter = 0;

function mockQuiz(w) {
  return { sentence: `The new policy had a ___ influence on how students chose their courses.`,
    distractors: [{ w: 'prevalent', why_zh: '（測試）意思接近但搭配不對' }, { w: 'pervasive', why_zh: '（測試）語氣太強' }, { w: 'provident', why_zh: '（測試）長得像但意思不同' }],
    synonyms: ['widespread'] };
}

function respond(system, prompt) {
  counter++;
  const j = o => JSON.stringify(o);
  if (prompt.includes('worth learning for the TOEFL')) {
    const letters = n => { let s = ''; do { s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); } while (n); return s; };
    const real = ['ubiquitous', 'mitigate', 'sediment', 'photosynthesis', 'hypothesis', 'empirical', 'erosion', 'tuition', 'prerequisite', 'inhabit'];
    return j({ words: Array.from({ length: 80 }, (_, i) => ({ w: counter === 1 && i < real.length ? real[i] : `mock${letters(counter * 100 + i)}`, topic: 'mock' })) });
  }
  if (prompt.includes('Write a study card')) {
    const list = prompt.split('\n')[0].replace('Write a study card for each word: ', '').split(', ');
    return j({ cards: list.map(w => ({ w, pos: 'adj.', zh: `（測試）${w} 的意思`, example: `Researchers found that the effect was ${w} across many regions of the country.`,
      example_zh: '研究人員發現這個效應在全國許多地區都很普遍。', collocations: [`${w} feature`, `increasingly ${w}`], family: [{ w: `${w}ly`, pos: 'adv.' }], tip_zh: '注意拼字。',
      quiz: mockQuiz(w) })) });
  }
  if (prompt.includes('write a quiz question')) {
    const list = prompt.split('\n').filter(l => l.startsWith('- ') && l.includes('(')).map(l => l.slice(2).split(' ')[0]);
    return j({ quizzes: list.map(w => ({ w, quiz: mockQuiz(w) })) });
  }
  if (system.includes('rater')) {
    return j({
      score: 3.5,
      summary_zh: '（測試模式）內容切題，但論點展開不足。',
      task_zh: '有回應題目要求。',
      strengths_zh: ['立場清楚'],
      corrections: [{ original: 'I think that', revised: 'I believe that', why_zh: '較正式' }],
      upgrade: [{ original: 'very important', better: 'crucial' }],
      model_answer: 'This is a mock model answer.',
      next_focus_zh: '每個論點加一個具體例子。',
    });
  }
  if (prompt.includes('"Complete the Words"')) {
    return j({ topic: 'mock', passage: `Coral reefs are among the most diverse ecosystems on Earth (${counter}). They cover a tiny fraction of the ocean floor, yet they support about a quarter of all marine species. Reefs are built slowly by small animals called polyps, which produce hard skeletons of calcium carbonate. When ocean water becomes too warm, the polyps expel the algae living inside them and turn white. Scientists call this process bleaching, and repeated events can kill an entire reef within a few years.` });
  }
  if (prompt.includes('"Read in Daily Life"')) {
    return j({ genre: 'notice', text: `Library notice ${counter}: The second floor will be closed on Friday for carpet cleaning. Study rooms on the third floor remain available and can be booked online.`,
      questions: [
        { q: 'Why is the second floor closed?', options: ['A holiday', 'Cleaning', 'An exam', 'A power outage'], answer: 1, explain_zh: '公告寫地毯清潔。' },
        { q: 'What can students do?', options: ['Book a third-floor room', 'Borrow carpets', 'Skip class', 'Call the dean'], answer: 0, explain_zh: '三樓自習室可線上預約。' },
        { q: 'When is the closure?', options: ['Monday', 'Wednesday', 'Friday', 'Sunday'], answer: 2, explain_zh: '週五。' },
      ] });
  }
  if (prompt.includes('"Read an Academic Passage"')) {
    const q = (n) => ({ q: `Mock question ${n}?`, options: ['A', 'B', 'C', 'D'], answer: n % 4, explain_zh: '測試說明' });
    return j({ title: `Mock passage ${counter}`, passage: 'Lorem ipsum '.repeat(40), questions: [1, 2, 3, 4, 5].map(q) });
  }
  if (prompt.includes('"Build a Sentence"')) {
    return j({ items: [1, 2, 3, 4, 5].map(n => ({ speaker: 'Maya', context: `Mock context ${counter}-${n}?`, answer: ['I was', 'wondering', 'when the', 'library closes'], extra: 'does', end: '.', explain_zh: '間接問句不倒裝。' })) });
  }
  if (prompt.includes('"Write an Email"')) {
    return j({ scenario: `Mock email scenario ${counter}.`, to: 'Professor Lee', points: ['Explain the problem', 'Ask for an extension', 'Suggest a new date'] });
  }
  if (prompt.includes('"Write for an Academic Discussion"')) {
    return j({ course: 'Sociology', professor: `Mock professor question ${counter}?`, students: [{ name: 'Ana', post: 'Mock view one.' }, { name: 'Ben', post: 'Mock view two.' }] });
  }
  return j({});
}

module.exports = { respond };
