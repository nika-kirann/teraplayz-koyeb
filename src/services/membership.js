'use strict';
/**
 * Premium membership bookkeeping. Membership status is derived purely from
 * users.premium_until on every request (no cron / background worker).
 */
const db = require('../db');
const config = require('../config');
const { now, DAY, randomToken } = require('../util');
const videos = require('./videos');

const PERIOD_MS = () => config.premium.periodDays * DAY;

/** Extend from max(now, current expiry) by `days`. Returns new expiry. */
async function extend(t, userId, days) {
  const u = await t.get('SELECT premium_until FROM users WHERE id = ?', [userId]);
  if (!u) throw new Error('User not found');
  const start = Math.max(now(), Number(u.premium_until) || 0);
  const end = start + days * DAY;
  await t.run('UPDATE users SET premium_until = ?, premium_auto_renew = 1 WHERE id = ?', [end, userId]);
  return { start, end };
}

/** Create an opaque invoice payload bound to a site user. */
async function createInvoice(userId) {
  const payload = 'tpz_' + randomToken(18);
  await db.run('INSERT INTO invoices (payload, user_id, amount, currency, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [payload, userId, config.premium.priceStars, 'XTR', 'pending', now()]);
  return payload;
}

/** Validate a pre_checkout_query before Telegram charges the user. */
async function validatePreCheckout(q) {
  if (q.currency !== 'XTR') return { ok: false, error: 'Unsupported currency.' };
  if (Number(q.total_amount) !== config.premium.priceStars) return { ok: false, error: 'Price changed — request a new invoice.' };
  const inv = await db.get('SELECT * FROM invoices WHERE payload = ?', [String(q.invoice_payload || '')]);
  if (!inv || inv.status !== 'pending') return { ok: false, error: 'This invoice is no longer valid. Request a new one on the website.' };
  if (now() - Number(inv.created_at) > 2 * DAY) return { ok: false, error: 'This invoice expired. Request a new one on the website.' };
  const u = await db.get('SELECT id, telegram_id, is_banned FROM users WHERE id = ?', [inv.user_id]);
  if (!u || u.is_banned) return { ok: false, error: 'Account not found.' };
  if (u.telegram_id && Number(u.telegram_id) !== Number(q.from && q.from.id)) return { ok: false, error: 'Pay from the Telegram account linked to your TERAPLAYZ profile.' };
  return { ok: true, invoice: inv };
}

/**
 * Record a successful_payment that arrived in a Telegram update (the only
 * trusted source). Idempotent on telegram_payment_charge_id.
 * Returns { status: 'granted'|'duplicate'|'rejected', ... }.
 */
async function recordPayment(fromTelegramId, sp) {
  if (!sp || sp.currency !== 'XTR' || !sp.telegram_payment_charge_id) return { status: 'rejected', reason: 'bad_payment' };
  if (Number(sp.total_amount) < config.premium.priceStars) return { status: 'rejected', reason: 'amount' };
  return db.tx(async (t) => {
    const dup = await t.get('SELECT id FROM payments WHERE telegram_payment_charge_id = ?', [sp.telegram_payment_charge_id]);
    if (dup) return { status: 'duplicate' };
    const inv = await t.get('SELECT * FROM invoices WHERE payload = ?', [String(sp.invoice_payload || '')]);
    let userId = inv ? inv.user_id : null;
    if (!userId) {
      const byTg = await t.get('SELECT id FROM users WHERE telegram_id = ?', [fromTelegramId]);
      userId = byTg ? byTg.id : null;
    }
    // Telegram has charged the user, so always store the charge for audit/refund,
    // even if we cannot map it to an account.
    let period = { start: now(), end: now() };
    if (userId) {
      const months = Math.max(1, Math.floor(Number(sp.total_amount) / config.premium.priceStars));
      period = await extend(t, userId, config.premium.periodDays * months);
      const u = await t.get('SELECT telegram_id FROM users WHERE id = ?', [userId]);
      if (u && !u.telegram_id) await t.run('UPDATE users SET telegram_id = ? WHERE id = ?', [fromTelegramId, userId]);
    }
    await t.run(`INSERT INTO payments (user_id, telegram_user_id, telegram_payment_charge_id, provider_payment_charge_id,
        invoice_payload, amount, currency, period_start, period_end, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, fromTelegramId, sp.telegram_payment_charge_id, sp.provider_payment_charge_id || null,
      sp.invoice_payload || null, Number(sp.total_amount), sp.currency, period.start, period.end, now()]);
    if (inv) await t.run("UPDATE invoices SET status = 'paid' WHERE payload = ?", [inv.payload]);
    return userId ? { status: 'granted', userId, until: period.end } : { status: 'unmatched' };
  }).then(async (r) => { if (r.status === 'granted') await videos.bumpDaily('payments'); return r; });
}

async function setAutoRenew(userId, on) {
  await db.run('UPDATE users SET premium_auto_renew = ? WHERE id = ?', [on ? 1 : 0, userId]);
}

async function adminGrant(userId, days) {
  return db.tx((t) => extend(t, userId, days));
}

async function adminSetExpiry(userId, untilMs) {
  await db.run('UPDATE users SET premium_until = ? WHERE id = ?', [untilMs, userId]);
}

async function adminRevoke(userId) {
  await db.run('UPDATE users SET premium_until = NULL WHERE id = ?', [userId]);
}

async function history(userId, limit = 20) {
  return db.all('SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', [userId, limit]);
}

// ---- Telegram account linking ----
async function createLinkToken(userId) {
  await db.run('DELETE FROM telegram_link_tokens WHERE user_id = ? OR expires_at < ?', [userId, now()]);
  const token = randomToken(16).replace(/[^A-Za-z0-9]/g, '').slice(0, 20).padEnd(20, '0');
  await db.run('INSERT INTO telegram_link_tokens (token, user_id, expires_at) VALUES (?, ?, ?)', [token, userId, now() + 30 * 60 * 1000]);
  return token;
}

/** Bind a Telegram account to the site account that owns `token`. */
async function consumeLinkToken(token, tgUser) {
  return db.tx(async (t) => {
    const row = await t.get('SELECT * FROM telegram_link_tokens WHERE token = ?', [token]);
    if (!row || Number(row.expires_at) < now()) return { ok: false, reason: 'expired' };
    const other = await t.get('SELECT id FROM users WHERE telegram_id = ?', [tgUser.id]);
    if (other && Number(other.id) !== Number(row.user_id)) await t.run('UPDATE users SET telegram_id = NULL WHERE id = ?', [other.id]);
    await t.run('UPDATE users SET telegram_id = ?, telegram_username = ? WHERE id = ?', [tgUser.id, tgUser.username || null, row.user_id]);
    await t.run('DELETE FROM telegram_link_tokens WHERE token = ?', [token]);
    const u = await t.get('SELECT id, username FROM users WHERE id = ?', [row.user_id]);
    return { ok: true, user: u };
  });
}

module.exports = { PERIOD_MS, createInvoice, validatePreCheckout, recordPayment, setAutoRenew, adminGrant, adminSetExpiry, adminRevoke, history, createLinkToken, consumeLinkToken };
