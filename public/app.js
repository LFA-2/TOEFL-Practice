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
class PendingError extends Error {}

// ---------- Supabase auth (plain fetch, no SDK) ----------
const CFG = window.TOEFL_CONFIG;
const AUTH = `${CFG.supabaseUrl}/auth/v1`;
const FN = `${CFG.supabaseUrl}/functions/v1/api`;
const SESSION_KEY = 'toefl-auth';
let ME = null; // { email, approved, usage } once checked

const session = {
  get() { try { return JSON.parse(store.get(SESSION_KEY)); } catch { return null; } },
  set(s) { store.set(SESSION_KEY, JSON.stringify({ access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at, email: s.user?.email })); },
  clear() { store.del(SESSION_KEY); ME = null; },
};

// Supabase Auth error messages, in Traditional Chinese.
function authMessage(data, status) {
  const m = String(data.msg || data.error_description || data.message || data.error || '');
  if (/invalid login credentials|invalid_credentials/i.test(m)) return 'Email 或密碼錯誤。';
  if (/already registered|already exists/i.test(m)) return '這個 Email 已經註冊過了，請直接登入。';
  if (/password should be|weak/i.test(m)) return '密碼太短，至少需要 8 個字元。';
  if (/email not confirmed/i.test(m)) return '這個 Email 還沒有確認，請先點信裡的確認連結。';
  if (/invalid email|unable to validate email/i.test(m)) return 'Email 格式不正確。';
  if (/rate limit|too many/i.test(m) || status === 429) return '嘗試太多次了，請稍後再試。';
  if (/signups not allowed|signup is disabled/i.test(m)) return '目前不開放註冊。';
  return m || `登入服務錯誤（HTTP ${status}）`;
}

async function authPost(path, body, token) {
  let res;
  try {
    res = await fetch(AUTH + path, { method: 'POST', body: JSON.stringify(body),
      headers: { apikey: CFG.publishableKey, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  } catch { throw new Error('無法連線，請確認網路後再試。'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(authMessage(data, res.status));
  return data;
}

let refreshing = null;
async function accessToken() {
  const s = session.get();
  if (!s) return null;
  if (s.expires_at * 1000 - 60_000 > Date.now()) return s.access_token;
  // expired or about to: trade the refresh token for a new session (one request at a time)
  refreshing = refreshing || authPost('/token?grant_type=refresh_token', { refresh_token: s.refresh_token })
    .then(n => { session.set(n); return n.access_token; })
    .catch(e => { if (!/無法連線/.test(e.message)) session.clear(); throw e; })
    .finally(() => { refreshing = null; });
  try { return await refreshing; } catch (e) { if (/無法連線/.test(e.message)) throw e; return null; }
}

// path keeps the old "/api/..." form; it maps onto the Edge Function.
async function api(path, body) {
  const token = await accessToken();
  if (!token && path !== '/api/me') throw new AuthError();
  let res;
  try {
    res = await fetch(FN + path.replace(/^\/api/, ''), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { apikey: CFG.publishableKey, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch { throw new Error('無法連線到伺服器，請確認網路後再試。'); }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { session.clear(); throw new AuthError(); }
  if (res.status === 403 && data.pending) throw new PendingError();
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
    if (!session.get()) return loginView();
    if (!ME || !ME.approved) {
      ME = await api('/api/me');
      if (!ME.authed) { session.clear(); return loginView(); }
      if (!ME.approved) return pendingView();
    }
    if (!META) META = await api('/api/meta');
    if (parts[0] === 'practice') return await practice(parts[1], params);
    if (parts[0] === 'attempt') return await attemptView(Number(parts[1]));
    if (parts[0] === 'vocab' && parts[1] === 'screen') return await vocabScreen();
    if (parts[0] === 'vocab' && parts[1] === 'review') return await vocabQuizRun();
    if (parts[0] === 'vocab' && parts[1] === 'quiz') return await vocabQuizRun({ free: true, params });
    if (parts[0] === 'vocab' && parts[1] === 'known') return await vocabKnown();
    if (parts[0] === 'vocab') return await vocabHome(params);
    if (parts[0] === 'progress') return await progressView();
    if (parts[0] === 'settings') return await settingsView();
    return await todayView();
  } catch (e) {
    if (e instanceof AuthError) return loginView();
    if (e instanceof PendingError) { ME = null; return pendingView(); }
    errorView(e);
  }
}
window.addEventListener('hashchange', route);
window.route = route;

// ---------- login ----------
function loginView(mode = 'login', notice = '') {
  const signup = mode === 'signup';
  setView(`<main class="stack" style="max-width:420px;padding-top:12vh">
    <h1 style="font-size:2rem">TOEFL Coach</h1>
    <p class="muted">${signup ? '建立帳號。註冊後需要等管理者核准才能使用。' : '用 Email 登入。'}</p>
    ${notice ? `<p class="notice">${esc(notice)}</p>` : ''}
    <form id="login">
      <label class="field"><span>Email</span><input class="text" type="email" name="email" autocomplete="email" required autofocus></label>
      <label class="field"><span>密碼${signup ? '（至少 8 個字元）' : ''}</span>
        <input class="text" type="password" name="pw" minlength="${signup ? 8 : 1}" autocomplete="${signup ? 'new-password' : 'current-password'}" required></label>
      <p class="error" id="err" hidden></p>
      <button class="btn block" style="margin-top:16px">${signup ? '註冊' : '登入'}</button>
    </form>
    <button class="btn ghost block" id="switch">${signup ? '已經有帳號？登入' : '還沒有帳號？註冊'}</button>
    </main>`, { focus: true });
  document.getElementById('switch').onclick = () => loginView(signup ? 'login' : 'signup');
  document.getElementById('login').onsubmit = async ev => {
    ev.preventDefault();
    const err = document.getElementById('err');
    const btn = ev.target.querySelector('button');
    const email = ev.target.email.value.trim();
    const password = ev.target.pw.value;
    btn.disabled = true; err.hidden = true;
    try {
      const data = signup
        ? await authPost(`/signup?redirect_to=${encodeURIComponent(location.href.split('#')[0])}`, { email, password })
        : await authPost('/token?grant_type=password', { email, password });
      if (!data.access_token) return loginView('login', '已寄出確認信。請點信裡的連結確認 Email，再回來登入。');
      session.set(data);
      ME = null; META = null;
      route();
    } catch (e) { err.hidden = false; err.textContent = e.message; btn.disabled = false; }
  };
}

function pendingView() {
  const email = ME?.email || session.get()?.email || '';
  setView(`<main class="stack" style="max-width:420px;padding-top:12vh">
    <h1 style="font-size:2rem">等待核准</h1>
    <p>帳號 <b>${esc(email)}</b> 已建立，但還沒有被核准。核准之後就能開始練習。</p>
    <button class="btn block" id="recheck">重新檢查</button>
    <button class="btn ghost block" id="logout">登出</button></main>`, { focus: true });
  document.getElementById('recheck').onclick = () => { ME = null; route(); };
  document.getElementById('logout').onclick = logout;
}

async function logout() {
  const s = session.get();
  session.clear();
  if (s) authPost('/logout', {}, s.access_token).catch(() => {});
  loginView();
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
  const totalMin = plan.tasks.reduce((a, t) => a + t.minutes, 0) + (plan.vocabMinutes || 0);
  const allDone = nextIdx === -1 && plan.tasks.length > 0;

  const v = plan.vocab;
  const vocabDone = v.screen.done >= v.screen.target && !v.review.due;
  const vocabRows = `
    <a class="task ${v.screen.done >= v.screen.target ? 'complete' : 'next'}" href="#/vocab/screen"><div class="spacer"><div class="name">挑新單字</div>
      <div class="sub">約 ${v.screen.minutes} 分鐘</div></div><div class="count">${v.screen.done}<span>/${v.screen.target}</span></div></a>
    <a class="task ${v.review.due ? (v.screen.done >= v.screen.target ? 'next' : '') : 'complete'}" href="#/vocab/review"><div class="spacer"><div class="name">單字複習</div>
      <div class="sub">${v.review.due ? `還有 ${v.review.due} 個到期` : '今天沒有到期的字'}</div></div><div class="count">${v.review.done}<span>/${v.review.target}</span></div></a>`;
  const tasks = plan.tasks.map((t, i) => {
    const meta = META.tasks[t.type];
    const left = t.target - t.done;
    const cls = ['task', left === 0 ? 'complete' : '', i === nextIdx && vocabDone ? 'next' : ''].join(' ');
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
      <div class="sheet">${vocabRows}${tasks}</div>
      ${allDone ? '<p>今天的任務都完成了。想多練可以到「進度」挑一個題型。</p>' : ''}
      <p class="muted small">單字最多佔每天時間的一半，其餘給閱讀與寫作。聽力與口說（打字版）會在下一版加入。</p>
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

// ---------- Letter boxes: one box per missing letter, like the real test ----------
function letterBoxes(prefix, len, b, label) {
  const cells = Array.from({ length: len }, (_, k) =>
    `<input class="lb-cell" data-b="${b}" data-k="${k}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="next" aria-label="${esc(label)}，第 ${k + 1} 個字母">`).join('');
  return `<span class="lb"><span class="prefix">${esc(prefix)}</span>${cells}</span>`;
}

// Wire typing across all boxes in `root`. Returns a function that reads the answers by blank index.
function wireLetterBoxes(root, onEnterLast) {
  const cells = [...root.querySelectorAll('.lb-cell')];
  const focus = i => { const c = cells[i]; if (c) { c.focus(); c.select(); } };
  cells.forEach((cell, i) => {
    cell.addEventListener('focus', () => cell.select());
    cell.addEventListener('input', () => {
      const letters = cell.value.replace(/[^a-zA-Z]/g, '');
      if (!letters) { cell.value = ''; return; }
      if (letters.length === 1) { cell.value = letters; focus(i + 1); return; }
      // typed over an existing letter: keep only the new one; pasted several letters: spread them out
      const prev = (cell.dataset.prev || '').toLowerCase();
      const chars = letters.length === 2 && prev && letters[0].toLowerCase() === prev ? [letters[1]] : [...letters];
      chars.forEach((ch, k) => { if (cells[i + k]) cells[i + k].value = ch; });
      focus(i + chars.length);
    });
    cell.addEventListener('keydown', e => {
      cell.dataset.prev = cell.value;
      if (e.key === 'Backspace' && !cell.value) { e.preventDefault(); if (cells[i - 1]) { cells[i - 1].value = ''; focus(i - 1); } }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); focus(i - 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); focus(i + 1); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        const nextBlank = cells.findIndex((c, j) => j > i && c.dataset.b !== cell.dataset.b);
        if (nextBlank >= 0) focus(nextBlank); else if (onEnterLast) onEnterLast();
      }
    });
  });
  return () => {
    const out = [];
    for (const c of cells) out[Number(c.dataset.b)] = (out[Number(c.dataset.b)] || '') + (c.value || ' ');
    return out.map(s => (s || '').replace(/\s+$/, ''));
  };
}

// ---------- Complete the Words ----------
function ctwMarkup(tokens, opts = {}) {
  return tokens.map(t => {
    if (t.t !== undefined) return esc(t.t);
    if (opts.result) {
      const d = opts.result[t.b];
      const rest = d.answer.slice(t.prefix.length);
      const given = (d.given ?? opts.given?.[t.b] ?? '').toLowerCase();
      if (d.ok) return `<span class="lb done right"><span class="prefix">${esc(t.prefix)}</span>${[...rest].map(ch => `<span class="lb-cell">${esc(ch)}</span>`).join('')}</span>`;
      // boxes show the right spelling, red where the learner's letter differed; their attempt follows, struck out
      const cells = [...rest].map((ch, k) => `<span class="lb-cell ${given[k] === ch.toLowerCase() ? '' : 'bad'}">${esc(ch)}</span>`).join('');
      const mine = given.trim() ? `<s class="mine">${esc(t.prefix + given.trim())}</s>` : '';
      return `<span class="lb done"><span class="prefix">${esc(t.prefix)}</span>${cells}</span>${mine}`;
    }
    return letterBoxes(t.prefix, t.len, t.b, `第 ${t.b + 1} 個字，缺 ${t.len} 個字母`);
  }).join('');
}

function renderCtw(session) {
  const c = session.item.content;
  setView(`${topBar(session)}<main class="stack">
    <p class="muted small">補上每個字缺少的字母，一格一個字母。打完會自動跳到下一格。</p>
    <div class="card ctw" id="ctw">${ctwMarkup(c.tokens)}</div>
    <button class="btn block" id="submit">送出</button></main>`, { focus: true });
  const submit = document.getElementById('submit');
  const read = wireLetterBoxes(document.getElementById('ctw'), () => submit.focus());
  submit.onclick = e => {
    const blanks = read();
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
  // older items have no template: every chunk is a blank
  const template = c.template || c.chunks.map(() => ({ blank: true }));
  const blanks = template.map((t, i) => (t.blank ? i : -1)).filter(i => i >= 0);
  const filled = new Map(); // template index -> chunk index
  setView(`${topBar(session)}<main>
    <p class="muted small">把字塊填進空格，組成通順的回覆。點空格裡的字塊可以拿回來。有一個字塊可能用不到。</p>
    <div class="speech"><b>${esc(c.speaker || 'A')}</b>${esc(c.context)}</div>
    <div class="reply" id="reply"></div>
    <div class="chips" id="chips">${c.chunks.map((ch, i) => `<button class="chip" data-i="${i}">${esc(ch)}</button>`).join('')}</div>
    <button class="btn block" id="submit" style="margin-top:24px" disabled>送出</button></main>`, { focus: true });
  const reply = document.getElementById('reply');
  const submit = document.getElementById('submit');
  const draw = () => {
    reply.innerHTML = template.map((t, i) => {
      if (!t.blank) return `<span class="given">${esc(t.t)}</span>`;
      const ci = filled.get(i);
      if (ci === undefined) return `<span class="slot" aria-label="空格"></span>`;
      // the chip is lowercase; capitalize it only where it starts the sentence
      const word = i === 0 ? c.chunks[ci].replace(/^(\s*)([a-z])/, (_, sp, ch) => sp + ch.toUpperCase()) : c.chunks[ci];
      return `<button class="chip placed" data-slot="${i}">${esc(word)}</button>`;
    }).join(' ') + `<span class="given">${esc(c.end)}</span>`;
    const used = new Set(filled.values());
    document.querySelectorAll('#chips .chip').forEach(b => b.classList.toggle('used', used.has(Number(b.dataset.i))));
    reply.querySelectorAll('.chip').forEach(b => b.onclick = () => { filled.delete(Number(b.dataset.slot)); draw(); });
    submit.disabled = filled.size < blanks.length;
  };
  document.querySelectorAll('#chips .chip').forEach(b => b.onclick = () => {
    const slot = blanks.find(i => !filled.has(i));
    if (slot === undefined) return;
    filled.set(slot, Number(b.dataset.i)); draw();
  });
  draw();
  submit.onclick = e => submitSession(session, { order: template.map((t, i) => (t.blank ? c.chunks[filled.get(i)] : t.t)) }, e.currentTarget);
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

// ---------- Vocabulary ----------
function speak(word) {
  try {
    const u = new SpeechSynthesisUtterance(word);
    u.lang = 'en-US'; u.rate = 0.9;
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  } catch { /* speech not available */ }
}

function vocabTop(title, progress) {
  return `<div class="ptop"><a class="link" href="#/vocab" aria-label="離開">✕</a>
    <span class="title">${esc(title)}</span><span class="spacer"></span><span class="muted small" id="vprog">${progress}</span></div>`;
}

function dueLabel(day) {
  if (!day) return '';
  const d = Math.round((Date.parse(day) - Date.parse(new Date().toLocaleDateString('en-CA'))) / 86400000);
  return d <= 0 ? '今天' : d === 1 ? '明天' : `${d} 天後`;
}

function cardBack(w) {
  const c = w.card || {};
  const ex = esc(c.example || '').replace(new RegExp(`\\b(${w.word}\\w*)\\b`, 'i'), '<mark>$1</mark>');
  return `<div class="vback">
    <p class="vzh"><span class="pos">${esc(c.pos || '')}</span>${esc(c.zh || '')}</p>
    ${c.example ? `<p class="vex">${ex}</p><p class="muted small">${esc(c.example_zh || '')}</p>` : ''}
    ${c.collocations?.length ? `<p class="small"><b>常見搭配</b>　${c.collocations.map(esc).join('、')}</p>` : ''}
    ${c.family?.length ? `<p class="small"><b>詞性變化</b>　${c.family.map(f => `${esc(f.w)} <span class="muted">${esc(f.pos)}</span>`).join('、')}</p>` : ''}
    ${c.tip_zh ? `<p class="small explain">${esc(c.tip_zh)}</p>` : ''}
  </div>`;
}

async function vocabHome(params = new URLSearchParams()) {
  setView(loading(), { tab: 'vocab' });
  const onlyHard = params.get('hard') === '1';
  const [{ plan }, book] = await Promise.all([api('/api/today'), api(`/api/vocab/list${onlyHard ? '?hard=1' : ''}`)]);
  const v = plan.vocab; const s = book.stats;
  const rows = book.words.map(w => `<details class="wrow"><summary><b>${esc(w.word)}</b>${w.hard ? '<span class="tag">難字</span>' : ''}<span class="spacer"></span>
      <span class="muted small">${esc(w.card?.zh || '')}</span><span class="muted small due">${dueLabel(w.due_day)}</span></summary>
      ${w.card ? cardBack(w) : '<p class="muted small">單字卡準備中</p>'}</details>`).join('');
  setView(`<main class="stack">
    <div class="vstats"><div><b>${s.learning}</b><span>學習中</span></div><div><b>${s.mature}</b><span>已熟練</span></div>
      <div><b>${s.hard}</b><span>難字</span></div><div><b>${s.known}</b><span>本來就會</span></div></div>
    <div class="sheet">
      <a class="task ${v.screen.done < v.screen.target ? 'next' : 'complete'}" href="#/vocab/screen"><div class="spacer"><div class="name">挑新單字</div>
        <div class="sub">今天 ${v.screen.done} / ${v.screen.target} 個</div></div></a>
      <a class="task ${v.review.due ? '' : 'complete'}" href="#/vocab/review"><div class="spacer"><div class="name">複習</div>
        <div class="sub">${v.review.due ? `還有 ${v.review.due} 個到期` : '今天沒有到期的單字'}</div></div></a>
      <a class="task" href="#/vocab/quiz"><div class="spacer"><div class="name">自由測驗</div>
        <div class="sub">從單字本抽 20 個，偏重常錯的字</div></div></a>
      ${s.hard ? `<a class="task" href="#/vocab/quiz?hard=1"><div class="spacer"><div class="name">只考難字</div>
        <div class="sub">${s.hard} 個常錯的字</div></div></a>` : ''}
    </div>
    <div class="row"><h2 class="spacer">單字本</h2>
      <a class="link small" href="${onlyHard ? '#/vocab' : '#/vocab?hard=1'}">${onlyHard ? '顯示全部' : '只看難字'}</a>
      <a class="link small" href="#/vocab/known">本來就會的字</a></div>
    ${rows ? `<div>${rows}</div>` : `<p class="muted">${onlyHard ? '目前沒有難字。' : '還沒有要背的字。先去「挑新單字」。'}</p>`}
    <p class="muted small">複習間隔是第 1、2、4、7、14、21、45、90 天。答對往下一個間隔，用了提示或打成近義字維持原間隔，答錯明天重來。升到第 7 天以上算熟練；累計錯 4 次以上標為難字。自由測驗答錯會拉回明天，答對不會提前往後推。</p>
  </main>`, { tab: 'vocab' });
}

async function vocabKnown() {
  setView(loading(), { tab: 'vocab' });
  const { words } = await api('/api/vocab/list?status=known');
  setView(`<main class="stack"><p><a class="link" href="#/vocab">← 單字</a></p>
    <h2>本來就會的字</h2><p class="muted small">挑錯了可以加回去背。</p>
    <div>${words.map(w => `<div class="wrow flat"><b class="spacer">${esc(w.word)}</b><button class="link" data-id="${w.id}">加入要背</button></div>`).join('') || '<p class="muted">還沒有。</p>'}</div>
  </main>`, { tab: 'vocab' });
  $app.querySelectorAll('button[data-id]').forEach(b => b.onclick = async () => {
    await api('/api/vocab/mark', { id: Number(b.dataset.id), how: 'unknown' });
    b.replaceWith(Object.assign(document.createElement('span'), { className: 'muted small', textContent: '已加入' }));
  });
}

async function vocabScreen() {
  setView(`${vocabTop('挑新單字', '')}${loading('準備單字')}`, { focus: true });
  const queue = []; const seen = new Set(); const history = [];
  let state = { picked: 0, target: 60 };
  let fetching = null;
  const fetchMore = () => fetching || (fetching = api('/api/vocab/screen').then(r => {
    state = { picked: r.picked, target: r.target };
    for (const w of r.words) if (!seen.has(w.id)) { seen.add(w.id); queue.push(w); }
  }).finally(() => { fetching = null; }));
  await fetchMore();

  const show = () => {
    const prog = `已挑 ${state.picked} / ${state.target}`;
    if (state.picked >= state.target) {
      setView(`${vocabTop('挑新單字', prog)}<main class="stack" style="padding-top:12vh">
        <h2>今天的 ${state.target} 個挑好了</h2><p>剛挑的字現在就複習第一次，明天會再出現。</p>
        <a class="btn block" href="#/vocab/review">開始複習</a>
        <button class="btn ghost block" id="more">再多挑一些</button></main>`, { focus: true });
      document.getElementById('more').onclick = () => { state.target += 20; show(); };
      return;
    }
    const w = queue[0];
    if (!w) {
      setView(`${vocabTop('挑新單字', prog)}${loading('準備更多單字')}`, { focus: true });
      fetchMore().then(show).catch(errorView);
      return;
    }
    setView(`${vocabTop('挑新單字', prog)}<main class="vscreen">
      <div class="vword"><span>${esc(w.word)}</span><button class="link small" id="say">發音</button></div>
      <p class="muted small" style="text-align:center">你知道這個字的意思嗎？</p>
      <div class="vbtns">
        <button class="btn ghost" data-how="unknown">不會</button>
        <button class="btn ghost" data-how="fuzzy">不熟</button>
        <button class="btn" data-how="known">會</button>
      </div>
      <p style="text-align:center;margin-top:18px">${history.length ? '<button class="link small" id="undo">上一個按錯了</button>' : ''}</p>
      <p class="muted small" style="text-align:center">「會」的字之後不會再出現。「不熟」和「不會」都會加進單字本。</p>
    </main>`, { focus: true });
    document.getElementById('say').onclick = () => speak(w.word);
    const undo = document.getElementById('undo');
    if (undo) undo.onclick = async () => {
      const last = history.pop();
      const r = await api('/api/vocab/mark', { id: last.id, how: 'undo' });
      state.picked = r.picked; queue.unshift(last); show();
    };
    $app.querySelectorAll('[data-how]').forEach(b => b.onclick = () => {
      const how = b.dataset.how;
      queue.shift(); history.push(w);
      if (how !== 'known') state.picked++;
      api('/api/vocab/mark', { id: w.id, how }).then(r => { state.picked = r.picked; const el = document.getElementById('vprog'); if (el) el.textContent = `已挑 ${r.picked} / ${state.target}`; })
        .catch(e => alert(`沒有存到：${e.message}`));
      if (queue.length < 6) fetchMore().catch(() => {});
      show();
    });
  };
  document.onkeydown = e => {
    if (!location.hash.startsWith('#/vocab/screen')) { document.onkeydown = null; return; }
    const map = { 1: 'unknown', 2: 'fuzzy', 3: 'known' };
    const b = map[e.key] && $app.querySelector(`[data-how="${map[e.key]}"]`);
    if (b) b.click();
  };
  show();
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// Split a sentence around the target word (exact spelling); null if it does not occur.
function aroundWord(sentence, word) {
  const m = (sentence || '').match(new RegExp(`\\b${word}\\b`, 'i'));
  return m ? { before: sentence.slice(0, m.index), after: sentence.slice(m.index + m[0].length) } : null;
}

// One quiz session. `free` = free quiz (fixed list, wrong answers only push words back).
async function vocabQuizRun({ free = false, params = new URLSearchParams() } = {}) {
  const title = free ? (params.get('hard') === '1' ? '難字測驗' : '自由測驗') : '單字複習';
  const url = free ? `/api/vocab/quiz?n=20${params.get('hard') === '1' ? '&hard=1' : ''}` : '/api/vocab/review';
  const home = free ? '#/vocab/quiz' : '#/vocab/review';
  setView(`${vocabTop(title, '')}${loading('準備題目')}`, { focus: true });
  let data = await api(url);
  let i = 0;
  const results = [];
  const prog = () => (free ? `${Math.min(i + 1, data.items.length)} / ${data.items.length}` : `${data.done} / ${data.target}`);

  const finish = () => {
    const wrong = results.filter(r => r.result === 'again');
    const right = results.length - wrong.length;
    const list = wrong.length ? `<h3>答錯的字</h3><ul class="fix-list">${wrong.map(r => `<li><b>${esc(r.word)}</b>　<span class="muted">${esc(r.zh)}</span></li>`).join('')}</ul>` : '';
    setView(`${vocabTop(title, '')}<main class="stack" style="padding-top:8vh">
      <h2>${free ? `答對 ${right} / ${results.length}` : '今天的複習完成了'}</h2>
      <p>${free ? '答錯的字明天會回到複習。' : '答錯的字明天會再出現。'}</p>${list}
      <a class="btn block" href="#/">回到今天</a>
      ${free ? '<button class="btn ghost block" id="again">再考一輪</button>' : ''}
      <a class="btn ghost block" href="#/vocab">單字本</a></main>`, { focus: true });
    const again = document.getElementById('again');
    if (again) again.onclick = () => vocabQuizRun({ free, params }).catch(errorView);
  };

  const next = async () => {
    if (i >= data.items.length) {
      if (free) return finish();
      data = await api(url); i = 0;
      if (!data.items.length && data.waitingForCards && data.cardError) {
        return setView(`${vocabTop(title, prog())}<main class="stack" style="padding-top:8vh">
          <h2>單字卡還沒準備好</h2><p class="error">${esc(data.cardError)}</p>
          <p class="muted">${data.waitingForCards} 個字在等單字卡。過幾分鐘會自動重試。</p>
          <button class="btn block" onclick="route()">重試</button><a class="btn ghost block" href="#/">回到今天</a></main>`, { focus: true });
      }
      if (!data.items.length && data.waitingForCards) {
        setView(`${vocabTop(title, prog())}${loading(`題目準備中（${data.waitingForCards} 個）`)}`, { focus: true });
        setTimeout(() => next().catch(errorView), 3000);
        return;
      }
      if (!data.items.length) return results.length ? finish() : setView(`${vocabTop(title, '')}<main class="stack" style="padding-top:12vh">
        <h2>現在沒有要複習的字</h2><a class="btn block" href="#/vocab/screen">去挑新單字</a><a class="btn ghost block" href="#/vocab/quiz">自由測驗</a></main>`, { focus: true });
    }
    const w = data.items[i];
    (w.mode === 'type' ? typeQ : choiceQ)(w);
  };

  const send = async (w, result) => {
    results.push({ word: w.word, zh: w.card.zh, result });
    const r = await api('/api/vocab/grade', { id: w.id, mode: w.mode, result, free });
    if (!free) { data.done = r.done; data.target = r.target; }
    i++; next().catch(errorView);
  };

  const nextButton = (w, result, label) => {
    document.getElementById('btns').innerHTML = `<button class="btn block" id="go">${label}</button>`;
    const go = document.getElementById('go');
    go.onclick = () => { go.disabled = true; send(w, result).catch(errorView); };
    go.focus();
  };

  // ---- fill-in-the-blank, four options ----
  const choiceQ = w => {
    const q = w.card.quiz;
    const options = shuffle([{ w: w.word, ok: true }, ...q.distractors.map(d => ({ ...d, ok: false }))]);
    const [before, after] = q.sentence.split('___');
    setView(`${vocabTop(title, prog())}<main class="vscreen">
      <p class="muted small">選出最適合放進空格的字。</p>
      ${w.firstTime ? `<p class="hint-zh">新字提示：<b>${esc(w.card.zh)}</b> <span class="pos">${esc(w.card.pos || '')}</span></p>` : ''}
      <div class="card qsent">${esc(before)}<span class="gap" id="gap">______</span>${esc(after ?? '')}</div>
      <div id="opts">${options.map((o, k) => `<button class="opt" data-k="${k}"><span class="letter">${LETTERS[k]}</span><span>${esc(o.w)}</span></button>`).join('')}</div>
      <div id="back"></div><div class="vbtns" id="btns"></div>
      <p class="muted small kbd-hint" style="text-align:center">鍵盤：1–4 選答案，Enter 下一題</p></main>`, { focus: true });
    $app.querySelectorAll('#opts .opt').forEach(b => b.onclick = () => {
      if ($app.querySelector('#opts .opt.correct')) return; // already answered
      const pick = options[Number(b.dataset.k)];
      $app.querySelectorAll('#opts .opt').forEach((x, k) => {
        const o = options[k];
        x.classList.add(o.ok ? 'correct' : (x === b ? 'missed' : 'dim'));
        x.disabled = true;
        if (!o.ok && o.why_zh) x.insertAdjacentHTML('beforeend', `<span class="why">${esc(o.why_zh)}</span>`);
      });
      document.getElementById('gap').textContent = w.word;
      document.getElementById('gap').classList.add(pick.ok ? 'right' : 'wrongtxt');
      speak(w.word);
      document.getElementById('back').innerHTML = cardBack(w);
      nextButton(w, pick.ok ? 'good' : 'again', pick.ok ? '答對了，下一題' : '答錯了，下一題');
    });
  };

  // ---- Chinese -> type the whole word ----
  const typeQ = w => {
    const c = w.card;
    const ctx = aroundWord(c.example, w.word);
    const boxes = letterBoxes('', w.word.length, 0, `${w.word.length} 個字母`);
    let hinted = false;
    setView(`${vocabTop(title, prog())}<main class="vscreen">
      <p class="muted small">看中文，拼出完整的英文單字（${w.word.length} 個字母）。</p>
      <p class="vzh" style="text-align:center"><span class="pos">${esc(c.pos || '')}</span>${esc(c.zh)}</p>
      <div class="card ctw" id="spell">${ctx ? `${esc(ctx.before)}${boxes}${esc(ctx.after)}` : `<div style="text-align:center">${boxes}</div>`}</div>
      <div id="note"></div><div id="back"></div>
      <div class="vbtns" id="btns"><button class="btn ghost" id="hint">提示</button><button class="btn" id="check" style="grid-column: span 2">檢查</button></div>
      <p class="muted small kbd-hint" style="text-align:center">鍵盤：直接打字，Enter 檢查，再按 Enter 下一題</p></main>`, { focus: true });
    const cells = [...document.querySelectorAll('#spell .lb-cell')];
    const read = wireLetterBoxes(document.getElementById('spell'), () => document.getElementById('check').click());
    cells[0]?.focus();
    document.getElementById('hint').onclick = e => {
      hinted = true; cells[0].value = w.word[0]; cells[0].disabled = true; e.currentTarget.disabled = true;
      document.getElementById('note').innerHTML = '<p class="muted small" style="text-align:center">用了提示，這題答對也只算「模糊」。</p>';
      cells[1]?.focus();
    };
    document.getElementById('check').onclick = () => {
      const given = (read()[0] || '').replace(/\s/g, '').toLowerCase();
      const target = w.word.toLowerCase();
      const near = [...(c.quiz?.synonyms || []), ...(c.family || []).map(f => String(f.w).toLowerCase())];
      let result; let msg;
      if (given === target) { result = hinted ? 'hard' : 'good'; msg = hinted ? '拼對了（用了提示）' : '拼對了'; }
      else if (given && near.includes(given)) { result = 'hard'; msg = `「${given}」很接近，但這裡要的是 ${w.word}`; }
      else { result = 'again'; msg = given ? '拼錯了' : '沒有作答'; }
      cells.forEach((cell, k) => {
        const ok = (cell.value || '').toLowerCase() === target[k];
        cell.disabled = true; cell.value = w.word[k]; cell.classList.toggle('bad', !ok && result === 'again');
      });
      speak(w.word);
      document.getElementById('note').innerHTML = '';
      document.getElementById('back').innerHTML = `<p class="${result === 'again' ? 'wrongtxt' : 'right'}" style="text-align:center"><b>${esc(msg)}</b>
        ${given && given !== target ? `<br><span class="muted small">你寫的：<s>${esc(given)}</s></span>` : ''}</p>${cardBack(w)}`;
      nextButton(w, result, '下一題');
    };
  };

  document.onkeydown = e => {
    if (!location.hash.startsWith(home.split('?')[0])) { document.onkeydown = null; return; }
    if (e.target.matches?.('input:not(:disabled), textarea')) return;
    if (e.key === 'Enter') { const go = document.getElementById('go'); if (go) { e.preventDefault(); go.click(); } return; }
    const opt = /^[1-4]$/.test(e.key) && $app.querySelector(`#opts .opt[data-k="${Number(e.key) - 1}"]:not(:disabled)`);
    if (opt) { e.preventDefault(); opt.click(); }
  };

  if (free && !data.items.length) {
    setView(`${vocabTop(title, '')}<main class="stack" style="padding-top:12vh"><h2>${data.waitingForCards ? '題目還在準備中，請稍後再試' : '單字本裡還沒有字'}</h2>
      <a class="btn block" href="#/vocab/screen">去挑新單字</a></main>`, { focus: true });
    return;
  }
  next();
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
  const [{ plan, vocabSettings: vs }, me] = await Promise.all([api('/api/today'), api('/api/me')]);
  ME = me;
  const s = plan.settings;
  setView(`<main class="stack"><h2>設定</h2>
    <form id="settings">
      <label class="field"><span>考試日期</span><input class="text" type="date" name="examDate" value="${esc(s.examDate)}" required></label>
      <label class="field"><span>目標總分（1–6 級；舊制 100 分約等於 5.0）</span>
        <select class="text" name="target">${[3.5, 4, 4.5, 5, 5.5, 6].map(v => `<option ${v === s.target ? 'selected' : ''} value="${v}">${v.toFixed(1)}</option>`).join('')}</select></label>
      <label class="field"><span>平日每天練習（分鐘）</span><input class="text" type="number" min="15" max="300" step="5" name="minutesWeekday" value="${s.minutesWeekday}"></label>
      <label class="field"><span>週末每天練習（分鐘）</span><input class="text" type="number" min="15" max="300" step="5" name="minutesWeekend" value="${s.minutesWeekend}"></label>
      <label class="field"><span>每天挑幾個新單字</span><input class="text" type="number" min="5" max="150" step="5" name="vocabNewPerDay" value="${vs.newPerDay}"></label>
      <button class="btn block" style="margin-top:20px">儲存</button>
      <p class="muted small" id="saved" hidden>已儲存，今天的任務已重新安排。</p>
    </form>
    <h2>帳號</h2>
    <p>${esc(ME?.email || '')}</p>
    ${ME?.usage ? `<p class="muted small">今天已用 AI ${ME.usage.used} / ${ME.usage.limit} 次（出題、批改、單字卡各算一次，台灣時間午夜重置）</p>` : ''}
    <button class="btn ghost block" id="logout">登出</button></main>`, { tab: 'settings' });
  document.getElementById('settings').onsubmit = async ev => {
    ev.preventDefault();
    const f = ev.target;
    await api('/api/settings', { examDate: f.examDate.value, target: Number(f.target.value), minutesWeekday: Number(f.minutesWeekday.value), minutesWeekend: Number(f.minutesWeekend.value), vocabNewPerDay: Number(f.vocabNewPerDay.value) });
    document.getElementById('saved').hidden = false;
  };
  document.getElementById('logout').onclick = logout;
}

// ---------- boot ----------
// Coming back from an email confirmation link: the session arrives in the URL hash.
if (/access_token=/.test(location.hash)) {
  const p = new URLSearchParams(location.hash.slice(1));
  session.set({ access_token: p.get('access_token'), refresh_token: p.get('refresh_token'),
    expires_at: Number(p.get('expires_at')) || Math.floor(Date.now() / 1000) + Number(p.get('expires_in') || 3600) });
  history.replaceState(null, '', location.pathname + location.search + '#/');
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
route();
