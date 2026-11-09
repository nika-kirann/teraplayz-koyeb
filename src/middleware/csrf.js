'use strict';
/**
 * CSRF protection: signed double-submit token + Origin check.
 *  - A random seed lives in an HttpOnly cookie (tpz_csrf).
 *  - The token embedded in forms / sent as X-CSRF-Token is HMAC(seed).
 *  - Every unsafe request (POST/PUT/PATCH/DELETE) must carry a token that
 *    matches HMAC(cookie seed); cross-site pages can neither read the cookie
 *    nor compute the HMAC without SESSION_SECRET.
 *  - Additionally, if an Origin header is present it must match our host.
 * The Telegram webhook is exempt (authenticated by its secret header instead).
 */
const config = require('../config');
const { randomToken, hmac, safeEqual } = require('../util');

const COOKIE = config.COOKIE_SECURE ? '__Host-tpz_csrf' : 'tpz_csrf';
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

function csrf({ exempt = [], multipart = [] } = {}) {
  return (req, res, next) => {
    let seed = req.cookies[COOKIE];
    if (!seed || seed.length < 20 || seed.length > 100) {
      seed = randomToken(24);
      res.cookie(COOKIE, seed, { httpOnly: true, secure: config.COOKIE_SECURE, sameSite: 'lax', path: '/', maxAge: 30 * 864e5 });
      req.cookies[COOKIE] = seed;
      req.csrfFresh = true;
    }
    const token = hmac('csrf:' + seed);
    req.csrfToken = () => token;
    res.locals.csrfToken = token;

    if (SAFE.has(req.method) || exempt.some((p) => req.path.startsWith(p))) return next();

    const origin = req.headers.origin;
    if (origin && origin !== 'null') {
      let ok = false;
      try {
        const o = new URL(origin);
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        ok = o.host === host || (config.PUBLIC_BASE_URL && origin === new URL(config.PUBLIC_BASE_URL).origin);
      } catch { ok = false; }
      if (!ok) return deny(req, res);
    }
    if (/^multipart\/form-data/i.test(req.headers['content-type'] || '')) {
      // Body is not parsed yet. Only explicitly registered upload routes may
      // receive multipart bodies, and those run verify() right after parsing.
      if (!multipart.some((re) => re.test(req.path))) return deny(req, res);
      req.csrfDeferred = true;
      return next();
    }
    return verify(req, res, next);
  };
}

function verify(req, res, next) {
  const sent = (req.body && req.body._csrf) || req.headers['x-csrf-token'];
  if (req.csrfFresh || !safeEqual(sent, req.csrfToken())) return deny(req, res);
  req.csrfDeferred = false;
  next();
}

function deny(req, res) {
  res.status(403);
  if (req.xhr || (req.headers.accept || '').includes('application/json') || req.path.includes('/api/')) {
    return res.json({ error: 'Invalid or missing CSRF token. Reload the page and try again.' });
  }
  return res.render('errors/error', { title: 'Security check failed', status: 403, message: 'Your form expired or came from another site. Go back, reload the page and try again.' });
}

module.exports = { csrf, verify };
