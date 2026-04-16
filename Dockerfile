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

# Apply Debian security patches to the base image (e.g. zlib1g)
RUN apt-get update && \
    apt-get upgrade -y && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Upgrade the npm bundled with node:22-slim to pick up fixes in its own
# transitive deps (brace-expansion, picomatch). The app does not run npm at
# runtime, but Snyk scans /usr/local/lib/node_modules.
RUN npm install -g --force npm@11.6.4

RUN groupadd --system appgroup && useradd --system --gid appgroup appuser

COPY --chown=appuser:appgroup package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=appuser:appgroup --from=builder /app/dist ./dist
COPY --chown=appuser:appgroup src/db/migrations ./dist/db/migrations

RUN mkdir -p /app/data && \
    chown -R appuser:appgroup /app/data

ARG APP_VERSION
ENV APP_VERSION=${APP_VERSION}

USER appuser

EXPOSE 3100

CMD ["node", "dist/server.js"]
