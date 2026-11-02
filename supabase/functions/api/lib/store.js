// Per-user key/value settings and short-lived locks. Row Level Security scopes every query to the
// signed-in user, so no query here needs a user_id filter.

export async function getSetting(db, key, fallback = null) {
  const row = await db.one('select value from public.settings where key = $1', [key]);
  return row ? row.value : fallback;
}

export async function setSetting(db, key, value) {
  await db.q(`insert into public.settings (key, value) values ($1, $2::jsonb)
              on conflict (user_id, key) do update set value = excluded.value`, [key, JSON.stringify(value)]);
}

// Takes the lock if it is free or expired. Returns true when this caller holds it.
export async function tryLock(db, name, seconds) {
  const rows = await db.q(`insert into public.user_locks (name, until) values ($1, now() + make_interval(secs => $2::int))
                           on conflict (user_id, name) do update set until = excluded.until
                           where public.user_locks.until < now()
                           returning name`, [name, seconds]);
  return rows.length > 0;
}

export async function unlock(db, name) {
  await db.q('delete from public.user_locks where name = $1', [name]);
}

export async function isLocked(db, name) {
  return !!(await db.one('select 1 as x from public.user_locks where name = $1 and until > now()', [name]));
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
