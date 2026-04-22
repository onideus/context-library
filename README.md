# Context Library

[![CI](https://github.com/onideus/context-library/actions/workflows/ci.yml/badge.svg)](https://github.com/onideus/context-library/actions/workflows/ci.yml)
[![Image Build](https://github.com/onideus/context-library/actions/workflows/image.yml/badge.svg)](https://github.com/onideus/context-library/actions/workflows/image.yml)
[![Release](https://img.shields.io/github/v/release/onideus/context-library)](https://github.com/onideus/context-library/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A personal MCP server that provides persistent operational context, task management, knowledge capture, artifact tracking, and semantic search across AI assistant sessions. Model-agnostic, Docker-ready, designed for single-user cognitive infrastructure.

## What It Does

AI assistants lose all context between conversations. Context Library solves this by providing MCP tools that any compatible assistant can use to store and retrieve operational state, track tasks, capture permanent knowledge, and search across accumulated history.

The server name is configurable via the `SERVER_NAME` environment variable (default: `context-library`). Name it whatever fits your mental model.

## Deployment Tiers

Context Library is designed to be deployed incrementally. Each tier adds functionality on top of the previous one, using Docker Compose file stacking.

### Tier 1: Core (Handoffs Only)

The simplest deployment. Stores and retrieves operational context as append-only JSON files. No database required.

```bash
docker compose up -d
```

**Available tools:** `store_handoff`, `get_latest_handoff`, `patch_handoff`, `list_handoffs`, `get_handoff`

> Handoff files are retained indefinitely by default. To enable automatic pruning of old handoffs, set `RETENTION_COUNT` to a positive number (e.g., `5000`).

### Tier 2: + PostgreSQL (Tasks + Knowledge + Artifacts + Full-Text Search)

Adds structured task management, permanent knowledge capture, generated-output tracking, and full-text search. Requires PostgreSQL 16 with pgvector.

```bash
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d
```

**Additional tools:** `create_task`, `get_task`, `list_tasks`, `update_task`, `search_tasks`, `create_note`, `get_note`, `list_notes`, `search_notes`, `update_note`, `delete_note`, `store_artifact`, `get_artifact`, `list_artifacts`, `search_artifacts`, `update_artifact`

### Tier 3: + Embeddings (Semantic Search)

Adds vector-based semantic search across all stored content using a Text Embeddings Inference (TEI) server. Use the `--profile` flag to select GPU or CPU runtime.

**GPU (desktop with NVIDIA GPU):**
```bash
docker compose -f docker-compose.yml -f docker-compose.postgres.yml -f docker-compose.embeddings.yml --profile embeddings-gpu up -d
```

**CPU (NAS or any machine without GPU):**
```bash
docker compose -f docker-compose.yml -f docker-compose.postgres.yml -f docker-compose.embeddings.yml --profile embeddings-cpu up -d
```

With no `--profile` flag, neither TEI service starts — the application degrades gracefully (semantic search falls back to FTS).

**Additional tools:** `search_context`, `reindex`

The TEI server can run on a separate machine — just point `EMBEDDING_URL` to its address. This is the recommended setup if your main server doesn't have a GPU.

#### Optional: Cross-Encoder Reranker

For improved retrieval precision, an optional cross-encoder reranker rescores candidates after RRF fusion. It runs as a second TEI instance:

```bash
# Add to your compose command:
--profile reranker-gpu   # or reranker-cpu
```

When the reranker is not configured or unreachable, `search_context` falls back to RRF-only ordering. Set `RERANKER_URL` in your `.env` to enable it.

#### Embedding Server Platform Options

| Platform | Profile / Method | GPU Acceleration |
|---|---|---|
| **Linux/Windows (NVIDIA GPU)** | `--profile embeddings-gpu` | CUDA (compute capability 7.5+) |
| **Linux/Windows (no GPU)** | `--profile embeddings-cpu` | None (CPU only, x86_64) |
| **Apple Silicon / ARM servers (Docker)** | `--profile embeddings-arm64` | None (CPU only, native ARM) |
| **macOS Apple Silicon (native)** | Homebrew: `text-embeddings-inference` | Metal (via native binary only) |

> **Apple Silicon note:** macOS does not support GPU passthrough into Docker containers. Running TEI in Docker on M-series Macs will be CPU-bound and slow. For CPU-only Docker deployment on Apple Silicon, use `--profile embeddings-arm64`. For Metal GPU acceleration, install TEI natively via Homebrew and run it outside of Docker:
>
> ```bash
> brew tap huggingface/tap
> brew install huggingface/tap/text-embeddings-inference
> text-embeddings-router --model-id nomic-ai/nomic-embed-text-v2-moe --port 8090
> ```
>
> Then set `EMBEDDING_URL=http://host.docker.internal:8090` (Docker) or `EMBEDDING_URL=http://localhost:8090` (local dev) so Context Library can reach it.

## Architecture

- **Server:** Hono 4.x + StreamableHTTP MCP transport (Node.js 22, TypeScript)
- **Storage (Tier 1):** Append-only JSON files in `./data/handoffs/`
- **Database (Tier 2):** PostgreSQL 16 with pgvector extension
- **Content primitives:** Handoffs (ephemeral session state), Tasks (lifecycle-managed action items), Notes (permanent knowledge — decisions, patterns, insights), Artifacts (generated outputs with lifecycle state and execution ordering)
- **Embeddings (Tier 3):** Text Embeddings Inference with nomic-embed-text-v2-moe (768 dims), optional cross-encoder reranker
- **Search:** Hybrid retrieval (vector + FTS with RRF fusion), optional cross-encoder reranking, entity-aware context envelopes, search alias expansion, date-range filtering
- **Auth:** Handled externally by [mcp-auth-proxy](https://github.com/sigbit/mcp-auth-proxy) — the server itself is unauthenticated and trusts its network boundary

Each component degrades gracefully when unavailable. If Postgres is down, handoffs still work. If the embedding server is unreachable, task, note, and artifact search still works via full-text search; failed embeddings are queued for automatic retry when TEI comes back.

## MCP Tools

| Tool | Tier | Description |
|---|---|---|
| `store_handoff` | Core | Full-state capture at session boundaries (append-only) |
| `get_latest_handoff` | Core | Retrieve most recent handoff with pre-computed fields |
| `patch_handoff` | Core | Partial update with merge semantics |
| `list_handoffs` | Core | Browse historical handoffs by date with metadata |
| `get_handoff` | Core | Retrieve a specific historical handoff by filename |
| `create_task` | Postgres | Create task with scope, priority, tags, dates |
| `get_task` | Postgres | Retrieve task by UUID |
| `list_tasks` | Postgres | Paginated filtering with status, scope, priority, tags |
| `update_task` | Postgres | Field updates + lifecycle actions (complete/cancel/defer/reopen) |
| `search_tasks` | Postgres | Full-text search with PostgreSQL FTS |
| `create_note` | Postgres | Capture permanent knowledge (decisions, patterns, insights) |
| `get_note` | Postgres | Retrieve note by UUID |
| `list_notes` | Postgres | Browse notes with scope, domain, and tag filters |
| `search_notes` | Postgres | Full-text search across note titles and content |
| `update_note` | Postgres | Update note fields; re-embeds on content change |
| `delete_note` | Postgres | Permanently delete a note and its embedding |
| `store_artifact` | Postgres | Capture a generated output (CC prompt, research, template) with lifecycle state |
| `get_artifact` | Postgres | Retrieve artifact by UUID (full content + pointer + metadata) |
| `list_artifacts` | Postgres | Browse artifacts with type, status, scope, and tag filters; execution_order-aware sort |
| `search_artifacts` | Postgres | Full-text search across artifact titles and content |
| `update_artifact` | Postgres | Update artifact fields; enforces status transitions; re-embeds on content change |
| `search_context` | Embeddings | Hybrid semantic search (vector + FTS with RRF fusion) across all content types |
| `reindex` | Embeddings | Rebuild semantic search index for handoffs, tasks, notes, and artifacts |

## Health Checks

The server exposes two health endpoints:

- **`GET /health`** — Basic liveness check. Returns server status, version, and uptime.
- **`GET /health/ready`** — Readiness check. Verifies the data directory is writable. Returns `"ok"` or `"degraded"` accordingly.

Both return JSON. Use `/health` for uptime monitoring and `/health/ready` after deployment to confirm the server can write data.

```bash
curl http://localhost:3100/health
# {"status":"ok","version":"0.7.1","uptime":42}

curl http://localhost:3100/health/ready
# {"status":"ok","archive":true,"uptime":42}
```

## Quick Start

### Prerequisites

- Docker and Docker Compose
- For local development without Docker: Node.js 22+
- For external access: an OIDC provider (Auth0, Google, etc.) and a reverse proxy or tunnel
- For Tier 3 embeddings: an NVIDIA GPU (Linux/Windows), or Apple Silicon Mac with Homebrew, or any CPU (slower)

### Setup

```bash
git clone https://github.com/onideus/context-library.git
cd context-library
cp .env.example .env
# Edit .env with your configuration
```

> **Data directory ownership:** The container runs as `appuser` (UID 999). If you're migrating data from an existing deployment or running on a NAS, ensure the `data/` directory is owned by the correct UID:
>
> ```bash
> sudo chown -R 999:999 ./data
> ```
>
> Without this, the server will fail with `EACCES: permission denied` when writing handoff files. The `proxy-data/` and `proxy-certs/` directories (used by `mcp-auth-proxy`) do not need this — the proxy runs as root.

### Local Development

```bash
npm install
npm run dev          # Start with hot reload (tsx watch)
npm test             # Run test suite
npm run build        # TypeScript compile
```

The server starts on `http://localhost:3100` by default. The MCP endpoint is at `http://localhost:3100/mcp`. Verify it's running:

```bash
curl http://localhost:3100/health
```

## Connecting MCP Clients

Once Context Library is running (either via `npm run dev` or Docker), you can connect any MCP-compatible client. The server uses **Streamable HTTP** transport on a single endpoint: `http://localhost:3100/mcp`.

### Roo Code (VS Code)

Roo Code is the most common local setup. Open your MCP settings (click the MCP icon in the Roo Code panel, then **Edit Global MCP** or **Edit Project MCP**) and add:

```json
{
  "mcpServers": {
    "context-library": {
      "type": "streamable-http",
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

For project-level configuration, create `.roo/mcp.json` in your project root with the same content. Project-level configs override global settings and can be committed to version control so your whole team shares the same MCP setup.

Save the file and Context Library should appear in the MCP servers list with a connected status. Roo Code will discover all available tools automatically.

### Claude Code (Terminal)

```bash
claude mcp add context-library --transport http http://localhost:3100/mcp
```

This registers the server globally. Claude Code will connect on next launch.

### Claude Desktop

Add to your Claude Desktop config file:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
**Windows (Store):** `%LOCALAPPDATA%\Packages\Claude_<hash>\LocalCache\Roaming\Claude\claude_desktop_config.json`

Claude Desktop does not natively support remote HTTP MCP servers. Use [mcp-remote](https://github.com/geelen/mcp-remote) as a stdio bridge:

```json
{
  "mcpServers": {
    "context-library": {
      "command": "npx",
      "args": ["mcp-remote", "http://localhost:3100/mcp"]
    }
  }
}
```

Restart Claude Desktop after saving.

### Claude.ai (Hosted)

Claude.ai requires the server to be publicly accessible with OAuth authentication. See [External Access with Auth Proxy](#external-access-with-auth-proxy) below.

### Other MCP Clients

Any client that supports Streamable HTTP transport can connect to `http://localhost:3100/mcp`. This includes VS Code with GitHub Copilot, Cursor, Windsurf, Continue, and others. Consult your client's documentation for the MCP server configuration format — typically you need to specify the URL and transport type (`streamable-http` or `streamableHttp` depending on the client).

### Verifying the Connection

After connecting, ask your AI assistant to call `get_latest_handoff`. If it returns a handoff (or an empty-state response on first use), the connection is working. You can also hit the health endpoint directly:

```bash
curl http://localhost:3100/health
# {"status":"ok","version":"0.7.1","uptime":42}
```

## External Access with Auth Proxy

To expose Context Library to the internet (required for Claude.ai and other hosted MCP clients), use the auth compose overlay. It bundles [mcp-auth-proxy](https://github.com/sigbit/mcp-auth-proxy) (OAuth 2.1 gateway) and a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) connector so the full ingress chain is managed as a single stack:

```
Internet → cloudflared → mcp-auth-proxy:443 → context-library:3100
```

### Auth Proxy Setup

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.postgres.yml \
  -f docker-compose.auth.yml \
  up -d
```

For deployments that also need embeddings, add `-f docker-compose.embeddings.yml --profile embeddings-cpu` (or `embeddings-gpu`).

**Required setup:**

1. **OIDC Provider (Auth0 example):**
   - Create a Regular Web Application (must be **first-party**, not third-party — third-party apps can't enable connections)
   - Enable a social connection (e.g., GitHub) on the application
   - Set the callback URL to: `https://YOUR_DOMAIN/.auth/oidc/callback`
   - Copy the Client ID, Client Secret, and Issuer URL to your `.env`

2. **TLS Certificates:**
   The auth proxy requires TLS certificates in `./proxy-certs/` (as `cert.pem` and `key.pem`), even if your tunnel handles external TLS termination. For self-signed certs:
   ```bash
   mkdir -p proxy-certs
   openssl req -x509 -newkey rsa:2048 -keyout proxy-certs/key.pem -out proxy-certs/cert.pem -days 365 -nodes -subj '/CN=localhost'
   ```

3. **Client Registration Data:**
   Once MCP clients (Claude.ai, Claude Desktop, etc.) authenticate through the proxy, their OAuth client registrations are stored in `./proxy-data/`. This directory must be preserved across deployments — losing it means all connected clients will need to re-register.

### Cloudflare Tunnel

The `cloudflared` service in `docker-compose.auth.yml` uses named-tunnel (token) mode — routing is configured in the Cloudflare dashboard, not in local files. To wire up a deployment:

1. In the Cloudflare dashboard, go to **Zero Trust → Networks → Tunnels** and create a new tunnel.
2. Configure the tunnel's public hostname to point to `https://mcp-auth-proxy:443` — this works because `cloudflared` runs on the same Docker network as the proxy and resolves the service name directly (no host IP needed).
3. Copy the tunnel token from the dashboard into `TUNNEL_TOKEN` in your `.env`.

Because routing lives in the dashboard, domain names and tunnel IDs stay out of the repo. `cloudflared` makes outbound-only connections to Cloudflare's edge, so no inbound ports need to be published on the host.

## Release Workflow

Every push to `main` builds, scans, and publishes a SHA-tagged image. Tagged releases promote a validated image — no rebuild required.

**Image pipeline (on push to main):**
```
Push → CI checks → Docker build → Snyk dep scan → Snyk container scan → Push sha-<hash> to GHCR
```

**Release pipeline (on tag push):**
```
Tag v* → Pull validated sha image → Retag as <version> + latest → Push → GitHub Release
```

Insecure images never reach the registry — Snyk gates the push. By the time a release tag exists, the image it points to has already passed every gate.

**To cut a release:**

```bash
git tag v0.7.1
git push origin v0.7.1
```

Old SHA-tagged images are pruned weekly (90-day retention), preserving any image referenced by a release tag.

## Pulling Without Cloning

You can run Context Library directly from the published GHCR image without cloning the repository:

```bash
# Create a minimal docker-compose.yml
cat > docker-compose.yml << 'EOF'
services:
  context-library:
    image: ghcr.io/onideus/context-library:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:3100:3100"
    volumes:
      - ./data:/app/data
    env_file:
      - .env
EOF

# Create a .env file (see .env.example in the repo for all options)
echo "SERVER_NAME=context-library" > .env

# Start
docker compose up -d
```

For Tier 2 (Postgres) or Tier 3 (embeddings), download the additional compose files from the repo and stack them as described in [Deployment Tiers](#deployment-tiers).

## Snyk Setup (Maintainer)

The CI and release pipelines require a `SNYK_TOKEN` repository secret for dependency and container vulnerability scanning.

**Setup:**

1. Sign up for a free Snyk account at [snyk.io](https://snyk.io) (free tier covers open-source projects)
2. Generate an API token from **Account Settings → API Token**
3. Add it as a repository secret:
   ```bash
   gh secret set SNYK_TOKEN --repo onideus/context-library
   ```

The scan threshold is `high` — only high and critical severity vulnerabilities block the pipeline. Medium and low findings are reported but do not fail the build.

## Maintainer Notes

### Branch Protection

After the CI workflow is live, enable branch protection for `main` to require the `ci` job to pass before merging:

```bash
gh api -X PUT /repos/onideus/context-library/branches/main/protection \
  -f required_status_checks.strict=true \
  -F required_status_checks.contexts[]='ci' \
  -F enforce_admins=false \
  -F required_pull_request_reviews.required_approving_review_count=0 \
  -F restrictions=null
```

This requires the `ci` job (from `.github/workflows/ci.yml`) to pass on all PRs before they can be merged to `main`.

## Troubleshooting

**`EACCES: permission denied` when writing handoffs**
The container runs as UID 999. Fix ownership: `sudo chown -R 999:999 ./data`

**Auth proxy returns "Authorization failed" in Claude.ai**
Common causes:
- Auth0 app is set as third-party (must be first-party)
- Social connection (e.g., GitHub) not enabled on the app
- Callback URL mismatch — must be `https://YOUR_DOMAIN/.auth/oidc/callback`
- Missing or expired TLS certificates in `proxy-certs/`

**Health check returns `"degraded"`**
The data directory is not writable. Check ownership (UID 999) and that the volume mount exists.

**Embeddings return errors but tasks still work**
This is expected graceful degradation. Check that your embedding server is running and reachable at `EMBEDDING_URL`. If it's on a separate machine, ensure the hostname resolves from inside the Docker network.

**Postgres migrations skipped on startup**
If you see `Postgres migrations skipped — database not available`, the server is running in Tier 1 mode (handoffs only). This is normal if you didn't include `docker-compose.postgres.yml`.

**`npm install` fails with missing tarball (e.g., `zod-to-json-schema`)**
Corporate npm registries (Artifactory, Nexus) may not proxy all transitive dependencies from the public npm registry. Either run `npm install` on a non-corporate network, configure your registry to proxy the missing package, or request the package be added to your organization's allowlist.

## Security

This server holds personal operational data — handoff state, tasks, knowledge entries, artifacts, execution logs. It is designed to run behind a reverse proxy that handles authentication. **Never expose the MCP server directly to the internet.**

> **Note:** When using the auth proxy overlay (`docker-compose.auth.yml`), the MCP server still binds to `127.0.0.1:3100` from the base compose file. This means the unauthenticated server remains accessible on localhost. This is intentional for local debugging but should be considered in your deployment security model. A future release will address this in the overlay.

For external access, use mcp-auth-proxy (included in the auth compose overlay) which handles OAuth 2.1 (DCR, authorization, token exchange) before forwarding authenticated requests to the server. Route external traffic through the proxy via Cloudflare Tunnel or your preferred reverse proxy.

## Environment Variables

See `.env.example` for all configuration options.

### Core

| Variable | Default | Description |
|---|---|---|
| `SERVER_NAME` | `context-library` | MCP server name (visible to LLM clients as the tool namespace) |
| `MCP_PORT` | `3100` | Server port |
| `DATA_DIR` | `./data` | Handoff file storage path |
| `RETENTION_COUNT` | `0` | Max handoff files to retain (`0` = unlimited) |
| `CORS_ORIGINS` | `https://claude.ai,https://claude.com` | Comma-separated list of allowed CORS origins |

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
| `RERANKER_URL` | — | Cross-encoder reranker endpoint (optional; leave unset to disable) |
| `SEARCH_ALIAS_PATH` | `./data/search-aliases.json` | Deployment-local search alias expansion file (optional) |
| `ENTITY_SEED_PATH` | `./data/entities.seed.json` | Entity seed file for context envelopes (optional) |

### Auth Proxy (External Access)

| Variable | Description |
|---|---|
| `AUTH0_ISSUER` | OIDC provider issuer URL (include trailing slash) |
| `AUTH0_CLIENT_ID` | OAuth client ID |
| `AUTH0_CLIENT_SECRET` | OAuth client secret |
| `ALLOWED_USERS` | Comma-separated list of authorized email addresses |
| `EXTERNAL_URL` | Public-facing URL (e.g., `https://your-domain.com`) |
| `TUNNEL_TOKEN` | Cloudflare named-tunnel token (routing configured in the Cloudflare dashboard) |

## License

MIT
