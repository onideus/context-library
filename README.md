# Cognition Bridge

Persistent operational context for AI assistants via MCP. Stores handoff state, manages tasks, and provides semantic search over accumulated history.

## Architecture

- **Server:** Hono 4.x + StreamableHTTP MCP transport (Node.js 22, TypeScript)
- **Database:** PostgreSQL 16 with pgvector for semantic search
- **Embeddings:** Text Embeddings Inference (TEI) with nomic-embed-text-v2-moe (768 dims)
- **Auth:** Auth0 RS256 JWT validation
- **Deployment:** Docker Compose on NAS, Cloudflare Tunnel for external access

## MCP Tools

| Tool | Description |
|---|---|
| `store_handoff` | Full-state capture at session boundaries (append-only) |
| `get_latest_handoff` | Retrieve most recent handoff with pre-computed fields |
| `patch_handoff` | Partial update with merge semantics |
| `create_task` | Create task with scope, priority, tags, dates |
| `get_task` | Retrieve task by UUID |
| `list_tasks` | Paginated filtering with status, scope, priority, tags |
| `update_task` | Field updates + lifecycle actions (complete/cancel/defer/reopen) |
| `search_tasks` | Full-text search with PostgreSQL FTS |
| `search_context` | Hybrid semantic search (vector + FTS with RRF fusion) |
| `reindex` | Rebuild semantic search index |

## Quick Start

### Prerequisites

- Docker and Docker Compose
- An Auth0 tenant (or use `SKIP_AUTH=true` for local dev)
- TEI embedding server (optional — degrades gracefully without it)

### Setup

```bash
git clone <repo-url>
cd cognition-bridge
cp .env.example .env
# Edit .env with your Auth0 credentials and Postgres password
```

### Run with Docker

```bash
docker compose up -d
```

This starts PostgreSQL, Cognition Bridge, the auth proxy, and Cloudflare Tunnel.

### Local Development

```bash
npm install
npm run dev          # Start with hot reload (tsx watch)
npm test             # Run test suite
npm run build        # TypeScript compile
```

## Deployment

```bash
git pull
docker compose build --no-cache
docker compose up -d
```

The Docker build uses multi-stage node:22-slim images. The production container runs as non-root (`appuser`).

## Environment Variables

See `.env.example` for all configuration options. Key variables:

- `AUTH0_DOMAIN` / `AUTH0_AUDIENCE` — Auth0 tenant configuration
- `SKIP_AUTH` — Set `true` for local dev only. **NEVER true in production.**
- `PGHOST` / `PGPASSWORD` / `PGDATABASE` — PostgreSQL connection
- `EMBEDDING_URL` — TEI server endpoint
- `MCP_PORT` — Server port (default: 3100)

## License

MIT
