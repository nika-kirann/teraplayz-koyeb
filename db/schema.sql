-- TERAPLAYZ schema — SQLite dialect (better-sqlite3).
-- All timestamps are INTEGER milliseconds since the Unix epoch (UTC) so the
-- same application code works unchanged on SQLite and PostgreSQL.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  username            TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash       TEXT    NOT NULL,
  role                TEXT    NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  telegram_id         INTEGER UNIQUE,
  telegram_username   TEXT,
  premium_until       INTEGER,
  premium_auto_renew  INTEGER NOT NULL DEFAULT 1,
  is_banned           INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  last_login_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_users_premium ON users(premium_until);
CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT    PRIMARY KEY,           -- HMAC-SHA256 of the cookie token
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  slug        TEXT    NOT NULL UNIQUE,
  description TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS videos (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  slug                     TEXT    NOT NULL UNIQUE,
  title                    TEXT    NOT NULL,
  description              TEXT    NOT NULL DEFAULT '',
  category_id              INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  source_type              TEXT    NOT NULL DEFAULT 'telegram' CHECK (source_type IN ('telegram','url')),
  source_url               TEXT,                 -- only for public demo / CC sample files
  telegram_message_id      INTEGER,
  telegram_file_id         TEXT,
  telegram_file_unique_id  TEXT UNIQUE,
  telegram_thumb_file_id   TEXT,
  thumbnail_path           TEXT,                 -- compressed WebP under DATA_DIR/thumbs
  thumbnail_url            TEXT,                 -- remote/static thumbnail URL
  mime_type                TEXT,
  file_size                INTEGER,
  duration                 INTEGER,              -- seconds
  width                    INTEGER,
  height                   INTEGER,
  is_published             INTEGER NOT NULL DEFAULT 0,
  is_premium               INTEGER NOT NULL DEFAULT 0,
  is_featured              INTEGER NOT NULL DEFAULT 0,
  download_allowed         INTEGER NOT NULL DEFAULT 0,
  views                    INTEGER NOT NULL DEFAULT 0,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  published_at             INTEGER
);
CREATE INDEX IF NOT EXISTS idx_videos_pub ON videos(is_published, published_at);
CREATE INDEX IF NOT EXISTS idx_videos_cat ON videos(category_id, is_published);
CREATE INDEX IF NOT EXISTS idx_videos_views ON videos(views);
CREATE INDEX IF NOT EXISTS idx_videos_msg ON videos(telegram_message_id);

CREATE TABLE IF NOT EXISTS watch_progress (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id    INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  position    REAL    NOT NULL DEFAULT 0,
  duration    REAL    NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, video_id)
);

CREATE TABLE IF NOT EXISTS telegram_link_tokens (
  token       TEXT    PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invoices (
  payload     TEXT    PRIMARY KEY,               -- opaque random id sent to Telegram
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount      INTEGER NOT NULL,
  currency    TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','expired')),
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices(user_id);

CREATE TABLE IF NOT EXISTS payments (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id                     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  telegram_user_id            INTEGER NOT NULL,
  telegram_payment_charge_id  TEXT    NOT NULL UNIQUE,
  provider_payment_charge_id  TEXT,
  invoice_payload             TEXT,
  amount                      INTEGER NOT NULL,
  currency                    TEXT    NOT NULL,
  period_start                INTEGER NOT NULL,
  period_end                  INTEGER NOT NULL,
  created_at                  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);

CREATE TABLE IF NOT EXISTS ads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  slot        TEXT    NOT NULL,                  -- home_top | home_mid | browse_top | watch_below | watch_sidebar
  kind        TEXT    NOT NULL DEFAULT 'image' CHECK (kind IN ('image','html')),
  html        TEXT,
  image_url   TEXT,
  link_url    TEXT,
  pages       TEXT    NOT NULL DEFAULT 'all',    -- all | home | watch | browse
  enabled     INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_stats (
  day      TEXT    PRIMARY KEY,                  -- YYYY-MM-DD (UTC)
  views    INTEGER NOT NULL DEFAULT 0,
  signups  INTEGER NOT NULL DEFAULT 0,
  payments INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT
);

-- Compressed thumbnails (WebP, ~20–40 KB) stored in the database so they
-- survive restarts on hosts without persistent disks (e.g. Koyeb free).
CREATE TABLE IF NOT EXISTS thumbnails (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  mime        TEXT    NOT NULL DEFAULT 'image/webp',
  data        BLOB    NOT NULL,
  created_at  INTEGER NOT NULL
);
