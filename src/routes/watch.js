'use strict';
const express = require('express');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const db = require('../db');
const config = require('../config');
const limits = require('../middleware/rateLimits');
const { requireUser } = require('../middleware/session');
const telegram = require('../telegram');
const videos = require('../services/videos');
const ads = require('../services/ads');
const { asyncH, now, redact, slugify } = require('../util');

const router = express.Router();

router.get('/watch/:slug', ads.adsFor('watch'), asyncH(async (req, res) => {
  const video = await videos.bySlug(String(req.params.slug).slice(0, 120));
  const access = videos.canWatch(video, req.user);
  if (access.reason === 'not_found') {
    return res.status(404).render('errors/error', { title: 'Video not found', status: 404, message: 'This video does not exist or is not published.' });
  }
  const vp = Boolean(req.user && req.user.isPremium);
  const related = await videos.related(video, 8, vp);
  let resumeAt = 0;
  if (access.ok) {
    const viewer = req.user ? `u${req.user.id}` : `ip${req.ip}`;
    videos.countView(video.id, viewer).catch((e) => console.warn('[views]', e.message));
    if (req.user) {
      const p = await db.get('SELECT position, duration FROM watch_progress WHERE user_id = ? AND video_id = ?', [req.user.id, video.id]);
      if (p && p.position > 5 && (!p.duration || p.position < p.duration - 5)) resumeAt = Math.floor(p.position);
    }
  }
  // Admin-only warning about Telegram's getFile limit.
  const oversized = video.source_type === 'telegram' && telegram.isOversized(video.file_size);
  const playable = access.ok && !oversized && (video.source_type === 'url' ? Boolean(video.source_url) : (config.telegramEnabled && Boolean(video.telegram_file_id)));
  res.render('watch', {
    title: `${video.title} — TERAPLAYZ`,
    description: video.description.slice(0, 160),
    video, related, access, resumeAt, playable, oversized,
    canDownload: videos.canDownload(video, req.user) && playable,
  });
}));

/** Resolve where the bytes for a video live (internal URL; never sent to clients). */
async function upstreamFor(video) {
  if (video.source_type === 'url') {
    if (!video.source_url || !/^https:\/\//.test(video.source_url)) throw Object.assign(new Error('Source unavailable'), { status: 404 });
    return { url: video.source_url, size: video.file_size };
  }
  if (!config.telegramEnabled) throw Object.assign(new Error('Telegram playback is disabled in demo mode.'), { status: 503 });
  if (!video.telegram_file_id) throw Object.assign(new Error('This video has no Telegram file yet.'), { status: 404 });
  if (telegram.isOversized(video.file_size)) throw Object.assign(new Error(`File exceeds the ${Math.round(config.telegram.maxDownloadBytes / 1048576)} MB Bot API download limit.`), { status: 413 });
  const f = await telegram.resolveFile(video.telegram_file_id);
  if (telegram.isOversized(f.fileSize)) throw Object.assign(new Error('File exceeds the Bot API download limit.'), { status: 413 });
  return { url: telegram.fileDownloadUrl(f.filePath), size: f.fileSize };
}

const RANGE_RE = /^bytes=\d*-\d*$/;

/**
 * Pipe an upstream HTTP(S) resource to the client chunk-by-chunk.
 * Forwards Range so seeking works when the origin supports it; nothing is
 * buffered beyond Node's stream highWaterMark (~64 KB).
 */
async function proxy(req, res, upstream, { mime, download, filename, cacheControl }) {
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  const headers = { 'user-agent': 'TERAPLAYZ/1.0 (+stream-proxy)' };
  const range = req.headers.range;
  if (range && RANGE_RE.test(range)) headers.range = range;
  let up;
  try {
    up = await fetch(upstream.url, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers, signal: ac.signal, redirect: 'follow' });
  } catch (e) {
    if (ac.signal.aborted) return;
    console.warn('[stream] upstream fetch failed:', redact(e.message));
    return res.status(502).type('text/plain').send('Upstream unavailable');
  }
  if (up.status === 416) {
    res.status(416);
    if (up.headers.get('content-range')) res.set('Content-Range', up.headers.get('content-range'));
    return res.end();
  }
  if (!up.ok) {
    up.body && up.body.cancel().catch(() => {});
    console.warn('[stream] upstream status', up.status);
    return res.status(up.status === 404 ? 404 : 502).type('text/plain').send('Video source unavailable');
  }
  res.status(up.status === 206 ? 206 : 200);
  const upType = up.headers.get('content-type') || '';
  res.set('Content-Type', /^(video|audio|image)\//.test(upType) ? upType : (mime || 'video/mp4'));
  for (const h of ['content-length', 'content-range', 'last-modified', 'etag']) {
    const val = up.headers.get(h);
    if (val) res.set(h, val);
  }
  res.set('Accept-Ranges', up.headers.get('accept-ranges') === 'bytes' || up.status === 206 ? 'bytes' : 'none');
  res.set('Cache-Control', cacheControl || 'private, no-store, no-transform');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cross-Origin-Resource-Policy', 'same-origin');
  if (download) {
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
  } else {
    res.set('Content-Disposition', 'inline');
  }
  if (req.method === 'HEAD' || !up.body) return res.end();
  try {
    await pipeline(Readable.fromWeb(up.body, { highWaterMark: 64 * 1024 }), res);
  } catch (e) {
    if (!ac.signal.aborted && e.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.warn('[stream] pipe error:', redact(e.message));
  }
}

async function loadAuthorized(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(id) || id < 1) { res.status(404).end(); return null; }
  const video = await videos.byId(id);
  const access = videos.canWatch(video, req.user);
  if (!access.ok) {
    res.status(access.reason === 'not_found' ? 404 : 403).type('text/plain').send(access.reason === 'not_found' ? 'Not found' : 'Premium membership required');
    return null;
  }
  return video;
}

router.get('/stream/:id', limits.stream, asyncH(async (req, res) => {
  const video = await loadAuthorized(req, res);
  if (!video) return;
  let up;
  try { up = await upstreamFor(video); } catch (e) {
    return res.status(e.status || 502).type('text/plain').send(e.status ? e.message : 'Video source unavailable');
  }
  await proxy(req, res, up, { mime: video.mime_type });
}));

router.get('/download/:id', limits.stream, requireUser, asyncH(async (req, res) => {
  const video = await loadAuthorized(req, res);
  if (!video) return;
  if (!videos.canDownload(video, req.user)) return res.status(403).type('text/plain').send('Downloads are not enabled for this video.');
  let up;
  try { up = await upstreamFor(video); } catch (e) {
    return res.status(e.status || 502).type('text/plain').send(e.status ? e.message : 'Video source unavailable');
  }
  const ext = /webm/.test(video.mime_type || '') ? 'webm' : 'mp4';
  await proxy(req, res, up, { mime: video.mime_type, download: true, filename: `TERAPLAYZ-${slugify(video.title)}.${ext}` });
}));

/** Telegram-hosted thumbnails (small JPEGs) proxied and cached by browsers/CDN. */
router.get('/thumb/:id', limits.api, asyncH(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const v = Number.isSafeInteger(id) ? await db.get('SELECT id, is_published, telegram_thumb_file_id FROM videos WHERE id = ?', [id]) : null;
  if (!v || !v.telegram_thumb_file_id || (!v.is_published && !(req.user && req.user.isAdmin)) || !config.telegramEnabled) {
    return res.redirect(302, '/img/placeholder.svg');
  }
  try {
    const f = await telegram.resolveFile(v.telegram_thumb_file_id);
    await proxy(req, res, { url: telegram.fileDownloadUrl(f.filePath) }, { mime: 'image/jpeg', cacheControl: 'public, max-age=86400' });
  } catch (e) {
    console.warn('[thumb]', e.message);
    res.redirect(302, '/img/placeholder.svg');
  }
}));

/** Resume-playback sync for signed-in users. */
router.post('/api/progress', limits.api, requireUser, asyncH(async (req, res) => {
  const videoId = parseInt(req.body.video_id, 10);
  const position = Number(req.body.position);
  const duration = Number(req.body.duration) || 0;
  if (!Number.isSafeInteger(videoId) || !(position >= 0 && position < 360000) || !(duration >= 0 && duration < 360000)) {
    return res.status(400).json({ error: 'Invalid progress' });
  }
  const v = await db.get('SELECT id FROM videos WHERE id = ?', [videoId]);
  if (!v) return res.status(404).json({ error: 'Not found' });
  await db.run(`INSERT INTO watch_progress (user_id, video_id, position, duration, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (user_id, video_id) DO UPDATE SET position = excluded.position, duration = excluded.duration, updated_at = excluded.updated_at`,
  [req.user.id, videoId, Math.round(position * 10) / 10, Math.round(duration * 10) / 10, now()]);
  res.json({ ok: true });
}));

/** HTML ad snippets render inside a sandboxed, opaque-origin iframe. */
router.get('/ads/frame/:id', asyncH(async (req, res) => {
  if (req.user && req.user.isPremium) return res.status(204).end();
  const id = parseInt(req.params.id, 10);
  const ad = Number.isSafeInteger(id) ? await ads.getHtml(id) : null;
  if (!ad || !ad.enabled) return res.status(404).end();
  res.set('Content-Security-Policy', "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; frame-ancestors 'self'");
  res.set('Cache-Control', 'private, max-age=60');
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><base target="_blank"><style>:root{color-scheme:dark}html,body{margin:0;background:transparent;overflow:hidden}</style></head><body>${ad.html}</body></html>`);
}));

module.exports = router;
