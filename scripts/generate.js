#!/usr/bin/env node
// Refill the item bank near the learner's current level, and prepare vocabulary.
// Run nightly (see deploy/toefl-generate.timer). Optional args: task types to refill, e.g. `ctw bas`.
const bank = require('../lib/bank');
const vocab = require('../lib/vocab');
const { seedIfEmpty } = require('../lib/seed');

const log = msg => console.log(new Date().toISOString(), msg);

(async () => {
  seedIfEmpty();
  const types = process.argv.slice(2);
  await bank.topUp(types.length ? types : undefined, log);
  console.table(bank.stock());
  if (!types.length) {
    // enough candidates for tomorrow's screening (about 2-3x the daily target, since many will be known)
    try {
      while (vocab.stats().pool < vocab.settings().newPerDay * 2.5) {
        const before = vocab.stats().pool;
        await vocab.refillPool();
        log(`vocab pool: ${vocab.stats().pool}`);
        if (vocab.stats().pool === before) break;
      }
      await vocab.scheduleCards();
    } catch (e) { log(`vocab: ${e.message}`); }
    console.table([vocab.stats()]);
  }
})().catch(e => { console.error(e); process.exit(1); });
