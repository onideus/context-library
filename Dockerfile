# Stage 1: Build
FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Extract version for runtime ENV (avoids runtime fs read of package.json)
RUN node -e "console.log(require('./package.json').version)" > /tmp/version.txt

# Stage 2: Production
FROM node:22-slim

WORKDIR /app

RUN groupadd --system appgroup && useradd --system --gid appgroup appuser

COPY --chown=appuser:appgroup package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=appuser:appgroup --from=builder /app/dist ./dist
COPY --chown=appuser:appgroup src/db/migrations ./dist/db/migrations
COPY --from=builder /tmp/version.txt /tmp/version.txt

RUN mkdir -p /app/data && \
    chown -R appuser:appgroup /app/data

# Inject version so server.ts reads from env, not filesystem
ENV APP_VERSION=
RUN APP_VERSION=$(cat /tmp/version.txt | tr -d '\n') && \
    echo "APP_VERSION=$APP_VERSION" >> /etc/environment
ENV APP_VERSION=${APP_VERSION}

USER appuser

EXPOSE 3100

CMD ["node", "dist/server.js"]
