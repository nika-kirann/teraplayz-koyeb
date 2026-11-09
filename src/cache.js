'use strict';
/** Tiny in-memory TTL cache with a hard entry cap (keeps RAM bounded). */
const config = require('./config');

const store = new Map();
const MAX_ENTRIES = 300;

function get(key) {
  const e = store.get(key);
  if (!e) return undefined;
  if (e.exp < Date.now()) { store.delete(key); return undefined; }
  return e.val;
}

function set(key, val, ttlSec = config.CACHE_TTL_SECONDS) {
  if (store.size >= MAX_ENTRIES) {
    const first = store.keys().next().value; // oldest insertion
    store.delete(first);
  }
  store.set(key, { val, exp: Date.now() + ttlSec * 1000 });
  return val;
}

async function wrap(key, ttlSec, fn) {
  const hit = get(key);
  if (hit !== undefined) return hit;
  const val = await fn();
  return set(key, val, ttlSec);
}

function del(key) { store.delete(key); }

/** Remove every key starting with prefix (or everything when omitted). */
function invalidate(prefix) {
  if (!prefix) return store.clear();
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
}

module.exports = { get, set, wrap, del, invalidate, _store: store };
