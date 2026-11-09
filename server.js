'use strict';
const config = require('./src/config');
const db = require('./src/db');
const { bootstrap } = require('./src/seed');
const { createApp } = require('./src/app');

async function main() {
  const engine = await db.init();
  await bootstrap();
  const app = createApp();
  const server = app.listen(config.PORT, () => {
    console.log(`[teraplayz] listening on :${config.PORT} (${config.NODE_ENV}, db=${engine}, ${config.demoMode ? 'DEMO mode — Telegram not configured' : 'Telegram enabled'})`);
  });
  // Long-lived streaming responses: no global timeout, but drop idle sockets.
  server.requestTimeout = 0;
  server.headersTimeout = 30000;
  server.keepAliveTimeout = 65000;

  const shutdown = (sig) => {
    console.log(`[teraplayz] ${sig} received, shutting down`);
    server.close(() => db.close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (e) => console.error('[teraplayz] unhandledRejection:', require('./src/util').redact(e && e.stack || e)));

main().catch((e) => {
  console.error('[teraplayz] fatal startup error:', require('./src/util').redact(e && e.stack || e));
  process.exit(1);
});
