#!/usr/bin/env node
'use strict';
/**
 * PostgreSQL smoke test: node scripts/pg-smoke.js postgres://user:pass@host:port/db
 * Boots the app against DATABASE_URL and exercises the main flows over HTTP.
 */
const assert = require('assert/strict');
const { startServer, Client } = require('../test/helpers');

(async () => {
  const url = process.argv[2] || process.env.DATABASE_URL;
  if (!url) throw new Error('pass a DATABASE_URL');
  const srv = await startServer({ DATABASE_URL: url, DATABASE_SSL: 'disable', PG_POOL_MAX: process.env.PG_POOL_MAX || '1' });
  const ok = (m) => console.log('  ✔ ' + m);
  try {
    assert.match(srv.log(), /db=pg/); ok('server started on PostgreSQL');
    const deep = await (await fetch(srv.base + '/healthz?deep=1')).json();
    assert.equal(deep.db, 'ok'); ok('/healthz?deep=1 db ok');
    const g = new Client(srv.base);
    const home = await g.get('/');
    assert.equal(home.status, 200); assert.match(home.text_, /Trending now/); assert.match(home.text_, /ad-slot/); ok('home renders with demo catalogue + ads');
    assert.match((await g.get('/search?q=DRAGON')).text_, /Sintel/); ok('case-insensitive search (LOWER LIKE) works');
    assert.match((await g.get('/category/nature')).text_, /Blooming Flower/); ok('category filter works');
    const a = new Client(srv.base);
    assert.equal((await a.login('admin', 'Tpz-Admin-Test-2026!x9')).status, 302); ok('admin login');
    await a.csrf('/admin/videos/new');
    const fd = new FormData();
    for (const [k, v] of Object.entries({ title: 'PG Clip', source_type: 'url', source_url: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', is_published: '1' })) fd.append(k, v);
    const png = await require('sharp')({ create: { width: 800, height: 600, channels: 3, background: '#a855f7' } }).png().toBuffer();
    fd.append('thumbnail', new Blob([png], { type: 'image/png' }), 't.png');
    const c = await a.postMultipart('/admin/videos', fd);
    assert.equal(c.status, 302, c.text_.slice(0, 300));
    const id = c.headers.get('location').match(/videos\/(\d+)/)[1]; ok('admin created video #' + id + ' (INSERT … RETURNING)');
    const sr = await g.get('/search?q=pg clip');
    assert.match(sr.text_, /PG Clip/);
    const thumbUrl = sr.text_.match(/src="(\/media\/t\/\d+\.webp)"/)[1];
    const tr = await fetch(srv.base + thumbUrl);
    assert.equal(tr.status, 200); assert.equal(tr.headers.get('content-type'), 'image/webp');
    ok('thumbnail compressed to WebP and stored in Postgres (' + (await tr.arrayBuffer()).byteLength + ' bytes) -> ' + thumbUrl);
    await a.post(`/admin/videos/${id}/unpublish`);
    assert.doesNotMatch((await g.get('/search?q=pg clip')).text_, /PG Clip/); ok('unpublish hides video');
    await a.post(`/admin/videos/${id}/delete`); ok('delete');
    const u = new Client(srv.base);
    await u.csrf('/register');
    assert.equal((await u.post('/register', { username: 'pguser', password: 'Pg-user-1234', password_confirm: 'Pg-user-1234' })).status, 302); ok('register');
    await u.csrf('/watch/big-buck-bunny');
    const vid = (await (await fetch(srv.base + '/api/videos?q=big buck')).json()).items[0].id;
    assert.equal((await u.postJson('/api/progress', { video_id: vid, position: 50, duration: 596 })).status, 200); ok('progress upsert (ON CONFLICT)');
    assert.match((await u.get('/watch/big-buck-bunny')).text_, /data-resume="50"/);
    const members = await a.get('/admin/members?q=pguser');
    const uid = members.text_.match(/\/admin\/members\/(\d+)\/grant/)[1];
    await a.csrf('/admin/members');
    await a.post(`/admin/members/${uid}/grant`, { days: '31' });
    const h2 = await u.get('/');
    assert.doesNotMatch(h2.text_, /class="ad-slot/); assert.match(h2.text_, /badge-premium/); ok('premium grant (transaction) -> ad-free + badge');
    assert.match((await u.get('/watch/sintel')).text_, /src="\/stream\//); ok('premium video playable');
    assert.equal((await a.get('/admin')).status, 200); ok('dashboard stats queries');
    console.log('PostgreSQL smoke test passed.');
  } finally { await srv.stop(); }
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
