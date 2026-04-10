# Context Library

A personal MCP server that provides persistent operational context, task management, and semantic search across AI assistant sessions. Model-agnostic, Docker-ready, designed for single-user cognitive infrastructure.

## What It Does

AI assistants lose all context between conversations. Context Library solves this by providing MCP tools that any compatible assistant can use to store and retrieve operational state, track tasks, and search across accumulated history.

The server name is configurable via the `SERVER_NAME` environment variable (default: `context-library`). Name it whatever fits your mental model.

## Deployment Tiers

Context Library is designed to be deployed incrementally. Each tier adds functionality on top of the previous one, using Docker Compose file stacking.

### Tier 1: Core (Handoffs Only)

The simplest deployment. Stores and retrieves operational context as append-only JSON files. No database required.

```bash
docker compose up -d
```

**Available tools:** `store_handoff`, `get_latest_handoff`, `patch_handoff`

### Tier 2: + PostgreSQL (Tasks + Full-Text Search)

Adds structured task management with full-text search. Requires PostgreSQL 16 with pgvector.

```bash
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d
```

**Additional tools:** `create_task`, `get_task`, `list_tasks`, `update_task`, `search_tasks`

### Tier 3: + Embeddings (Semantic Search)

Adds vector-based semantic search across all stored content using a Text Embeddings Inference (TEI) server.

```bash
docker compose -f docker-compose.yml -f docker-compose.postgres.yml -f docker-compose.embeddings.yml up -d
```

**Additional tools:** `search_context`, `reindex`

The TEI server can run on a separate machine — just point `EMBEDDING_URL` to its address. This is the recommended setup if your main server doesn't have a GPU.

#### Embedding Server Platform Options

| Platform | Method | GPU Acceleration |
|---|---|---|
| **Linux/Windows (NVIDIA GPU)** | Docker: `ghcr.io/huggingface/text-embeddings-inference:cuda-1.9` | CUDA (compute capability 7.5+) |
| **Linux/Windows (no GPU)** | Docker: `ghcr.io/huggingface/text-embeddings-inference:cpu-1.9` | None (CPU only, slower) |
| **macOS Apple Silicon** | Native: `brew install huggingface/tap/tei` | Metal (via native binary only) |

> **Apple Silicon note:** macOS does not support GPU passthrough into Docker containers. Running TEI in Docker on M-series Macs will be CPU-bound and slow. For GPU acceleration, install TEI natively via Homebrew and run it outside of Docker:
>
> ```bash
> brew install huggingface/tap/tei
> text-embeddings-router --model-id nomic-ai/nomic-embed-text-v2-moe --port 8090
> ```
>
> Then set `EMBEDDING_URL=http://host.docker.internal:8090` (Docker) or `EMBEDDING_URL=http://localhost:8090` (local dev) so Context Library can reach it.

## Architecture

- **Server:** Hono 4.x + StreamableHTTP MCP transport (Node.js 22, TypeScript)
- **Storage (Tier 1):** Append-only JSON files in `./data/handoffs/`
- **Database (Tier 2):** PostgreSQL 16 with pgvector extension
- **Embeddings (Tier 3):** Text Embeddings Inference with nomic-embed-text-v2-moe (768 dims)
- **Auth:** Handled externally by [mcp-auth-proxy](https://github.com/sigbit/mcp-auth-proxy) — the server itself is unauthenticated and trusts its network boundary

Each component degrades gracefully when unavailable. If Postgres is down, handoffs still work. If the embedding server is unreachable, task search still works via full-text search.

## MCP Tools

| Tool | Tier | Description |
|---|---|---|
| `store_handoff` | Core | Full-state capture at session boundaries (append-only) |
| `get_latest_handoff` | Core | Retrieve most recent handoff with pre-computed fields |
| `patch_handoff` | Core | Partial update with merge semantics |
| `create_task` | Postgres | Create task with scope, priority, tags, dates |
| `get_task` | Postgres | Retrieve task by UUID |
| `list_tasks` | Postgres | Paginated filtering with status, scope, priority, tags |
| `update_task` | Postgres | Field updates + lifecycle actions (complete/cancel/defer/reopen) |
| `search_tasks` | Postgres | Full-text search with PostgreSQL FTS |
| `search_context` | Embeddings | Hybrid semantic search (vector + FTS with RRF fusion) |
| `reindex` | Embeddings | Rebuild semantic search index |

## Quick Start

### Prerequisites

- Docker and Docker Compose
- For external access: an OIDC provider (Auth0, Google, etc.) and a domain with a Cloudflare Tunnel
- For Tier 3 embeddings: an NVIDIA GPU (Linux/Windows), or Apple Silicon Mac with Homebrew, or any CPU (slower)

### Setup

```bash
git clone https://github.com/onideus/context-library.git
cd context-library
cp .env.example .env
# Edit .env with your configuration
```

### Local Development

```bash
npm install
npm run dev          # Start with hot reload (tsx watch)
npm test             # Run test suite
npm run build        # TypeScript compile
```

## Security

This server holds personal operational data — handoff state, tasks, execution logs. It is designed to run behind a reverse proxy that handles authentication. **Never expose the MCP server directly to the internet.**

For external access, use mcp-auth-proxy (included in the auth compose overlay) which handles OAuth 2.1 (DCR, authorization, token exchange) before forwarding authenticated requests to the server. Route external traffic through the proxy via Cloudflare Tunnel or your preferred reverse proxy.

## Environment Variables

See `.env.example` for all configuration options.

### Core

| Variable | Default | Description |
|---|---|---|
| `SERVER_NAME` | `context-library` | MCP server name (visible to LLM clients as the tool namespace) |
| `MCP_PORT` | `3100` | Server port |
| `DATA_DIR` | `./data` | Handoff file storage path |
| `RETENTION_COUNT` | `5000` | Max handoff files to retain |

### PostgreSQL (Tier 2)

| Variable | Default | Description |
|---|---|---|
| `PGHOST` | — | PostgreSQL host |
| `PGPORT` | `5432` | PostgreSQL port |
| `PGUSER` | — | PostgreSQL user |
| `PGPASSWORD` | — | PostgreSQL password |
| `PGDATABASE` | — | PostgreSQL database name |
| `POSTGRES_PASSWORD` | — | Root Postgres password (used by compose) |

### Embeddings (Tier 3)

| Variable | Default | Description |
|---|---|---|
| `EMBEDDING_URL` | `http://embeddings:80` | TEI server endpoint |
| `EMBEDDING_MODEL` | `nomic-ai/nomic-embed-text-v2-moe` | Embedding model name |
| `EMBEDDING_DIMENSIONS` | `768` | Embedding vector dimensions |

### Auth Proxy (External Access)

| Variable | Description |
|---|---|
| `AUTH0_ISSUER` | OIDC provider issuer URL |
| `AUTH0_CLIENT_ID` | OAuth client ID |
| `AUTH0_CLIENT_SECRET` | OAuth client secret |
| `ALLOWED_USERS` | Comma-separated list of authorized email addresses |
| `EXTERNAL_URL` | Public-facing URL (e.g., `https://your-domain.com`) |

## License

MIT
