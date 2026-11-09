-- TERAPLAYZ schema — PostgreSQL dialect (pg). Mirrors db/schema.sql.
-- All timestamps are BIGINT milliseconds since the Unix epoch (UTC) so the
-- same application code works unchanged on SQLite and PostgreSQL.

CREATE TABLE IF NOT EXISTS users (
  id                  BIGSERIAL PRIMARY KEY,
  username            TEXT    NOT NULL UNIQUE,
  password_hash       TEXT    NOT NULL,
  role                TEXT    NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  telegram_id         BIGINT UNIQUE,
  telegram_username   TEXT,
  premium_until       BIGINT,
  premium_auto_renew  BIGINT NOT NULL DEFAULT 1,
  is_banned           BIGINT NOT NULL DEFAULT 0,
  created_at          BIGINT NOT NULL,
  last_login_at       BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users (LOWER(username));
CREATE INDEX IF NOT EXISTS idx_users_premium ON users(premium_until);
CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT    PRIMARY KEY,           -- HMAC-SHA256 of the cookie token
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  BIGINT NOT NULL,
  expires_at  BIGINT NOT NULL,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS categories (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT    NOT NULL,
  slug        TEXT    NOT NULL UNIQUE,
  description TEXT,
  sort_order  BIGINT NOT NULL DEFAULT 0,
  created_at  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS videos (
  id                       BIGSERIAL PRIMARY KEY,
  slug                     TEXT    NOT NULL UNIQUE,
  title                    TEXT    NOT NULL,
  description              TEXT    NOT NULL DEFAULT '',
  category_id              BIGINT REFERENCES categories(id) ON DELETE SET NULL,
  source_type              TEXT    NOT NULL DEFAULT 'telegram' CHECK (source_type IN ('telegram','url')),
  source_url               TEXT,                 -- only for public demo / CC sample files
  telegram_message_id      BIGINT,
  telegram_file_id         TEXT,
  telegram_file_unique_id  TEXT UNIQUE,
  telegram_thumb_file_id   TEXT,
  thumbnail_path           TEXT,                 -- compressed WebP under DATA_DIR/thumbs
  thumbnail_url            TEXT,                 -- remote/static thumbnail URL
  mime_type                TEXT,
  file_size                BIGINT,
  duration                 BIGINT,              -- seconds
  width                    BIGINT,
  height                   BIGINT,
  is_published             BIGINT NOT NULL DEFAULT 0,
  is_premium               BIGINT NOT NULL DEFAULT 0,
  is_featured              BIGINT NOT NULL DEFAULT 0,
  download_allowed         BIGINT NOT NULL DEFAULT 0,
  views                    BIGINT NOT NULL DEFAULT 0,
  created_at               BIGINT NOT NULL,
  updated_at               BIGINT NOT NULL,
  published_at             BIGINT
);
CREATE INDEX IF NOT EXISTS idx_videos_pub ON videos(is_published, published_at);
CREATE INDEX IF NOT EXISTS idx_videos_cat ON videos(category_id, is_published);
CREATE INDEX IF NOT EXISTS idx_videos_views ON videos(views);
CREATE INDEX IF NOT EXISTS idx_videos_msg ON videos(telegram_message_id);

CREATE TABLE IF NOT EXISTS watch_progress (
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id    BIGINT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  position    DOUBLE PRECISION    NOT NULL DEFAULT 0,
  duration    DOUBLE PRECISION    NOT NULL DEFAULT 0,
  updated_at  BIGINT NOT NULL,
  PRIMARY KEY (user_id, video_id)
);

CREATE TABLE IF NOT EXISTS telegram_link_tokens (
  token       TEXT    PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS invoices (
  payload     TEXT    PRIMARY KEY,               -- opaque random id sent to Telegram
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount      BIGINT NOT NULL,
  currency    TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','expired')),
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices(user_id);

CREATE TABLE IF NOT EXISTS payments (
  id                          BIGSERIAL PRIMARY KEY,
  user_id                     BIGINT REFERENCES users(id) ON DELETE SET NULL,
  telegram_user_id            BIGINT NOT NULL,
  telegram_payment_charge_id  TEXT    NOT NULL UNIQUE,
  provider_payment_charge_id  TEXT,
  invoice_payload             TEXT,
  amount                      BIGINT NOT NULL,
  currency                    TEXT    NOT NULL,
  period_start                BIGINT NOT NULL,
  period_end                  BIGINT NOT NULL,
  created_at                  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);

CREATE TABLE IF NOT EXISTS ads (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT    NOT NULL,
  slot        TEXT    NOT NULL,                  -- home_top | home_mid | browse_top | watch_below | watch_sidebar
  kind        TEXT    NOT NULL DEFAULT 'image' CHECK (kind IN ('image','html')),
  html        TEXT,
  image_url   TEXT,
  link_url    TEXT,
  pages       TEXT    NOT NULL DEFAULT 'all',    -- all | home | watch | browse
  enabled     BIGINT NOT NULL DEFAULT 1,
  sort_order  BIGINT NOT NULL DEFAULT 0,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_stats (
  day      TEXT    PRIMARY KEY,                  -- YYYY-MM-DD (UTC)
  views    BIGINT NOT NULL DEFAULT 0,
  signups  BIGINT NOT NULL DEFAULT 0,
  payments BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT
);

-- Compressed thumbnails (WebP, ~20–40 KB) stored in the database so they
-- survive restarts on hosts without persistent disks (e.g. Koyeb free).
CREATE TABLE IF NOT EXISTS thumbnails (
  id          BIGSERIAL PRIMARY KEY,
  mime        TEXT    NOT NULL DEFAULT 'image/webp',
  data        BYTEA   NOT NULL,
  created_at  BIGINT  NOT NULL
);
