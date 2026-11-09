'use strict';
const path = require('path');
const fs = require('fs');

// Minimal .env loader (avoids the dotenv dependency). Real environment
// variables always win over values from the file.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/(^|\s+)#.*$/, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadDotEnv(path.join(__dirname, '..', process.env.ENV_FILE || '.env'));

const env = process.env;
const int = (v, d) => (v === undefined || v === '' || isNaN(parseInt(v, 10)) ? d : parseInt(v, 10));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

const NODE_ENV = env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';

let SESSION_SECRET = env.SESSION_SECRET || '';
if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  if (isProd) {
    console.error('[config] SESSION_SECRET must be set to at least 32 random characters in production.');
    process.exit(1);
  }
  SESSION_SECRET = SESSION_SECRET || require('crypto').randomBytes(32).toString('hex');
  console.warn('[config] SESSION_SECRET missing/short — using an ephemeral development secret.');
}

const DATA_DIR = path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data'));

const telegramToken = env.TELEGRAM_BOT_TOKEN || '';
const config = {
  NODE_ENV,
  isProd,
  PORT: int(env.PORT, 3000),
  PUBLIC_BASE_URL: (env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
  SESSION_SECRET,
  SESSION_TTL_DAYS: int(env.SESSION_TTL_DAYS, 30),
  COOKIE_SECURE: bool(env.COOKIE_SECURE, isProd),
  TRUST_PROXY: int(env.TRUST_PROXY, 1),
  DATA_DIR,
  THUMBS_DIR: path.join(DATA_DIR, 'thumbs'),
  DATABASE_URL: env.DATABASE_URL || '',
  DATABASE_PATH: path.resolve(env.DATABASE_PATH || path.join(DATA_DIR, 'teraplayz.db')),
  DATABASE_SSL: env.DATABASE_SSL || 'auto', // auto | require | disable
  PG_POOL_MAX: int(env.PG_POOL_MAX, 4),
  ADMIN_USERNAME: (env.ADMIN_USERNAME || '').trim().toLowerCase(),
  ADMIN_PASSWORD: env.ADMIN_PASSWORD || '',
  SEED_DEMO: env.SEED_DEMO, // undefined => auto (seed when Telegram is not configured and DB is empty)
  SUPPORT_CONTACT: env.SUPPORT_CONTACT || '',
  ALLOW_REGISTRATION: bool(env.ALLOW_REGISTRATION, true),
  PREMIUM_TEASERS: bool(env.PREMIUM_TEASERS, true),
  CACHE_TTL_SECONDS: int(env.CACHE_TTL_SECONDS, 60),
  PAGE_SIZE: int(env.PAGE_SIZE, 24),
  MAX_THUMB_UPLOAD_MB: int(env.MAX_THUMB_UPLOAD_MB, 5),
  // 'db' keeps compressed thumbnails in the database (survives ephemeral disks);
  // 'disk' writes them under DATA_DIR/thumbs. Default: db when DATABASE_URL is set.
  THUMB_STORAGE: /^(db|disk)$/.test(env.THUMB_STORAGE || '') ? env.THUMB_STORAGE : (env.DATABASE_URL ? 'db' : 'disk'),
  telegram: {
    token: telegramToken,
    channelId: env.TELEGRAM_CHANNEL_ID || '',
    botUsername: (env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, ''),
    webhookSecret: env.TELEGRAM_WEBHOOK_SECRET || '',
    apiRoot: (env.TELEGRAM_API_ROOT || 'https://api.telegram.org').replace(/\/+$/, ''),
    // Official cloud Bot API: getFile only serves files up to 20 MB. A
    // self-hosted Bot API server (--local) lifts this to 2000 MB.
    maxDownloadBytes: int(env.TELEGRAM_MAX_FILE_MB, null) !== null
      ? int(env.TELEGRAM_MAX_FILE_MB, 20) * 1024 * 1024
      : ((env.TELEGRAM_API_ROOT && !/api\.telegram\.org/.test(env.TELEGRAM_API_ROOT)) ? 2000 : 20) * 1024 * 1024,
    // When using a self-hosted server in --local mode, getFile returns an
    // absolute path on that server's disk; set this so we can still stream
    // it via the server's /file endpoint (default behaviour) .
    autoIngest: bool(env.TELEGRAM_AUTO_INGEST, true),
  },
  premium: {
    priceStars: int(env.PREMIUM_PRICE_STARS, 100),
    periodDays: int(env.PREMIUM_PERIOD_DAYS, 31),
    title: env.PREMIUM_TITLE || 'TERAPLAYZ Premium — 1 month',
    description: env.PREMIUM_DESCRIPTION || 'Ad-free streaming, premium-only catalogue and a Premium badge for 31 days.',
  },
};
config.telegramEnabled = Boolean(telegramToken);
config.demoMode = !config.telegramEnabled;

module.exports = config;
