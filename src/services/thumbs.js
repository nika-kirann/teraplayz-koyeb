'use strict';
/**
 * Thumbnail compression: any uploaded image -> 640x360 WebP (~20–40 KB).
 * Storage (THUMB_STORAGE):
 *   db   -> row in `thumbnails`, referenced as "db:<id>" (persistent with managed Postgres)
 *   disk -> file under DATA_DIR/thumbs (needs a persistent volume in production)
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../db');
const { randomToken, now } = require('../util');

let sharp = null;
function getSharp() {
  if (sharp === null) {
    try {
      sharp = require('sharp');
      sharp.cache(false); // keep RSS low on small instances
      sharp.concurrency(1);
    } catch (e) {
      console.warn('[thumbs] sharp unavailable, thumbnails will be stored as-is:', e.message);
      sharp = false;
    }
  }
  return sharp;
}

if (config.THUMB_STORAGE === 'disk') fs.mkdirSync(config.THUMBS_DIR, { recursive: true });

async function compress(buffer, mimetype) {
  const s = getSharp();
  if (s) {
    const out = await s(buffer, { limitInputPixels: 40e6, failOn: 'error' })
      .rotate()
      .resize(640, 360, { fit: 'cover', position: 'attention' })
      .webp({ quality: 72, effort: 3 })
      .toBuffer();
    return { data: out, mime: 'image/webp', ext: 'webp' };
  }
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[mimetype];
  if (!ext) throw Object.assign(new Error('Unsupported image type'), { status: 400 });
  if (buffer.length > 400 * 1024) throw Object.assign(new Error('Image too large without sharp'), { status: 400 });
  return { data: buffer, mime: mimetype, ext };
}

/** Returns the value to store in videos.thumbnail_path. */
async function saveUploaded(buffer, mimetype) {
  const img = await compress(buffer, mimetype);
  if (config.THUMB_STORAGE === 'db') {
    const r = await db.run('INSERT INTO thumbnails (mime, data, created_at) VALUES (?, ?, ?)', [img.mime, img.data, now()]);
    return `db:${r.lastId}`;
  }
  const name = `${Date.now().toString(36)}-${randomToken(6).replace(/[^A-Za-z0-9]/g, 'x')}.${img.ext}`;
  await fs.promises.writeFile(path.join(config.THUMBS_DIR, name), img.data);
  return name;
}

async function load(id) {
  return db.get('SELECT mime, data FROM thumbnails WHERE id = ?', [id]);
}

function remove(ref) {
  if (!ref) return;
  const m = String(ref).match(/^db:(\d+)$/);
  if (m) { db.run('DELETE FROM thumbnails WHERE id = ?', [Number(m[1])]).catch(() => {}); return; }
  if (!/^[A-Za-z0-9._-]+$/.test(ref)) return;
  fs.promises.unlink(path.join(config.THUMBS_DIR, ref)).catch(() => {});
}

module.exports = { saveUploaded, load, remove, compress };
