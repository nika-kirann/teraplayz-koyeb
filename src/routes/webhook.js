'use strict';
/**
 * Telegram webhook (POST /telegram/webhook). Authenticated with the
 * X-Telegram-Bot-Api-Secret-Token header set via setWebhook(secret_token).
 * Handles: account linking (/start link_<token>), /premium invoices,
 * pre_checkout_query, successful_payment, and auto-ingest of channel videos.
 */
const express = require('express');
const db = require('../db');
const config = require('../config');
const limits = require('../middleware/rateLimits');
const telegram = require('../telegram');
const membership = require('../services/membership');
const videos = require('../services/videos');
const { safeEqual, redact, formatDate } = require('../util');

const router = express.Router();
const esc = (s) => String(s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const site = () => config.PUBLIC_BASE_URL || '';

async function userByTelegram(id) {
  return db.get('SELECT id, username, role, premium_until, premium_auto_renew FROM users WHERE telegram_id = ?', [id]);
}

async function sendPremiumInvoice(chatId, tgUserId) {
  const u = await userByTelegram(tgUserId);
  if (!u) {
    return telegram.sendMessage(chatId, `🔗 First link this Telegram account to your TERAPLAYZ profile:\nopen ${esc(site())}/premium while signed in and tap <b>Link Telegram</b>.`);
  }
  const payload = await membership.createInvoice(u.id);
  const active = u.premium_until && Number(u.premium_until) > Date.now();
  if (active) await telegram.sendMessage(chatId, `⭐ You're Premium until <b>${formatDate(u.premium_until)}</b>. Paying now adds ${config.premium.periodDays} more days.`);
  return telegram.sendStarsInvoice(chatId, payload);
}

async function ingestVideo(msg, { fromAdmin = false } = {}) {
  const media = telegram.extractMedia(msg);
  if (!media) return null;
  // If an admin forwards a post from our channel, keep the original channel message id.
  let messageId = null;
  const fo = msg.forward_origin;
  const fromChat = (fo && fo.chat) || msg.forward_from_chat;
  if (fromChat && String(fromChat.id) === String(config.telegram.channelId)) messageId = fo ? fo.message_id : msg.forward_from_message_id;
  if (!fromAdmin) messageId = msg.message_id;
  if (media.file_unique_id && await db.get('SELECT id FROM videos WHERE telegram_file_unique_id = ?', [media.file_unique_id])) return { duplicate: true };
  const caption = (media.caption || '').trim();
  const title = (caption.split('\n')[0] || media.file_name || `Telegram upload #${messageId || msg.message_id}`).slice(0, 200);
  const id = await videos.create({
    title,
    description: caption.split('\n').slice(1).join('\n').trim().slice(0, 5000),
    source_type: 'telegram',
    telegram_message_id: messageId,
    telegram_file_id: media.file_id,
    telegram_file_unique_id: media.file_unique_id || null,
    telegram_thumb_file_id: media.thumb_file_id,
    mime_type: media.mime_type,
    file_size: media.file_size,
    duration: media.duration,
    width: media.width,
    height: media.height,
    is_published: 0,
  });
  return { id, oversized: media.oversized, title };
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const from = msg.from || {};

  // ---- payment confirmation: the ONLY place premium is granted ----
  if (msg.successful_payment) {
    const r = await membership.recordPayment(from.id, msg.successful_payment);
    if (r.status === 'granted') {
      await telegram.sendMessage(chatId, `✅ Payment received — TERAPLAYZ Premium is active until <b>${formatDate(r.until)}</b>. Enjoy ad-free streaming!`).catch(() => {});
    } else if (r.status === 'unmatched') {
      await telegram.sendMessage(chatId, '⚠️ Payment received but no linked TERAPLAYZ account was found. Contact support with your payment receipt.').catch(() => {});
    }
    return;
  }

  if (msg.chat.type !== 'private') return;
  const text = (msg.text || '').trim();

  if (/^\/start(@\w+)?\s+link_([A-Za-z0-9]{20})$/.test(text)) {
    const token = text.match(/link_([A-Za-z0-9]{20})$/)[1];
    const r = await membership.consumeLinkToken(token, from);
    return telegram.sendMessage(chatId, r.ok
      ? `🔗 Linked to TERAPLAYZ account <b>${esc(r.user.username)}</b>.\nSend /premium to get Premium for ${config.premium.priceStars} ⭐ / month.`
      : '⌛ That link has expired. Generate a new one on the TERAPLAYZ Premium page.');
  }
  if (/^\/start(@\w+)?\s+premium$/.test(text) || /^\/premium(@\w+)?$/.test(text)) return sendPremiumInvoice(chatId, from.id);
  if (/^\/status(@\w+)?$/.test(text)) {
    const u = await userByTelegram(from.id);
    if (!u) return telegram.sendMessage(chatId, 'This Telegram account is not linked to TERAPLAYZ yet.');
    const active = u.premium_until && Number(u.premium_until) > Date.now();
    return telegram.sendMessage(chatId, active ? `⭐ Premium active until <b>${formatDate(u.premium_until)}</b>${u.premium_auto_renew ? '' : ' (renewal cancelled)'}.` : 'You are on the free plan. Send /premium to upgrade.');
  }

  // Admin convenience: send or forward a video to the bot to create a draft.
  if (telegram.extractMedia(msg)) {
    const u = await userByTelegram(from.id);
    if (u && u.role === 'admin') {
      const r = await ingestVideo(msg, { fromAdmin: true });
      if (r && r.duplicate) return telegram.sendMessage(chatId, 'ℹ️ That video is already in the library.');
      if (r) {
        return telegram.sendMessage(chatId, `📥 Draft created: <b>${esc(r.title)}</b>${r.oversized ? '\n⚠️ Over the Bot API 20 MB download limit — playback will be refused until you use a self-hosted Bot API server.' : ''}\n${esc(site())}/admin/videos/${r.id}/edit`);
      }
    }
    return;
  }

  if (/^\/(paysupport|terms)(@\w+)?$/.test(text)) {
    return telegram.sendMessage(chatId, `🧾 <b>Payments &amp; support</b>\nPremium costs ${config.premium.priceStars} ⭐ for ${config.premium.periodDays} days and does not renew automatically. For payment problems or refund requests contact ${esc(config.SUPPORT_CONTACT || site() || 'the site administrator')} with your receipt.`);
  }
  if (/^\/(start|help)/.test(text)) {
    return telegram.sendMessage(chatId, `🎬 <b>TERAPLAYZ</b>\n\n/premium — get Premium (${config.premium.priceStars} ⭐ for ${config.premium.periodDays} days)\n/status — check your membership\n\nTo link your account, open ${esc(site())}/premium on the website.`);
  }
}

router.post('/webhook', limits.webhook, async (req, res) => {
  const secret = config.telegram.webhookSecret;
  if (!config.telegramEnabled || !secret) return res.status(404).end();
  if (!safeEqual(req.get('x-telegram-bot-api-secret-token'), secret)) return res.status(401).end();
  const u = req.body || {};
  try {
    if (u.pre_checkout_query) {
      const q = u.pre_checkout_query;
      const r = await membership.validatePreCheckout(q);
      await telegram.answerPreCheckout(q.id, r.ok, r.error);
    } else if (u.message) {
      await handleMessage(u.message);
    } else if (u.channel_post && String(u.channel_post.chat.id) === String(config.telegram.channelId) && config.telegram.autoIngest) {
      await ingestVideo(u.channel_post);
    }
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[webhook]', redact(e.stack || e.message));
    // Ask Telegram to retry only for payment updates (handled idempotently).
    if (u.message && u.message.successful_payment) return res.status(500).end();
    res.status(200).json({ ok: false });
  }
});

module.exports = router;
module.exports._internals = { handleMessage, ingestVideo };
