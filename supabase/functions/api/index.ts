// @ts-nocheck — the shared code in app.js and lib/ is plain JavaScript.
// Supabase Edge Function entry point: wires the runtime-independent handler to Deno.
//
// Secrets (set with `npx supabase secrets set NAME=value`):
//   ANTHROPIC_API_KEY        required for AI features; never sent to the browser
//   ANTHROPIC_MODEL          optional, default claude-sonnet-5-5 (questions, essay grading)
//   ANTHROPIC_VOCAB_MODEL    optional, default claude-haiku-5-5 (word lists, study cards)
//   ALLOWED_ORIGINS          optional, comma-separated site origins for CORS, default *
// Provided by Supabase automatically: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_DB_URL
import postgres from 'npm:postgres@3.4.5';
import { createHandler } from './app.js';
import { makeAi } from './lib/ai.js';

const env = name => Deno.env.get(name) || '';
const SUPABASE_URL = env('SUPABASE_URL');

// Direct database connection; every query runs as the signed-in user with Row Level Security applied.
const sql = postgres(env('SUPABASE_DB_URL'), { prepare: false, max: 4, idle_timeout: 20, connect_timeout: 10 });

async function runAs(uid, fn) {
  return sql.begin(async tx => {
    await tx.unsafe(`select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)`,
      [JSON.stringify({ sub: uid, role: 'authenticated' })]);
    return fn(async (text, params) => [...(await tx.unsafe(text, params))]);
  });
}

// Asks Supabase Auth who owns this access token (rejects expired or forged tokens).
async function getUser(token, apikey) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { authorization: `Bearer ${token}`, apikey: apikey || env('SUPABASE_ANON_KEY') },
  });
  if (!res.ok) return null;
  const u = await res.json();
  return u && u.id ? { id: u.id, email: u.email } : null;
}

const handle = createHandler({
  getUser,
  runAs,
  ai: makeAi({
    anthropicKey: env('ANTHROPIC_API_KEY'),
    model: env('ANTHROPIC_MODEL') || 'claude-sonnet-5-5',
    vocabModel: env('ANTHROPIC_VOCAB_MODEL') || 'claude-haiku-5-5',
    apiBase: 'https://api.anthropic.com',
    aiMock: false,
  }),
  waitUntil: p => (globalThis.EdgeRuntime?.waitUntil ? globalThis.EdgeRuntime.waitUntil(p) : p),
  allowedOrigins: (env('ALLOWED_ORIGINS') || '*').split(',').map(s => s.trim()).filter(Boolean),
});

Deno.serve(handle);
