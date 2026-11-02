// Builds the daily task list from exam date, target band and current ability.
import { TASKS } from './tasks.js';
import { allSkills } from './skills.js';
import { today, daysBetween, weekday } from './time.js';
import { getSetting, setSetting } from './store.js';
import { json } from './json.js';
import * as vocab from './vocab.js';

const DEFAULTS = {
  examDate: '2027-01-30',
  target: 5.0,
  minutesWeekday: 90,
  minutesWeekend: 120,
};

export async function settings(db) {
  return { ...DEFAULTS, ...(await getSetting(db, 'plan', {})) };
}

export async function saveSettings(db, s) {
  await setSetting(db, 'plan', s);
}

// Bump when new task types are added, so today's saved plan is rebuilt to include them.
const PLAN_VERSION = 2;

// How many of each type the diagnostic asks for.
const DIAGNOSTIC_COUNT = { ctw: 2, bas: 5, lcr: 5 };

// Points each type carries on the real test (shapes the daily split), and a cap per day.
const POINT_WEIGHT = { ctw: 30, rdl: 10, acad: 10, lcr: 17, conv: 10, ann: 8, talk: 12, rep: 7, interview: 8, bas: 10 };
const CAP_MINUTES = { ctw: 36, rdl: 15, acad: 21, lcr: 9, conv: 9, ann: 6, talk: 10, rep: 8, interview: 9, bas: 15 };

function phaseFor(daysLeft) {
  if (daysLeft <= 0) return { key: 'done', zh: '考試日已過', factor: 0 };
  if (daysLeft <= 6) return { key: 'taper', zh: '考前收尾', factor: 0.5 };
  if (daysLeft <= 27) return { key: 'mock', zh: '模考期', factor: 1 };
  if (daysLeft <= 55) return { key: 'build', zh: '強化期', factor: 1 };
  return { key: 'base', zh: '打底期', factor: 1 };
}

export async function buildPlan(db, day) {
  const s = await settings(db);
  const daysLeft = daysBetween(day, s.examDate);
  const phase = phaseFor(daysLeft);
  const wd = weekday(day);
  const total = Math.round(((wd === 0 || wd === 6) ? s.minutesWeekend : s.minutesWeekday) * phase.factor);
  // Vocabulary comes off the top, but always leaves at least half the time for test tasks.
  const vt = await vocab.planTasks(db, day);
  const vocabMinutes = Math.min(Math.round(total / 2), vt.screen.minutes + vt.review.minutes);
  const budget = total - vocabMinutes;
  const skills = await allSkills(db);
  const tasks = [];

  // 1. Any task type never attempted is part of the diagnostic.
  const unmeasured = skills.filter(k => k.n === 0).map(k => k.type);
  let used = 0;
  for (const type of unmeasured) {
    const t = TASKS[type];
    const target = DIAGNOSTIC_COUNT[type] || 1;
    tasks.push({ type, target, minutes: target * t.unitMinutes, diagnostic: true });
    used += target * t.unitMinutes;
  }
  if (unmeasured.length) return { v: PLAN_VERSION, day, daysLeft, phase, budget, vocabMinutes, tasks, diagnostic: true };

  // 2. One long writing task every day, alternating.
  const writingType = (daysBetween('2026-01-01', day) % 2 === 0) ? 'email' : 'disc';
  tasks.push({ type: writingType, target: 1, minutes: TASKS[writingType].unitMinutes });
  used += TASKS[writingType].unitMinutes;

  // Mock phase weekends: the second writing task too, for a full writing set.
  const other = writingType === 'email' ? 'disc' : 'email';
  let otherAdded = false;
  if (phase.key === 'mock' && (wd === 0 || wd === 6)) {
    tasks.push({ type: other, target: 1, minutes: TASKS[other].unitMinutes });
    used += TASKS[other].unitMinutes;
    otherAdded = true;
  }

  // 3. Spread the rest by gap-to-target, weighted by how many points each type carries,
  //    with caps so no single drill eats the whole session.
  const stretch = phase.key === 'base' ? 1.5 : 1.0; // early on, lean harder on weaknesses
  const listenBoost = phase.key === 'mock' || phase.key === 'taper' ? 1.4 : 1; // more listening close to the exam
  const pool = skills.filter(k => POINT_WEIGHT[k.type]);
  const weightOf = k => {
    const gap = Math.max(0, s.target + 0.25 - k.rating);
    const boost = TASKS[k.type].section === 'listening' ? listenBoost : 1;
    return (Math.pow(gap, stretch) + 0.25) * Math.sqrt(POINT_WEIGHT[k.type]) * boost;
  };
  const weights = pool.map(weightOf);
  const totalW = weights.reduce((a, b) => a + b, 0);
  const remaining = Math.max(0, budget - used);
  let spent = 0;
  const add = (type, units) => {
    const t = TASKS[type];
    const minutes = Math.round(units * t.unitMinutes);
    tasks.push({ type, target: units, minutes });
    spent += minutes;
  };
  pool.forEach((k, i) => {
    const t = TASKS[k.type];
    const minutes = Math.min(CAP_MINUTES[k.type], remaining * weights[i] / totalW);
    const units = Math.round(minutes / t.unitMinutes / t.sessionSize) * t.sessionSize;
    if (units > 0) add(k.type, units);
  });

  // Every day has some listening and some speaking, even if the split above rounded them away:
  // the weakest listening type, and the speaking types taking turns.
  const has = section => tasks.some(t => TASKS[t.type].section === section);
  if (!has('listening')) {
    const best = pool.filter(k => TASKS[k.type].section === 'listening').sort((a, b) => weightOf(b) - weightOf(a))[0];
    if (best) add(best.type, TASKS[best.type].sessionSize);
  }
  if (!has('speaking')) {
    const speakType = (daysBetween('2026-01-01', day) % 2 === 0) ? 'rep' : 'interview';
    add(speakType, 1);
  }

  // Time left over after the caps goes to the other long writing task.
  if (!otherAdded && remaining - spent >= TASKS[other].unitMinutes) {
    tasks.push({ type: other, target: 1, minutes: TASKS[other].unitMinutes });
  }
  // Order like the real test: reading, listening, speaking, writing.
  const order = Object.keys(TASKS);
  tasks.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  return { v: PLAN_VERSION, day, daysLeft, phase, budget, vocabMinutes, tasks, diagnostic: false };
}

// Plans are frozen once created for the day, so they don't shift mid-session.
// A diagnostic plan is the exception: it's rebuilt until the diagnostic is complete.
export async function getPlan(db, day = today()) {
  const row = await db.one('select tasks from public.plans where day = $1', [day]);
  let plan = row ? row.tasks : null;
  // A saved plan can come back as a JSON string (stored twice-encoded) or without its task list.
  // Such a plan is unusable: rebuild it instead of failing the whole page.
  if (typeof plan === 'string') { try { plan = JSON.parse(plan); } catch { plan = null; } }
  if (plan && !Array.isArray(plan.tasks)) plan = null;
  if (plan && (plan.v || 1) < PLAN_VERSION) plan = null; // made before the newest task types existed
  if (!plan) {
    plan = await buildPlan(db, day);
    await savePlan(db, day, plan);
  } else if (plan.diagnostic && !(await buildPlan(db, day)).diagnostic) {
    // diagnostic finished today: keep today's list, but mark it complete
    plan.diagnostic = false;
    plan.diagnosticDone = true;
    await savePlan(db, day, plan);
  }
  const done = Object.fromEntries(
    (await db.q('select type, count(*)::int as c from public.attempts where day = $1 group by type', [day])).map(r => [r.type, r.c]));
  plan.tasks = plan.tasks.map(t => ({ ...t, done: Math.min(done[t.type] || 0, t.target) }));
  plan.vocab = await vocab.planTasks(db, day); // live counts, not frozen
  plan.settings = await settings(db);
  return plan;
}

async function savePlan(db, day, plan) {
  await db.q(`insert into public.plans (day, tasks) values ($1, $2::jsonb)
              on conflict (user_id, day) do update set tasks = excluded.tasks`, [day, json(plan)]);
}

export async function resetToday(db, day = today()) {
  await db.q('delete from public.plans where day = $1', [day]);
}

export { DEFAULTS };
