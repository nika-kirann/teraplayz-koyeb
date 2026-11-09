'use strict';
const db = require('../db');
const cache = require('../cache');

/** Enabled ads grouped by slot for a page. Premium users never reach this. */
async function forPage(page) {
  const all = await cache.wrap('ads:enabled', 120, () =>
    db.all('SELECT id, name, slot, kind, image_url, link_url, pages FROM ads WHERE enabled = 1 ORDER BY sort_order ASC, id ASC'));
  const bySlot = {};
  for (const a of all) {
    if (a.pages !== 'all' && a.pages !== page) continue;
    (bySlot[a.slot] = bySlot[a.slot] || []).push(a);
  }
  return bySlot;
}

/** Middleware: exposes res.locals.ads (empty object for premium users). */
function adsFor(page) {
  return async (req, res, next) => {
    try {
      res.locals.ads = req.user && (req.user.isPremium) ? {} : await forPage(page);
      res.locals.adsEnabled = !(req.user && req.user.isPremium);
      next();
    } catch (e) { next(e); }
  };
}

async function getHtml(id) {
  return cache.wrap(`ads:html:${id}`, 120, () => db.get("SELECT id, html, enabled, kind FROM ads WHERE id = ? AND kind = 'html'", [id]));
}

const invalidate = () => cache.invalidate('ads:');

module.exports = { forPage, adsFor, getHtml, invalidate };
