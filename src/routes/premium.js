'use strict';
const express = require('express');
const db = require('../db');
const config = require('../config');
const limits = require('../middleware/rateLimits');
const { requireUser } = require('../middleware/session');
const telegram = require('../telegram');
const membership = require('../services/membership');
const { asyncH } = require('../util');

const router = express.Router();

async function premiumPage(req, res, extra = {}) {
  const botUsername = config.telegramEnabled ? await telegram.botUsername() : '';
  const payments = req.user ? await membership.history(req.user.id, 10) : [];
  const premiumCount = Number((await db.get('SELECT COUNT(*) AS n FROM videos WHERE is_published = 1 AND is_premium = 1')).n);
  res.render('premium', { title: 'TERAPLAYZ Premium — 100 Stars / month', botUsername, payments, premiumCount, linkUrl: null, invoiceUrl: null, ...extra });
}

router.get('/premium', asyncH((req, res) => premiumPage(req, res)));

/** Step 1: bind a Telegram account via a one-time /start deep link. */
router.post('/premium/link', requireUser, limits.payment, asyncH(async (req, res) => {
  if (!config.telegramEnabled) { req.flash('warn', 'Telegram is not configured on this server (demo mode).'); return res.redirect('/premium'); }
  const bot = await telegram.botUsername();
  if (!bot) { req.flash('error', 'Bot username unavailable. Set TELEGRAM_BOT_USERNAME.'); return res.redirect('/premium'); }
  const token = await membership.createLinkToken(req.user.id);
  await premiumPage(req, res, { linkUrl: `https://t.me/${bot}?start=link_${token}` });
}));

router.post('/premium/unlink', requireUser, asyncH(async (req, res) => {
  await db.run('UPDATE users SET telegram_id = NULL, telegram_username = NULL WHERE id = ?', [req.user.id]);
  req.flash('ok', 'Telegram account unlinked.');
  res.redirect('/premium');
}));

/**
 * Step 2: create a Stars invoice bound to this user. The invoice is sent to
 * the linked Telegram chat and also returned as a t.me invoice link. Access
 * is granted ONLY when Telegram later delivers successful_payment to our
 * webhook — never from anything the browser says.
 */
router.post('/premium/checkout', requireUser, limits.payment, asyncH(async (req, res) => {
  if (!config.telegramEnabled) { req.flash('warn', 'Payments are disabled in demo mode.'); return res.redirect('/premium'); }
  if (!req.user.telegram_id) { req.flash('warn', 'Link your Telegram account first.'); return res.redirect('/premium'); }
  const payload = await membership.createInvoice(req.user.id);
  let invoiceUrl = null;
  let sent = false;
  try { invoiceUrl = await telegram.createStarsInvoiceLink(payload); } catch (e) { console.warn('[premium] createInvoiceLink:', e.message); }
  try { await telegram.sendStarsInvoice(req.user.telegram_id, payload); sent = true; } catch (e) { console.warn('[premium] sendInvoice:', e.message); }
  if (!invoiceUrl && !sent) { req.flash('error', 'Could not create a Telegram invoice right now. Open the bot, press Start, and try again.'); return res.redirect('/premium'); }
  await premiumPage(req, res, { invoiceUrl, invoiceSent: sent });
}));

/** Cancel = stop renewal reminders. Paid time is always honoured until premium_until. */
router.post('/premium/cancel', requireUser, asyncH(async (req, res) => {
  await membership.setAutoRenew(req.user.id, false);
  req.flash('ok', req.user.isPremium ? `Renewal cancelled. Premium stays active until ${new Date(Number(req.user.premium_until)).toUTCString().slice(5, 16)}.` : 'Renewal reminders turned off.');
  res.redirect('/premium');
}));

router.post('/premium/resume', requireUser, asyncH(async (req, res) => {
  await membership.setAutoRenew(req.user.id, true);
  req.flash('ok', 'Renewal reminders turned back on.');
  res.redirect('/premium');
}));

/** Lightweight status poll used by the premium page after checkout. */
router.get('/api/premium/status', limits.api, requireUser, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ premium: req.user.isPremium, premium_until: req.user.premium_until || null, auto_renew: Boolean(req.user.premium_auto_renew) });
});

module.exports = router;
