'use strict';
/** One-shot flash messages carried in a short-lived cookie (no session store needed). */
const config = require('../config');

const NAME = 'tpz_flash';

module.exports = function flash(req, res, next) {
  res.locals.flash = null;
  const raw = req.cookies && req.cookies[NAME];
  if (raw) {
    try {
      const f = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
      if (f && typeof f.msg === 'string') res.locals.flash = { type: ['ok', 'error', 'warn'].includes(f.type) ? f.type : 'ok', msg: f.msg.slice(0, 400) };
    } catch { /* ignore */ }
    res.clearCookie(NAME, { path: '/' });
  }
  req.flash = (type, msg) => {
    res.cookie(NAME, Buffer.from(JSON.stringify({ type, msg: String(msg).slice(0, 400) })).toString('base64url'), {
      httpOnly: true, sameSite: 'lax', secure: config.COOKIE_SECURE, path: '/', maxAge: 60000,
    });
  };
  next();
};
