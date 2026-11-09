'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const config = require('../config');
const limits = require('../middleware/rateLimits');
const { createSession, destroySession, requireUser } = require('../middleware/session');
const v = require('../validators');
const { asyncH, now } = require('../util');
const videos = require('../services/videos');
const membership = require('../services/membership');

const router = express.Router();

// Pre-computed hash so login timing is identical for unknown usernames.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password-' + Math.random(), 10);

function safeNext(n) {
  const s = typeof n === 'string' ? n : '';
  return /^\/(?!\/)[\w\-./?=&%]*$/.test(s) && !s.startsWith('/login') ? s : '/';
}

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(safeNext(req.query.next));
  res.render('login', { title: 'Sign in — TERAPLAYZ', errors: {}, form: {}, next: safeNext(req.query.next) });
});

router.post('/login', limits.auth, asyncH(async (req, res) => {
  const { value, errors } = v.credentials(req.body);
  const next = safeNext(req.body.next);
  const fail = (msg) => res.status(401).render('login', { title: 'Sign in — TERAPLAYZ', errors: { form: msg }, form: { username: value.username }, next });
  if (Object.keys(errors).length) return fail('Incorrect username or password.');
  const user = await db.get('SELECT id, password_hash, is_banned FROM users WHERE username = ?', [value.username]);
  const ok = await bcrypt.compare(value.password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) return fail('Incorrect username or password.');
  if (user.is_banned) return fail('This account has been suspended.');
  await createSession(req, res, user.id);
  res.redirect(next);
}));

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('register', { title: 'Create account — TERAPLAYZ', errors: {}, form: {} });
});

router.post('/register', limits.register, asyncH(async (req, res) => {
  if (!config.ALLOW_REGISTRATION) return res.status(403).render('errors/error', { title: 'Registration closed', status: 403, message: 'New sign-ups are currently disabled.' });
  const { value, errors } = v.credentials(req.body, { register: true });
  if (!Object.keys(errors).length) {
    const exists = await db.get('SELECT id FROM users WHERE username = ?', [value.username]);
    if (exists) errors.username = 'That username is taken.';
  }
  if (Object.keys(errors).length) return res.status(400).render('register', { title: 'Create account — TERAPLAYZ', errors, form: { username: value.username } });
  const hash = await bcrypt.hash(value.password, 12);
  let r;
  try {
    r = await db.run("INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, 'user', ?)", [value.username, hash, now()]);
  } catch (e) {
    return res.status(400).render('register', { title: 'Create account — TERAPLAYZ', errors: { username: 'That username is taken.' }, form: { username: value.username } });
  }
  await videos.bumpDaily('signups');
  await createSession(req, res, r.lastId);
  req.flash('ok', `Welcome to TERAPLAYZ, ${value.username}!`);
  res.redirect('/');
}));

router.post('/logout', asyncH(async (req, res) => {
  await destroySession(req, res);
  res.redirect('/');
}));

router.get('/account', requireUser, asyncH(async (req, res) => {
  const payments = await membership.history(req.user.id, 10);
  const progress = await db.all(`SELECT p.position, p.duration, p.updated_at, v.slug, v.title FROM watch_progress p
    JOIN videos v ON v.id = p.video_id WHERE p.user_id = ? AND v.is_published = 1 ORDER BY p.updated_at DESC LIMIT 10`, [req.user.id]);
  res.render('account', { title: 'My account — TERAPLAYZ', payments, progress, errors: {} });
}));

router.post('/account/password', requireUser, limits.auth, asyncH(async (req, res) => {
  const row = await db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  const current = typeof req.body.current_password === 'string' ? req.body.current_password : '';
  const { errors } = v.credentials({ username: req.user.username, password: req.body.password, password_confirm: req.body.password_confirm }, { register: true });
  if (!(await bcrypt.compare(current, row.password_hash))) errors.current_password = 'Current password is incorrect.';
  if (Object.keys(errors).length) {
    req.flash('error', Object.values(errors)[0]);
    return res.redirect('/account');
  }
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(req.body.password, 12), req.user.id]);
  await db.run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', [req.user.id, req.sessionId]);
  req.flash('ok', 'Password updated. Other devices were signed out.');
  res.redirect('/account');
}));

module.exports = router;
