'use strict';
const db = require('../db');
const { now, DAY } = require('../util');

async function overview() {
  const t = now();
  const one = async (sql, p) => Number((await db.get(sql, p)).n || 0);
  const [users, premium, videos, published, premiumVideos, views, payments, stars, signups7] = await Promise.all([
    one('SELECT COUNT(*) AS n FROM users'),
    one('SELECT COUNT(*) AS n FROM users WHERE premium_until > ?', [t]),
    one('SELECT COUNT(*) AS n FROM videos'),
    one('SELECT COUNT(*) AS n FROM videos WHERE is_published = 1'),
    one('SELECT COUNT(*) AS n FROM videos WHERE is_premium = 1'),
    one('SELECT COALESCE(SUM(views), 0) AS n FROM videos'),
    one('SELECT COUNT(*) AS n FROM payments'),
    one('SELECT COALESCE(SUM(amount), 0) AS n FROM payments'),
    one('SELECT COUNT(*) AS n FROM users WHERE created_at > ?', [t - 7 * DAY]),
  ]);
  const since = new Date(t - 13 * DAY).toISOString().slice(0, 10);
  const daily = await db.all('SELECT day, views, signups, payments FROM daily_stats WHERE day >= ? ORDER BY day ASC', [since]);
  const recentUsers = await db.all('SELECT id, username, role, premium_until, telegram_id, created_at FROM users ORDER BY created_at DESC LIMIT 8');
  const topVideos = await db.all('SELECT id, slug, title, views, is_premium, is_published FROM videos ORDER BY views DESC LIMIT 6');
  // Fill missing days so the chart is continuous.
  const map = Object.fromEntries(daily.map((d) => [d.day, d]));
  const series = [];
  for (let i = 13; i >= 0; i--) {
    const day = new Date(t - i * DAY).toISOString().slice(0, 10);
    series.push(map[day] || { day, views: 0, signups: 0, payments: 0 });
  }
  return { users, premium, videos, published, premiumVideos, views, payments, stars, signups7, series, recentUsers, topVideos };
}

module.exports = { overview };
