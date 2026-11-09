'use strict';
/*
 * End-to-end tests with Telegram ENABLED against a local mock of the Bot API
 * (TELEGRAM_API_ROOT). Covers: account linking via /start deep link, Stars
 * invoices, pre_checkout validation, successful_payment verification + replay
 * protection, webhook secret, channel auto-ingest, "Retrieve from Telegram",
 * proxied Telegram playback with Range, the 20 MB limit, token secrecy.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const { startServer, Client, freePort } = require('./helpers');

const TOKEN = '123456:TEST_fake_token_ABCDEFGHIJKLMNOPQRSTU';
const SECRET = 'webhook_secret_for_tests_123456';
const CHANNEL = '-1001234567890';
const FILE = Buffer.alloc(300 * 1024, 7); // 300 KB fake mp4 bytes
const calls = [];
let mock; let srv; let admin; let bob; let mockPort;

function mockApi() {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url.startsWith(`/file/bot${TOKEN}/`)) {
        const range = req.headers.range;
        if (range) {
          const [s, e] = range.replace('bytes=', '').split('-').map((x) => (x === '' ? undefined : Number(x)));
          const start = s || 0; const end = Math.min(e ?? FILE.length - 1, FILE.length - 1);
          res.writeHead(206, { 'content-type': 'video/mp4', 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${FILE.length}`, 'accept-ranges': 'bytes' });
          return res.end(FILE.subarray(start, end + 1));
        }
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': FILE.length, 'accept-ranges': 'bytes' });
        return res.end(FILE);
      }
      const m = req.url.match(/^\/bot([^/]+)\/(\w+)$/);
      if (!m || m[1] !== TOKEN) { res.writeHead(401); return res.end(JSON.stringify({ ok: false, description: 'Unauthorized' })); }
      const method = m[2]; const p = body ? JSON.parse(body) : {};
      calls.push({ method, p });
      const ok = (result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result })); };
      switch (method) {
        case 'getMe': return ok({ id: 1, is_bot: true, username: 'TeraplayzTestBot' });
        case 'getFile': return ok({ file_id: p.file_id, file_size: FILE.length, file_path: 'videos/file_1.mp4' });
        case 'forwardMessage':
          if (p.message_id === 404) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, description: 'Bad Request: message to forward not found' })); }
          return ok({ message_id: 9000 + p.message_id, chat: { id: Number(CHANNEL), type: 'channel' },
            video: p.message_id === 77
              ? { file_id: 'BAACAgBIGFILEID_oversized_0000000', file_unique_id: 'AgADbig', duration: 3600, width: 1920, height: 1080, mime_type: 'video/mp4', file_size: 900 * 1024 * 1024 }
              : { file_id: 'BAACAgFILEID_lookup_000000000000', file_unique_id: 'AgADlook', duration: 42, width: 1280, height: 720, mime_type: 'video/mp4', file_size: FILE.length, thumbnail: { file_id: 'AAMCthumb_lookup_00000000' } },
            caption: 'Looked Up Title\nLooked up description' });
        case 'createInvoiceLink': return ok('https://t.me/$TESTINVOICE');
        case 'deleteMessage': case 'sendMessage': case 'sendInvoice': case 'answerPreCheckoutQuery': case 'setWebhook': case 'setMyCommands': return ok(true);
        case 'getWebhookInfo': return ok({ url: '', pending_update_count: 0 });
        default: return ok(true);
      }
    });
  });
}

const hook = (update, secret = SECRET) => fetch(srv.base + '/telegram/webhook', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret }, body: JSON.stringify(update),
});
const db = () => new (require('better-sqlite3'))(path.join(srv.dataDir, 'teraplayz.db'));
const q = (sql, ...a) => { const d = db(); const r = d.prepare(sql).get(...a); d.close(); return r; };

test.before(async () => {
  mockPort = await freePort();
  mock = mockApi();
  await new Promise((r) => mock.listen(mockPort, '127.0.0.1', r));
  srv = await startServer({
    TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHANNEL_ID: CHANNEL, TELEGRAM_WEBHOOK_SECRET: SECRET,
    TELEGRAM_API_ROOT: `http://127.0.0.1:${mockPort}`, TELEGRAM_MAX_FILE_MB: '20', PUBLIC_BASE_URL: 'https://teraplayz.example',
  });
  admin = new Client(srv.base);
  bob = new Client(srv.base);
});
test.after(async () => { await srv.stop(); mock.close(); });

test('telegram mode starts with empty catalogue (no demo seed) and healthz ok', async () => {
  assert.equal((await fetch(srv.base + '/healthz')).status, 200);
  assert.equal(q('SELECT COUNT(*) AS n FROM videos').n, 0);
  assert.match(srv.log(), /Telegram enabled/);
});

test('webhook rejects missing/wrong secret', async () => {
  assert.equal((await hook({ update_id: 1 }, 'nope')).status, 401);
  const r = await fetch(srv.base + '/telegram/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401);
});

test('channel post auto-ingests a draft video (metadata only)', async () => {
  const r = await hook({ update_id: 2, channel_post: { message_id: 55, chat: { id: Number(CHANNEL), type: 'channel' }, caption: 'Channel Upload One\nA nature clip',
    video: { file_id: 'BAACAgCHANNELFILE_55_000000000000', file_unique_id: 'AgADch55', duration: 30, width: 1280, height: 720, mime_type: 'video/mp4', file_size: FILE.length, thumbnail: { file_id: 'AAMCthumb55_000000000000' } } } });
  assert.equal(r.status, 200);
  const v = q('SELECT * FROM videos WHERE telegram_message_id = 55');
  assert.ok(v);
  assert.equal(v.title, 'Channel Upload One');
  assert.equal(v.is_published, 0, 'ingested as draft');
  assert.equal(v.telegram_file_id, 'BAACAgCHANNELFILE_55_000000000000');
  // duplicate ignored
  await hook({ update_id: 3, channel_post: { message_id: 56, chat: { id: Number(CHANNEL), type: 'channel' }, video: { file_id: 'BAACAgCHANNELFILE_55_000000000000', file_unique_id: 'AgADch55', file_size: 10 } } });
  assert.equal(q("SELECT COUNT(*) AS n FROM videos WHERE telegram_file_unique_id = 'AgADch55'").n, 1);
  // posts from other chats ignored
  await hook({ update_id: 4, channel_post: { message_id: 1, chat: { id: -100999, type: 'channel' }, video: { file_id: 'BAACAgOTHER_000000000000000', file_unique_id: 'AgADother', file_size: 10 } } });
  assert.equal(q("SELECT COUNT(*) AS n FROM videos WHERE telegram_file_unique_id = 'AgADother'").n, 0);
});

test('admin: Retrieve from Telegram, create, publish; playback proxies Telegram with Range and never leaks the token', async () => {
  await admin.login('admin', 'Tpz-Admin-Test-2026!x9');
  await admin.csrf('/admin/videos/new');
  const look = await admin.postJson('/admin/api/telegram/lookup', { message_id: 12 });
  assert.equal(look.status, 200);
  assert.equal(look.json_.media.file_id, 'BAACAgFILEID_lookup_000000000000');
  assert.ok(calls.some((c) => c.method === 'forwardMessage' && c.p.from_chat_id === CHANNEL && c.p.message_id === 12));
  assert.ok(calls.some((c) => c.method === 'deleteMessage' && c.p.message_id === 9012), 'temporary forward cleaned up');
  const miss = await admin.postJson('/admin/api/telegram/lookup', { message_id: 404 });
  assert.equal(miss.status, 502);

  // Create with only the message id: server fetches file metadata automatically.
  const fd = new FormData();
  for (const [k, v] of Object.entries({ title: 'Telegram Hosted Film', description: 'Stored in a private channel', source_type: 'telegram', telegram_message_id: '12', is_published: '1' })) fd.append(k, v);
  const c = await admin.postMultipart('/admin/videos', fd);
  assert.equal(c.status, 302, c.text_.slice(0, 400));
  const v = q("SELECT * FROM videos WHERE title = 'Telegram Hosted Film'");
  assert.equal(v.telegram_file_id, 'BAACAgFILEID_lookup_000000000000');
  assert.equal(v.duration, 42);
  assert.equal(v.telegram_thumb_file_id, 'AAMCthumb_lookup_00000000');

  const w = await new Client(srv.base).get('/watch/' + v.slug);
  assert.equal(w.status, 200);
  assert.ok(!w.text_.includes(TOKEN) && !w.text_.includes('api.telegram') && !w.text_.includes(CHANNEL), 'no token/channel in HTML');
  assert.match(w.text_, new RegExp(`src="/stream/${v.id}"`));
  const s = await fetch(`${srv.base}/stream/${v.id}`, { headers: { range: 'bytes=100-1123' } });
  assert.equal(s.status, 206);
  assert.equal(s.headers.get('content-range'), `bytes 100-1123/${FILE.length}`);
  const buf = Buffer.from(await s.arrayBuffer());
  assert.equal(buf.length, 1024);
  for (const [k, val] of s.headers) assert.ok(!String(val).includes(TOKEN), 'token leaked in header ' + k);
  const full = await fetch(`${srv.base}/stream/${v.id}`);
  assert.equal(full.status, 200);
  assert.equal((await full.arrayBuffer()).byteLength, FILE.length);
  const th = await fetch(`${srv.base}/thumb/${v.id}`, { redirect: 'manual' });
  assert.equal(th.status, 200);
  assert.match(th.headers.get('cache-control'), /max-age=86400/);
  await th.arrayBuffer();
  assert.ok(!srv.log().includes(TOKEN), 'token never logged');
});

test('files above the 20 MB Bot API limit are saved with a warning and refused for playback', async () => {
  await admin.csrf('/admin/videos/new');
  const fd = new FormData();
  for (const [k, v] of Object.entries({ title: 'Huge Upload', source_type: 'telegram', telegram_message_id: '77', is_published: '1' })) fd.append(k, v);
  const c = await admin.postMultipart('/admin/videos', fd);
  assert.equal(c.status, 302);
  const v = q("SELECT * FROM videos WHERE title = 'Huge Upload'");
  const s = await fetch(`${srv.base}/stream/${v.id}`);
  assert.equal(s.status, 413);
  const w = await admin.get('/watch/' + v.slug);
  assert.match(w.text_, /larger than the Telegram Bot API download limit/);
  const dash = await admin.get('/admin');
  assert.match(dash.text_, /exceed the 20 MB Bot API download limit/);
});

test('Stars flow: link Telegram, invoice, pre_checkout validation, verified payment grants 31 days, replay is ignored', async () => {
  await bob.csrf('/register');
  await bob.post('/register', { username: 'bob', password: 'Bob-pass-12345', password_confirm: 'Bob-pass-12345' });
  const bobId = q("SELECT id FROM users WHERE username='bob'").id;

  // Browser cannot grant premium: there is no client-facing "paid" endpoint.
  await bob.csrf('/premium');
  for (const p of ['/premium/success', '/api/premium/confirm', '/premium/paid']) {
    const r = await bob.post(p, { paid: 'true', telegram_payment_charge_id: 'forged' });
    assert.equal(r.status, 404);
  }
  assert.equal(q('SELECT premium_until FROM users WHERE id = ?', bobId).premium_until, null);

  // Checkout before linking -> redirected with a warning
  const early = await bob.post('/premium/checkout');
  assert.equal(early.status, 302);

  // Step 1: link
  const link = await bob.post('/premium/link');
  assert.equal(link.status, 200);
  const token = link.text_.match(/start=link_([A-Za-z0-9]{20})/)[1];
  const TG_BOB = 5550001;
  await hook({ update_id: 10, message: { message_id: 1, chat: { id: TG_BOB, type: 'private' }, from: { id: TG_BOB, username: 'bob_tg' }, text: `/start link_${token}` } });
  const linked = q('SELECT telegram_id, telegram_username FROM users WHERE id = ?', bobId);
  assert.equal(linked.telegram_id, TG_BOB);
  assert.equal(linked.telegram_username, 'bob_tg');
  // token is single-use
  await hook({ update_id: 11, message: { message_id: 2, chat: { id: 777, type: 'private' }, from: { id: 777 }, text: `/start link_${token}` } });
  assert.equal(q('SELECT telegram_id FROM users WHERE id = ?', bobId).telegram_id, TG_BOB);

  // Step 2: checkout -> invoice link + sendInvoice in XTR for 100
  await bob.csrf('/premium');
  const co = await bob.post('/premium/checkout');
  assert.equal(co.status, 200);
  assert.match(co.text_, /https:\/\/t\.me\/\$TESTINVOICE/);
  const inv = calls.filter((c) => c.method === 'sendInvoice').pop();
  assert.equal(inv.p.chat_id, TG_BOB);
  assert.equal(inv.p.currency, 'XTR');
  assert.deepEqual(inv.p.prices, [{ label: 'Premium (1 month)', amount: 100 }]);
  assert.equal(inv.p.provider_token, undefined);
  const payload = inv.p.payload;

  // pre_checkout: wrong amount rejected, wrong payer rejected, correct accepted
  await hook({ update_id: 12, pre_checkout_query: { id: 'pcq1', from: { id: TG_BOB }, currency: 'XTR', total_amount: 1, invoice_payload: payload } });
  assert.equal(calls.filter((c) => c.method === 'answerPreCheckoutQuery').pop().p.ok, false);
  await hook({ update_id: 13, pre_checkout_query: { id: 'pcq2', from: { id: 999 }, currency: 'XTR', total_amount: 100, invoice_payload: payload } });
  assert.equal(calls.filter((c) => c.method === 'answerPreCheckoutQuery').pop().p.ok, false);
  await hook({ update_id: 14, pre_checkout_query: { id: 'pcq3', from: { id: TG_BOB }, currency: 'XTR', total_amount: 100, invoice_payload: 'tpz_unknown' } });
  assert.equal(calls.filter((c) => c.method === 'answerPreCheckoutQuery').pop().p.ok, false);
  await hook({ update_id: 15, pre_checkout_query: { id: 'pcq4', from: { id: TG_BOB }, currency: 'XTR', total_amount: 100, invoice_payload: payload } });
  const ans = calls.filter((c) => c.method === 'answerPreCheckoutQuery').pop().p;
  assert.equal(ans.pre_checkout_query_id, 'pcq4'); assert.equal(ans.ok, true);

  // Still not premium until Telegram confirms
  assert.equal(q('SELECT premium_until FROM users WHERE id = ?', bobId).premium_until, null);

  // successful_payment (server-side verification from webhook only)
  const before = Date.now();
  const sp = { currency: 'XTR', total_amount: 100, invoice_payload: payload, telegram_payment_charge_id: 'stxCHARGE001', provider_payment_charge_id: '' };
  const pr = await hook({ update_id: 16, message: { message_id: 3, chat: { id: TG_BOB, type: 'private' }, from: { id: TG_BOB }, successful_payment: sp } });
  assert.equal(pr.status, 200);
  const u1 = q('SELECT premium_until FROM users WHERE id = ?', bobId);
  const days = (u1.premium_until - before) / 864e5;
  assert.ok(days > 30.99 && days < 31.01, 'expiry = now + 31 days, got ' + days);
  assert.equal(q("SELECT status FROM invoices WHERE payload = ?", payload).status, 'paid');

  // replay of the same charge id does nothing
  await hook({ update_id: 17, message: { message_id: 4, chat: { id: TG_BOB, type: 'private' }, from: { id: TG_BOB }, successful_payment: sp } });
  assert.equal(q('SELECT premium_until FROM users WHERE id = ?', bobId).premium_until, u1.premium_until);
  assert.equal(q('SELECT COUNT(*) AS n FROM payments').n, 1);

  // paid invoice cannot be pre-checked-out again
  await hook({ update_id: 18, pre_checkout_query: { id: 'pcq5', from: { id: TG_BOB }, currency: 'XTR', total_amount: 100, invoice_payload: payload } });
  assert.equal(calls.filter((c) => c.method === 'answerPreCheckoutQuery').pop().p.ok, false);

  // UI reflects premium: badge, no ads, status API
  const home = await bob.get('/');
  assert.match(home.text_, /class="badge-premium"/);
  assert.doesNotMatch(home.text_, /class="ad-slot/);
  const st = await (await bob.req('/api/premium/status')).json();
  assert.equal(st.premium, true);

  // Renewal via /premium in Telegram extends from current expiry
  await hook({ update_id: 19, message: { message_id: 5, chat: { id: TG_BOB, type: 'private' }, from: { id: TG_BOB }, text: '/premium' } });
  const inv2 = calls.filter((c) => c.method === 'sendInvoice').pop().p;
  assert.notEqual(inv2.payload, payload);
  await hook({ update_id: 20, message: { message_id: 6, chat: { id: TG_BOB, type: 'private' }, from: { id: TG_BOB }, successful_payment: { ...sp, invoice_payload: inv2.payload, telegram_payment_charge_id: 'stxCHARGE002' } } });
  const u2 = q('SELECT premium_until FROM users WHERE id = ?', bobId);
  assert.equal(Math.round((u2.premium_until - u1.premium_until) / 864e5), 31);

  // Cancel = stop renewal intent; premium stays until expiry
  await bob.csrf('/premium');
  await bob.post('/premium/cancel');
  const u3 = q('SELECT premium_until, premium_auto_renew FROM users WHERE id = ?', bobId);
  assert.equal(u3.premium_auto_renew, 0);
  assert.equal(u3.premium_until, u2.premium_until);
  assert.match((await bob.get('/premium')).text_, /Renewal is cancelled/);

  // Admin payments page lists both charges
  const pay = await admin.get('/admin/payments');
  assert.match(pay.text_, /stxCHARGE001/); assert.match(pay.text_, /stxCHARGE002/);
});

test('non-XTR or under-priced successful_payment is rejected', async () => {
  const before = q('SELECT COUNT(*) AS n FROM payments').n;
  await hook({ update_id: 30, message: { message_id: 7, chat: { id: 5550001, type: 'private' }, from: { id: 5550001 }, successful_payment: { currency: 'USD', total_amount: 100, invoice_payload: 'x', telegram_payment_charge_id: 'usd1' } } });
  await hook({ update_id: 31, message: { message_id: 8, chat: { id: 5550001, type: 'private' }, from: { id: 5550001 }, successful_payment: { currency: 'XTR', total_amount: 5, invoice_payload: 'x', telegram_payment_charge_id: 'cheap1' } } });
  assert.equal(q('SELECT COUNT(*) AS n FROM payments').n, before);
});

test('admin can forward a video to the bot from linked Telegram to create a draft', async () => {
  const adminId = q("SELECT id FROM users WHERE username='admin'").id;
  const d = db(); d.prepare('UPDATE users SET telegram_id = 4242 WHERE id = ?').run(adminId); d.close();
  await hook({ update_id: 40, message: { message_id: 9, chat: { id: 4242, type: 'private' }, from: { id: 4242 },
    forward_origin: { type: 'channel', chat: { id: Number(CHANNEL), type: 'channel' }, message_id: 321 },
    video: { file_id: 'BAACAgFORWARDED_321_00000000000', file_unique_id: 'AgADfw321', duration: 12, mime_type: 'video/mp4', file_size: 1000 }, caption: 'Forwarded Film' } });
  const v = q("SELECT * FROM videos WHERE telegram_file_unique_id = 'AgADfw321'");
  assert.ok(v); assert.equal(v.telegram_message_id, 321); assert.equal(v.is_published, 0);
  // a non-admin forwarding is ignored
  await hook({ update_id: 41, message: { message_id: 10, chat: { id: 5550001, type: 'private' }, from: { id: 5550001 }, video: { file_id: 'BAACAgNOTADMIN_0000000000000', file_unique_id: 'AgADnope', file_size: 10 } } });
  assert.equal(q("SELECT COUNT(*) AS n FROM videos WHERE telegram_file_unique_id = 'AgADnope'").n, 0);
});

test('admin Telegram page + webhook registration use setWebhook with secret_token', async () => {
  const p = await admin.get('/admin/telegram');
  assert.equal(p.status, 200);
  assert.ok(!p.text_.includes(TOKEN) && !p.text_.includes(CHANNEL));
  await admin.csrf('/admin/telegram');
  await admin.post('/admin/telegram/webhook');
  const sw = calls.filter((c) => c.method === 'setWebhook').pop();
  assert.equal(sw.p.url, 'https://teraplayz.example/telegram/webhook');
  assert.equal(sw.p.secret_token, SECRET);
  assert.ok(sw.p.allowed_updates.includes('pre_checkout_query'));
});
