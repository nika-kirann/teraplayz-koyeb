'use strict';
const express = require('express');
const multer = require('multer');
const db = require('../db');
const config = require('../config');
const { requireAdmin } = require('../middleware/session');
const csrf = require('../middleware/csrf');
const v = require('../validators');
const telegram = require('../telegram');
const videos = require('../services/videos');
const membership = require('../services/membership');
const adsSvc = require('../services/ads');
const stats = require('../services/stats');
const thumbs = require('../services/thumbs');
const cache = require('../cache');
const { asyncH, now, DAY, slugify, escapeLike } = require('../util');

const router = express.Router();
router.use(requireAdmin); // server-side authorization for EVERYTHING below
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); res.locals.adminNav = req.path; next(); });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.MAX_THUMB_UPLOAD_MB * 1024 * 1024, files: 1, fields: 40 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|webp|gif|avif)$/.test(file.mimetype)),
});
const thumbUpload = (req, res, next) => upload.single('thumbnail')(req, res, (err) => {
  if (err) {
    // CSRF must still be verified before we act on anything.
    if (!req.body) req.body = {};
    return csrf.verify(req, res, () => { req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? `Thumbnail must be under ${config.MAX_THUMB_UPLOAD_MB} MB.` : 'Thumbnail upload failed.'; next(); });
  }
  return csrf.verify(req, res, next);
});

// ---------------- Dashboard ----------------
router.get('/', asyncH(async (req, res) => {
  const s = await stats.overview();
  const warnings = [];
  if (config.demoMode) warnings.push('Demo mode: TELEGRAM_BOT_TOKEN is not set. Telegram playback, ingest and Stars payments are disabled.');
  if (config.telegramEnabled && !config.telegram.channelId) warnings.push('TELEGRAM_CHANNEL_ID is not set — "Retrieve from Telegram" and auto-ingest are disabled.');
  if (config.telegramEnabled && !config.telegram.webhookSecret) warnings.push('TELEGRAM_WEBHOOK_SECRET is not set — the webhook (payments) will reject all updates.');
  if (!config.DATABASE_URL && config.isProd) warnings.push('Using SQLite. Make sure DATA_DIR is on a persistent Koyeb volume, or set DATABASE_URL to managed PostgreSQL.');
  const oversized = Number((await db.get("SELECT COUNT(*) AS n FROM videos WHERE source_type = 'telegram' AND file_size > ?", [config.telegram.maxDownloadBytes])).n);
  if (oversized) warnings.push(`${oversized} Telegram video(s) exceed the ${Math.round(config.telegram.maxDownloadBytes / 1048576)} MB Bot API download limit and cannot be played.`);
  res.render('admin/dashboard', { title: 'Dashboard — TERAPLAYZ Admin', s, warnings });
}));

// ---------------- Videos ----------------
router.get('/videos', asyncH(async (req, res) => {
  const q = v.searchQuery(req.query.q);
  const status = ['published', 'draft', 'premium', 'oversized'].includes(req.query.status) ? req.query.status : '';
  const page = v.pageNum(req.query.page);
  const pageSize = 25;
  const where = ['1=1'];
  const params = [];
  if (q) { where.push(`(${db.ilike('v.title')} OR CAST(v.telegram_message_id AS TEXT) = ?)`); params.push('%' + escapeLike(q) + '%', q); }
  if (status === 'published') where.push('v.is_published = 1');
  if (status === 'draft') where.push('v.is_published = 0');
  if (status === 'premium') where.push('v.is_premium = 1');
  if (status === 'oversized') { where.push("v.source_type = 'telegram' AND v.file_size > ?"); params.push(config.telegram.maxDownloadBytes); }
  const w = where.join(' AND ');
  const total = Number((await db.get(`SELECT COUNT(*) AS n FROM videos v WHERE ${w}`, params)).n);
  const items = (await db.all(`SELECT v.*, c.name AS category_name FROM videos v LEFT JOIN categories c ON c.id = v.category_id
    WHERE ${w} ORDER BY v.updated_at DESC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize])).map(videos.decorate);
  res.render('admin/videos', { title: 'Videos — TERAPLAYZ Admin', items, q, status, page, pages: Math.max(1, Math.ceil(total / pageSize)), total, maxBytes: config.telegram.maxDownloadBytes });
}));

async function renderForm(res, video, errors = {}, status = 200) {
  const categories = await db.all('SELECT id, name FROM categories ORDER BY sort_order, name');
  res.status(status).render('admin/video-form', {
    title: (video.id ? 'Edit video' : 'Add video') + ' — TERAPLAYZ Admin',
    video, errors, categories,
    maxMb: Math.round(config.telegram.maxDownloadBytes / 1048576),
    channelConfigured: Boolean(config.telegramEnabled && config.telegram.channelId),
  });
}

router.get('/videos/new', asyncH((req, res) => renderForm(res, { source_type: config.demoMode ? 'url' : 'telegram', is_published: 0 })));

router.get('/videos/:id(\\d+)/edit', asyncH(async (req, res) => {
  const video = await videos.byId(req.params.id);
  if (!video) return res.status(404).render('errors/error', { title: 'Not found', status: 404, message: 'Video not found.' });
  renderForm(res, video);
}));

/** Fill Telegram metadata automatically when only a message id is known. */
async function enrichFromTelegram(data, warnings) {
  if (data.source_type !== 'telegram') {
    for (const k of ['telegram_message_id', 'telegram_file_id', 'telegram_file_unique_id', 'telegram_thumb_file_id']) data[k] = data[k] || null;
    return;
  }
  data.source_url = null;
  if (data.telegram_message_id && !data.telegram_file_id) {
    if (!config.telegramEnabled || !config.telegram.channelId) throw Object.assign(new Error('Telegram is not configured — paste the file id manually.'), { field: 'telegram_message_id' });
    const m = await telegram.fetchChannelMessage(data.telegram_message_id);
    Object.assign(data, {
      telegram_file_id: m.file_id, telegram_file_unique_id: m.file_unique_id || data.telegram_file_unique_id,
      telegram_thumb_file_id: data.telegram_thumb_file_id || m.thumb_file_id, mime_type: data.mime_type || m.mime_type,
      file_size: data.file_size || m.file_size, duration: data.duration || m.duration, width: data.width || m.width, height: data.height || m.height,
    });
  }
  if (telegram.isOversized(data.file_size)) warnings.push(`This file is ${(data.file_size / 1048576).toFixed(1)} MB — above the ${Math.round(config.telegram.maxDownloadBytes / 1048576)} MB Bot API getFile limit, so playback/download will be refused. Re-encode it smaller or use a self-hosted Bot API server (TELEGRAM_API_ROOT).`);
}

async function saveVideo(req, res, id) {
  const { value, errors } = v.video(req.body);
  if (req.uploadError) errors.thumbnail = req.uploadError;
  const existing = id ? await videos.byId(id) : null;
  if (id && !existing) return res.status(404).render('errors/error', { title: 'Not found', status: 404, message: 'Video not found.' });
  const warnings = [];
  if (!Object.keys(errors).length) {
    try { await enrichFromTelegram(value, warnings); } catch (e) { errors[e.field || 'telegram_message_id'] = e.message; }
  }
  if (value.telegram_file_unique_id && !errors.telegram_file_unique_id) {
    const dup = await db.get('SELECT id FROM videos WHERE telegram_file_unique_id = ?', [value.telegram_file_unique_id]);
    if (dup && Number(dup.id) !== Number(id)) errors.telegram_file_unique_id = `This Telegram file is already used by video #${dup.id}.`;
  }
  if (value.category_id && !(await db.get('SELECT id FROM categories WHERE id = ?', [value.category_id]))) errors.category_id = 'Unknown category.';
  if (Object.keys(errors).length) return renderForm(res, { ...(existing || {}), ...value, id }, errors, 400);

  if (req.file) {
    try {
      value.thumbnail_path = await thumbs.saveUploaded(req.file.buffer, req.file.mimetype);
      if (existing && existing.thumbnail_path) thumbs.remove(existing.thumbnail_path);
    } catch (e) {
      return renderForm(res, { ...(existing || {}), ...value, id }, { thumbnail: 'Could not process that image. Use JPG, PNG or WebP.' }, 400);
    }
  } else if (value.remove_thumbnail && existing && existing.thumbnail_path) {
    thumbs.remove(existing.thumbnail_path);
    value.thumbnail_path = null;
  }
  delete value.remove_thumbnail;
  if (!value.category_id) value.category_id = null;

  let videoId = id;
  if (id) await videos.update(id, value);
  else videoId = await videos.create(value);
  req.flash(warnings.length ? 'warn' : 'ok', warnings.length ? `Saved with warning: ${warnings[0]}` : `“${value.title}” saved.`);
  res.redirect(`/admin/videos/${videoId}/edit`);
}

router.post('/videos', thumbUpload, asyncH((req, res) => saveVideo(req, res, null)));
router.post('/videos/:id(\\d+)', thumbUpload, asyncH((req, res) => saveVideo(req, res, Number(req.params.id))));

router.post('/videos/:id(\\d+)/publish', asyncH(async (req, res) => {
  await videos.setPublished(req.params.id, true);
  req.flash('ok', 'Video published.');
  res.redirect(backTo(req, '/admin/videos'));
}));
router.post('/videos/:id(\\d+)/unpublish', asyncH(async (req, res) => {
  await videos.setPublished(req.params.id, false);
  req.flash('ok', 'Video unpublished — it is now hidden from the public site.');
  res.redirect(backTo(req, '/admin/videos'));
}));
router.post('/videos/:id(\\d+)/delete', asyncH(async (req, res) => {
  const old = await videos.remove(req.params.id);
  if (old && old.thumbnail_path) thumbs.remove(old.thumbnail_path);
  req.flash('ok', 'Video deleted. (The file itself stays in your Telegram channel.)');
  res.redirect('/admin/videos');
}));

router.post('/videos/:id(\\d+)/refresh-telegram', asyncH(async (req, res) => {
  const video = await videos.byId(req.params.id);
  if (!video || !video.telegram_message_id) { req.flash('error', 'This video has no Telegram message id.'); return res.redirect(backTo(req, '/admin/videos')); }
  try {
    const m = await telegram.fetchChannelMessage(video.telegram_message_id);
    await videos.update(video.id, {
      telegram_file_id: m.file_id, telegram_file_unique_id: m.file_unique_id || null, telegram_thumb_file_id: m.thumb_file_id,
      mime_type: m.mime_type, file_size: m.file_size, duration: m.duration, width: m.width, height: m.height,
    });
    telegram._fileCache.delete(video.telegram_file_id);
    req.flash(m.oversized ? 'warn' : 'ok', m.oversized ? `Refreshed, but the file is over the ${m.max_mb} MB Bot API limit.` : 'Telegram metadata refreshed.');
  } catch (e) { req.flash('error', e.message); }
  res.redirect(`/admin/videos/${video.id}/edit`);
}));

/** JSON: "Retrieve from Telegram" button in the video form. */
router.post('/api/telegram/lookup', asyncH(async (req, res) => {
  const mid = v.intOrNull(req.body.message_id, { min: 1 });
  if (!mid) return res.status(400).json({ error: 'Enter a valid channel message id.' });
  if (!config.telegramEnabled || !config.telegram.channelId) return res.status(503).json({ error: 'Telegram is not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHANNEL_ID).' });
  try {
    const m = await telegram.fetchChannelMessage(mid);
    const dup = m.file_unique_id ? await db.get('SELECT id, title FROM videos WHERE telegram_file_unique_id = ?', [m.file_unique_id]) : null;
    res.json({ ok: true, media: m, duplicate: dup });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
}));

// ---------------- Categories ----------------
router.get('/categories', asyncH(async (req, res) => {
  const items = await db.all(`SELECT c.*, (SELECT COUNT(*) FROM videos v WHERE v.category_id = c.id) AS video_count
    FROM categories c ORDER BY c.sort_order, c.name`);
  res.render('admin/categories', { title: 'Categories — TERAPLAYZ Admin', items, errors: {}, form: {} });
}));

async function saveCategory(req, res, id) {
  const { value, errors } = v.category(req.body);
  value.slug = value.slug || slugify(value.name);
  const dup = await db.get('SELECT id FROM categories WHERE slug = ?', [value.slug]);
  if (dup && Number(dup.id) !== Number(id)) errors.slug = 'Slug already exists.';
  if (Object.keys(errors).length) { req.flash('error', Object.values(errors)[0]); return res.redirect('/admin/categories'); }
  if (id) await db.run('UPDATE categories SET name = ?, slug = ?, description = ?, sort_order = ? WHERE id = ?', [value.name, value.slug, value.description, value.sort_order, id]);
  else await db.run('INSERT INTO categories (name, slug, description, sort_order, created_at) VALUES (?, ?, ?, ?, ?)', [value.name, value.slug, value.description, value.sort_order, now()]);
  videos.invalidate();
  req.flash('ok', `Category “${value.name}” saved.`);
  res.redirect('/admin/categories');
}
router.post('/categories', asyncH((req, res) => saveCategory(req, res, null)));
router.post('/categories/:id(\\d+)', asyncH((req, res) => saveCategory(req, res, Number(req.params.id))));
router.post('/categories/:id(\\d+)/delete', asyncH(async (req, res) => {
  await db.run('UPDATE videos SET category_id = NULL WHERE category_id = ?', [req.params.id]);
  await db.run('DELETE FROM categories WHERE id = ?', [req.params.id]);
  videos.invalidate();
  req.flash('ok', 'Category deleted. Its videos are now uncategorised.');
  res.redirect('/admin/categories');
}));

// ---------------- Members / premium ----------------
router.get('/members', asyncH(async (req, res) => {
  const q = v.searchQuery(req.query.q).toLowerCase();
  const filter = ['premium', 'expired', 'admins', 'banned'].includes(req.query.filter) ? req.query.filter : '';
  const page = v.pageNum(req.query.page);
  const pageSize = 30;
  const where = ['1=1'];
  const params = [];
  const t = now();
  if (q) { where.push(`(${db.ilike('username')} OR CAST(telegram_id AS TEXT) = ?)`); params.push('%' + escapeLike(q) + '%', q); }
  if (filter === 'premium') { where.push('premium_until > ?'); params.push(t); }
  if (filter === 'expired') { where.push('premium_until IS NOT NULL AND premium_until <= ?'); params.push(t); }
  if (filter === 'admins') where.push("role = 'admin'");
  if (filter === 'banned') where.push('is_banned = 1');
  const w = where.join(' AND ');
  const total = Number((await db.get(`SELECT COUNT(*) AS n FROM users WHERE ${w}`, params)).n);
  const items = await db.all(`SELECT u.id, u.username, u.role, u.telegram_id, u.telegram_username, u.premium_until, u.premium_auto_renew, u.is_banned, u.created_at, u.last_login_at,
      (SELECT COUNT(*) FROM payments p WHERE p.user_id = u.id) AS payments
    FROM users u WHERE ${w} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
  res.render('admin/members', { title: 'Members — TERAPLAYZ Admin', items, q, filter, page, pages: Math.max(1, Math.ceil(total / pageSize)), total });
}));

router.post('/members/:id(\\d+)/grant', asyncH(async (req, res) => {
  const days = v.intOrNull(req.body.days, { min: 1, max: 3650 });
  if (!days) { req.flash('error', 'Days must be between 1 and 3650.'); return res.redirect(backTo(req, '/admin/members')); }
  const r = await membership.adminGrant(Number(req.params.id), days);
  req.flash('ok', `Premium extended by ${days} days (until ${new Date(r.end).toISOString().slice(0, 10)}).`);
  res.redirect(backTo(req, '/admin/members'));
}));
router.post('/members/:id(\\d+)/expiry', asyncH(async (req, res) => {
  const s = v.str(req.body.until);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(Date.parse(s + 'T23:59:59Z'))) { req.flash('error', 'Pick a valid date.'); return res.redirect(backTo(req, '/admin/members')); }
  await membership.adminSetExpiry(Number(req.params.id), Date.parse(s + 'T23:59:59Z'));
  req.flash('ok', `Premium expiry set to ${s} 23:59 UTC.`);
  res.redirect(backTo(req, '/admin/members'));
}));
router.post('/members/:id(\\d+)/revoke', asyncH(async (req, res) => {
  await membership.adminRevoke(Number(req.params.id));
  req.flash('ok', 'Premium revoked.');
  res.redirect(backTo(req, '/admin/members'));
}));
router.post('/members/:id(\\d+)/ban', asyncH(async (req, res) => {
  const id = Number(req.params.id);
  if (id === Number(req.user.id)) { req.flash('error', "You can't suspend yourself."); return res.redirect(backTo(req, '/admin/members')); }
  const u = await db.get('SELECT is_banned FROM users WHERE id = ?', [id]);
  if (!u) return res.redirect('/admin/members');
  await db.run('UPDATE users SET is_banned = ? WHERE id = ?', [u.is_banned ? 0 : 1, id]);
  if (!u.is_banned) await db.run('DELETE FROM sessions WHERE user_id = ?', [id]);
  req.flash('ok', u.is_banned ? 'Account restored.' : 'Account suspended and signed out.');
  res.redirect(backTo(req, '/admin/members'));
}));

router.get('/payments', asyncH(async (req, res) => {
  const items = await db.all(`SELECT p.*, u.username FROM payments p LEFT JOIN users u ON u.id = p.user_id ORDER BY p.created_at DESC LIMIT 200`);
  res.render('admin/payments', { title: 'Payments — TERAPLAYZ Admin', items });
}));

// ---------------- Ads ----------------
router.get('/ads', asyncH(async (req, res) => {
  const items = await db.all('SELECT * FROM ads ORDER BY slot, sort_order, id');
  res.render('admin/ads', { title: 'Ad placements — TERAPLAYZ Admin', items, slots: v.AD_SLOTS });
}));
router.get('/ads/new', (req, res) => res.render('admin/ad-form', { title: 'New ad — TERAPLAYZ Admin', ad: { kind: 'image', enabled: 1, pages: 'all', slot: 'home_mid' }, errors: {}, slots: v.AD_SLOTS, pages: v.AD_PAGES }));
router.get('/ads/:id(\\d+)/edit', asyncH(async (req, res) => {
  const ad = await db.get('SELECT * FROM ads WHERE id = ?', [req.params.id]);
  if (!ad) return res.redirect('/admin/ads');
  res.render('admin/ad-form', { title: 'Edit ad — TERAPLAYZ Admin', ad, errors: {}, slots: v.AD_SLOTS, pages: v.AD_PAGES });
}));
async function saveAd(req, res, id) {
  const { value, errors } = v.ad(req.body);
  if (Object.keys(errors).length) return res.status(400).render('admin/ad-form', { title: 'Ad — TERAPLAYZ Admin', ad: { ...value, id }, errors, slots: v.AD_SLOTS, pages: v.AD_PAGES });
  const t = now();
  const vals = [value.name, value.slot, value.kind, value.kind === 'html' ? value.html : null, value.kind === 'image' ? value.image_url : null, value.kind === 'image' ? value.link_url : null, value.pages, value.enabled, value.sort_order];
  if (id) await db.run('UPDATE ads SET name = ?, slot = ?, kind = ?, html = ?, image_url = ?, link_url = ?, pages = ?, enabled = ?, sort_order = ?, updated_at = ? WHERE id = ?', [...vals, t, id]);
  else await db.run('INSERT INTO ads (name, slot, kind, html, image_url, link_url, pages, enabled, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [...vals, t, t]);
  adsSvc.invalidate();
  req.flash('ok', 'Ad placement saved.');
  res.redirect('/admin/ads');
}
router.post('/ads', asyncH((req, res) => saveAd(req, res, null)));
router.post('/ads/:id(\\d+)', asyncH((req, res) => saveAd(req, res, Number(req.params.id))));
router.post('/ads/:id(\\d+)/toggle', asyncH(async (req, res) => {
  await db.run('UPDATE ads SET enabled = CASE WHEN enabled = 1 THEN 0 ELSE 1 END, updated_at = ? WHERE id = ?', [now(), req.params.id]);
  adsSvc.invalidate();
  res.redirect('/admin/ads');
}));
router.post('/ads/:id(\\d+)/delete', asyncH(async (req, res) => {
  await db.run('DELETE FROM ads WHERE id = ?', [req.params.id]);
  adsSvc.invalidate();
  req.flash('ok', 'Ad deleted.');
  res.redirect('/admin/ads');
}));

// ---------------- Telegram status / webhook ----------------
router.get('/telegram', asyncH(async (req, res) => {
  let me = null; let hook = null; let error = null;
  if (config.telegramEnabled) {
    try { me = await telegram.getMe(); hook = await telegram.call('getWebhookInfo'); } catch (e) { error = e.message; }
    if (hook && hook.url) hook.url = hook.url.replace(/\/\/[^/]+/, (m) => m); // URL only contains our own host
  }
  res.render('admin/telegram', {
    title: 'Telegram — TERAPLAYZ Admin', me, hook, error,
    channelConfigured: Boolean(config.telegram.channelId), secretConfigured: Boolean(config.telegram.webhookSecret),
    publicBase: config.PUBLIC_BASE_URL, apiRootCustom: config.telegram.apiRoot !== 'https://api.telegram.org',
    maxMb: Math.round(config.telegram.maxDownloadBytes / 1048576),
  });
}));
router.post('/telegram/webhook', asyncH(async (req, res) => {
  if (!config.telegramEnabled || !config.PUBLIC_BASE_URL || !config.telegram.webhookSecret) {
    req.flash('error', 'Set TELEGRAM_BOT_TOKEN, PUBLIC_BASE_URL and TELEGRAM_WEBHOOK_SECRET first.');
    return res.redirect('/admin/telegram');
  }
  try {
    await telegram.call('setWebhook', {
      url: `${config.PUBLIC_BASE_URL}/telegram/webhook`,
      secret_token: config.telegram.webhookSecret,
      allowed_updates: ['message', 'channel_post', 'pre_checkout_query'],
      max_connections: 10,
    });
    req.flash('ok', 'Webhook registered with Telegram.');
  } catch (e) { req.flash('error', e.message); }
  res.redirect('/admin/telegram');
}));

router.post('/cache/clear', (req, res) => { cache.invalidate(); req.flash('ok', 'Cache cleared.'); res.redirect('/admin'); });

function backTo(req, fallback) {
  const r = req.get('referer');
  try {
    if (r) { const u = new URL(r); if (u.host === req.get('host') && u.pathname.startsWith('/admin')) return u.pathname + u.search; }
  } catch { /* ignore */ }
  return fallback;
}

module.exports = router;
