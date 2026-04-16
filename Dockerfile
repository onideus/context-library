# Stage 1: Build
FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Stage 2: Production
FROM node:22-slim

WORKDIR /app

RUN groupadd --system appgroup && useradd --system --gid appgroup appuser

COPY --chown=appuser:appgroup package.json package-lock.json ./

# Install production deps, then strip npm from the image. The runtime starts
# `node dist/server.js` and never invokes npm, so shipping npm only adds
# attack surface — every npm release bundles vulnerable transitive deps
# (brace-expansion, minimatch, tar, picomatch…) that Snyk flags even though
# nothing at runtime imports them.
RUN npm ci --omit=dev && \
    npm cache clean --force && \
    rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm \
           /usr/local/bin/npx \
           /usr/local/bin/corepack \
           /root/.npm

COPY --chown=appuser:appgroup --from=builder /app/dist ./dist
COPY --chown=appuser:appgroup src/db/migrations ./dist/db/migrations

RUN mkdir -p /app/data && \
    chown -R appuser:appgroup /app/data

ARG APP_VERSION
ENV APP_VERSION=${APP_VERSION}

USER appuser

EXPOSE 3100

CMD ["node", "dist/server.js"]
