#!/usr/bin/env node
// Turns a backup of the old self-hosted TOEFL Coach (SQLite) into one SQL script that imports
// everything into a Supabase account. Paste the output into the Supabase SQL Editor and run it.
//
// Usage: node tools/sqlite-to-sql.js toefl-backup.db you@example.com > import.sql
//
// The script: finds the account by email (register on the site first), approves it, and copies
// practice items, attempts, skill estimates, the plan, settings, words and word reviews.
// It refuses to run twice into an account that already has data.
'use strict';
process.removeAllListeners('warning');
const { DatabaseSync } = require('node:sqlite');

const [file, email] = process.argv.slice(2);
if (!file || !email) {
  console.error('Usage: node tools/sqlite-to-sql.js toefl-backup.db you@example.com > import.sql');
  process.exit(1);
}
const db = new DatabaseSync(file, { readOnly: true });
const has = t => !!db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(t);
const all = (t, cols = '*', where = '') => (has(t) ? db.prepare(`select ${cols} from ${t} ${where} order by rowid`).all() : []);
const parse = s => { try { return s == null ? null : JSON.parse(s); } catch { return s; } };

const data = {
  items: all('items').map(r => ({ ...r, content: parse(r.content) })),
  attempts: all('attempts').map(r => ({ ...r, response: parse(r.response), feedback: parse(r.feedback) })),
  skills: all('skills'),
  skill_history: all('skill_history'),
  plans: all('plans').map(r => ({ ...r, tasks: parse(r.tasks) })),
  settings: all('settings', '*', "where key not in ('session_secret')").map(r => ({ ...r, value: parse(r.value) })),
  words: all('words').map(r => ({ ...r, card: parse(r.card) })),
  word_reviews: all('word_reviews').map(r => ({ ...r, free: !!r.free })),
};

const json = JSON.stringify(data);
let tag = 'data';
while (json.includes(`$${tag}$`)) tag += 'x';
const lit = s => `'${String(s).replace(/'/g, "''")}'`;
const counts = Object.entries(data).map(([k, v]) => `${k} ${v.length}`).join(', ');

process.stdout.write(`-- TOEFL Coach: import from the old SQLite backup into ${email}
-- Contents: ${counts}
do $import$
declare
  target_email text := ${lit(email)};
  uid uuid;
  d jsonb := $${tag}$${json}$${tag}$::jsonb;
  r record;
  nid int;
begin
  select id into uid from auth.users where lower(email) = lower(target_email);
  if uid is null then
    raise exception '找不到帳號 %：請先在網站上用這個 Email 註冊，再執行這個匯入', target_email;
  end if;
  if exists (select 1 from public.words where user_id = uid) or exists (select 1 from public.attempts where user_id = uid) then
    raise exception '帳號 % 已經有資料，為了避免重複匯入，已停止（沒有任何變更）', target_email;
  end if;

  update public.profiles set approved = true where id = uid;

  -- practice items: starter items match the ones already in the bank; the rest are added
  create temp table item_map (old_id int primary key, new_id int not null) on commit drop;
  for r in select * from jsonb_to_recordset(d->'items') as x(id int, type text, difficulty float8, content jsonb, source text, created_at text) loop
    nid := null;
    if r.source = 'seed' then
      select id into nid from public.items i where i.source = 'seed' and i.type = r.type and i.content = r.content limit 1;
    end if;
    if nid is null then
      insert into public.items (type, difficulty, content, source, created_by, created_at)
      values (r.type, r.difficulty, r.content, r.source, uid, coalesce((r.created_at || '+00')::timestamptz, now()))
      returning id into nid;
    end if;
    insert into item_map values (r.id, nid);
  end loop;

  insert into public.attempts (user_id, item_id, type, mode, response, score, raw_score, max_score, feedback, seconds, day, created_at)
  select uid, m.new_id, x.type, x.mode, x.response, x.score, x.raw_score, x.max_score, x.feedback, x.seconds, x.day,
         coalesce((x.created_at || '+00')::timestamptz, now())
  from jsonb_to_recordset(d->'attempts') as x(id int, item_id int, type text, mode text, response jsonb, score float8,
       raw_score float8, max_score float8, feedback jsonb, seconds int, day text, created_at text)
  join item_map m on m.old_id = x.item_id
  order by x.id;

  insert into public.skills (user_id, type, rating, n, updated_at)
  select uid, x.type, x.rating, x.n, coalesce((x.updated_at || '+00')::timestamptz, now())
  from jsonb_to_recordset(d->'skills') as x(type text, rating float8, n int, updated_at text);

  insert into public.skill_history (user_id, type, rating, day)
  select uid, x.type, x.rating, x.day from jsonb_to_recordset(d->'skill_history') as x(id int, type text, rating float8, day text) order by x.id;

  insert into public.plans (user_id, day, tasks)
  select uid, x.day, x.tasks from jsonb_to_recordset(d->'plans') as x(day text, tasks jsonb);

  insert into public.settings (user_id, key, value)
  select uid, x.key, x.value from jsonb_to_recordset(d->'settings') as x(key text, value jsonb)
  on conflict (user_id, key) do update set value = excluded.value;

  create temp table word_map (old_id int primary key, new_id int not null) on commit drop;
  for r in select * from jsonb_to_recordset(d->'words') as x(id int, word text, topic text, band float8, status text, mark text, card jsonb,
           step int, due_day text, reps int, lapses int, marked_day text, created_at text) loop
    insert into public.words (user_id, word, topic, band, status, mark, card, step, due_day, reps, lapses, marked_day, created_at)
    values (uid, r.word, r.topic, r.band, r.status, r.mark, r.card, r.step, r.due_day, r.reps, r.lapses, r.marked_day,
            coalesce((r.created_at || '+00')::timestamptz, now()))
    returning id into nid;
    insert into word_map values (r.id, nid);
  end loop;

  insert into public.word_reviews (user_id, word_id, day, mode, result, free, created_at)
  select uid, m.new_id, x.day, x.mode, x.result, coalesce(x.free, false), coalesce((x.created_at || '+00')::timestamptz, now())
  from jsonb_to_recordset(d->'word_reviews') as x(id int, word_id int, day text, mode text, result text, free boolean, created_at text)
  join word_map m on m.old_id = x.word_id
  order by x.id;

  raise notice '匯入完成：%', ${lit(counts)};
end
$import$;

-- Check: what is now in the account
select (select count(*) from public.words w join auth.users u on u.id = w.user_id where lower(u.email) = lower(${lit(email)})) as words,
       (select count(*) from public.attempts a join auth.users u on u.id = a.user_id where lower(u.email) = lower(${lit(email)})) as attempts,
       (select approved from public.profiles p join auth.users u on u.id = p.id where lower(u.email) = lower(${lit(email)})) as approved;
`);
