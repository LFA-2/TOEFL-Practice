// Starter items so the diagnostic works before any API call.
const { db } = require('./db');
const { buildCtw } = require('./tasks');
const { insertItems } = require('./bank');

const CTW = [
  [3.5, 'Many cities are planting more trees along their streets. Trees give shade in the summer, which keeps sidewalks and buildings cooler. They also clean the air by taking in dust and some harmful gases. In addition, people often feel calmer when they walk in green areas. For these reasons, planners now see trees as an important part of city design.'],
  [4.5, 'Sleep plays a central role in how the brain stores new information. During the day, experiences are held briefly in a region called the hippocampus. While we sleep, these memories are replayed and gradually moved to the outer layer of the brain for long-term storage. Students who rest after studying usually remember more than those who stay awake. This suggests that sleep is an active process rather than simply a period of rest.'],
  [5.0, 'The invention of the printing press transformed the way knowledge spread across Europe. Before its arrival, books were copied by hand, which made them rare and extremely expensive. Printed texts could be produced quickly and in large numbers, so prices fell and literacy gradually increased. Scholars in distant cities were able to compare identical copies of the same work. As a result, errors were corrected more easily, and new ideas circulated with remarkable speed.'],
  [5.5, 'Economists have long debated whether minimum wage laws reduce employment. Classical theory predicts that raising the cost of labor should lead firms to hire fewer workers. However, several influential studies found little measurable decline in jobs after moderate increases. One explanation is that higher pay lowers turnover, which saves employers the considerable expense of recruiting and training. Critics respond that effects may appear only over longer periods or in regions where wages are already low.'],
];

const RDL = [
  [3.5, {
    genre: 'notice',
    text: 'Campus Fitness Center\nStarting Monday, the pool will open at 6:30 a.m. instead of 7:00 a.m. on weekdays. Weekend hours stay the same. Lockers must be emptied every night; items left overnight will be taken to the front desk.',
    questions: [
      { q: 'What is changing at the fitness center?', options: ['The weekend hours', 'The weekday opening time of the pool', 'The price of lockers', 'The location of the front desk'], answer: 1, explain_zh: '公告說平日泳池改為 6:30 開放，週末不變。' },
      { q: 'What happens to items left in a locker overnight?', options: ['They are thrown away', 'They stay in the locker', 'They are moved to the front desk', 'They are given to charity'], answer: 2, explain_zh: '最後一句：過夜物品會被拿到櫃檯。' },
    ],
  }],
  [4.5, {
    genre: 'email',
    text: 'Hi Jordan,\nThanks for agreeing to cover my shift at the bookstore on Saturday. Just a heads-up: the delivery truck usually arrives around noon, so someone needs to sign for the boxes. The new textbooks for the biology course should be shelved first, since classes start Monday. If anything comes up, Priya is the manager on duty and can answer questions.\nThanks again,\nSam',
    questions: [
      { q: 'Why is Sam writing to Jordan?', options: ['To ask Jordan to work on Saturday', 'To give information about a shift Jordan will work', 'To complain about a late delivery', 'To recommend a biology course'], answer: 1, explain_zh: 'Jordan 已經答應代班，信件是提醒代班時要注意的事。' },
      { q: 'Why should the biology textbooks be shelved first?', options: ['They are the heaviest boxes', 'Priya asked for them', 'Students will need them soon', 'They arrived before noon'], answer: 2, explain_zh: '「since classes start Monday」表示學生很快需要。' },
      { q: 'What can be inferred about Priya?', options: ['She will be working on Saturday', 'She ordered the textbooks', 'She is a biology student', 'She will sign for the delivery'], answer: 0, explain_zh: '她是當天值班經理（manager on duty），所以星期六在店裡。' },
    ],
  }],
];

const ACAD = [
  [4.5, {
    title: 'Why Some Birds Migrate at Night',
    passage: 'Many songbirds that fly thousands of kilometers each year travel mainly at night. At first this seems surprising, since these birds are active during the day for the rest of the year. Researchers have proposed several advantages of nocturnal migration. First, the night air is usually cooler and calmer, which reduces the amount of water and energy a bird loses while flying. Second, predators such as hawks hunt mostly in daylight, so flying in darkness lowers the risk of attack. A third explanation concerns navigation. Experiments suggest that birds use the pattern of stars to keep their direction, and some species can also sense the Earth\'s magnetic field. Finally, traveling at night leaves the daytime free for feeding. Because migrating birds burn fuel rapidly, they must stop regularly to rebuild their fat reserves, and food is easiest to find in daylight. Together, these factors explain why the night sky in spring and autumn is filled with travelers that are rarely seen.',
    questions: [
      { q: 'What is the passage mainly about?', options: ['How birds find food during the day', 'Reasons many songbirds migrate at night', 'Why hawks hunt in daylight', 'How scientists track migrating birds'], answer: 1, explain_zh: '全文列出夜間遷徙的幾個好處。' },
      { q: 'According to the passage, how does cooler night air help migrating birds?', options: ['It makes stars easier to see', 'It helps them find insects', 'It reduces the water and energy they lose', 'It keeps predators away'], answer: 2, explain_zh: '第四句：涼爽平穩的空氣減少水分與能量流失。' },
      { q: 'The word "nocturnal" in the passage is closest in meaning to', options: ['long-distance', 'seasonal', 'happening at night', 'dangerous'], answer: 2, explain_zh: 'nocturnal 意思是夜間的。' },
      { q: 'What can be inferred about migrating songbirds during the day?', options: ['They rest without eating', 'They spend much of the time feeding', 'They fly at higher altitudes', 'They follow the magnetic field'], answer: 1, explain_zh: '白天留給覓食，因為需要補充脂肪。' },
      { q: 'Why does the author mention experiments on stars and magnetic fields?', options: ['To support the navigation explanation', 'To show that birds are intelligent', 'To argue against nocturnal migration', 'To describe how predators hunt'], answer: 0, explain_zh: '用來支持「導航」這個解釋。' },
    ],
  }],
];

const BAS = [
  [3.0, { speaker: 'Lena', context: 'Are you coming to the study group tonight?', answer: ['I can\'t', 'because I', 'have to', 'work late'], extra: null, end: '.', explain_zh: '「because + 子句」說明原因。' }],
  [3.5, { speaker: 'Omar', context: 'Do you know where the lab is?', answer: ['I think', 'it is', 'on the', 'second floor'], extra: 'are', end: '.', explain_zh: '主詞 it 搭配 is，are 是干擾項。' }],
  [4.0, { speaker: 'Mei', context: 'Did the professor say anything about the exam?', answer: ['she told us', 'that it', 'would cover', 'chapters', 'four to six'], extra: null, end: '.', explain_zh: '間接引述：told us that + 子句，時態後移 will → would。' }],
  [4.5, { speaker: 'Carlos', context: 'I need to talk to the advisor.', answer: ['do you know', 'what time', 'her office', 'hours', 'start'], extra: 'does', end: '?', explain_zh: '間接問句（what time her office hours start）用直述句語序，不加 does。' }],
  [4.5, { speaker: 'Anna', context: 'Which book did you finally choose?', answer: ['the one', 'that our', 'instructor', 'recommended', 'last week'], extra: null, end: '.', explain_zh: '關係子句 that our instructor recommended 修飾 the one。' }],
  [5.0, { speaker: 'Ravi', context: 'Why weren\'t you at the meeting?', answer: ['nobody', 'had told me', 'that it', 'had been', 'moved to Tuesday'], extra: 'was', end: '.', explain_zh: '過去完成式：會議被改期發生在「被告知」之前。' }],
  [5.0, { speaker: 'Julia', context: 'Should I submit the report by email?', answer: ['it would be', 'better', 'if you', 'uploaded it', 'to the portal'], extra: null, end: '.', explain_zh: 'it would be better if + 過去式，表示委婉建議。' }],
  [5.5, { speaker: 'Tom', context: 'Have the results been published yet?', answer: ['not yet', 'but they', 'are expected', 'to be released', 'by Friday'], extra: 'will', end: '.', explain_zh: 'be expected to be released 被動語態；will 是干擾項。' }],
];

const EMAIL = [
  [4.5, { scenario: 'You borrowed a camera from your university\'s media lab for a class project. When you returned it, you noticed that the lens cap was missing, and you cannot find it.', to: 'Ms. Harper, the media lab coordinator', points: ['Explain what happened', 'Apologize and offer a solution', 'Ask whether you can still borrow equipment next week'] }],
  [5.0, { scenario: 'Your neighbor has started practicing the drums late at night, and it is affecting your sleep before early classes. You have never spoken to them about it.', to: 'Your neighbor, Chris', points: ['Introduce yourself and describe the problem politely', 'Explain how it affects you', 'Propose a compromise'] }],
];

const DISC = [
  [4.5, { course: 'Education', professor: 'This week we are discussing how universities should prepare students for their careers. Some people argue that universities should require every student to complete an internship before graduating, while others think internships should remain optional. What is your view? Should internships be required? Why or why not?', students: [
    { name: 'Kelly', post: 'I think internships should be required. Many students graduate without knowing what a real workplace is like. An internship helps them build skills and contacts, and it often leads directly to a job offer.' },
    { name: 'Andrew', post: 'I disagree. Not every field offers useful internships, and many are unpaid. Students who need to work part-time jobs to pay tuition would be at a disadvantage if internships were mandatory.' },
  ] }],
  [5.0, { course: 'Environmental Science', professor: 'Cities around the world are trying to reduce car traffic. One approach is to make public transportation completely free, paid for by taxes. Do you think free public transportation is an effective way to reduce traffic and pollution? Explain your reasoning.', students: [
    { name: 'Sofia', post: 'Free transit is a great idea. Cost is one of the main reasons people choose to drive, so removing fares would get many cars off the road and cut emissions quickly.' },
    { name: 'Daniel', post: 'I\'m not convinced. In my city, people drive because buses are slow and unreliable, not because tickets are expensive. The money would be better spent improving service.' },
  ] }],
];

function seedIfEmpty() {
  const n = db.prepare('SELECT COUNT(*) c FROM items').get().c;
  if (n > 0) return;
  for (const [d, p] of CTW) insertItems('ctw', d, [buildCtw(p)], 'seed');
  for (const [d, c] of RDL) insertItems('rdl', d, [c], 'seed');
  for (const [d, c] of ACAD) insertItems('acad', d, [c], 'seed');
  for (const [d, c] of BAS) insertItems('bas', d, [c], 'seed');
  for (const [d, c] of EMAIL) insertItems('email', d, [c], 'seed');
  for (const [d, c] of DISC) insertItems('disc', d, [c], 'seed');
  console.log('Seeded starter items.');
}

module.exports = { seedIfEmpty };
