'use strict';
const express = require('express');
const db = require('../db');
const config = require('../config');
const limits = require('../middleware/rateLimits');
const v = require('../validators');
const { asyncH } = require('../util');
const videos = require('../services/videos');
const ads = require('../services/ads');

const router = express.Router();

router.get('/', ads.adsFor('home'), asyncH(async (req, res) => {
  const vp = Boolean(req.user && req.user.isPremium);
  const [featured, latest, trending, cats] = await Promise.all([
    videos.featured(vp),
    videos.list({ sort: 'latest', pageSize: 12, viewerPremium: vp }),
    videos.trending(12, vp),
    videos.categories(),
  ]);
  const rows = [];
  for (const c of cats.filter((x) => Number(x.video_count) > 0).slice(0, 4)) {
    const r = await videos.list({ categoryId: c.id, pageSize: 12, viewerPremium: vp });
    if (r.items.length) rows.push({ category: c, items: r.items });
  }
  let continueWatching = [];
  if (req.user) {
    continueWatching = (await db.all(`SELECT v.id, v.slug, v.title, v.thumbnail_path, v.thumbnail_url, v.telegram_thumb_file_id,
        v.duration, v.height, v.is_premium, v.views, v.created_at, v.published_at, p.position, p.duration AS pdur
        FROM watch_progress p JOIN videos v ON v.id = p.video_id
       WHERE p.user_id = ? AND v.is_published = 1 AND p.position > 5 AND (p.duration = 0 OR p.position < p.duration - 5)
       ORDER BY p.updated_at DESC LIMIT 8`, [req.user.id])).map(videos.decorate);
  }
  res.render('home', { title: 'TERAPLAYZ — Stream premium open films', featured, latest: latest.items, trending, rows, continueWatching, categories: cats });
}));

async function browse(req, res, extra = {}) {
  const q = v.searchQuery(req.query.q);
  const page = v.pageNum(req.query.page);
  const sort = ['latest', 'popular', 'oldest', 'title'].includes(req.query.sort) ? req.query.sort : 'latest';
  const cats = await videos.categories();
  const slug = extra.categorySlug || v.str(req.query.category);
  const category = slug ? cats.find((c) => c.slug === slug) : null;
  if (slug && !category) return res.status(404).render('errors/error', { title: 'Not found', status: 404, message: 'That category does not exist.' });
  const vp = Boolean(req.user && req.user.isPremium);
  const premiumOnly = req.query.premium === '1';
  const result = await videos.list({ q, categoryId: category ? category.id : null, sort, page, viewerPremium: vp, premiumOnly });
  if (req.query.partial === '1') {
    res.set('Cache-Control', 'private, max-age=30');
    return res.render('partials/card-grid-items', { items: result.items });
  }
  const heading = q ? `Results for “${q}”` : category ? category.name : premiumOnly ? 'Premium catalogue' : 'Browse all';
  res.render('browse', { title: `${heading} — TERAPLAYZ`, heading, q, sort, category, categories: cats, result, premiumOnly });
}

router.get('/browse', limits.search, ads.adsFor('browse'), asyncH((req, res) => browse(req, res)));
router.get('/search', limits.search, ads.adsFor('browse'), asyncH((req, res) => browse(req, res)));
router.get('/category/:slug', ads.adsFor('browse'), asyncH((req, res) => browse(req, res, { categorySlug: String(req.params.slug).slice(0, 60) })));

// JSON API (lightweight, cached) — used by search suggestions.
router.get('/api/videos', limits.api, asyncH(async (req, res) => {
  const q = v.searchQuery(req.query.q);
  const page = v.pageNum(req.query.page);
  const pageSize = Math.min(48, Math.max(1, parseInt(req.query.limit, 10) || 12));
  const vp = Boolean(req.user && req.user.isPremium);
  const cats = await videos.categories();
  const category = req.query.category ? cats.find((c) => c.slug === String(req.query.category)) : null;
  const r = await videos.list({ q, page, pageSize, categoryId: category ? category.id : null, viewerPremium: vp });
  res.set('Cache-Control', 'private, max-age=30');
  res.json({
    page: r.page, pages: r.pages, total: r.total,
    items: r.items.map((x) => ({ id: x.id, slug: x.slug, title: x.title, thumb: x.thumb, category: x.category_name, premium: Boolean(x.is_premium), duration: x.duration, date: x.date, url: `/watch/${x.slug}` })),
  });
}));

router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send('User-agent: *\nDisallow: /admin\nDisallow: /stream/\nDisallow: /download/\nDisallow: /api/\n');
});

module.exports = router;
