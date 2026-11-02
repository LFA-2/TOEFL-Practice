// Canned AI responses for offline development (AI_MOCK=1). Never used in production.
let counter = 0;

function respond(system, prompt) {
  counter++;
  const j = o => JSON.stringify(o);
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
