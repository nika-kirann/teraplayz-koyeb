#!/usr/bin/env node
'use strict';
/**
 * One-off Telegram webhook helper (no long-polling worker needed).
 *   npm run telegram:webhook          -> setWebhook to PUBLIC_BASE_URL/telegram/webhook
 *   npm run telegram:webhook:info     -> getWebhookInfo
 *   npm run telegram:webhook:delete   -> deleteWebhook
 * Reads TELEGRAM_BOT_TOKEN, PUBLIC_BASE_URL, TELEGRAM_WEBHOOK_SECRET from env/.env.
 * Never prints the bot token.
 */
const config = require('../src/config');
const telegram = require('../src/telegram');

(async () => {
  if (!config.telegramEnabled) throw new Error('TELEGRAM_BOT_TOKEN is not set.');
  if (process.argv.includes('--info')) {
    const info = await telegram.call('getWebhookInfo');
    console.log(JSON.stringify(info, null, 2));
    return;
  }
  if (process.argv.includes('--delete')) {
    await telegram.call('deleteWebhook', { drop_pending_updates: false });
    console.log('Webhook deleted.');
    return;
  }
  if (!config.PUBLIC_BASE_URL || !/^https:\/\//.test(config.PUBLIC_BASE_URL)) throw new Error('PUBLIC_BASE_URL must be your public https:// URL (e.g. https://teraplayz-yourorg.koyeb.app).');
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(config.telegram.webhookSecret)) throw new Error('TELEGRAM_WEBHOOK_SECRET must be 16–256 chars of A–Z a–z 0–9 _ -');
  const me = await telegram.getMe();
  await telegram.call('setWebhook', {
    url: `${config.PUBLIC_BASE_URL}/telegram/webhook`,
    secret_token: config.telegram.webhookSecret,
    allowed_updates: ['message', 'channel_post', 'pre_checkout_query'],
    max_connections: 10,
    drop_pending_updates: false,
  });
  await telegram.call('setMyCommands', { commands: [
    { command: 'premium', description: `Get Premium (${config.premium.priceStars} Stars / month)` },
    { command: 'status', description: 'Check your membership' },
    { command: 'paysupport', description: 'Payment support' },
    { command: 'help', description: 'How TERAPLAYZ works' },
  ] }).catch(() => {});
  console.log(`Webhook set for @${me.username} -> ${config.PUBLIC_BASE_URL}/telegram/webhook`);
})().catch((e) => { console.error('Error:', e.message); process.exit(1); });
