'use strict';
const crypto = require('crypto');
const config = require('./config');

const now = () => Date.now();
const DAY = 24 * 60 * 60 * 1000;

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const hmac = (value) => crypto.createHmac('sha256', config.SESSION_SECRET).update(String(value)).digest('base64url');

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function slugify(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'video';
}

const escapeLike = (s) => String(s).replace(/[\\%_]/g, (m) => '\\' + m);

function isPremium(user) {
  return Boolean(user && user.premium_until && Number(user.premium_until) > Date.now());
}

function formatDate(ms) {
  if (!ms) return '';
  return new Date(Number(ms)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function formatDuration(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  if (!sec) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function formatBytes(n) {
  n = Number(n) || 0;
  if (!n) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function timeAgo(ms) {
  const d = Date.now() - Number(ms);
  if (d < 60e3) return 'just now';
  const mins = Math.floor(d / 60e3);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days} day${days > 1 ? 's' : ''} ago`;
  return formatDate(ms);
}

function formatCount(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

const todayKey = () => new Date().toISOString().slice(0, 10);

/** Never let secrets leak into logs. */
function redact(s) {
  let out = String(s);
  if (config.telegram.token) out = out.split(config.telegram.token).join('<redacted>');
  return out.replace(/bot\d+:[A-Za-z0-9_-]{20,}/g, 'bot<redacted>');
}

const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = {
  now, DAY, randomToken, hmac, safeEqual, slugify, escapeLike, isPremium, formatDate,
  formatDuration, formatBytes, timeAgo, formatCount, todayKey, redact, asyncH,
};
