'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const ROOT = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function startServer(extraEnv = {}) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpz-test-'));
  const env = {
    PATH: process.env.PATH,
    NODE_ENV: 'test',
    PORT: String(port),
    SESSION_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'Tpz-Admin-Test-2026!x9',
    DATA_DIR: dataDir,
    ENV_FILE: '.env.does-not-exist',
    ...extraEnv,
  };
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + '/healthz'); if (r.ok) break; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
    if (child.exitCode !== null) throw new Error('server exited:\n' + log);
  }
  return { base, child, dataDir, log: () => log, stop: () => new Promise((r) => { child.once('exit', r); child.kill('SIGTERM'); }) };
}

/** Minimal cookie-jar HTTP client. */
class Client {
  constructor(base) { this.base = base; this.jar = new Map(); }
  cookieHeader() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '); }
  store(res) {
    for (const c of res.headers.getSetCookie()) {
      const [kv, ...attrs] = c.split(';');
      const i = kv.indexOf('=');
      const k = kv.slice(0, i).trim(); const v = kv.slice(i + 1).trim();
      if (!v || attrs.some((a) => /max-age=0/i.test(a) || /expires=Thu, 01 Jan 1970/i.test(a))) this.jar.delete(k); else this.jar.set(k, v);
    }
  }
  async req(p, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (this.jar.size) headers.cookie = this.cookieHeader();
    const res = await fetch(this.base + p, { redirect: 'manual', ...opts, headers });
    this.store(res);
    return res;
  }
  async get(p, opts) { const r = await this.req(p, opts); r.text_ = await r.text(); return r; }
  async csrf(p = '/login') {
    const r = await this.get(p);
    const m = r.text_.match(/name="csrf-token" content="([^"]+)"/);
    if (!m) throw new Error('no csrf token on ' + p);
    this.token = m[1];
    return m[1];
  }
  async post(p, data = {}, { csrf = true } = {}) {
    const body = new URLSearchParams({ ...(csrf ? { _csrf: this.token } : {}), ...data });
    const r = await this.req(p, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    r.text_ = await r.text();
    return r;
  }
  async postJson(p, data) {
    const r = await this.req(p, { method: 'POST', body: JSON.stringify(data), headers: { 'content-type': 'application/json', 'x-csrf-token': this.token, accept: 'application/json' } });
    r.json_ = await r.json().catch(() => null);
    return r;
  }
  async postMultipart(p, fd) {
    fd.append('_csrf', this.token);
    const r = await this.req(p, { method: 'POST', body: fd });
    r.text_ = await r.text();
    return r;
  }
  async login(username, password) {
    await this.csrf('/login');
    return this.post('/login', { username, password });
  }
}

module.exports = { startServer, Client, freePort, ROOT };
