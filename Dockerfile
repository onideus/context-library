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

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY src/db/migrations ./dist/db/migrations

RUN chmod -R 644 /app/dist/db/migrations/*.sql && \
    mkdir -p /app/data && \
    chown -R appuser:appgroup /app/data /app/dist/db/migrations

USER appuser

EXPOSE 3100

CMD ["node", "dist/server.js"]
