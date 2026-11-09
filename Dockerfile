# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------------
# TERAPLAYZ — production image (multi-stage, non-root, ~190 MB)
# Node 22 LTS: Node 20 reached end-of-life on 2026-04-30 and better-sqlite3 13
# requires Node >= 22. better-sqlite3 and sharp ship prebuilt musl binaries,
# so no compiler toolchain is needed.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data \
    # Keep V8 well inside Koyeb's 512 MB free instance.
    NODE_OPTIONS="--max-old-space-size=256"
RUN apk add --no-cache tini \
 && mkdir -p /app/data/thumbs \
 && chown -R node:node /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node src ./src
COPY --chown=node:node views ./views
COPY --chown=node:node public ./public
COPY --chown=node:node db ./db
COPY --chown=node:node scripts ./scripts
USER node
EXPOSE 3000
# SQLite database + disk thumbnails live here. Mount a volume, or set
# DATABASE_URL (managed Postgres) so nothing important is on local disk.
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=4s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1 || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
