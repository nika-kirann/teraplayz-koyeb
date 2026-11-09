'use strict';
/**
 * Official Telegram Bot API client (HTTPS JSON calls via global fetch).
 * The bot token never leaves this module: it is not logged, rendered, or
 * returned to browsers. File downloads are streamed by the /stream route.
 */
const config = require('./config');
const { redact } = require('./util');

const tg = config.telegram;

class TelegramError extends Error {
  constructor(method, description, code) {
    super(`Telegram ${method} failed: ${redact(description)}`);
    this.code = code;
    this.description = redact(description);
  }
}

function ensureEnabled() {
  if (!config.telegramEnabled) {
    const e = new Error('Telegram is not configured (demo mode). Set TELEGRAM_BOT_TOKEN.');
    e.status = 503;
    throw e;
  }
}

async function call(method, params = {}, { timeoutMs = 15000 } = {}) {
  ensureEnabled();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${tg.apiRoot}/bot${tg.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: ctrl.signal,
    });
    let data;
    try { data = await res.json(); } catch { data = { ok: false, description: `HTTP ${res.status}` }; }
    if (!data.ok) throw new TelegramError(method, data.description || `HTTP ${res.status}`, data.error_code || res.status);
    return data.result;
  } catch (e) {
    if (e instanceof TelegramError) throw e;
    throw new TelegramError(method, e.name === 'AbortError' ? 'timeout' : e.message, 0);
  } finally {
    clearTimeout(t);
  }
}

// ---- bot identity (cached for the process lifetime) ----
let meCache = null;
async function getMe() {
  if (meCache) return meCache;
  meCache = await call('getMe');
  return meCache;
}
async function botUsername() {
  if (tg.botUsername) return tg.botUsername;
  if (!config.telegramEnabled) return '';
  try { return (await getMe()).username; } catch (e) { console.warn('[telegram] getMe:', e.message); return ''; }
}

// ---- file path cache: getFile paths are valid for at least one hour ----
const fileCache = new Map();
const FILE_TTL = 50 * 60 * 1000;

/** Resolve a file_id to {fileSize, filePath}; throws for oversized files. */
async function resolveFile(fileId) {
  const hit = fileCache.get(fileId);
  if (hit && hit.exp > Date.now()) return hit;
  const f = await call('getFile', { file_id: fileId });
  const entry = { fileSize: f.file_size || null, filePath: f.file_path, exp: Date.now() + FILE_TTL };
  if (fileCache.size > 500) fileCache.delete(fileCache.keys().next().value);
  fileCache.set(fileId, entry);
  return entry;
}

/**
 * Internal-only download URL. Must never be sent to a client or logged.
 * Self-hosted Bot API servers in --local mode return absolute paths; those
 * are still served by the server's /file/bot<token>/<path> endpoint when it
 * runs with --http-file-server style proxies, so we use the same scheme.
 */
function fileDownloadUrl(filePath) {
  ensureEnabled();
  const p = String(filePath).split('/').map(encodeURIComponent).join('/');
  return `${tg.apiRoot}/file/bot${tg.token}/${p.replace(/^\/+/, '')}`;
}

function isOversized(bytes) {
  return Boolean(bytes && bytes > tg.maxDownloadBytes);
}

/** Pick the playable media object from a Telegram Message. */
function extractMedia(msg) {
  if (!msg) return null;
  let media = null;
  let kind = null;
  if (msg.video) { media = msg.video; kind = 'video'; }
  else if (msg.document && /^video\//.test(msg.document.mime_type || '')) { media = msg.document; kind = 'document'; }
  else if (msg.animation) { media = msg.animation; kind = 'animation'; }
  if (!media) return null;
  const thumb = media.thumbnail || media.thumb || null;
  return {
    kind,
    file_id: media.file_id,
    file_unique_id: media.file_unique_id,
    mime_type: media.mime_type || (kind === 'video' ? 'video/mp4' : null),
    file_size: media.file_size || null,
    duration: media.duration || null,
    width: media.width || null,
    height: media.height || null,
    file_name: media.file_name || null,
    thumb_file_id: thumb ? thumb.file_id : null,
    caption: msg.caption || '',
    message_id: msg.message_id,
    oversized: isOversized(media.file_size),
    max_mb: Math.round(tg.maxDownloadBytes / 1048576),
  };
}

/**
 * The Bot API has no "getMessage". To read an existing channel post we
 * forward it (silently) into the same private channel, read the media from
 * the returned Message, and immediately delete the temporary copy.
 * Requires the bot to be an admin with "Post" and "Delete" rights.
 */
async function fetchChannelMessage(messageId) {
  ensureEnabled();
  if (!tg.channelId) { const e = new Error('TELEGRAM_CHANNEL_ID is not set.'); e.status = 400; throw e; }
  const fwd = await call('forwardMessage', {
    chat_id: tg.channelId,
    from_chat_id: tg.channelId,
    message_id: Number(messageId),
    disable_notification: true,
  });
  await call('deleteMessage', { chat_id: tg.channelId, message_id: fwd.message_id }).catch((e) => console.warn('[telegram] cleanup deleteMessage:', e.message));
  const media = extractMedia(fwd);
  if (!media) { const e = new Error(`Channel message ${messageId} has no video.`); e.status = 404; throw e; }
  media.message_id = Number(messageId);
  return media;
}

function sendMessage(chatId, text, extra = {}) {
  return call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
}

/** Telegram Stars invoice (currency XTR, no provider token). */
function starsInvoiceParams(payload) {
  return {
    title: config.premium.title,
    description: config.premium.description,
    payload,
    currency: 'XTR',
    prices: [{ label: 'Premium (1 month)', amount: config.premium.priceStars }],
  };
}

function sendStarsInvoice(chatId, payload) {
  return call('sendInvoice', { chat_id: chatId, ...starsInvoiceParams(payload) });
}

function createStarsInvoiceLink(payload) {
  return call('createInvoiceLink', starsInvoiceParams(payload));
}

function answerPreCheckout(id, ok, errorMessage) {
  return call('answerPreCheckoutQuery', ok ? { pre_checkout_query_id: id, ok: true } : { pre_checkout_query_id: id, ok: false, error_message: errorMessage || 'Payment could not be processed.' });
}

module.exports = {
  call, getMe, botUsername, resolveFile, fileDownloadUrl, isOversized, extractMedia,
  fetchChannelMessage, sendMessage, sendStarsInvoice, createStarsInvoiceLink, answerPreCheckout,
  TelegramError, _fileCache: fileCache,
};
