'use strict';
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const config = require('./config');
const util = require('./util');
const limits = require('./middleware/rateLimits');
const { loadSession } = require('./middleware/session');
const { csrf } = require('./middleware/csrf');
const flash = require('./middleware/flash');
const videos = require('./services/videos');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY);
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  if (config.isProd) app.set('view cache', true);

  // ---- Health check: no auth, no DB, always fast ----
  const started = Date.now();
  app.get('/healthz', async (req, res) => {
    const body = { status: 'ok', uptime: Math.round((Date.now() - started) / 1000) };
    if (req.query.deep === '1') {
      try { await require('./db').ping(); body.db = 'ok'; } catch { body.db = 'error'; }
    }
    res.set('Cache-Control', 'no-store').status(200).json(body);
  });

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", 'https://fonts.googleapis.com', "'unsafe-inline'"],
        'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
        'img-src': ["'self'", 'data:', 'https:'],
        'media-src': ["'self'"],
        'frame-src': ["'self'"],
        'connect-src': ["'self'"],
        'form-action': ["'self'"],
        'upgrade-insecure-requests': config.COOKIE_SECURE ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    hsts: config.isProd ? undefined : false,
  }));

  // gzip HTML/CSS/JS, never the byte-range video proxy.
  app.use(compression({ filter: (req, res) => !/^\/(stream|download|thumb|media)\//.test(req.path) && compression.filter(req, res) }));

  app.use(express.static(path.join(__dirname, '..', 'public'), {
    maxAge: config.isProd ? '7d' : 0,
    setHeaders: (res, p) => { if (/\/img\//.test(p)) res.setHeader('Cache-Control', 'public, max-age=2592000'); },
  }));
  app.use('/media/thumbs', express.static(config.THUMBS_DIR, { maxAge: '30d', immutable: true, fallthrough: false, index: false, dotfiles: 'deny' }));

  // Baseline view locals so any page (incl. 403/429 error pages) can render.
  app.use((req, res, next) => {
    Object.assign(res.locals, {
      h: util, currentPath: req.path, query: req.query, user: null, isPremium: false, csrfToken: '', flash: null,
      navCategories: [], ads: {}, adsEnabled: true, title: 'TERAPLAYZ',
      description: 'TERAPLAYZ — premium streaming of open, family-friendly films, animation and more.',
      cfg: {
        demoMode: config.demoMode, telegramEnabled: config.telegramEnabled, priceStars: config.premium.priceStars,
        periodDays: config.premium.periodDays, allowRegistration: config.ALLOW_REGISTRATION,
      },
    });
    next();
  });

  // DB-stored thumbnails (immutable: a new upload gets a new id)
  app.get('/media/t/:id(\\d+).webp', async (req, res, next) => {
    try {
      const t = await require('./services/thumbs').load(Number(req.params.id));
      if (!t) return res.status(404).end();
      res.set('Content-Type', t.mime).set('Cache-Control', 'public, max-age=31536000, immutable').send(Buffer.from(t.data));
    } catch (e) { next(e); }
  });

  app.use(limits.global);
  app.use(express.urlencoded({ extended: false, limit: '64kb', parameterLimit: 100 }));
  app.use(express.json({ limit: '256kb' }));

  app.use(loadSession);
  app.use(csrf({ exempt: ['/telegram/webhook'], multipart: [/^\/admin\/videos(\/\d+)?$/] }));
  app.use(flash);

  app.use(async (req, res, next) => {
    try { res.locals.navCategories = await videos.categories(); } catch (e) { return next(e); }
    next();
  });

  app.use(require('./routes/auth'));
  app.use(require('./routes/public'));
  app.use(require('./routes/watch'));
  app.use(require('./routes/premium'));
  app.use('/telegram', require('./routes/webhook'));
  app.use('/admin', limits.admin, require('./routes/admin'));

  app.use((req, res) => {
    res.status(404).render('errors/error', { title: 'Not found', status: 404, message: "We couldn't find that page. It may have been moved or unpublished." });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error('[error]', req.method, req.path, util.redact(err.stack || err.message));
    if (res.headersSent) return res.destroy();
    const message = status >= 500 && config.isProd ? 'Something went wrong on our side. Please try again.' : err.expose === false ? 'Error' : err.message;
    if (req.path.startsWith('/api/') || req.path.startsWith('/admin/api/') || (req.headers.accept || '').startsWith('application/json')) {
      return res.status(status).json({ error: message });
    }
    res.status(status).render('errors/error', { title: status === 403 ? 'Access denied' : 'Error', status, message });
  });

  return app;
}

module.exports = { createApp };
