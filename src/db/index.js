'use strict';
/**
 * Thin portable query helper.
 *   - SQLite (better-sqlite3) by default, file at DATABASE_PATH.
 *   - PostgreSQL (pg) when DATABASE_URL is set.
 * SQL is written once with "?" placeholders; they are rewritten to $1..$n
 * for PostgreSQL. All helpers are async so callers never care which engine
 * is active.
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');

let engine = null; // 'sqlite' | 'pg'
let sqlite = null;
let pool = null;

function toPg(sql) {
  let i = 0;
  let out = '';
  let inStr = false;
  for (const ch of sql) {
    if (ch === "'") inStr = !inStr;
    if (ch === '?' && !inStr) out += '$' + (++i);
    else out += ch;
  }
  return out;
}

function normParams(params) {
  return (params || []).map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p === undefined ? null : p));
}

async function init() {
  if (config.DATABASE_URL) {
    const { Pool, types } = require('pg');
    types.setTypeParser(20, (v) => (v === null ? null : Number(v))); // BIGINT -> number
    types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // NUMERIC -> number
    let ssl;
    if (config.DATABASE_SSL === 'disable') ssl = false;
    else if (config.DATABASE_SSL === 'require' || /sslmode=require/.test(config.DATABASE_URL) || !/localhost|127\.0\.0\.1/.test(config.DATABASE_URL)) ssl = { rejectUnauthorized: false };
    pool = new Pool({ connectionString: config.DATABASE_URL, max: config.PG_POOL_MAX, idleTimeoutMillis: 30000, ssl });
    pool.on('error', (e) => console.error('[db] pg pool error:', e.message));
    engine = 'pg';
    const schema = fs.readFileSync(path.join(__dirname, '..', '..', 'db', 'schema.postgres.sql'), 'utf8');
    await pool.query(schema);
  } else {
    const Database = require('better-sqlite3');
    fs.mkdirSync(path.dirname(config.DATABASE_PATH), { recursive: true });
    sqlite = new Database(config.DATABASE_PATH);
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('synchronous = NORMAL');
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma('busy_timeout = 5000');
    sqlite.pragma('cache_size = -4000'); // ~4 MB page cache — keep RAM low
    engine = 'sqlite';
    const schema = fs.readFileSync(path.join(__dirname, '..', '..', 'db', 'schema.sql'), 'utf8');
    sqlite.exec(schema);
  }
  return engine;
}

async function all(sql, params) {
  if (engine === 'pg') return (await pool.query(toPg(sql), normParams(params))).rows;
  return sqlite.prepare(sql).all(...normParams(params));
}

async function get(sql, params) {
  if (engine === 'pg') return (await pool.query(toPg(sql), normParams(params))).rows[0] || null;
  return sqlite.prepare(sql).get(...normParams(params)) || null;
}

/** Executes a write. Returns { changes, lastId } (lastId only for INSERTs). */
async function run(sql, params) {
  if (engine === 'pg') {
    let q = toPg(sql);
    const isInsert = /^\s*insert/i.test(q) && !/returning/i.test(q);
    if (isInsert) q += ' RETURNING *';
    const r = await pool.query(q, normParams(params));
    return { changes: r.rowCount, lastId: isInsert && r.rows[0] ? r.rows[0].id ?? null : null };
  }
  const r = sqlite.prepare(sql).run(...normParams(params));
  return { changes: r.changes, lastId: Number(r.lastInsertRowid) || null };
}

/** Run fn inside a transaction. fn receives a tx-scoped {all,get,run}. */
async function tx(fn) {
  if (engine === 'pg') {
    const client = await pool.connect();
    const t = {
      all: async (s, p) => (await client.query(toPg(s), normParams(p))).rows,
      get: async (s, p) => (await client.query(toPg(s), normParams(p))).rows[0] || null,
      run: async (s, p) => {
        let q = toPg(s);
        const isInsert = /^\s*insert/i.test(q) && !/returning/i.test(q);
        if (isInsert) q += ' RETURNING *';
        const r = await client.query(q, normParams(p));
        return { changes: r.rowCount, lastId: isInsert && r.rows[0] ? r.rows[0].id ?? null : null };
      },
    };
    try {
      await client.query('BEGIN');
      const out = await fn(t);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  // better-sqlite3 is synchronous; wrap in BEGIN IMMEDIATE so concurrent
  // async callers cannot interleave inside the transaction.
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    const out = await fn({ all, get, run });
    sqlite.exec('COMMIT');
    return out;
  } catch (e) {
    try { sqlite.exec('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  }
}

/** Fast liveness probe for /healthz?deep=1 */
async function ping() {
  if (engine === 'pg') { await pool.query('SELECT 1'); return true; }
  sqlite.prepare('SELECT 1').get();
  return true;
}

async function close() {
  if (pool) await pool.end();
  if (sqlite) sqlite.close();
}

/** Case-insensitive LIKE that works on both engines. */
const ilike = (col) => `LOWER(${col}) LIKE LOWER(?) ESCAPE '\\'`;

module.exports = { init, all, get, run, tx, ping, close, ilike, get engine() { return engine; } };
