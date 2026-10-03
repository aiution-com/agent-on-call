# syntax=docker/dockerfile:1

# ---- build -------------------------------------------------------------------
# Everything needed to compile TypeScript, thrown away afterwards.
FROM node:24-alpine AS build
WORKDIR /app

# Copied first so that a source change does not invalidate the dependency layer.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime -----------------------------------------------------------------
# Carries the compiled output and production dependencies only: no source, no
# TypeScript, no test files, no build tooling.
FROM node:24-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY public ./public
COPY migrations ./migrations
COPY scripts ./scripts
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh

RUN chmod +x /usr/local/bin/entrypoint.sh \
 && chown -R node:node /app

# node:24-alpine ships an unprivileged `node` user; nothing here needs root.
USER node

EXPOSE 3000

# The app's own /health endpoint returns 503 when the database is unreachable,
# so this reports whether the container can actually serve, not merely that the
# process is alive.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/index.js"]
