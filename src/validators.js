'use strict';
/** Small, dependency-free input validators. Each returns { value, error }. */

class ValidationError extends Error {
  constructor(errors) { super('Validation failed'); this.errors = errors; this.status = 400; }
}

const str = (v) => (v === undefined || v === null ? '' : String(v)).trim();
const flag = (v) => v === true || v === 1 || v === '1' || v === 'on' || v === 'true';

function intOrNull(v, { min = -Infinity, max = Infinity } = {}) {
  const s = str(v);
  if (!s) return null;
  if (!/^-?\d+$/.test(s)) return NaN;
  const n = parseInt(s, 10);
  if (n < min || n > max || !Number.isSafeInteger(n)) return NaN;
  return n;
}

function httpsUrl(v, { allowEmpty = true, allowRelative = false } = {}) {
  const s = str(v);
  if (!s) return allowEmpty ? '' : null;
  if (allowRelative && /^\/[A-Za-z0-9_\-./]+$/.test(s) && !s.includes('..')) return s;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.toString();
  } catch { return null; }
}

const USERNAME_RE = /^[a-z0-9_]{3,24}$/;

function credentials(body, { register = false } = {}) {
  const errors = {};
  const username = str(body.username).toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';
  if (!USERNAME_RE.test(username)) errors.username = 'Username must be 3–24 characters: letters, numbers or underscore.';
  if (register) {
    if (password.length < 8 || password.length > 128) errors.password = 'Password must be 8–128 characters.';
    else if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) errors.password = 'Password needs at least one letter and one number.';
    if (body.password_confirm !== undefined && body.password_confirm !== password) errors.password_confirm = 'Passwords do not match.';
  } else if (!password || password.length > 128) errors.password = 'Enter your password.';
  return { value: { username, password }, errors };
}

const TG_FILE_ID_RE = /^[A-Za-z0-9_-]{10,255}$/;

function video(body) {
  const errors = {};
  const v = {
    title: str(body.title).slice(0, 200),
    description: str(body.description).slice(0, 5000),
    category_id: intOrNull(body.category_id, { min: 1 }),
    source_type: str(body.source_type) === 'url' ? 'url' : 'telegram',
    source_url: '',
    telegram_message_id: intOrNull(body.telegram_message_id, { min: 1 }),
    telegram_file_id: str(body.telegram_file_id),
    telegram_file_unique_id: str(body.telegram_file_unique_id),
    telegram_thumb_file_id: str(body.telegram_thumb_file_id),
    thumbnail_url: '',
    mime_type: str(body.mime_type).slice(0, 100),
    file_size: intOrNull(body.file_size, { min: 0 }),
    duration: intOrNull(body.duration, { min: 0, max: 360000 }),
    width: intOrNull(body.width, { min: 0, max: 16384 }),
    height: intOrNull(body.height, { min: 0, max: 16384 }),
    is_published: flag(body.is_published) ? 1 : 0,
    is_premium: flag(body.is_premium) ? 1 : 0,
    is_featured: flag(body.is_featured) ? 1 : 0,
    download_allowed: flag(body.download_allowed) ? 1 : 0,
    remove_thumbnail: flag(body.remove_thumbnail),
  };
  if (v.title.length < 2) errors.title = 'Title is required (2–200 characters).';
  for (const k of ['category_id', 'telegram_message_id', 'file_size', 'duration', 'width', 'height']) {
    if (Number.isNaN(v[k])) errors[k] = 'Must be a valid positive whole number.';
  }
  for (const k of ['telegram_file_id', 'telegram_file_unique_id', 'telegram_thumb_file_id']) {
    if (v[k] && !TG_FILE_ID_RE.test(v[k]) && !(k === 'telegram_file_unique_id' && /^[A-Za-z0-9_-]{4,64}$/.test(v[k]))) errors[k] = 'Looks invalid — copy the exact id from Telegram.';
  }
  const thumb = httpsUrl(body.thumbnail_url, { allowRelative: true });
  if (thumb === null) errors.thumbnail_url = 'Thumbnail URL must be http(s) or a site-relative path.';
  else v.thumbnail_url = thumb;
  if (v.source_type === 'url') {
    const u = httpsUrl(body.source_url, { allowEmpty: false });
    if (!u || !u.startsWith('https://')) errors.source_url = 'Public sample URL must be an https:// link to an MP4/WebM file.';
    else v.source_url = u;
  } else if (!v.telegram_file_id && !v.telegram_message_id) {
    errors.telegram_message_id = 'Provide a Telegram channel message ID (we fetch the file id automatically) or a file id.';
  }
  if (!v.telegram_file_unique_id) v.telegram_file_unique_id = null;
  return { value: v, errors };
}

function category(body) {
  const errors = {};
  const v = {
    name: str(body.name).slice(0, 60),
    slug: str(body.slug).toLowerCase(),
    description: str(body.description).slice(0, 300),
    sort_order: intOrNull(body.sort_order, { min: -1000, max: 1000 }) ?? 0,
  };
  if (v.name.length < 2) errors.name = 'Name is required.';
  if (v.slug && !/^[a-z0-9-]{2,60}$/.test(v.slug)) errors.slug = 'Slug: lowercase letters, numbers and dashes.';
  if (Number.isNaN(v.sort_order)) errors.sort_order = 'Must be a number.';
  return { value: v, errors };
}

const AD_SLOTS = ['home_top', 'home_mid', 'browse_top', 'watch_below', 'watch_sidebar'];
const AD_PAGES = ['all', 'home', 'browse', 'watch'];

function ad(body) {
  const errors = {};
  const v = {
    name: str(body.name).slice(0, 80),
    slot: str(body.slot),
    kind: str(body.kind) === 'html' ? 'html' : 'image',
    html: typeof body.html === 'string' ? body.html.slice(0, 20000) : '',
    image_url: '',
    link_url: '',
    pages: str(body.pages) || 'all',
    enabled: flag(body.enabled) ? 1 : 0,
    sort_order: intOrNull(body.sort_order, { min: -1000, max: 1000 }) ?? 0,
  };
  if (v.name.length < 2) errors.name = 'Name is required.';
  if (!AD_SLOTS.includes(v.slot)) errors.slot = 'Choose a placement.';
  if (!AD_PAGES.includes(v.pages)) errors.pages = 'Choose where it appears.';
  if (v.kind === 'image') {
    const img = httpsUrl(body.image_url, { allowEmpty: false, allowRelative: true });
    const link = httpsUrl(body.link_url, { allowEmpty: true, allowRelative: true });
    if (!img) errors.image_url = 'Image URL is required (http(s) or /path).';
    else v.image_url = img;
    if (link === null) errors.link_url = 'Link must be an http(s) URL.';
    else v.link_url = link;
  } else if (!v.html.trim()) errors.html = 'HTML snippet is required.';
  if (Number.isNaN(v.sort_order)) errors.sort_order = 'Must be a number.';
  return { value: v, errors };
}

function pageNum(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 && n < 100000 ? n : 1;
}

function searchQuery(v) {
  return str(v).replace(/\s+/g, ' ').slice(0, 80);
}

module.exports = { ValidationError, str, flag, intOrNull, httpsUrl, credentials, video, category, ad, pageNum, searchQuery, AD_SLOTS, AD_PAGES };
