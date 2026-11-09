'use strict';
const db = require('../db');
const cache = require('../cache');
const config = require('../config');
const { escapeLike, now, slugify, randomToken, todayKey } = require('../util');

const CARD_COLS = `v.id, v.slug, v.title, v.description, v.category_id, v.thumbnail_path, v.thumbnail_url,
  v.telegram_thumb_file_id, v.duration, v.width, v.height, v.is_premium, v.is_featured, v.is_published,
  v.views, v.created_at, v.published_at, c.name AS category_name, c.slug AS category_slug`;

function thumbSrc(v) {
  if (!v) return '/img/placeholder.svg';
  if (v.thumbnail_path) {
    const m = String(v.thumbnail_path).match(/^db:(\d+)$/);
    return m ? `/media/t/${m[1]}.webp` : '/media/thumbs/' + encodeURIComponent(v.thumbnail_path);
  }
  if (v.thumbnail_url) return v.thumbnail_url;
  if (v.telegram_thumb_file_id) return '/thumb/' + v.id;
  return '/img/placeholder.svg';
}

function decorate(v) {
  if (!v) return v;
  v.thumb = thumbSrc(v);
  v.date = v.published_at || v.created_at;
  v.isHD = Number(v.height) >= 720;
  return v;
}

/** Visibility clause for public listings. */
function visibility(viewerPremium) {
  // Premium items are shown as locked teasers unless PREMIUM_TEASERS=false.
  return config.PREMIUM_TEASERS || viewerPremium ? 'v.is_published = 1' : 'v.is_published = 1 AND v.is_premium = 0';
}

async function list({ q = '', categoryId = null, sort = 'latest', page = 1, pageSize = config.PAGE_SIZE, viewerPremium = false, premiumOnly = false } = {}) {
  const key = `videos:list:${q}|${categoryId}|${sort}|${page}|${pageSize}|${viewerPremium ? 1 : 0}|${premiumOnly ? 1 : 0}`;
  return cache.wrap(key, config.CACHE_TTL_SECONDS, async () => {
    const where = [visibility(viewerPremium)];
    const params = [];
    if (q) {
      const like = '%' + escapeLike(q) + '%';
      where.push(`(${db.ilike('v.title')} OR ${db.ilike('v.description')})`);
      params.push(like, like);
    }
    if (categoryId) { where.push('v.category_id = ?'); params.push(categoryId); }
    if (premiumOnly) where.push('v.is_premium = 1');
    const order = sort === 'popular' ? 'v.views DESC, v.id DESC'
      : sort === 'oldest' ? 'COALESCE(v.published_at, v.created_at) ASC, v.id ASC'
      : sort === 'title' ? 'LOWER(v.title) ASC'
      : 'COALESCE(v.published_at, v.created_at) DESC, v.id DESC';
    const w = where.join(' AND ');
    const totalRow = await db.get(`SELECT COUNT(*) AS n FROM videos v WHERE ${w}`, params);
    const total = Number(totalRow.n);
    const offset = (page - 1) * pageSize;
    const items = await db.all(
      `SELECT ${CARD_COLS} FROM videos v LEFT JOIN categories c ON c.id = v.category_id
        WHERE ${w} ORDER BY ${order} LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
    return { items: items.map(decorate), total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
  });
}

/** Trending = views decayed by age (Hacker-News-style gravity), computed in JS for portability. */
async function trending(limit = 12, viewerPremium = false) {
  return cache.wrap(`videos:trending:${limit}:${viewerPremium ? 1 : 0}`, config.CACHE_TTL_SECONDS, async () => {
    const rows = await db.all(
      `SELECT ${CARD_COLS} FROM videos v LEFT JOIN categories c ON c.id = v.category_id
        WHERE ${visibility(viewerPremium)} ORDER BY v.views DESC LIMIT 300`);
    const t = now();
    for (const r of rows) {
      const ageH = Math.max(0, (t - Number(r.published_at || r.created_at)) / 3600000);
      r.score = (Number(r.views) + 1) / Math.pow(ageH / 24 + 2, 1.2);
    }
    rows.sort((a, b) => b.score - a.score);
    return rows.slice(0, limit).map(decorate);
  });
}

async function featured(viewerPremium = false) {
  return cache.wrap(`videos:featured:${viewerPremium ? 1 : 0}`, config.CACHE_TTL_SECONDS, async () => {
    const rows = await db.all(
      `SELECT ${CARD_COLS} FROM videos v LEFT JOIN categories c ON c.id = v.category_id
        WHERE ${visibility(viewerPremium)} ORDER BY v.is_featured DESC, COALESCE(v.published_at, v.created_at) DESC LIMIT 5`);
    return rows.map(decorate);
  });
}

async function categories() {
  return cache.wrap('categories:all', 300, async () => db.all(
    `SELECT c.id, c.name, c.slug, c.description, c.sort_order,
            (SELECT COUNT(*) FROM videos v WHERE v.category_id = c.id AND v.is_published = 1) AS video_count
       FROM categories c ORDER BY c.sort_order ASC, c.name ASC`));
}

async function bySlug(slug) {
  const v = await db.get(`SELECT v.*, c.name AS category_name, c.slug AS category_slug FROM videos v
    LEFT JOIN categories c ON c.id = v.category_id WHERE v.slug = ?`, [slug]);
  return decorate(v);
}

async function byId(id) {
  const v = await db.get(`SELECT v.*, c.name AS category_name, c.slug AS category_slug FROM videos v
    LEFT JOIN categories c ON c.id = v.category_id WHERE v.id = ?`, [id]);
  return decorate(v);
}

async function related(video, limit = 8, viewerPremium = false) {
  return cache.wrap(`videos:related:${video.id}:${viewerPremium ? 1 : 0}`, config.CACHE_TTL_SECONDS, async () => {
    const rows = await db.all(
      `SELECT ${CARD_COLS} FROM videos v LEFT JOIN categories c ON c.id = v.category_id
        WHERE ${visibility(viewerPremium)} AND v.id <> ?
        ORDER BY CASE WHEN v.category_id = ? THEN 0 ELSE 1 END, v.views DESC LIMIT ?`,
      [video.id, video.category_id || 0, limit]);
    return rows.map(decorate);
  });
}

/** Who may play a video? Returns { ok, reason }. Pure server-side check. */
function canWatch(video, user) {
  if (!video) return { ok: false, reason: 'not_found' };
  const isAdmin = Boolean(user && user.role === 'admin');
  if (!video.is_published && !isAdmin) return { ok: false, reason: 'not_found' };
  if (video.is_premium && !isAdmin && !(user && user.isPremium)) return { ok: false, reason: user ? 'premium' : 'login_premium' };
  return { ok: true };
}

function canDownload(video, user) {
  if (!video || !video.download_allowed || !user) return false;
  return canWatch(video, user).ok;
}

// ---- view counting with in-memory de-duplication (no background jobs) ----
const seen = new Map();
async function countView(videoId, viewerKey) {
  const k = `${videoId}:${viewerKey}`;
  const t = now();
  const last = seen.get(k);
  if (last && t - last < 30 * 60 * 1000) return false;
  if (seen.size > 20000) seen.clear();
  seen.set(k, t);
  await db.run('UPDATE videos SET views = views + 1 WHERE id = ?', [videoId]);
  await bumpDaily('views');
  return true;
}

async function bumpDaily(field) {
  if (!['views', 'signups', 'payments'].includes(field)) return;
  const day = todayKey();
  const r = await db.run(`UPDATE daily_stats SET ${field} = ${field} + 1 WHERE day = ?`, [day]);
  if (!r.changes) {
    try { await db.run(`INSERT INTO daily_stats (day, ${field}) VALUES (?, 1)`, [day]); }
    catch { await db.run(`UPDATE daily_stats SET ${field} = ${field} + 1 WHERE day = ?`, [day]); }
  }
}

async function uniqueSlug(title, excludeId = null) {
  const base = slugify(title);
  let slug = base;
  for (let i = 0; i < 20; i++) {
    const row = await db.get('SELECT id FROM videos WHERE slug = ?', [slug]);
    if (!row || (excludeId && Number(row.id) === Number(excludeId))) return slug;
    slug = `${base}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
  }
  return `${base}-${Date.now()}`;
}

const WRITABLE = ['title', 'description', 'category_id', 'source_type', 'source_url', 'telegram_message_id',
  'telegram_file_id', 'telegram_file_unique_id', 'telegram_thumb_file_id', 'thumbnail_path', 'thumbnail_url',
  'mime_type', 'file_size', 'duration', 'width', 'height', 'is_published', 'is_premium', 'is_featured', 'download_allowed'];

async function create(data) {
  const t = now();
  const slug = await uniqueSlug(data.title);
  const cols = WRITABLE.filter((k) => data[k] !== undefined);
  const vals = cols.map((k) => data[k]);
  const r = await db.run(
    `INSERT INTO videos (slug, ${cols.join(', ')}, created_at, updated_at, published_at)
     VALUES (?, ${cols.map(() => '?').join(', ')}, ?, ?, ?)`,
    [slug, ...vals, t, t, data.is_published ? t : null]);
  invalidate();
  return r.lastId;
}

async function update(id, data) {
  const current = await db.get('SELECT id, title, slug, is_published, published_at FROM videos WHERE id = ?', [id]);
  if (!current) return false;
  const cols = WRITABLE.filter((k) => data[k] !== undefined);
  const sets = cols.map((k) => `${k} = ?`);
  const vals = cols.map((k) => data[k]);
  if (data.title && data.title !== current.title) { sets.push('slug = ?'); vals.push(await uniqueSlug(data.title, id)); }
  if (data.is_published && !current.published_at) { sets.push('published_at = ?'); vals.push(now()); }
  sets.push('updated_at = ?'); vals.push(now());
  await db.run(`UPDATE videos SET ${sets.join(', ')} WHERE id = ?`, [...vals, id]);
  invalidate();
  return true;
}

async function setPublished(id, published) {
  const t = now();
  const r = await db.run(`UPDATE videos SET is_published = ?, updated_at = ?,
      published_at = CASE WHEN ? = 1 AND published_at IS NULL THEN ? ELSE published_at END WHERE id = ?`,
  [published ? 1 : 0, t, published ? 1 : 0, t, id]);
  invalidate();
  return r.changes > 0;
}

async function remove(id) {
  const v = await db.get('SELECT thumbnail_path FROM videos WHERE id = ?', [id]);
  await db.run('DELETE FROM videos WHERE id = ?', [id]);
  invalidate();
  return v;
}

function invalidate() { cache.invalidate('videos:'); cache.invalidate('categories:'); cache.invalidate('home:'); }

module.exports = {
  list, trending, featured, categories, bySlug, byId, related, canWatch, canDownload, countView,
  bumpDaily, create, update, setPublished, remove, invalidate, thumbSrc, decorate, uniqueSlug,
};
