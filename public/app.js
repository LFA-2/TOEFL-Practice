'use strict';
// TOEFL Coach client — no framework, hash routing.

const $app = document.getElementById('app');
const $tabs = document.getElementById('tabs');
let META = null;
let timerHandle = null;

// ---------- helpers ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LETTERS = 'ABCD';
const fmtBand = v => (v == null ? '—' : Number(v).toFixed(1));
const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const words = t => (t.trim().match(/\S+/g) || []).length;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
};

class AuthError extends Error {}

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (res.status === 401 && path !== '/api/login') throw new AuthError();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function setView(html, { focus = false, tab = null } = {}) {
  clearInterval(timerHandle);
  document.body.classList.toggle('focus', focus);
  $tabs.hidden = focus;
  for (const a of $tabs.querySelectorAll('a')) a.classList.toggle('on', a.dataset.tab === tab);
  $app.innerHTML = html;
  window.scrollTo(0, 0);
}

const loading = (msg = '載入中') => `<main><div class="loading"><div class="spinner"></div>${esc(msg)}</div></main>`;

function errorView(e, retry = true) {
  setView(`<main class="stack"><h2>出了點問題</h2><p class="error">${esc(e.message)}</p>
    ${retry ? '<button class="btn ghost" onclick="route()">重試</button>' : ''} <a class="btn ghost" href="#/">回到今天</a></main>`);
}

// ---------- router ----------
async function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [path, query] = hash.split('?');
  const params = new URLSearchParams(query || '');
  const parts = path.split('/').filter(Boolean);
  try {
    if (!META) META = await api('/api/meta');
    if (parts[0] === 'practice') return await practice(parts[1], params);
    if (parts[0] === 'attempt') return await attemptView(Number(parts[1]));
    if (parts[0] === 'progress') return await progressView();
    if (parts[0] === 'settings') return await settingsView();
    return await todayView();
  } catch (e) {
    if (e instanceof AuthError) return loginView();
    errorView(e);
  }
}
window.addEventListener('hashchange', route);
window.route = route;

// ---------- login ----------
function loginView() {
  setView(`<main class="stack" style="max-width:420px;padding-top:15vh">
    <h1 style="font-size:2rem">TOEFL Coach</h1>
    <form id="login">
      <label class="field"><span>密碼</span><input class="text" type="password" name="pw" autocomplete="current-password" required autofocus></label>
      <p class="error" id="err" hidden></p>
      <button class="btn block" style="margin-top:16px">登入</button>
    </form></main>`, { focus: true });
  document.getElementById('login').onsubmit = async ev => {
    ev.preventDefault();
    const err = document.getElementById('err');
    try {
      await api('/api/login', { password: ev.target.pw.value });
      META = null; route();
    } catch (e) { err.hidden = false; err.textContent = e.message; }
  };
}

// ---------- today ----------
function bandsRow(est, target) {
  const sec = est.sections;
  const cell = (k, v, cls = '') => `<div class="${cls}"><span class="v ${v == null ? 'none' : ''}">${fmtBand(v)}</span><span class="k">${k}</span></div>`;
  return `<div class="bands">
    ${cell('閱讀', sec.reading?.band)}${cell('聽力', sec.listening?.band)}${cell('口說', sec.speaking?.band)}${cell('寫作', sec.writing?.band)}
    ${cell('總分', est.overall, 'overall')}
  </div>`;
}

async function todayView() {
  setView(loading(), { tab: 'today' });
  const { plan, estimates } = await api('/api/today');
  const s = plan.settings;
  const exam = new Date(s.examDate + 'T00:00:00');
  const nextIdx = plan.tasks.findIndex(t => t.done < t.target);
  const totalMin = plan.tasks.reduce((a, t) => a + t.minutes, 0);
  const allDone = nextIdx === -1 && plan.tasks.length > 0;

  const tasks = plan.tasks.map((t, i) => {
    const meta = META.tasks[t.type];
    const left = t.target - t.done;
    const cls = ['task', left === 0 ? 'complete' : '', i === nextIdx ? 'next' : ''].join(' ');
    const bubbles = Array.from({ length: t.target }, (_, k) => `<i class="${k < t.done ? 'on' : ''}"></i>`).join('');
    const href = left > 0 ? `#/practice/${t.type}?n=${left}${t.diagnostic ? '&mode=diagnostic' : ''}` : `#/practice/${t.type}?n=1`;
    return `<a class="${cls}" href="${href}">
      <div class="spacer"><div class="name">${esc(meta.zh)}</div>
      <div class="sub">${esc(meta.name)}・約 ${t.minutes} 分鐘</div></div>
      <div class="bubbles" aria-label="完成 ${t.done} / ${t.target}">${bubbles}</div></a>`;
  }).join('');

  const intro = plan.diagnostic
    ? `<p>先做一輪<b>診斷</b>：每個題型各做一點，系統會用結果估算你的起點並排出之後的計畫。大約 ${totalMin} 分鐘，可以分次完成。</p>`
    : plan.diagnosticDone
      ? '<p>診斷完成。從明天起，每天的任務會依你的弱項自動分配。</p>'
      : `<p class="muted">${esc(plan.phase.zh)}・今天約 ${totalMin} 分鐘</p>`;

  setView(`<main>
    <div class="countdown"><span class="days">${Math.max(0, plan.daysLeft)}</span>
      <span class="unit"><b>天</b><span class="muted">到 ${exam.getMonth() + 1}/${exam.getDate()} 考試<br>目標總分 ${fmtBand(s.target)}</span></span></div>
    ${bandsRow(estimates, s.target)}
    <div class="stack">${intro}
      <div class="sheet">${tasks}</div>
      ${allDone ? '<p>今天的任務都完成了。想多練可以到「進度」挑一個題型。</p>' : ''}
      <p class="muted small">聽力與口說（打字版）會在下一版加入，目前的時間都分配給閱讀與寫作。</p>
    </div></main>`, { tab: 'today' });
}

// ---------- practice session ----------
async function practice(type, params) {
  const meta = META.tasks[type];
  if (!meta) throw new Error('沒有這個題型');
  const total = Math.max(1, Number(params.get('n')) || 1);
  const mode = params.get('mode') === 'diagnostic' ? 'diagnostic' : 'practice';
  const session = { type, meta, total, mode, index: 0, exclude: [], results: [] };
  await nextInSession(session);
}

async function nextInSession(session) {
  const { type, meta } = session;
  setView(`${topBar(session)}${loading(meta.ai ? '準備題目' : '載入題目')}`, { focus: true });
  const item = await api(`/api/next?type=${type}&exclude=${session.exclude.join(',')}`);
  session.exclude.push(item.id);
  session.item = item;
  session.started = Date.now();
  const render = { ctw: renderCtw, rdl: renderMc, acad: renderMc, bas: renderBas, email: renderWriting, disc: renderWriting }[type];
  render(session);
  startTimer(session);
}

function topBar(session) {
  return `<div class="ptop"><a class="link" href="#/" aria-label="離開練習">✕</a>
    <span class="title">${esc(session.meta.zh)}</span><span class="spacer"></span>
    <span class="muted small">${session.index + 1} / ${session.total}</span>
    <span class="timer" id="timer"></span></div>`;
}

function startTimer(session) {
  const el = document.getElementById('timer');
  const limit = session.meta.timeLimit;
  const tick = () => {
    const el2 = document.getElementById('timer');
    if (!el2) return clearInterval(timerHandle);
    const s = (Date.now() - session.started) / 1000;
    if (limit) { const left = limit - s; el2.textContent = (left < 0 ? '+' : '') + fmtTime(Math.abs(left)); el2.classList.toggle('over', left < 0); }
    else el2.textContent = fmtTime(s);
  };
  if (el) { tick(); timerHandle = setInterval(tick, 1000); }
}

async function submitSession(session, response, submitBtn) {
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = session.meta.ai ? '批改中，約 20 秒…' : '送出中…'; }
  const seconds = (Date.now() - session.started) / 1000;
  clearInterval(timerHandle);
  try {
    const result = await api('/api/submit', { itemId: session.item.id, response, seconds, mode: session.mode });
    session.results.push(result);
    store.del(`draft:${session.item.id}`);
    showResult(session, result, response);
  } catch (e) {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '重新送出'; }
    alert(`送出失敗：${e.message}\n你的作答還在畫面上，可以再試一次。`);
  }
}

function afterResultButtons(session) {
  const more = session.index + 1 < session.total;
  return `<div class="row" style="margin-top:24px">
    ${more ? '<button class="btn block" id="next">下一題</button>' : '<a class="btn block" href="#/">完成，回到今天</a>'}
  </div>`;
}

function wireNext(session) {
  const b = document.getElementById('next');
  if (b) b.onclick = () => { session.index++; nextInSession(session).catch(errorView); };
}

function ratingDelta(r) {
  const d = r.rating - r.before;
  return `<p class="delta">這個題型的能力估計：${fmtBand(r.before)} → <b>${fmtBand(r.rating)}</b>（${d >= 0 ? '+' : ''}${d.toFixed(2)}）</p>`;
}

// ---------- Complete the Words ----------
function ctwMarkup(tokens, opts = {}) {
  return tokens.map(t => {
    if (t.t !== undefined) return esc(t.t);
    if (opts.result) {
      const d = opts.result[t.b]; const given = opts.given[t.b] || '';
      const rest = d.answer.slice(t.prefix.length);
      return d.ok ? `<span class="blank right">${esc(t.prefix)}${esc(rest)}</span>`
        : `<span class="blank"><span class="prefix">${esc(t.prefix)}</span><span class="wrong">${esc(given) || '___'}</span><span class="fix">${esc(rest)}</span></span>`;
    }
    const w = Math.max(2, t.len) + 1;
    return `<span class="blank"><span class="prefix">${esc(t.prefix)}</span><input data-b="${t.b}" maxlength="${t.len + 2}" style="width:${w}ch"
      autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="第 ${t.b + 1} 格，缺 ${t.len} 個字母"></span>`;
  }).join('');
}

function renderCtw(session) {
  const c = session.item.content;
  setView(`${topBar(session)}<main class="stack">
    <p class="muted small">補上每個單字缺少的字母。</p>
    <div class="card ctw" id="ctw">${ctwMarkup(c.tokens)}</div>
    <button class="btn block" id="submit">送出</button></main>`, { focus: true });
  const inputs = [...document.querySelectorAll('#ctw input')];
  inputs.forEach((inp, i) => {
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); (inputs[i + 1] || document.getElementById('submit')).focus(); } });
  });
  document.getElementById('submit').onclick = e => {
    const blanks = [];
    inputs.forEach(inp => { blanks[Number(inp.dataset.b)] = inp.value; });
    session.given = blanks;
    submitSession(session, { blanks }, e.currentTarget);
  };
}

// ---------- Multiple choice (daily life / academic) ----------
function mcPassage(c) {
  return `<div class="card">${c.title ? `<div class="passage-title">${esc(c.title)}</div>` : ''}
    ${c.genre ? `<div class="muted small" style="margin-bottom:6px">${esc(c.genre)}</div>` : ''}
    <div class="passage">${esc(c.text || c.passage)}</div></div>`;
}

function renderMc(session) {
  const c = session.item.content;
  const picks = new Array(c.questions.length).fill(null);
  const qs = c.questions.map((q, qi) => `<div class="q"><div class="stem">${qi + 1}. ${esc(q.q)}</div>
    ${q.options.map((o, oi) => `<button class="opt" data-q="${qi}" data-o="${oi}"><span class="letter">${LETTERS[oi]}</span><span>${esc(o)}</span></button>`).join('')}</div>`).join('');
  setView(`${topBar(session)}<main>${mcPassage(c)}${qs}
    <button class="btn block" id="submit" style="margin-top:24px" disabled>送出</button></main>`, { focus: true });
  const submit = document.getElementById('submit');
  $app.querySelectorAll('.opt').forEach(b => b.onclick = () => {
    const qi = Number(b.dataset.q);
    picks[qi] = Number(b.dataset.o);
    $app.querySelectorAll(`.opt[data-q="${qi}"]`).forEach(x => x.classList.toggle('sel', x === b));
    submit.disabled = picks.some(p => p === null);
  });
  submit.onclick = e => submitSession(session, { answers: picks }, e.currentTarget);
}

function mcResultMarkup(c, detail) {
  return detail.map((d, qi) => `<div class="q"><div class="stem">${qi + 1}. ${esc(d.q)}</div>
    ${d.options.map((o, oi) => {
      const cls = oi === d.answer ? 'correct' : (oi === d.picked ? 'missed' : '');
      return `<div class="opt ${cls}"><span class="letter">${LETTERS[oi]}</span><span>${esc(o)}</span></div>`;
    }).join('')}
    ${d.explain_zh ? `<div class="explain small">${d.ok ? '' : '<b>錯了。</b>'}${esc(d.explain_zh)}</div>` : ''}</div>`).join('');
}

// ---------- Build a Sentence ----------
function renderBas(session) {
  const c = session.item.content;
  const placed = [];
  setView(`${topBar(session)}<main>
    <p class="muted small">點選字塊，組成通順的回覆。點已放上的字塊可以移除。不一定每個字塊都要用。</p>
    <div class="speech"><b>${esc(c.speaker || 'A')}</b>${esc(c.context)}</div>
    <div class="slots" id="slots"></div>
    <div class="chips" id="chips">${c.chunks.map((ch, i) => `<button class="chip" data-i="${i}">${esc(ch)}</button>`).join('')}</div>
    <button class="btn block" id="submit" style="margin-top:24px" disabled>送出</button></main>`, { focus: true });
  const slots = document.getElementById('slots');
  const submit = document.getElementById('submit');
  const draw = () => {
    slots.innerHTML = placed.length
      ? placed.map(i => `<button class="chip placed" data-i="${i}">${esc(c.chunks[i])}</button>`).join('') + `<span>${esc(c.end)}</span>`
      : '<span class="hint">回覆會出現在這裡</span>';
    document.querySelectorAll('#chips .chip').forEach(b => b.classList.toggle('used', placed.includes(Number(b.dataset.i))));
    slots.querySelectorAll('.chip').forEach(b => b.onclick = () => { placed.splice(placed.indexOf(Number(b.dataset.i)), 1); draw(); });
    submit.disabled = placed.length < 2;
  };
  document.querySelectorAll('#chips .chip').forEach(b => b.onclick = () => { placed.push(Number(b.dataset.i)); draw(); });
  draw();
  submit.onclick = e => submitSession(session, { order: placed.map(i => c.chunks[i]) }, e.currentTarget);
}

// ---------- Writing (email / academic discussion) ----------
function writingPrompt(type, c) {
  if (type === 'email') {
    return `<div class="prompt-box"><p>${esc(c.scenario)}</p>
      <p>寫一封 email 給 <b>${esc(c.to)}</b>。你的 email 要：</p>
      <ul>${c.points.map(p => `<li>${esc(p)}</li>`).join('')}</ul></div>`;
  }
  return `<div class="prompt-box"><p class="muted small">${esc(c.course)}</p><p><b>教授：</b>${esc(c.professor)}</p>
    ${c.students.map(s => `<div class="post"><b>${esc(s.name)}</b>${esc(s.post)}</div>`).join('')}
    </div><p class="muted small" style="margin-top:12px">寫一段回應，表達並支持你的看法。建議 100 字以上，並提出跟兩位同學不同的觀點。</p>`;
}

function renderWriting(session) {
  const { type, item } = session;
  const key = `draft:${item.id}`;
  setView(`${topBar(session)}<main class="stack">
    ${writingPrompt(type, item.content)}
    <textarea id="text" placeholder="${type === 'email' ? 'Dear …' : '在這裡寫你的回應'}" autocapitalize="sentences" spellcheck="false"></textarea>
    <div class="row"><span class="muted small" id="wc">0 字</span><span class="spacer"></span>
      <button class="btn" id="submit">送出批改</button></div>
    <p class="muted small">正式考試${type === 'email' ? ' 7' : ' 10'} 分鐘。超時可以照樣送出，計時器會變紅提醒你。拼字檢查已關閉，跟考場一樣。</p></main>`, { focus: true });
  const ta = document.getElementById('text');
  const wc = document.getElementById('wc');
  ta.value = store.get(key) || '';
  const update = () => { wc.textContent = `${words(ta.value)} 字`; store.set(key, ta.value); };
  ta.oninput = update; update();
  document.getElementById('submit').onclick = e => {
    if (words(ta.value) < 20 && !confirm('字數很少，確定要送出嗎？')) return;
    submitSession(session, { text: ta.value }, e.currentTarget);
  };
}

function writingFeedback(fb, text) {
  const list = (arr, fn) => (arr && arr.length ? `<ul class="fix-list">${arr.map(fn).join('')}</ul>` : '<p class="muted">—</p>');
  return `<div class="fb">
    <p>${esc(fb.summary_zh)}</p>
    ${fb.task_zh ? `<h3>題目要求</h3><p>${esc(fb.task_zh)}</p>` : ''}
    ${fb.strengths_zh?.length ? `<h3>做得好的地方</h3><ul>${fb.strengths_zh.map(s => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
    <h3>修改</h3>${list(fb.corrections, c => `<li><del>${esc(c.original)}</del><ins>${esc(c.revised)}</ins><span class="why">${esc(c.why_zh)}</span></li>`)}
    ${fb.upgrade?.length ? `<h3>可以換成更精準的說法</h3>${list(fb.upgrade, u => `<li><del>${esc(u.original)}</del><ins>${esc(u.better)}</ins></li>`)}` : ''}
    ${fb.next_focus_zh ? `<h3>下次練習的重點</h3><p>${esc(fb.next_focus_zh)}</p>` : ''}
    ${fb.model_answer ? `<details><summary>5 分範文（保留你的想法改寫）</summary><div class="card passage" style="margin-top:8px">${esc(fb.model_answer)}</div></details>` : ''}
    ${text != null ? `<details><summary>你的原文</summary><div class="card passage" style="margin-top:8px">${esc(text)}</div></details>` : ''}
  </div>`;
}

// ---------- Results ----------
function verdict(r) {
  const ai = META.tasks[r.type].ai;
  const mark = ai ? `${fmtBand(r.raw)}<small>/5</small>` : `${r.raw}<small>/${r.max}</small>`;
  const note = ai ? `約等於 ${fmtBand(1 + r.raw)} 級` : `${Math.round(r.score * 100)}%`;
  return `<div class="verdict"><span class="mark">${mark}</span><span class="muted">${note}</span></div>`;
}

function resultBody(type, content, feedback, response, given) {
  if (type === 'ctw') return `<div class="card ctw">${ctwMarkup(content.tokens, { result: feedback.detail, given: given || response.blanks || [] })}</div>`;
  if (type === 'rdl' || type === 'acad') return mcPassage(content) + mcResultMarkup(content, feedback.detail);
  if (type === 'bas') {
    const d = feedback.detail[0];
    return `<div class="speech"><b>${esc(content.speaker || 'A')}</b>${esc(content.context)}</div>
      <div class="card" style="margin-top:14px">
        ${d.ok ? `<p class="right" style="color:var(--ok)"><b>${esc(d.answer)}${esc(content.end)}</b></p>`
          : `<p><del style="color:var(--red)">${esc((response.order || []).join(' '))}</del></p><p><b>${esc(d.answer)}${esc(content.end)}</b></p>`}
        ${d.explain_zh ? `<div class="explain small">${esc(d.explain_zh)}</div>` : ''}</div>`;
  }
  return writingFeedback(feedback, response.text);
}

function showResult(session, r, response) {
  setView(`${topBar(session)}<main>${verdict(r)}${ratingDelta(r)}
    ${resultBody(session.type, session.item.content, r.feedback, response, session.given)}
    ${afterResultButtons(session)}</main>`, { focus: true });
  document.getElementById('timer').textContent = '';
  wireNext(session);
}

async function attemptView(id) {
  setView(loading(), { tab: 'progress' });
  const a = await api(`/api/attempt?id=${id}`);
  const r = { type: a.type, raw: a.raw_score, max: a.max_score, score: a.score };
  setView(`<main><p><a class="link" href="#/progress">← 進度</a></p>
    <h2>${esc(META.tasks[a.type].zh)}</h2><p class="muted small">${esc(a.day)}・${fmtTime(a.seconds || 0)}</p>
    ${a.type === 'email' || a.type === 'disc' ? writingPrompt(a.type, a.item.content) : ''}
    ${verdict(r)}${resultBody(a.type, a.item.content, a.feedback, a.response)}
    <a class="btn ghost block" style="margin-top:24px" href="#/practice/${a.type}?n=1">再練一題</a></main>`, { tab: 'progress' });
}

// ---------- Progress ----------
function sparkline(points, target) {
  if (points.length < 2) return '';
  const W = 640, H = 140, P = 8;
  const x = i => P + (i / (points.length - 1)) * (W - 2 * P);
  const y = v => H - P - ((v - 1) / 5) * (H - 2 * P);
  const d = points.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="整體能力估計趨勢">
    <line x1="${P}" x2="${W - P}" y1="${y(target)}" y2="${y(target)}" stroke="var(--red)" stroke-dasharray="4 4"/>
    <text x="${W - P}" y="${y(target) - 6}" text-anchor="end" fill="var(--red)" font-size="14">目標 ${fmtBand(target)}</text>
    <path d="${d}" fill="none" stroke="var(--ink)" stroke-width="2.5" stroke-linejoin="round"/></svg>`;
}

async function progressView() {
  setView(loading(), { tab: 'progress' });
  const d = await api('/api/dashboard');
  const target = d.settings.target;
  const rows = Object.entries(META.tasks).map(([type, m]) => {
    const s = d.estimates.skills[type];
    const pct = s.n ? ((s.rating - 1) / 5) * 100 : 0;
    return `<a class="skill-row" href="#/practice/${type}?n=${m.sessionSize}">
      <div><div><b>${esc(m.zh)}</b></div><div class="muted small">${s.n ? `練過 ${s.n} 次` : '還沒練過'}</div></div>
      <div class="meter"><span style="width:${pct}%"></span><i class="target" style="left:${((target - 1) / 5) * 100}%"></i></div>
      <b>${s.n ? fmtBand(s.rating) : '—'}</b></a>`;
  }).join('');

  // overall trend: replay history, average of latest rating per type that has data
  const latest = {}; const trend = [];
  for (const h of d.history) { latest[h.type] = h.rating; const v = Object.values(latest); trend.push(v.reduce((a, b) => a + b, 0) / v.length); }

  const hist = d.recent.map(a => `<li><a href="#/attempt/${a.id}"><span class="spacer">${esc(META.tasks[a.type].zh)}</span>
    <span class="muted small">${esc(a.day.slice(5))}</span><b>${META.tasks[a.type].ai ? fmtBand(a.raw_score) + '/5' : `${a.raw_score}/${a.max_score}`}</b></a></li>`).join('');

  setView(`<main class="stack">
    <h2>各題型能力</h2>
    <p class="muted small">1–6 級分估計，紅線是目標 ${fmtBand(target)}。點題型可以額外練習。</p>
    <div>${rows}</div>
    ${trend.length > 1 ? `<h2>整體趨勢</h2>${sparkline(trend.slice(-60), target)}` : ''}
    <h2>最近的練習</h2>
    ${hist ? `<ul class="hist">${hist}</ul>` : '<p class="muted">還沒有練習紀錄。從「今天」的診斷開始。</p>'}
  </main>`, { tab: 'progress' });
}

// ---------- Settings ----------
async function settingsView() {
  setView(loading(), { tab: 'settings' });
  const { plan } = await api('/api/today');
  const s = plan.settings;
  setView(`<main class="stack"><h2>設定</h2>
    <form id="settings">
      <label class="field"><span>考試日期</span><input class="text" type="date" name="examDate" value="${esc(s.examDate)}" required></label>
      <label class="field"><span>目標總分（1–6 級；舊制 100 分約等於 5.0）</span>
        <select class="text" name="target">${[3.5, 4, 4.5, 5, 5.5, 6].map(v => `<option ${v === s.target ? 'selected' : ''} value="${v}">${v.toFixed(1)}</option>`).join('')}</select></label>
      <label class="field"><span>平日每天練習（分鐘）</span><input class="text" type="number" min="15" max="300" step="5" name="minutesWeekday" value="${s.minutesWeekday}"></label>
      <label class="field"><span>週末每天練習（分鐘）</span><input class="text" type="number" min="15" max="300" step="5" name="minutesWeekend" value="${s.minutesWeekend}"></label>
      <button class="btn block" style="margin-top:20px">儲存</button>
      <p class="muted small" id="saved" hidden>已儲存，今天的任務已重新安排。</p>
    </form>
    <button class="btn ghost block" id="logout">登出</button></main>`, { tab: 'settings' });
  document.getElementById('settings').onsubmit = async ev => {
    ev.preventDefault();
    const f = ev.target;
    await api('/api/settings', { examDate: f.examDate.value, target: Number(f.target.value), minutesWeekday: Number(f.minutesWeekday.value), minutesWeekend: Number(f.minutesWeekend.value) });
    document.getElementById('saved').hidden = false;
  };
  document.getElementById('logout').onclick = async () => { await api('/api/logout', {}); loginView(); };
}

// ---------- boot ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
route();
