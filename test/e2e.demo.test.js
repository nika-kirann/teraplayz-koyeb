'use strict';
/* End-to-end tests in DEMO mode (no Telegram). Spawns the real server. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startServer, Client } = require('./helpers');

let srv; let admin; let guest; let alice;
const ADMIN_PW = 'Tpz-Admin-Test-2026!x9';

test.before(async () => {
  srv = await startServer();
  admin = new Client(srv.base);
  guest = new Client(srv.base);
  alice = new Client(srv.base);
});
test.after(async () => { await srv.stop(); });

const db = () => new (require('better-sqlite3'))(path.join(srv.dataDir, 'teraplayz.db'));
const idOf = (slug) => { const d = db(); const r = d.prepare('SELECT id FROM videos WHERE slug = ?').get(slug); d.close(); return r && r.id; };

test('GET /healthz returns 200 {status:"ok"} without auth', async () => {
  const r = await fetch(srv.base + '/healthz');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.status, 'ok');
  const deep = await (await fetch(srv.base + '/healthz?deep=1')).json();
  assert.equal(deep.db, 'ok');
});

test('homepage renders hero, trending, latest, categories and ads for guests', async () => {
  const r = await guest.get('/');
  assert.equal(r.status, 200);
  assert.match(r.text_, /TERA<span>PLAYZ<\/span>/);
  assert.match(r.text_, /class="hero"/);
  assert.match(r.text_, /Trending now/);
  assert.match(r.text_, /Latest releases/);
  assert.match(r.text_, /href="\/category\/animation"/);
  assert.match(r.text_, /class="ad-slot ad-home_mid"/, 'guest should see ads');
  assert.match(r.text_, /loading="lazy"/);
  assert.ok(r.headers.get('content-security-policy'), 'CSP header present');
});

test('search matches title/description and shows empty state', async () => {
  const r = await guest.get('/search?q=dragon');
  assert.equal(r.status, 200);
  assert.match(r.text_, /Sintel/);
  assert.doesNotMatch(r.text_, /card-title">Big Buck Bunny/);
  const none = await guest.get('/search?q=zzzznothing');
  assert.match(none.text_, /Nothing here yet/);
  const api = await (await fetch(srv.base + '/api/videos?q=bunny')).json();
  assert.ok(api.items.some((i) => i.slug === 'big-buck-bunny'));
});

test('category filter and pagination partials work', async () => {
  const r = await guest.get('/category/nature');
  assert.equal(r.status, 200);
  assert.match(r.text_, /Blooming Flower/);
  assert.doesNotMatch(r.text_, /card-title">Big Buck Bunny/);
  const b = await guest.get('/browse?category=animation&sort=popular');
  assert.match(b.text_, /Big Buck Bunny/);
  assert.doesNotMatch(b.text_, /card-title">Blooming Flower/);
  const partial = await guest.get('/browse?partial=1&page=1');
  assert.match(partial.text_, /class="card/);
  assert.doesNotMatch(partial.text_, /<html/);
  assert.equal((await guest.get('/category/does-not-exist')).status, 404);
});

test('player page loads with custom controls and the stream proxy honours Range', async () => {
  const r = await guest.get('/watch/big-buck-bunny');
  assert.equal(r.status, 200);
  for (const needle of ['id="player"', 'data-act="play"', 'pc-vol-range', 'data-act="speed"', 'data-act="fs"', 'player-progress', '/js/player.js']) assert.ok(r.text_.includes(needle), needle);
  assert.doesNotMatch(r.text_, /archive\.org/, 'upstream URL must not be exposed');
  const id = idOf('big-buck-bunny');
  let s;
  for (let i = 0; i < 3; i++) { // public CDN (archive.org) can be flaky; retry
    s = await fetch(`${srv.base}/stream/${id}`, { headers: { range: 'bytes=0-1023' } });
    if (s.status === 206) break;
    await s.arrayBuffer(); await new Promise((r) => setTimeout(r, 1000));
  }
  assert.equal(s.status, 206);
  assert.match(s.headers.get('content-range') || '', /^bytes 0-1023\//);
  assert.equal((await s.arrayBuffer()).byteLength, 1024);
});

test('premium-only video is gated for guests and free users', async () => {
  const r = await guest.get('/watch/sintel');
  assert.equal(r.status, 200);
  assert.match(r.text_, /Premium exclusive/);
  assert.doesNotMatch(r.text_, /src="\/stream\//);
  const s = await fetch(`${srv.base}/stream/${idOf('sintel')}`, { headers: { range: 'bytes=0-10' } });
  assert.equal(s.status, 403);
});

test('register + login; free user still gated and sees ads; download needs login', async () => {
  await alice.csrf('/register');
  const reg = await alice.post('/register', { username: 'alice', password: 'Alice-pass-1234', password_confirm: 'Alice-pass-1234' });
  assert.equal(reg.status, 302);
  const home = await alice.get('/');
  assert.match(home.text_, /aria-label="Account menu"/);
  assert.match(home.text_, /class="ad-slot/);
  const s = await alice.req(`/stream/${idOf('sintel')}`, { headers: { range: 'bytes=0-10' } });
  assert.equal(s.status, 403);
  const dlGuest = await guest.req(`/download/${idOf('sintel-trailer')}`);
  assert.equal(dlGuest.status, 302);
  const dl = await alice.req(`/download/${idOf('sintel-trailer')}`, { headers: { range: 'bytes=0-99' } });
  assert.equal(dl.status, 206);
  assert.match(dl.headers.get('content-disposition'), /attachment/);
  await dl.arrayBuffer();
  const noDl = await alice.req(`/download/${idOf('big-buck-bunny')}`);
  assert.equal(noDl.status, 403);
});

test('auth rejects bad credentials, duplicate usernames and weak passwords', async () => {
  const c = new Client(srv.base);
  const bad = await c.login('admin', 'wrong-password');
  assert.equal(bad.status, 401);
  await c.csrf('/register');
  const dup = await c.post('/register', { username: 'alice', password: 'Another-pass-99', password_confirm: 'Another-pass-99' });
  assert.equal(dup.status, 400);
  const weak = await c.post('/register', { username: 'bob', password: 'short', password_confirm: 'short' });
  assert.equal(weak.status, 400);
});

test('CSRF: form posts without/with a wrong token are rejected', async () => {
  const c = new Client(srv.base);
  await c.csrf('/login');
  const r = await c.post('/login', { username: 'admin', password: ADMIN_PW }, { csrf: false });
  assert.equal(r.status, 403);
  const r2 = await c.post('/login', { username: 'admin', password: ADMIN_PW, _csrf: 'forged' }, { csrf: false });
  assert.equal(r2.status, 403);
  const r3 = await c.req('/login', { method: 'POST', body: new URLSearchParams({ _csrf: c.token, username: 'admin', password: ADMIN_PW }), headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' } });
  assert.equal(r3.status, 403);
});

test('admin dashboard is admin-only (server-side)', async () => {
  assert.equal((await guest.req('/admin')).status, 302);
  assert.equal((await alice.get('/admin')).status, 403);
  assert.equal((await alice.get('/admin/videos')).status, 403);
  const login = await admin.login('admin', ADMIN_PW);
  assert.equal(login.status, 302);
  const dash = await admin.get('/admin');
  assert.equal(dash.status, 200);
  assert.match(dash.text_, /Total users/);
  assert.match(dash.text_, /Premium members/);
  assert.match(dash.text_, /Demo mode/);
});

test('admin video CRUD: create (with thumbnail upload), edit, unpublish hides, publish shows, delete', async () => {
  await admin.csrf('/admin/videos/new');
  const sharp = require('sharp');
  const png = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#7c3aed' } }).png().toBuffer();
  const fd = new FormData();
  fd.append('title', 'Ocean Waves Test Clip');
  fd.append('description', 'Relaxing ocean footage for testing.');
  const d = db(); const nature = d.prepare("SELECT id FROM categories WHERE slug='nature'").get().id; d.close();
  fd.append('category_id', String(nature));
  fd.append('source_type', 'url');
  fd.append('source_url', 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4');
  fd.append('is_published', '1');
  fd.append('thumbnail', new Blob([png], { type: 'image/png' }), 'thumb.png');
  const created = await admin.postMultipart('/admin/videos', fd);
  assert.equal(created.status, 302, created.text_.slice(0, 500));
  const editUrl = created.headers.get('location');
  const vid = Number(editUrl.match(/\/admin\/videos\/(\d+)\/edit/)[1]);
  const row = (() => { const x = db(); const r = x.prepare('SELECT * FROM videos WHERE id = ?').get(vid); x.close(); return r; })();
  assert.ok(row.thumbnail_path && row.thumbnail_path.endsWith('.webp'), 'thumbnail compressed to webp');
  const meta = await sharp(path.join(srv.dataDir, 'thumbs', row.thumbnail_path)).metadata();
  assert.equal(meta.width, 640); assert.equal(meta.height, 360);

  let pub = await guest.get('/search?q=ocean');
  assert.match(pub.text_, /Ocean Waves Test Clip/);

  // edit
  await admin.csrf(editUrl);
  const fd2 = new FormData();
  for (const [k, v] of Object.entries({ title: 'Ocean Waves (Edited)', description: 'Edited.', category_id: String(nature), source_type: 'url', source_url: row.source_url, is_published: '1', is_premium: '1' })) fd2.append(k, v);
  const edited = await admin.postMultipart(`/admin/videos/${vid}`, fd2);
  assert.equal(edited.status, 302);
  pub = await guest.get('/search?q=ocean');
  assert.match(pub.text_, /Ocean Waves \(Edited\)/);
  const slug = (() => { const x = db(); const r = x.prepare('SELECT slug FROM videos WHERE id = ?').get(vid); x.close(); return r.slug; })();
  assert.match((await guest.get('/watch/' + slug)).text_, /Premium exclusive/);

  // unpublish -> hidden
  const un = await admin.post(`/admin/videos/${vid}/unpublish`);
  assert.equal(un.status, 302);
  pub = await guest.get('/search?q=ocean');
  assert.doesNotMatch(pub.text_, /Ocean Waves/);
  assert.equal((await guest.get('/watch/' + slug)).status, 404);
  assert.equal((await guest.req(`/stream/${vid}`)).status, 404);
  assert.equal((await admin.get('/watch/' + slug)).status, 200, 'admin can preview drafts');

  // publish -> visible again
  await admin.post(`/admin/videos/${vid}/publish`);
  pub = await guest.get('/search?q=ocean');
  assert.match(pub.text_, /Ocean Waves/);

  // validation
  await admin.csrf('/admin/videos/new');
  const bad = new FormData(); bad.append('title', ''); bad.append('source_type', 'url'); bad.append('source_url', 'javascript:alert(1)');
  const badR = await admin.postMultipart('/admin/videos', bad);
  assert.equal(badR.status, 400);

  // delete
  const del = await admin.post(`/admin/videos/${vid}/delete`);
  assert.equal(del.status, 302);
  assert.equal((await guest.get('/watch/' + slug)).status, 404);
});

test('admin categories CRUD', async () => {
  await admin.csrf('/admin/categories');
  await admin.post('/admin/categories', { name: 'Kids & Family', description: 'Fun for everyone' });
  let r = await guest.get('/');
  assert.match(r.text_, /Kids &amp; Family/);
  const d = db(); const c = d.prepare("SELECT id FROM categories WHERE slug='kids-family'").get(); d.close();
  assert.ok(c);
  await admin.post(`/admin/categories/${c.id}`, { name: 'Family', slug: 'family', sort_order: '9' });
  r = await guest.get('/category/family');
  assert.equal(r.status, 200);
  await admin.post(`/admin/categories/${c.id}/delete`);
  assert.equal((await guest.get('/category/family')).status, 404);
});

test('admin grants premium -> user sees no ads, gets badge and can stream premium video; revoke restores gating', async () => {
  const d = db(); const aliceId = d.prepare("SELECT id FROM users WHERE username='alice'").get().id; d.close();
  await admin.csrf('/admin/members');
  const g = await admin.post(`/admin/members/${aliceId}/grant`, { days: '31' });
  assert.equal(g.status, 302);
  const home = await alice.get('/');
  assert.doesNotMatch(home.text_, /class="ad-slot/, 'premium user must not see ads');
  assert.match(home.text_, /class="badge-premium"/);
  const watch = await alice.get('/watch/sintel');
  assert.match(watch.text_, /src="\/stream\//);
  assert.doesNotMatch(watch.text_, /class="ad-slot/);
  const s = await alice.req(`/stream/${idOf('sintel')}`, { headers: { range: 'bytes=0-1023' } });
  assert.equal(s.status, 206); await s.arrayBuffer();
  const frame = await alice.req('/ads/frame/4');
  assert.equal(frame.status, 204, 'html ad frame empty for premium');
  // guest still sees ads
  assert.match((await guest.get('/')).text_, /class="ad-slot/);
  // expiry computed per request: set expiry in the past directly in DB
  const x = db(); x.prepare('UPDATE users SET premium_until = ? WHERE id = ?').run(Date.now() - 1000, aliceId); x.close();
  assert.match((await alice.get('/watch/sintel')).text_, /Premium exclusive/);
  assert.match((await alice.get('/')).text_, /class="ad-slot/);
  // mark premium in DB directly -> ad-free
  const y = db(); y.prepare('UPDATE users SET premium_until = ? WHERE id = ?').run(Date.now() + 864e5, aliceId); y.close();
  assert.doesNotMatch((await alice.get('/browse')).text_, /class="ad-slot/);
  await admin.post(`/admin/members/${aliceId}/revoke`);
  assert.match((await alice.get('/watch/sintel')).text_, /Premium exclusive/);
});

test('resume playback: progress API stores position and watch page offers resume', async () => {
  await alice.csrf('/watch/big-buck-bunny');
  const id = idOf('big-buck-bunny');
  const r = await alice.postJson('/api/progress', { video_id: id, position: 123.4, duration: 596 });
  assert.equal(r.status, 200);
  const w = await alice.get('/watch/big-buck-bunny');
  assert.match(w.text_, /data-resume="123"/);
  const home = await alice.get('/');
  assert.match(home.text_, /Continue watching/);
  const bad = await alice.postJson('/api/progress', { video_id: id, position: -5 });
  assert.equal(bad.status, 400);
  const noCsrf = await alice.req('/api/progress', { method: 'POST', body: JSON.stringify({ video_id: id, position: 1 }), headers: { 'content-type': 'application/json' } });
  assert.equal(noCsrf.status, 403);
});

test('ads are configurable from admin (toggle off -> hidden for free users)', async () => {
  await admin.csrf('/admin/ads');
  const x = db(); const ad = x.prepare("SELECT id FROM ads WHERE slot='home_mid'").get(); x.close();
  await admin.post(`/admin/ads/${ad.id}/toggle`);
  assert.doesNotMatch((await guest.get('/')).text_, /ad-home_mid/);
  await admin.post(`/admin/ads/${ad.id}/toggle`);
  assert.match((await guest.get('/')).text_, /ad-home_mid/);
  const created = await admin.post('/admin/ads', { name: 'Test top', slot: 'home_top', kind: 'image', image_url: '/img/ads/house-premium.svg', link_url: '/premium', pages: 'home', enabled: '1' });
  assert.equal(created.status, 302);
  assert.match((await guest.get('/')).text_, /ad-home_top/);
});

test('premium page shows disabled Stars CTA in demo mode; webhook disabled', async () => {
  const p = await alice.get('/premium');
  assert.match(p.text_, /Go Premium — 100 Stars\/month/);
  assert.match(p.text_, /demo mode/);
  const w = await fetch(srv.base + '/telegram/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(w.status, 404);
});

test('logout clears the session', async () => {
  await alice.csrf('/');
  const r = await alice.post('/logout');
  assert.equal(r.status, 302);
  assert.doesNotMatch((await alice.get('/')).text_, /aria-label="Account menu"/);
});
