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
  if (system.includes('"Take an Interview"')) {
    return j({
      score: 3,
      summary_zh: '（測試模式）回答切題，但理由和例子不夠具體。',
      per_question: [1, 2, 3, 4].map(n => ({ comment_zh: `（測試）第 ${n} 題回答切題。`, better: `This is a mock stronger answer for question ${n}.` })),
      strengths_zh: ['回答都有對到問題'],
      corrections: [{ original: 'I am agree', revised: 'I agree', why_zh: 'agree 是動詞，不用 be' }],
      upgrade: [{ original: 'good', better: 'beneficial' }],
      next_focus_zh: '每個回答加一個具體例子。',
    });
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
  const mq = (n, k = 4) => Array.from({ length: k }, (_, i) => ({ q: `Mock listening question ${n}-${i + 1}?`, options: ['A one', 'B two', 'C three', 'D four'], answer: i % 4, explain_zh: '（測試）解析' }));
  if (prompt.includes('"Listen and Choose a Response"')) {
    return j({ items: [1, 2, 3, 4, 5].map(n => ({ voice: n % 2 ? 'f' : 'm', says: `Do you know when the library closes tonight, number ${counter}-${n}?`,
      options: ['At nine, I think.', 'Yes, I read it.', 'In the library.', 'It closed a book.'], answer: 0, explain_zh: '問時間，回答時間。' })) });
  }
  if (prompt.includes('"Listen to a Conversation"')) {
    return j({ title: `Mock conversation ${counter}`, speakers: [{ name: 'Lena', role: 'student', voice: 'f' }, { name: 'Mark', role: 'librarian', voice: 'm' }],
      turns: [['Lena', 'Hi, I need a book that is checked out.'], ['Mark', 'You can place a hold on it.'], ['Lena', 'How long does that take?'], ['Mark', 'Usually about a week.'],
        ['Lena', 'Okay, I will do that.'], ['Mark', 'Great, it only takes a minute.']].map(([speaker, text]) => ({ speaker, text })), questions: mq(counter, 2) });
  }
  if (prompt.includes('"Listen to an Announcement"')) {
    return j({ title: `Mock announcement ${counter}`, speaker: { role: 'Professor', voice: 'm' },
      text: 'Good morning, everyone. Before we start, a quick reminder about next week. The lab session on Tuesday is moved to Thursday at the same time, because the building will be closed for repairs. Please bring your lab notebooks and finish the reading before you come. If you cannot attend on Thursday, send me an email by Monday so we can find another time.',
      questions: mq(counter, 2) });
  }
  if (prompt.includes('"Listen to an Academic Talk"')) {
    return j({ title: `Mock talk ${counter}`, course: 'Biology', voice: 'f', text: 'So, today we will look at how plants respond to light. '.repeat(14), questions: mq(counter, 4) });
  }
  if (prompt.includes('"Listen and Repeat"')) {
    return j({ situation: 'A guide shows new students around the library.', situation_zh: '導覽員帶新生參觀圖書館。', voice: 'f',
      sentences: ['Welcome to the main library.', 'The front desk is on your left.', 'You can borrow up to ten books at once.', 'Quiet study rooms are on the third floor.',
        'Please return your books before the end of the semester.', 'If you need help finding a book, ask anyone at the information desk.',
        'The library stays open until midnight during the two weeks before final exams.'] });
  }
  if (prompt.includes('"Take an Interview"')) {
    return j({ topic: `Study habits ${counter}`, topic_zh: '讀書習慣', voice: 'm', intro: 'Thanks for joining. We are studying how university students plan their study time.',
      questions: ['Where do you usually study, and why?', 'Do you prefer studying alone or with others? Explain.', 'How would your study habits change if all classes were online?', 'Should universities require students to attend every class? Why or why not?'] });
  }
  if (prompt.includes('"Write an Email"')) {
    return j({ scenario: `Mock email scenario ${counter}.`, to: 'Professor Lee', points: ['Explain the problem', 'Ask for an extension', 'Suggest a new date'] });
  }
  if (prompt.includes('"Write for an Academic Discussion"')) {
    return j({ course: 'Sociology', professor: `Mock professor question ${counter}?`, students: [{ name: 'Ana', post: 'Mock view one.' }, { name: 'Ben', post: 'Mock view two.' }] });
  }
  return j({});
}

export { respond };
