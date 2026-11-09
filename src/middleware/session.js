'use strict';
/**
 * Server-side sessions stored in the database. The browser only holds an
 * opaque random token in an HttpOnly, SameSite=Lax (Secure in prod) cookie;
 * the database stores HMAC(token) so a DB leak cannot be replayed as cookies.
 */
const db = require('../db');
const config = require('../config');
const { randomToken, hmac, now, DAY, isPremium } = require('../util');

const COOKIE = config.COOKIE_SECURE ? '__Host-tpz_sid' : 'tpz_sid';

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || out[k] !== undefined) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

function cookieOpts(maxAgeMs) {
  return { httpOnly: true, secure: config.COOKIE_SECURE, sameSite: 'lax', path: '/', maxAge: maxAgeMs };
}

// Throttle last-seen writes; we only need to refresh long sessions occasionally.
async function loadSession(req, res, next) {
  req.cookies = parseCookies(req.headers.cookie);
  req.user = null;
  const token = req.cookies[COOKIE];
  if (token && token.length >= 20 && token.length <= 100) {
    try {
      const row = await db.get(
        `SELECT s.id AS sid, s.expires_at, u.id, u.username, u.role, u.telegram_id, u.telegram_username,
                u.premium_until, u.premium_auto_renew, u.is_banned, u.created_at
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.id = ?`, [hmac(token)]);
      if (row && row.expires_at > now() && !row.is_banned) {
        req.sessionId = row.sid;
        req.user = row;
        req.user.isPremium = isPremium(row);
        req.user.isAdmin = row.role === 'admin';
      } else if (row) {
        await db.run('DELETE FROM sessions WHERE id = ?', [row.sid]);
        res.clearCookie(COOKIE, cookieOpts(0));
      }
    } catch (e) { return next(e); }
  }
  res.locals.user = req.user;
  res.locals.isPremium = Boolean(req.user && req.user.isPremium);
  res.locals.adsEnabled = !res.locals.isPremium;
  next();
}

async function createSession(req, res, userId) {
  const token = randomToken(32);
  const ttl = config.SESSION_TTL_DAYS * DAY;
  await db.run('INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)',
    [hmac(token), userId, now(), now() + ttl, String(req.headers['user-agent'] || '').slice(0, 200)]);
  await db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [now(), userId]);
  // Opportunistic cleanup instead of a background job.
  if (Math.random() < 0.05) await db.run('DELETE FROM sessions WHERE expires_at < ?', [now()]);
  res.cookie(COOKIE, token, cookieOpts(ttl));
}

async function destroySession(req, res) {
  if (req.sessionId) await db.run('DELETE FROM sessions WHERE id = ?', [req.sessionId]);
  res.clearCookie(COOKIE, cookieOpts(0));
}

function requireUser(req, res, next) {
  if (req.user) return next();
  if (req.accepts(['html', 'json']) === 'json' || req.path.startsWith('/api/')) return res.status(401).json({ error: 'Login required' });
  return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
}

function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  const err = new Error('Administrators only');
  err.status = 403;
  return next(err);
}

module.exports = { loadSession, createSession, destroySession, requireUser, requireAdmin, parseCookies, COOKIE };
