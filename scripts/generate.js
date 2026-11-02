#!/usr/bin/env node
// Refill the item bank near the learner's current level. Run nightly (see deploy/toefl-generate.timer).
const bank = require('../lib/bank');
const { seedIfEmpty } = require('../lib/seed');

seedIfEmpty();
const types = process.argv.slice(2);
bank.topUp(types.length ? types : undefined, msg => console.log(new Date().toISOString(), msg))
  .then(() => { console.table(bank.stock()); })
  .catch(e => { console.error(e); process.exit(1); });
