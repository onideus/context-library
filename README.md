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

**Available tools:** `create_handoff`, `get_latest_handoff`, `update_handoff`, `list_handoffs`, `get_handoff`

> **Retention.** Handoff files are retained indefinitely by default (`RETENTION_COUNT=0`). For long-lived deployments, set `RETENTION_COUNT` to a positive number (e.g., `5000`) to cap disk growth — older handoffs are pruned along with their search-index entries. The tradeoff: higher retention keeps more history searchable; lower retention keeps the disk footprint tight.
>
> **Compaction.** After each `create_handoff`, the handoff it supersedes may be rewritten to keep the working set small. This rewrite is **lossy**: `active_context` is collapsed to a single `compacted_summary` line, and the original prose survives only as chunks in the embeddings index (and is destroyed there too if a handoff reindex — `npm run reindex -- --types handoff --include-handoffs` — re-reads the already-compacted file). `COMPACTION_MODE` decides what happens:
>
> | Mode | Behaviour |
> |---|---|
> | `archive` (default) | Copy the original byte-exact to `DATA_DIR/handoffs/archive/` first, then rewrite. Lossless on disk; costs roughly double the handoff bytes. |
> | `off` | Never rewrite. Every handoff keeps its full `active_context` permanently. Use this when the corpus is a long-term record rather than a working set. |
> | `in-place` | Legacy. Rewrite with no copy — the smallest footprint, and the only mode that discards content irrecoverably. |
>
> `archive/` sits outside retention: pruning never touches it, and it is invisible to handoff listing and latest-handoff resolution. `npm run compact-history` honours the same setting and refuses to run under `off`.

### Tier 2: + PostgreSQL (Tasks + Knowledge + Artifacts + Full-Text Search)

Adds structured task management, permanent knowledge capture, generated-output tracking, and full-text search. Requires PostgreSQL 16 with pgvector.

```bash
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d
```

**Additional tools:** `create_task`, `get_task`, `list_tasks`, `update_task`, `search_tasks`, `create_note`, `get_note`, `list_notes`, `search_notes`, `update_note`, `edit_note`, `append_note`, `delete_note`, `supersede_note`, `get_note_history`, `prune_note_history`, `create_artifact`, `get_artifact`, `list_artifacts`, `search_artifacts`, `update_artifact`, `edit_artifact`

### Tier 3: + Embeddings (Semantic Search)

Adds vector-based semantic search across all stored content using a Text Embeddings Inference (TEI) server. Use the `--profile` flag to select the GPU, CPU, or ARM64 runtime (see [Embedding Server Platform Options](#embedding-server-platform-options)).

**GPU (desktop with NVIDIA GPU):**
```bash
docker compose -f docker-compose.yml -f docker-compose.postgres.yml -f docker-compose.embeddings.yml --profile embeddings-gpu up -d
```

**CPU (NAS or any machine without GPU):**
```bash
docker compose -f docker-compose.yml -f docker-compose.postgres.yml -f docker-compose.embeddings.yml --profile embeddings-cpu up -d
```

With no `--profile` flag, neither TEI service starts — the application degrades gracefully (semantic search falls back to FTS).

**Additional tools:** `search_context`

**Rebuilding the index.** `npm run reindex` re-embeds tasks, notes and artifacts (it is an operator script, not an MCP tool). Run it from a source checkout with `EMBEDDING_URL`, the `PG*` variables and `DATA_DIR` pointed at the deployment — for example `localhost` with the host ports your compose file publishes for the embedding server and Postgres. `--types task,note` narrows it. Handoffs are skipped unless you pass both `--types handoff` and `--include-handoffs`: reindexing a compacted handoff overwrites the only copy of its pre-compaction text in the index, so run `npm run audit-compaction` first.

The TEI server can run on a separate machine — just point `EMBEDDING_URL` to its address. This is the recommended setup if your main server doesn't have a GPU.

#### Optional: Cross-Encoder Reranker

For improved retrieval precision, an optional cross-encoder reranker rescores candidates after RRF fusion. It runs as a second TEI instance:

```bash
# Add to your compose command:
--profile reranker-gpu   # or reranker-cpu, reranker-arm64
```

When the reranker is not configured or unreachable, `search_context` falls back to RRF-only ordering. Set `RERANKER_URL` in your `.env` to enable it.

Every `search_context` response carries two booleans so "off" and "broken" are distinguishable from the caller's side: `reranker_configured` (is `RERANKER_URL` set) and `reranked` (did the cross-encoder actually rescore this response). `reranker_configured=true` with `reranked=false` on a multi-result response means the reranker is unreachable, timing out (`RERANKER_TIMEOUT_MS`, default 3000), or returning bad data; the server logs a `[rerank]` warning with the host, HTTP status, and elapsed time.

On a fresh host the reranker's first start must be able to reach the Hugging Face hub so TEI can pull the model into the shared models volume. Set `HF_HUB_OFFLINE=1` on the service only after the model directory exists there; an offline first start fails with no error visible to the caller.

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

### Tier 4: + Entity Extraction (Knowledge Graph)

Adds background extraction of entity triples (subject → relation → object) from handoffs and notes into a queryable knowledge graph. Extraction runs against an external LLM provider — either a local Ollama instance or an Anthropic/OpenAI-compatible API.

```bash
docker compose -f docker-compose.yml -f docker-compose.postgres.yml -f docker-compose.entities.yml up -d
```

Extraction is disabled by default (`ENTITY_EXTRACTION_ENABLED=false`) and is fully fire-and-forget: if the provider is unreachable, handoff and note writes still succeed and a warning is logged. Ollama itself is not managed by Compose — point `OLLAMA_BASE_URL` at wherever it runs.

Here Context Library is the caller: it sends your content to a model to extract triples. Chatting with a local model that calls Context Library's tools is the reverse direction, covered in [Local LLM](#local-llm).

**Additional tools:** `extract_entities`, `create_extraction_run`, `compare_extraction_runs`, `list_extraction_runs`, `list_entities`, `get_entity_relations`

## Architecture

- **Server:** Hono 4.x + StreamableHTTP MCP transport (Node.js 22, TypeScript)
- **Storage (Tier 1):** Append-only JSON files in `./data/handoffs/`
- **Database (Tier 2):** PostgreSQL 16 with pgvector extension
- **Content primitives:** Handoffs (ephemeral session state), Tasks (lifecycle-managed action items), Notes (permanent knowledge — decisions, patterns, insights), Artifacts (generated outputs with lifecycle state and execution ordering)
- **Embeddings (Tier 3):** Text Embeddings Inference with nomic-embed-text-v2-moe (768 dims), optional cross-encoder reranker
- **Search:** Hybrid retrieval (vector + FTS with RRF fusion), optional cross-encoder reranking, entity-aware context envelopes, search alias expansion, date-range filtering
- **Auth:** Handled externally by [mcp-auth-proxy](https://github.com/sigbit/mcp-auth-proxy) — the server itself is unauthenticated and trusts its network boundary

Each component degrades gracefully when unavailable. If Postgres is down, handoffs still work. If the embedding server is unreachable, task, note, and artifact search still works via full-text search; failed embeddings are queued for automatic retry when TEI comes back.

## The Autonomous Pipeline Pattern

The four content primitives (handoffs, tasks, notes, artifacts) are enough substrate to run an autonomous build pipeline against your own repositories. A planning session stores `ready` artifacts. A separate interceptor process polls `list_artifacts`, claims work by transitioning status to `executing`, runs the artifact content as a prompt against a target repo, opens a PR, gates the merge behind adversarial review + CI, and writes a digest note back to Context Library.

The reference implementation is private. What is documented here is the pattern — the contracts between planner, artifact store, interceptor, and review gate — so you can build your own on top of a Tier 2+ deployment. See [docs/pipeline/](docs/pipeline/README.md) for the full write-up: lifecycle rules, governance model, replication spec, and worked example.

## MCP Tools

| Tool | Tier | Description |
|---|---|---|
| `create_handoff` | Core | Full-state capture at session boundaries (append-only) |
| `get_latest_handoff` | Core | Retrieve most recent handoff with pre-computed fields |
| `update_handoff` | Core | Partial update with merge semantics |
| `list_handoffs` | Core | Browse historical handoffs by date with metadata |
| `get_handoff` | Core | Retrieve a specific historical handoff by filename |
| `create_task` | Postgres | Create task with scope, priority, tags, dates |
| `get_task` | Postgres | Retrieve task by UUID |
| `list_tasks` | Postgres | Paginated filtering with status, scope, priority, tags |
| `update_task` | Postgres | Field updates + lifecycle actions (complete/cancel/defer/reopen) |
| `search_tasks` | Postgres | Full-text search with PostgreSQL FTS |
| `create_note` | Postgres | Capture permanent knowledge (decisions, patterns, insights) with optional `provenance` and `valid_until` |
| `get_note` | Postgres | Retrieve note by UUID, with lifecycle status, successor, predecessors, and version |
| `list_notes` | Postgres | Browse notes with scope, domain, tag, and lifecycle-status filters |
| `search_notes` | Postgres | Full-text search across note titles and content; a superseded hit is redirected to its current successor (`include_superseded` / `include_expired` opt out) |
| `update_note` | Postgres | Update note fields with optional `expected_version` precondition; every effective edit is versioned; re-embeds on content change |
| `edit_note` | Postgres | Exact-match edits to a note's content (ordered, all-or-nothing; optional `expected_version`; versioned; compact response, no content echo) |
| `append_note` | Postgres | Append text to a note on a new line (logs, dated entries; optional `expected_version`; versioned; compact response) |
| `delete_note` | Postgres | Permanently delete a note, its history, and its embedding; splices any supersession chain through it |
| `supersede_note` | Postgres | Mark a note as replaced by another (both must be active); the old note keeps its content with `status='superseded'` |
| `get_note_history` | Postgres | Read a note's prior versions (title, content, what changed, who changed it) |
| `prune_note_history` | Postgres | Drop all but the newest N history rows of a note — the only way to remove content edited out of it |
| `create_artifact` | Postgres | Capture a generated output (CC prompt, research, template) with lifecycle state |
| `get_artifact` | Postgres | Retrieve artifact by UUID (full content + pointer + metadata) |
| `list_artifacts` | Postgres | Browse artifacts with type, status, scope, and tag filters; execution_order-aware sort |
| `search_artifacts` | Postgres | Full-text search across artifact titles and content |
| `update_artifact` | Postgres | Update artifact fields; enforces status transitions; re-embeds on content change |
| `edit_artifact` | Postgres | Exact-match edits to an artifact's content (ordered, all-or-nothing) without resending the whole body; draft/superseded only; recomputes `content_hash` |
| `search_context` | Embeddings | Hybrid semantic search (vector + FTS with RRF fusion) across all content types; superseded notes redirect to their successor, expired notes are hidden (`include_superseded` / `include_expired` opt out) |
| `extract_entities` | Entities | Trigger entity extraction on a single content item |
| `create_extraction_run` | Entities | Batch-extract entities from multiple content items |
| `compare_extraction_runs` | Entities | Compare two extraction runs (e.g., different providers or models) |
| `list_extraction_runs` | Entities | List recent entity extraction runs with stats |
| `list_entities` | Entities | Browse the extracted entity graph with type and name filters |
| `get_entity_relations` | Entities | Retrieve the relation graph for a specific entity |

Tool names follow one convention: `verb_noun` in snake_case (`create_`, `get_`, `list_`, `search_`, `update_`, `edit_`, `append_`, `delete_`, plus a few domain verbs such as `supersede_` and `prune_`).

### Renamed tools

Nine tools were renamed. The old names still work as deprecated aliases for **one release** and are removed in the next one; each alias call logs `[deprecated-tool] <old> called; use <new>`. Set `LEGACY_TOOL_NAMES=false` to preview the removal — it also brings the tool count down from 43 to 34, which matters for clients that warn when a server offers around 40 tools. `reindex` is no longer an MCP tool (no alias): use `npm run reindex`.

| Old name | New name |
|---|---|
| `store_handoff` | `create_handoff` |
| `patch_handoff` | `update_handoff` |
| `store_artifact` | `create_artifact` |
| `patch_artifact` | `edit_artifact` |
| `str_replace_note` | `edit_note` (takes an `edits` array like `edit_artifact`; the alias keeps the old `old_str`/`new_str` input) |
| `browse_entities` | `list_entities` |
| `entity_relations` | `get_entity_relations` (the `entity_relations` table keeps its name) |
| `run_extraction` | `create_extraction_run` |
| `compare_extractions` | `compare_extraction_runs` |

The server also registers three MCP prompts as workflow entry points: `session_start` (load handoff state at conversation start), `architect` (load prior design decisions before architecture discussions), and `plan` (load task and artifact state before planning).

## Health Checks

The server exposes two health endpoints:

- **`GET /health`** — Basic liveness check. Returns server status, version, uptime, and whether the embedding server is reachable.
- **`GET /health/ready`** — Readiness check. Verifies the data directory is writable. Returns `"ok"` (HTTP 200) or `"degraded"` (HTTP 503) accordingly.

Both return JSON. Use `/health` for uptime monitoring and `/health/ready` after deployment to confirm the server can write data.

```bash
curl http://localhost:3100/health
# {"status":"ok","version":"<version>","uptime":42,"embedding_status":{"available":true}}

curl http://localhost:3100/health/ready
# {"status":"ok","writable":true,"uptime":42}
```

`version` depends on the build: a released image reports its release version (`X.Y.Z`), an image built from `main` reports `0.0.0-sha.<hash>`, and a source checkout reports `0.0.0-development`. `embedding_status.available` is `true` when the TEI server answers its health check, `false` when it does not (including deployments without Tier 3), and `null` if the check itself failed; the result is cached for about 10 seconds.

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

The server speaks **Streamable HTTP** on a single endpoint, `http://localhost:3100/mcp`, and has no authentication of its own. Who can reach that endpoint depends on how you run it:

- **Docker Compose (base `docker-compose.yml`):** the port is published on `127.0.0.1:3100` only, so only clients on the same machine can connect.
- **From source (`npm run dev` / `npm start`):** the process listens on all interfaces (`0.0.0.0`), so the unauthenticated endpoint is reachable from the network. On a shared network, block port 3100 with a host firewall or run via Compose instead.

Anything that has to reach the server from another machine, including every cloud-hosted client, goes through the auth proxy: see [External Access with Auth Proxy](#external-access-with-auth-proxy). Do not publish the port on `0.0.0.0` without it.

### Claude

#### Claude Code

```bash
claude mcp add --transport http context-library http://localhost:3100/mcp
```

This uses the default **local** scope: the server is available in the current project only, and the entry is stored in `~/.claude.json`. Other scopes:

- `--scope user` makes the server available in every project.
- `--scope project` writes a shared `.mcp.json` at the project root, which can be committed:

  ```json
  {
    "mcpServers": {
      "context-library": {
        "type": "http",
        "url": "http://localhost:3100/mcp"
      }
    }
  }
  ```

  The `"type": "http"` field is required: an entry with a `url` but no `type` is reported as a configuration error and skipped. Claude Code asks you to approve project-scoped servers the first time it sees them.

Reference: [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp).

#### Claude Desktop

Which setup applies depends on where the server runs.

**Local server (the default deployment).** Claude Desktop's config file takes stdio servers only, so bridge to the HTTP endpoint with [mcp-remote](https://github.com/geelen/mcp-remote). Edit the config file:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
**Windows (Store):** `%LOCALAPPDATA%\Packages\Claude_<hash>\LocalCache\Roaming\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "context-library": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://127.0.0.1:3100/mcp"]
    }
  }
}
```

`-y` skips the npx install prompt, and `127.0.0.1` avoids problems when `localhost` resolves to IPv6 first. Fully quit Claude Desktop and relaunch it after saving.

**Public deployment behind the auth proxy.** Add the server as a custom connector instead. The connection is opened from Anthropic's cloud, not from your machine, so the URL must be reachable from the public internet over valid TLS; a `localhost` URL never works as a custom connector. See [External Access with Auth Proxy](#external-access-with-auth-proxy).

Reference: [Get started with custom connectors using remote MCP](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

#### Claude.ai

Claude.ai uses the same custom-connector model: a public URL, with OAuth handled by the auth proxy. See [External Access with Auth Proxy](#external-access-with-auth-proxy).

### Local LLM

Two different pieces are involved when you use a local model:

- The **model runtime** (Ollama, LM Studio's server, llama.cpp) loads and runs the model.
- The **MCP client** is the chat application that shows the conversation and calls tools.

Context Library connects to the MCP client, not to the runtime. Some applications are both.

> This is unrelated to using Ollama as an [entity extraction provider](#tier-4--entity-extraction-knowledge-graph) (Tier 4). There, Context Library calls a model; here, a model's chat client calls Context Library.

#### LM Studio (0.3.17 or later)

LM Studio is both runtime and MCP client. In the app, open the **Program** tab in the right sidebar, then **Install > Edit mcp.json**, and add:

```json
{
  "mcpServers": {
    "context-library": {
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

LM Studio's documentation warns that servers designed for cloud models can use enough tokens to overflow a local model's context. Read [Model and context requirements](#model-and-context-requirements) before using it.

Reference: [LM Studio MCP documentation](https://lmstudio.ai/docs/app/mcp).

#### Open WebUI (0.6.31 or later) with Ollama or another local runtime

Open WebUI works with Ollama or any OpenAI-compatible local runtime. Its native MCP support is Streamable HTTP only, which is what this server speaks. Go to **Admin Settings > External Tools > Add Server**, choose the type **MCP (Streamable HTTP)**, and enter the URL for your setup.

Open WebUI's backend makes the connection, not your browser. When Open WebUI runs in Docker, `localhost` means the Open WebUI container, not the host:

| Setup | URL |
|---|---|
| Open WebUI running directly on the host (not in Docker) | `http://localhost:3100/mcp` |
| Open WebUI in Docker Desktop (macOS / Windows) | `http://host.docker.internal:3100/mcp` |
| Open WebUI in Docker on Linux, Context Library on the default compose file | `http://context-library:3100/mcp` (after joining the network, below) |
| Open WebUI in Docker on Linux, Context Library run from source (`npm run dev` / `npm start`) | `http://host.docker.internal:3100/mcp`, with `extra_hosts: ["host.docker.internal:host-gateway"]` on the Open WebUI container |

When Context Library runs from source it listens on `0.0.0.0`, so `host-gateway` reaches it (a host firewall that blocks the Docker bridge will still refuse the connection). On Linux, the base compose file publishes the port on `127.0.0.1` only, so `host.docker.internal` / `host-gateway` gets connection refused. Attach Open WebUI to Context Library's compose network instead; inside that network the service is named `context-library` and listens on port `3100`. The network is named `<project>_default`, where the project name defaults to the directory holding the compose files (`context-library_default` for a default clone; check with `docker network ls`). Either connect a running container:

```bash
docker network connect context-library_default <open-webui-container>
```

or declare the network in Open WebUI's compose file:

```yaml
services:
  open-webui:
    # ...existing configuration...
    networks:
      - default
      - context-library

networks:
  context-library:
    external: true
    name: context-library_default
```

Reference: [Open WebUI MCP documentation](https://docs.openwebui.com/features/mcp).

#### Model and context requirements

Every tool is registered on every server, whatever tier you deploy, so the tool list a client loads is always the same size. Measured at v0.13.0, the `tools/list` response for all 35 tools is about 93,000 characters, roughly **23K tokens**. Tool descriptions change between releases, so treat this as approximate.

- **Context window.** A model needs a context window of at least about 23K tokens just to hold the tool list, before any conversation. Your messages and the tool results come on top of that, so configure well above it; 32K tokens is a practical floor and more is better. LM Studio and Ollama both default to context windows smaller than many models support. The context length is a setting in each: set it explicitly when you load the model.
- **Tool calling.** The model must support tool calling. Small models often call tools poorly: wrong tool, malformed arguments, or no call at all. The tool descriptions in this server are long by design (each is a self-contained briefing for a model with no prior context), which favors larger models.

### Other MCP Clients

Any client that supports the Streamable HTTP transport can connect to `http://localhost:3100/mcp` (or to the public URL behind the auth proxy). Consult the client's documentation for its configuration format; typically you specify the URL and the transport type.

### Verifying the Connection

After connecting, ask your AI assistant to call `get_latest_handoff`. If it returns a handoff (or an empty-state response on first use), the connection is working. You can also hit the health endpoint directly:

```bash
curl http://localhost:3100/health
# {"status":"ok","version":"<version>","uptime":42,"embedding_status":{"available":true}}
```

See [Health Checks](#health-checks) for what each field means.

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

Every push to `main` builds, scans, and publishes a SHA-tagged image. A release promotes one of those tested images — no version-bump commit, no rebuild, no test re-run.

**Image pipeline (on push to main):**
```
Push → ci (build + tests) → on success: Docker build → Trivy container scan → Push sha-<hash> to GHCR
```

**Release pipeline (one button):**
```
Pick version + newest sha image → Trivy re-scan (today's CVE data) → Stamp version (no rebuild)
  → /health must report the new version → SBOM + scan report + release notes
  → Push <version> + latest → Tag + GitHub Release with the files attached
```

Every GitHub Release carries three files for downstream consumers:

- **`RELEASE_NOTES.md`**, also the release description. It has:
  - the image tag and pinnable digest;
  - what the release fixed: the known vulnerabilities in the previous release's image that this image no longer has (both scanned with the same data), the CodeQL alerts closed, and security-related PRs;
  - what is new: vulnerabilities in packages added or changed since the previous release;
  - the release-time scan result;
  - the merged changes grouped by type (from conventional-commit PR titles), with a compare link.
- **`sbom.cdx.json`**, a CycloneDX SBOM of every OS and npm package in the image.
- **`trivy-report.json`**, the release-time vulnerability scan at all severities, including known issues with no upstream fix.

A dry run produces the same files as a workflow artifact without publishing anything.

Optional: the workflow's own token cannot read Dependabot alerts. To also list the Dependabot alerts closed in each release (split into runtime and dev-only), create a fine-grained token scoped to this repository with only **Dependabot alerts: Read**, and save it as the `DEPENDABOT_ALERTS_TOKEN` repository secret.

Insecure images never reach the registry — the image is built only after `ci` passes, and the Trivy container scan (OS packages and npm packages) gates the push. The release re-scans the same image, so a CVE published between the merge and the release blocks it.

**Versions** live in git tags and the image, not in `package.json` (frozen at `0.0.0-development`). Unreleased images report `0.0.0-sha.<hash>` from `/health`; a released image reports its version, because the release sets `APP_VERSION` on the tested image without touching its code layers.

**To cut a release:** Actions → **release** → **Run workflow**, choose patch / minor / major, run. Or:

```bash
gh workflow run release.yml -f bump=patch
gh workflow run release.yml -f version=0.13.0-rc.1      # exact version; prereleases don't move latest
gh workflow run release.yml -f bump=minor -f dry_run=true  # validate everything, publish nothing
```

If newer commits on `main` have no image yet (ci failed, or `image.yml` is still running), the release uses the newest commit that has one and warns about the ones it skipped. Pass `-f source_sha=<commit>` to choose a commit explicitly.

Old SHA-tagged images are pruned weekly (90-day retention). Released images carry their version tag and are kept.

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

## Security Scanning Setup (Maintainer)

Three scans gate code on its way in, and none needs an account or secret. Only high and critical severity findings block; medium and low are reported but do not fail anything.

**Before merge (on every PR):**

- **Dependency review (`ci-checks.yml`)** diffs the PR's changes to `package.json` / `package-lock.json` against GitHub's advisory database and fails if the PR adds, or upgrades to, a package with a HIGH or CRITICAL advisory, runtime or dev dependency. It is the first step of the `ci / ci` check, so it takes seconds and fails before install and tests spend any minutes.
- **CodeQL (GitHub default setup)** analyses JavaScript/TypeScript and the workflows themselves. The `main` ruleset blocks a merge that introduces a HIGH or CRITICAL security alert, or an error-level alert.

**After merge (on every push to `main`):**

- **Container scan (Trivy, `image.yml`)** runs on the freshly built image before it is pushed to GHCR. It needs no account, token, or secret. It fails on HIGH and CRITICAL CVEs that have a fix available, in OS packages and Node modules alike, and ignores CVEs with no fix (the base image carries dozens of those in Debian packages that nobody downstream can patch). A fixable base-image CVE means rebuilding on a newer `node:22-slim`.

An advisory published after a package is already on `main` is not something a PR gate can catch. Between pushes, **Dependabot alerts** (repository Settings → Code security) flag vulnerable packages in `package-lock.json`, and Dependabot opens update PRs for them.

## Maintainer Notes

### Branch Protection

`main` is protected by a repository ruleset rather than classic branch protection. It requires a pull request with code-owner review, linear history, no force-pushes or deletion, the CI check to pass (which includes dependency review), and no new HIGH or CRITICAL CodeQL alerts.

The check to require is **`ci / ci`**, not `ci`: `ci.yml` calls the reusable `ci-checks.yml`, so GitHub reports the check as `<caller job> / <called job>`. Requiring a context that never reports blocks every merge. Pin it to the GitHub Actions app (integration ID `15368`) so no other app can satisfy it.

To create the ruleset on a fresh copy of the repo, save this as `ruleset.json`:

```json
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "require_code_owner_review": true,
        "dismiss_stale_reviews_on_push": true,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [{ "context": "ci / ci", "integration_id": 15368 }]
      }
    },
    {
      "type": "code_scanning",
      "parameters": {
        "code_scanning_tools": [
          { "tool": "CodeQL", "security_alerts_threshold": "high_or_higher", "alerts_threshold": "errors" }
        ]
      }
    }
  ]
}
```

```bash
gh api -X POST /repos/onideus/context-library/rulesets --input ruleset.json
```

The `code_scanning` rule needs CodeQL to be running on PRs: enable **default setup** under Settings → Code security → Code scanning first.

`strict_required_status_checks_policy` is `false` on purpose: `true` makes every open PR re-run CI each time `main` moves, which mostly burns CI minutes on Dependabot PRs. `ci.yml` still runs on every push to `main`, so a bad interaction between merged PRs shows up there right away.

`ci-checks.yml` runs once per push to `main`, from `ci.yml`. `image.yml` does not run it again. It starts from `workflow_run` when `ci` completes, and builds only if that run succeeded, from the exact commit `ci` tested.

## Troubleshooting

**`EACCES: permission denied` when writing handoffs**
The container runs as UID 999. Fix ownership: `sudo chown -R 999:999 ./data`

**Auth proxy returns "Authorization failed" in Claude.ai**
Common causes:
- Auth0 app is set as third-party (must be first-party)
- Social connection (e.g., GitHub) not enabled on the app
- Callback URL mismatch — must be `https://YOUR_DOMAIN/.auth/oidc/callback`
- Missing or expired TLS certificates in `proxy-certs/`

**`/health/ready` returns `"degraded"`**
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
| `COMPACTION_MODE` | `archive` | How the superseded handoff is treated after a store: `archive` (keep a byte-exact original in `handoffs/archive/`), `off` (never rewrite), `in-place` (legacy, lossy) |
| `LEGACY_TOOL_NAMES` | `true` | Also register the nine pre-rename tool names as deprecated aliases (see [Renamed tools](#renamed-tools)); removed in the next release. `false` previews that and lowers the tool count from 43 to 34 |
| `NOTE_HISTORY_MAX_VERSIONS` | `0` | Max prior versions kept per note in `note_versions` (`0` = unlimited); `prune_note_history` is the per-note manual control |
| `CORS_ORIGINS` | `https://claude.ai,https://claude.com` | Comma-separated list of allowed CORS origins |
| `LOG_RESPONSE_BODIES` | `false` | Include response bodies in the per-request `/mcp` response logs (debugging only; bodies contain user content) |
| `APP_VERSION` | — | Version reported by `/health`, MCP server info, and export manifests. Set by the image build; when unset it falls back to `package.json` (`0.0.0-development`) |

### PostgreSQL (Tier 2)

| Variable | Default | Description |
|---|---|---|
| `PGHOST` | — | PostgreSQL host |
| `PGPORT` | `5432` | PostgreSQL port |
| `PGUSER` | — | PostgreSQL user |
| `PGPASSWORD` | — | PostgreSQL password |
| `PGDATABASE` | — | PostgreSQL database name |
| `POSTGRES_DB` | `context_library` | Database created by the Postgres container (used by compose) |
| `POSTGRES_USER` | `cl` | Superuser created by the Postgres container (used by compose) |
| `POSTGRES_PASSWORD` | — | Password for that user (used by compose; required for Tier 2) |

### Embeddings (Tier 3)

| Variable | Default | Description |
|---|---|---|
| `EMBEDDING_URL` | `http://embeddings:80` | TEI server endpoint |
| `EMBEDDING_MODEL` | `nomic-ai/nomic-embed-text-v2-moe` | Embedding model name |
| `EMBEDDING_DIMENSIONS` | `768` | Embedding vector dimensions |
| `RERANKER_URL` | — | Cross-encoder reranker endpoint (optional; leave unset to disable) |
| `RERANKER_TIMEOUT_MS` | `3000` | Abort budget per `/rerank` call; on timeout the search falls back to RRF ordering |
| `RERANKER_MODEL` | `cross-encoder/ms-marco-MiniLM-L-6-v2` | Model loaded by the reranker service (used by `docker-compose.embeddings.yml`) |
| `SEARCH_ALIAS_PATH` | `./data/search-aliases.json` | Deployment-local search alias expansion file (optional) |
| `ENTITY_SEED_PATH` | `./data/entities.seed.json` | Entity seed file for context envelopes (optional) |

### Entity Extraction (Tier 4)

| Variable | Default | Description |
|---|---|---|
| `ENTITY_EXTRACTION_ENABLED` | `false` | Enable background entity extraction on handoff/note writes |
| `ENTITY_EXTRACTION_PROVIDER` | `none` | Extraction provider: `ollama`, `api`, or `none` |
| `ENTITY_EXTRACTION_ASYNC` | `true` | Run extraction fire-and-forget (recommended) |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama endpoint for the `ollama` provider |
| `OLLAMA_EXTRACTION_MODEL` | `sciphi/triplex` | Ollama model used for triple extraction |
| `ENTITY_MIN_CONFIDENCE` | `0.5` | Minimum confidence threshold for extracted triples (0–1) |
| `ENTITY_EXTRACTION_TIMEOUT_MS` | `30000` | Timeout per extraction call in milliseconds |
| `ENTITY_API_KEY` | — | API key for the `api` provider (leave unset to disable) |
| `ENTITY_API_BASE_URL` | `https://api.anthropic.com` | Base URL for the `api` provider |
| `ENTITY_API_MODEL` | `claude-sonnet-4-20250514` | Model used by the `api` provider |
| `ENTITY_API_FORMAT` | `anthropic` | API wire format: `anthropic` or `openai` |

### Entity Graph Retrieval (optional)

When enabled, `search_context` matches entity names in the query, walks `entity_relations`, and adds the content it reaches as a third ranking signal in RRF fusion. Turn it on once an extraction run has populated the graph.

| Variable | Default | Description |
|---|---|---|
| `ENTITY_GRAPH_ENABLED` | `false` | Enable the graph signal in `search_context` |
| `ENTITY_GRAPH_HOPS` | `1` | Traversal depth (clamped to 1–3) |
| `ENTITY_GRAPH_RRF_WEIGHT` | `0.3` | Weight of the graph signal in fusion (0–1) |
| `ENTITY_GRAPH_FTS_WEIGHT` | `1.0` | Weight of the full-text signal in hybrid fusion (0–1) |
| `ENTITY_GRAPH_VECTOR_WEIGHT` | `1.0` | Weight of the vector signal in hybrid fusion (0–1) |
| `ENTITY_GRAPH_MAX_CANDIDATES` | `50` | Maximum content rows returned by the traversal |

### Sync Endpoints (optional)

Plain-HTTP `/sync/*` endpoints for clients that cannot use the MCP OAuth flow. Every request is rejected until a token is set.

| Variable | Default | Description |
|---|---|---|
| `SYNC_BEARER_TOKEN` | — | Bearer token for `/sync/*` (unset or empty = every request rejected) |
| `SYNC_CHANGES_DEFAULT_LIMIT` | `100` | Rows per `GET /sync/changes` when `limit` is omitted |
| `SYNC_CHANGES_MAX_LIMIT` | `500` | Upper bound on the `limit` query parameter |
| `SYNC_PUSH_MAX_BYTES` | `5242880` | Whole-request body cap for `POST /sync/push` (5 MiB) |
| `SYNC_PUSH_MAX_OP_BYTES` | `131072` | Per-op cap for `POST /sync/push` (128 KiB) |

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
