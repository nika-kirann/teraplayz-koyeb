'use strict';
/**
 * Startup bootstrap: admin upsert + optional demo catalogue.
 * Demo catalogue = Creative Commons / CC0 sample films with public HTTPS
 * progressive MP4 URLs. Used only when Telegram is not configured (or
 * SEED_DEMO=true) and the database has no videos yet.
 */
const bcrypt = require('bcryptjs');
const db = require('./db');
const config = require('./config');
const { now, DAY } = require('./util');

const CATEGORIES = [
  ['Animation', 'animation', 'Open animated films and shorts.', 1],
  ['Short Films', 'short-films', 'Live-action and VFX shorts.', 2],
  ['Nature', 'nature', 'Calm footage from the natural world.', 3],
  ['Education', 'education', 'Learn something new — tutorials and explainers.', 4],
  ['Documentary', 'documentary', 'Real stories, real people.', 5],
  ['Music', 'music', 'Performances, videos and soundscapes.', 6],
  ['Sports', 'sports', 'Highlights and athletic moments.', 7],
];

const BF = 'Blender Foundation — CC BY 3.0 (www.blender.org).';
const DEMO = [
  { slug: 'big-buck-bunny', title: 'Big Buck Bunny', cat: 'animation', featured: 1, premium: 0, dl: 0, days: 1, views: 1840,
    url: 'https://archive.org/download/BigBuckBunny_124/Content/big_buck_bunny_720p_surround.mp4', w: 640, h: 360, dur: 596,
    desc: `A giant, gentle rabbit's peaceful day is spoiled by three mischievous rodents — and he decides to get even, cartoon-style. A joyful comedy for the whole family. © 2008 ${BF}` },
  { slug: 'elephants-dream', title: 'Elephants Dream', cat: 'animation', featured: 0, premium: 0, dl: 0, days: 6, views: 820,
    url: 'https://archive.org/download/ElephantsDream/ed_1024_512kb.mp4', w: 426, h: 240, dur: 654,
    desc: `Two characters explore a vast, surreal machine world — the world's first open movie, made entirely with open-source tools. © 2006 Orange Open Movie Project / ${BF}` },
  { slug: 'sintel', title: 'Sintel', cat: 'animation', featured: 1, premium: 1, dl: 0, days: 3, views: 1310,
    url: 'https://archive.org/download/Sintel/sintel-2048-surround_512kb.mp4', w: 564, h: 240, dur: 888,
    desc: `A lonely young woman searches far and wide for a baby dragon she once rescued. An epic fantasy adventure about friendship. Premium exclusive. © 2010 ${BF}` },
  { slug: 'tears-of-steel', title: 'Tears of Steel', cat: 'short-films', featured: 0, premium: 1, dl: 0, days: 2, views: 990,
    url: 'https://archive.org/download/Tears-of-Steel/tears_of_steel_1080p.mp4', w: 864, h: 360, dur: 734,
    desc: `In a futuristic Amsterdam, a group of scientists attempt to save the world with the help of a memory from the past. A sci‑fi VFX short. Premium exclusive. © 2012 ${BF}` },
  { slug: 'sintel-trailer', title: 'Sintel — Official Trailer', cat: 'animation', featured: 0, premium: 0, dl: 1, days: 9, views: 640,
    url: 'https://download.blender.org/durian/trailer/sintel_trailer-480p.mp4', w: 854, h: 480, dur: 52,
    desc: `The official trailer for Sintel, the Durian open movie project. Downloads enabled for signed-in viewers. © 2010 ${BF}` },
  { slug: 'blooming-flower', title: 'Blooming Flower — Macro Timelapse', cat: 'nature', featured: 0, premium: 0, dl: 1, days: 4, views: 410,
    url: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', w: 960, h: 540, dur: 5,
    desc: 'A short, relaxing macro shot of a red flower opening in the breeze. Public domain (CC0) sample footage.' },
  { slug: 'hd-playback-test-1080p', title: 'HD Playback Test — 1080p Meadow', cat: 'education', featured: 0, premium: 0, dl: 1, days: 12, views: 220,
    url: 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/1080/Big_Buck_Bunny_1080_10s_10MB.mp4', w: 1920, h: 1080, dur: 10,
    desc: `A 10-second Full HD H.264 sample (from Big Buck Bunny) to check your connection and screen handle 1080p playback. ${BF}` },
  { slug: 'sintel-1080p-sample', title: 'Sintel — 1080p Sample Clip', cat: 'education', featured: 0, premium: 1, dl: 1, days: 15, views: 150,
    url: 'https://test-videos.co.uk/vids/sintel/mp4/h264/1080/Sintel_1080_10s_10MB.mp4', w: 1920, h: 1080, dur: 10,
    desc: `A 10-second Full HD extract of Sintel for testing premium playback and downloads. ${BF}` },
];

const THUMB = {
  'big-buck-bunny': 'big-buck-bunny', 'elephants-dream': 'elephants-dream', sintel: 'sintel', 'tears-of-steel': 'tears-of-steel',
  'sintel-trailer': 'sintel-trailer', 'blooming-flower': 'flower', 'hd-playback-test-1080p': 'bbb-1080-clip', 'sintel-1080p-sample': 'sintel-1080-clip',
};

async function upsertAdmin() {
  if (!config.ADMIN_USERNAME || !config.ADMIN_PASSWORD) return;
  if (!/^[a-z0-9_]{3,24}$/.test(config.ADMIN_USERNAME)) { console.warn('[seed] ADMIN_USERNAME invalid; skipping admin upsert'); return; }
  if (config.ADMIN_PASSWORD.length < 10) console.warn('[seed] ADMIN_PASSWORD is short — use 16+ random characters in production.');
  const hash = await bcrypt.hash(config.ADMIN_PASSWORD, 12);
  const existing = await db.get('SELECT id, password_hash FROM users WHERE username = ?', [config.ADMIN_USERNAME]);
  if (existing) {
    const same = await bcrypt.compare(config.ADMIN_PASSWORD, existing.password_hash);
    await db.run("UPDATE users SET role = 'admin', is_banned = 0" + (same ? '' : ', password_hash = ?') + ' WHERE id = ?',
      same ? [existing.id] : [hash, existing.id]);
    if (!same) await db.run('DELETE FROM sessions WHERE user_id = ?', [existing.id]);
  } else {
    await db.run("INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, 'admin', ?)", [config.ADMIN_USERNAME, hash, now()]);
  }
  console.log(`[seed] admin account "${config.ADMIN_USERNAME}" ready`);
}

async function ensureCategories() {
  const n = Number((await db.get('SELECT COUNT(*) AS n FROM categories')).n);
  if (n) return;
  for (const [name, slug, description, sort] of CATEGORIES) {
    await db.run('INSERT INTO categories (name, slug, description, sort_order, created_at) VALUES (?, ?, ?, ?, ?)', [name, slug, description, sort, now()]);
  }
}

async function seedDemo({ force = false, onlyIfEmpty = false } = {}) {
  const want = config.SEED_DEMO === undefined || config.SEED_DEMO === '' ? config.demoMode : /^(1|true|yes)$/i.test(config.SEED_DEMO);
  if (!want && !force) return false;
  const n = Number((await db.get('SELECT COUNT(*) AS n FROM videos')).n);
  if (n && (!force || onlyIfEmpty)) return false;
  const cats = Object.fromEntries((await db.all('SELECT id, slug FROM categories')).map((c) => [c.slug, c.id]));
  const t = now();
  for (const d of DEMO) {
    if (await db.get('SELECT id FROM videos WHERE slug = ?', [d.slug])) continue;
    const ts = t - d.days * DAY;
    await db.run(`INSERT INTO videos (slug, title, description, category_id, source_type, source_url, thumbnail_url, mime_type,
        duration, width, height, is_published, is_premium, is_featured, download_allowed, views, created_at, updated_at, published_at)
        VALUES (?, ?, ?, ?, 'url', ?, ?, 'video/mp4', ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
    [d.slug, d.title, d.desc, cats[d.cat] || null, d.url, `/img/demo/${THUMB[d.slug]}.webp`, d.dur, d.w, d.h, d.premium, d.featured, d.dl, d.views, ts, ts, ts]);
  }
  const ads = Number((await db.get('SELECT COUNT(*) AS n FROM ads')).n);
  if (!ads) {
    await db.run(`INSERT INTO ads (name, slot, kind, image_url, link_url, pages, enabled, sort_order, created_at, updated_at)
      VALUES ('House: Go Premium (banner)', 'home_mid', 'image', '/img/ads/house-premium.svg', '/premium', 'all', 1, 0, ?, ?)`, [t, t]);
    await db.run(`INSERT INTO ads (name, slot, kind, image_url, link_url, pages, enabled, sort_order, created_at, updated_at)
      VALUES ('House: Go Premium (browse)', 'browse_top', 'image', '/img/ads/house-premium.svg', '/premium', 'browse', 1, 0, ?, ?)`, [t, t]);
    await db.run(`INSERT INTO ads (name, slot, kind, image_url, link_url, pages, enabled, sort_order, created_at, updated_at)
      VALUES ('Sponsor: Blender (sidebar)', 'watch_sidebar', 'image', '/img/ads/house-sidebar.svg', 'https://www.blender.org/', 'watch', 1, 0, ?, ?)`, [t, t]);
    await db.run(`INSERT INTO ads (name, slot, kind, html, pages, enabled, sort_order, created_at, updated_at)
      VALUES ('HTML snippet example (below player)', 'watch_below', 'html', ?, 'watch', 1, 0, ?, ?)`,
    ['<div style="font:600 15px system-ui;color:#e9d5ff;background:linear-gradient(90deg,#1a0630,#3b0764);padding:18px 22px;border-radius:12px">Your ad network snippet renders here, sandboxed in an isolated frame. <a href="/premium" target="_top" style="color:#fff">Remove ads →</a></div>', t, t]);
  }
  console.log('[seed] demo catalogue ready (Creative Commons sample films)');
  return true;
}

async function bootstrap() {
  await ensureCategories();
  await upsertAdmin();
  await seedDemo();
}

module.exports = { bootstrap, seedDemo, upsertAdmin, ensureCategories, DEMO };
