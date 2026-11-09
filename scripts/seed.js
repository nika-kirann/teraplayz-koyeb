#!/usr/bin/env node
'use strict';
/** npm run seed — (re)creates categories, admin and the CC demo catalogue. */
const db = require('../src/db');
const seed = require('../src/seed');

(async () => {
  await db.init();
  await seed.ensureCategories();
  await seed.upsertAdmin();
  const done = await seed.seedDemo({ force: true, onlyIfEmpty: !process.argv.includes('--force') });
  console.log(done ? 'Seed complete.' : 'Nothing to seed.');
  await db.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
