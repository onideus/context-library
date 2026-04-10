# Context Library

A personal MCP server that provides persistent operational context, task management, and semantic search across AI assistant sessions. Model-agnostic, Docker-ready, designed for single-user cognitive infrastructure.

## What It Does

AI assistants lose all context between conversations. Context Library solves this by providing MCP tools that any compatible assistant can use to store and retrieve operational state, track tasks, and search across accumulated history.

The server name is configurable via the `SERVER_NAME` environment variable (default: `context-library`). Name it whatever fits your mental model.

## Architecture

- **Server:** Hono 4.x + StreamableHTTP MCP transport (Node.js 22, TypeScript)
- **Database:** PostgreSQL 16 with pgvector for semantic search
- **Embeddings:** Text Embeddings Inference (TEI) with nomic-embed-text-v2-moe (768 dims)
- **Auth:** Handled externally by [mcp-auth-proxy](https://github.com/sigbit/mcp-auth-proxy) — the server itself is unauthenticated and trusts its network boundary
- **Deployment:** Docker Compose with Cloudflare Tunnel for external access

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
- An OIDC provider (Auth0, Google, etc.) for authentication via mcp-auth-proxy
- TEI embedding server (optional — semantic search degrades gracefully without it)

### Setup

```bash
git clone https://github.com/onideus/context-library.git
cd context-library
cp .env.example .env
# Edit .env with your OIDC credentials and Postgres password
```

### Run with Docker

```bash
docker compose up -d
```

This starts PostgreSQL, the MCP server, the auth proxy, and Cloudflare Tunnel.

### Local Development

```bash
npm install
npm run dev          # Start with hot reload (tsx watch)
npm test             # Run test suite
npm run build        # TypeScript compile
```

## Security

This server holds personal operational data — handoff state, tasks, execution logs. It is designed to run behind a reverse proxy that handles authentication. **Never expose the MCP server directly to the internet.** The included `docker-compose.yml` routes all external traffic through mcp-auth-proxy, which handles OAuth 2.1 (DCR, authorization, token exchange) before forwarding authenticated requests to the server.

## Environment Variables

See `.env.example` for all configuration options. Key variables:

| Variable | Default | Description |
|---|---|---|
| `SERVER_NAME` | `context-library` | MCP server name (visible to LLM clients as the tool namespace) |
| `MCP_PORT` | `3100` | Server port |
| `DATA_DIR` | `./data` | Handoff file storage path |
| `RETENTION_COUNT` | `5000` | Max handoff files to retain |
| `PGHOST` / `PGPASSWORD` / `PGDATABASE` | — | PostgreSQL connection |
| `EMBEDDING_URL` | `http://embeddings:80` | TEI server endpoint |

Auth proxy configuration (see `docker-compose.yml`):

| Variable | Description |
|---|---|
| `AUTH0_ISSUER` | OIDC provider issuer URL |
| `AUTH0_CLIENT_ID` | OAuth client ID |
| `AUTH0_CLIENT_SECRET` | OAuth client secret |
| `ALLOWED_USERS` | Comma-separated list of authorized email addresses |
| `EXTERNAL_URL` | Public-facing URL (e.g., `https://your-domain.com`) |

## Deployment

```bash
git pull
docker compose build --no-cache
docker compose up -d
```

The Docker build uses multi-stage node:22-slim images. The production container runs as non-root (`appuser`).

## License

MIT
