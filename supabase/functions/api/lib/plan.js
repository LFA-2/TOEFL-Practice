// Builds the daily task list from exam date, target band and current ability.
import { TASKS } from './tasks.js';
import { allSkills } from './skills.js';
import { today, daysBetween, weekday } from './time.js';
import { getSetting, setSetting } from './store.js';
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
    const target = type === 'bas' ? 5 : type === 'ctw' ? 2 : 1;
    tasks.push({ type, target, minutes: target * t.unitMinutes, diagnostic: true });
    used += target * t.unitMinutes;
  }
  if (unmeasured.length) return { day, daysLeft, phase, budget, vocabMinutes, tasks, diagnostic: true };

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
  const pointWeight = { ctw: 30, rdl: 10, acad: 10, bas: 10 };
  const capMinutes = { ctw: 36, rdl: 15, acad: 21, bas: 15 };
  const stretch = phase.key === 'base' ? 1.5 : 1.0; // early on, lean harder on weaknesses
  const pool = skills.filter(k => pointWeight[k.type]);
  const weights = pool.map(k => {
    const gap = Math.max(0, s.target + 0.25 - k.rating);
    return (Math.pow(gap, stretch) + 0.25) * Math.sqrt(pointWeight[k.type]);
  });
  const totalW = weights.reduce((a, b) => a + b, 0);
  const remaining = Math.max(0, budget - used);
  let spent = 0;
  pool.forEach((k, i) => {
    const t = TASKS[k.type];
    const minutes = Math.min(capMinutes[k.type], remaining * weights[i] / totalW);
    const units = Math.round(minutes / t.unitMinutes / t.sessionSize) * t.sessionSize;
    if (units > 0) { tasks.push({ type: k.type, target: units, minutes: units * t.unitMinutes }); spent += units * t.unitMinutes; }
  });

  // Time left over after the caps goes to the other long writing task.
  if (!otherAdded && remaining - spent >= TASKS[other].unitMinutes) {
    tasks.push({ type: other, target: 1, minutes: TASKS[other].unitMinutes });
  }
  return { day, daysLeft, phase, budget, vocabMinutes, tasks, diagnostic: false };
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
              on conflict (user_id, day) do update set tasks = excluded.tasks`, [day, JSON.stringify(plan)]);
}

export async function resetToday(db, day = today()) {
  await db.q('delete from public.plans where day = $1', [day]);
}

export { DEFAULTS };
