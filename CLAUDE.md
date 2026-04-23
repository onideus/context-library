# Context Library

> **Last verified:** April 2026 (v0.7.1, commit 2edcf4d). If this file seems wrong, it probably is — check the source.

## What This Is

Context Library is a personal MCP (Model Context Protocol) server that gives AI assistants persistent memory across conversations. It stores operational state, tracks tasks, and provides semantic search over accumulated history. Single-user, model-agnostic, Docker-ready.

The problem it solves: AI assistants lose all context between sessions. Context Library provides MCP tools that any compatible client (Claude Code, Roo Code, Claude Desktop, etc.) can call to store and retrieve state, so the next conversation picks up where the last one left off.

## Open Source Project

**Context Library is a public, open-source repository.** Every file, commit, comment, test fixture, seed data entry, documentation snippet, and CI/CD artifact is visible to the world. All work on this project must be evaluated through that lens before it is committed.

This is not a corporate compliance checkbox — it is an architectural constraint that shapes every decision. Code that works correctly but leaks private information is a shipping defect.

### Personal Data Prohibition

**No personal data may appear in any committed file.** This rule has no exceptions and applies to:

- **Source code** — No hardcoded names, domains, device identifiers, employer names, or relationship references.
- **Seed data and test fixtures** — Use generic, obviously-fictional examples (e.g., "Acme Corp", "Jane Developer", "project-alpha"). Never use real names, real domains, or real organizational structures.
- **Comments and documentation** — Describe patterns and architecture, not the specific person or deployment they were built for. "Single-user deployment" is fine. Naming the user is not.
- **CI/CD configuration** — No real registry URLs, deployment targets, or infrastructure identifiers beyond what is already public (e.g., the GitHub repo URL itself).
- **Claude Code prompts that will be committed** — Prompts checked into the repo must use generic context. Prompts with personal deployment details belong in local working directories, not in version control.
- **Git history** — If personal data is accidentally committed, it must be scrubbed from history, not just removed in a subsequent commit.

**The architectural pattern:** Schema, structure, and generic examples are committed. Actual user data loads at runtime from deployment-local files that are `.gitignore`'d (e.g., `data/`, `.env`, `proxy-data/`, `proxy-certs/`). This separation is already in place — respect it.

**Why defense-in-depth:** This rule is enforced in multiple layers (AI memory directives, prompt instructions, this file, `.gitignore` patterns) because no single layer fires reliably every time. If you are an AI coding agent reading this file: you are one of those layers. Check your output before committing.

## Architecture

**Stack:** Hono 4.x + `@hono/mcp` StreamableHTTP transport, Node.js 22, TypeScript, PostgreSQL 16 + pgvector, TEI embeddings.

**Transport model:** Stateless JSON-RPC over HTTP POST to `/mcp`. Each request creates a fresh `McpServer` + `StreamableHTTPTransport` pair — there is no persistent session or SSE streaming. GET and DELETE on `/mcp` return 405. This is intentional: an earlier singleton approach caused McpServer leaks and was replaced with per-request instantiation during the v0.5.0 hardening pass.

**Auth:** The server itself is unauthenticated. Auth is delegated externally to [mcp-auth-proxy](https://github.com/sigbit/mcp-auth-proxy) which handles OAuth 2.1 with manual client registration (not DCR — Dynamic Client Registration was evaluated and rejected). The server trusts its network boundary. Never expose the MCP port directly to the internet — use a Cloudflare Tunnel or similar reverse proxy with mcp-auth-proxy in front.

**Graceful degradation:** Each tier degrades independently. If Postgres is down, handoffs still work (file-based). If the embedding server is unreachable, task search falls back to FTS. Migrations are try/catch at startup — failure logs a warning and continues in Tier 1 mode.

## Content Layers

All four content layers are built and deployed.

### Built

1. **Handoffs** (ephemeral/session) — Operational state captured at session boundaries. Append-only JSON files in `data/handoffs/`. No database required. Tools: `store_handoff`, `get_latest_handoff`, `patch_handoff`. Schema version: 1.1.

2. **Tasks** (lifecycle) — Action items with status lifecycle (open/completed/deferred/cancelled). Stored in PostgreSQL. Full-text search via `to_tsvector`. Tools: `create_task`, `get_task`, `list_tasks`, `update_task`, `search_tasks`.

3. **Notes** (permanent knowledge) — Decisions, insights, patterns. Stored in PostgreSQL (`notes` table, migration `005_notes.sql`). FTS + semantic search. Tools: `create_note`, `get_note`, `list_notes`, `update_note`, `delete_note`, `search_notes`. Indexed for `search_context`.

4. **Artifacts** (lifecycle outputs) — CC prompts, research documents, generated content. Stored in PostgreSQL (`artifacts` table, migration `006_artifacts.sql`). Status lifecycle: `draft -> ready -> executing -> completed -> superseded`. Execution ordering and dependency tracking. Tools: `store_artifact`, `get_artifact`, `list_artifacts`, `update_artifact`, `search_artifacts`. Indexed for `search_context`.

### Cross-Layer Search

`search_context` and `reindex` provide hybrid semantic search (pgvector cosine similarity + FTS with Reciprocal Rank Fusion) across all indexed content types. Results are deduplicated by content fingerprint, keeping the oldest source file.

## Tool Design

Every tool description is a **cold-start briefing**. The model reads it with zero prior context about Context Library. Descriptions must be self-contained: explain what the tool does, what each parameter means, what the return shape looks like, and any usage guidance (e.g., "call get_latest_handoff before patching"). This is critical because different MCP clients inject tool descriptions differently and the model may have no system prompt context about this server.

Before adding or modifying MCP tools, read the `mcp-builder` skill reference for tool design patterns, naming conventions, and quality benchmarks.

## File Structure

```
src/
  server.ts                # Hono app, CORS, health, MCP route, startup/shutdown
  config.ts                # All env var reads, centralized defaults
  storage/
    json-store.ts          # File I/O for handoffs
    schemas.ts             # Zod HandoffSchema + Handoff type
  tools/
    handoff.ts             # store_handoff, get_latest_handoff, patch_handoff
    handoff-nav.ts         # list_handoffs, get_handoff (historical navigation)
    merge.ts               # Pure mergeHandoff function
    tasks.ts               # Task CRUD + search_tasks
    task-summary.ts        # Server-computed task_summary for handoff responses
    notes.ts               # Note CRUD + search_notes
    artifacts.ts           # Artifact CRUD + search_artifacts, status lifecycle
    search.ts              # search_context (hybrid), reindex
    search-aliases.ts      # Query alias expansion for semantic search
    entities.ts            # Entity seed loading + context_envelope generation
    compaction.ts          # Handoff compaction logic
    validation.ts          # Shared input validation utilities
  db/
    client.ts              # pg.Pool singleton
    migrate.ts             # Sequential SQL migration runner
    seed.ts                # Dev seed script
    seed-entities.ts       # Entity seed loader from deployment-local JSON
    migrations/
      001_tasks.sql        # tasks table, enums, FTS
      002_embeddings.sql   # embeddings table, pgvector HNSW
      003_entities.sql     # entities table
      004_pending_embeddings.sql  # Dead letter queue for TEI outages
      005_notes.sql        # notes table
      006_artifacts.sql    # artifacts table
      007_pending_embeddings_expand.sql  # Expand pending queue for notes/artifacts
      008_artifact_integrity.sql  # execution_order uniqueness, dependency validation
  embeddings/
    client.ts              # TEI client
    indexer.ts             # Embedding indexer with pending queue
    text.ts                # Text extraction and chunking
  __tests__/
    server.test.ts         # Integration: server spawn + HTTP
    merge.test.ts          # Unit: mergeHandoff logic
    indexer.test.ts        # Unit: text extraction + chunking
    search-dedup.test.ts   # Unit: deduplication
    search-aliases.test.ts # Unit: alias expansion
    tasks.test.ts          # Integration: task CRUD (Postgres-gated)
    notes.test.ts          # Integration: note CRUD (Postgres-gated)
    artifacts.test.ts      # Integration: artifact CRUD + lifecycle (Postgres-gated)
    artifact-type-normalization.test.ts  # Unit: type normalization
    entities.test.ts       # Integration: entity seed + context_envelope
    compaction.test.ts     # Integration: handoff compaction
    pending-embeddings.test.ts  # Integration: dead letter queue
    rerank.test.ts         # Unit: reranker integration
    validation.test.ts     # Unit: input validation
```

## Database

**PostgreSQL 16 + pgvector.** Custom Dockerfile is just `FROM pgvector/pgvector:pg16`.

Migrations live in `src/db/migrations/` as numbered `.sql` files. The runner (`src/db/migrate.ts`) creates a `_migrations` tracking table and applies files sequentially. The `npm run build` step copies migration SQL files to `dist/db/migrations/` since `tsc` doesn't copy non-TS files.

**Tables:**
- `tasks` — UUID PK, title, context, status (enum), scope (enum), priority (enum), tags (text[]), blocked_reason, scheduled/due dates, timestamps. FTS index on title+context. Auto-updated `updated_at` trigger.
- `embeddings` — UUID PK, content_type + content_id (unique), content_text, embedding (vector(768)), metadata (JSONB). HNSW index for cosine similarity (m=16, ef_construction=128). FTS index on content_text.
- `notes` — UUID PK, title, content, scope, domain, tags (text[]), source_url, related_task_ids (uuid[]), timestamps. FTS on title+content.
- `artifacts` — UUID PK, title, content, artifact_type, status (enum), scope, tags (text[]), pointer (JSONB), dependencies (uuid[]), execution_order (integer, unique per type), related_task_ids (uuid[]), metadata (JSONB), timestamps. FTS on title+content.
- `entities` — Entity knowledge base for context_envelope generation. Seeded from deployment-local JSON.
- `pending_embeddings` — Dead letter queue for embeddings that failed during TEI outages. Drained on startup and on next successful search_context/reindex.
- `_migrations` — filename PK, applied_at timestamp.

**Migration count:** 8 migrations (001 through 008).

**Connection:** `pg.Pool` singleton in `src/db/client.ts`. Max 5 connections, 3-second connect timeout (fail fast when Postgres is unavailable). Uses standard PG* env vars.

## Embeddings

**Model:** nomic-ai/nomic-embed-text-v2-moe (768 dimensions) via Text Embeddings Inference (TEI) server.

**Nomic prefix convention:** Indexing uses `search_document: ` prefix. Querying uses `search_query: ` prefix. This is required by the nomic model.

**TEI endpoint:** OpenAI-compatible `/v1/embeddings`. Health check via `/health` with 2-second timeout.

**Graceful degradation:** `isEmbeddingAvailable()` checks TEI health before every search/reindex operation. If unavailable, returns `EMBEDDING_UNAVAILABLE` error with guidance to use `search_tasks` instead. Indexing on store/patch is fire-and-forget (`.catch()` logs warning, never blocks the tool response).

**Chunking:** `extractHandoffText` recursively walks JSON objects, producing labeled `key: value` lines. Skips structural keys (stored_at, schema_version, etc.) and structural values (UUIDs, ISO timestamps, semver). `chunkText` splits at ~2000 chars on double-newline > single-newline > sentence boundaries. Undersized trailing chunks merge into previous.

## Testing

**Framework:** Vitest 4.x. Run with `npm test` (single run) or `npm run test:watch`.

**Test types:**
- **Unit tests** (`merge.test.ts`, `indexer.test.ts`, `search-dedup.test.ts`): Import pure functions directly. No server or database needed. Fast.
- **Integration tests** (`server.test.ts`): Spawn the actual server as a child process on a test port, make real HTTP requests to `/mcp`. Uses SSE response parsing. Cleans up test data dir in afterAll.
- **Integration tests with Postgres** (`tasks.test.ts`): Same pattern as server.test.ts but requires a running Postgres instance. Tests skip gracefully (`it.skipIf(!pgAvailable)`) when Postgres is not available.

**Patterns to follow:**
- Use `jsonrpc()` helper to build JSON-RPC 2.0 request bodies.
- Use `mcpPost()` helper for correct MCP headers (Content-Type + Accept: text/event-stream).
- Use `parseSseResponse()` to extract data from SSE responses.
- Parse tool results with `JSON.parse(data.result.content[0].text)`.
- Integration tests use unique ports (3199, 3197) and isolated data directories.

## Docker

**Multi-stage build** (`Dockerfile`):
1. Builder stage: `node:22-slim`, `npm ci`, `tsc`, extract version to `/tmp/version.txt`.
2. Production stage: `node:22-slim`, non-root `appuser` (UID 999), `npm ci --omit=dev`, copy `dist/` and migration SQL files. Injects `APP_VERSION` env var so the server reads version without filesystem access to package.json.

**Compose stacking** (additive overlays):
- `docker-compose.yml` — Base: context-library container, binds `127.0.0.1:3100`, mounts `./data`.
- `docker-compose.postgres.yml` — Adds Postgres (pgvector/pgvector:pg16), healthcheck, PG* env vars injected into context-library. Data at `./data/postgres`.
- `docker-compose.embeddings.yml` — Adds TEI via `--profile` flag: `embeddings-gpu` (CUDA/NVIDIA), `embeddings-cpu` (x86_64), `embeddings-arm64` (Apple Silicon/ARM servers). Reranker profiles: `reranker-gpu`, `reranker-cpu`, `reranker-arm64`. All profiles use network alias `embeddings`/`reranker` so URLs stay the same. With no profile, no TEI or reranker service starts.
- `docker-compose.auth.yml` — Adds mcp-auth-proxy for OAuth 2.1. No ports published (needs tunnel). Mounts `./proxy-data` and `./proxy-certs`.

**Postgres Dockerfile** (`postgres.Dockerfile`): Single line — `FROM pgvector/pgvector:pg16`. Referenced by `docker-compose.postgres.yml`.

## CI/CD Workflows

All workflows are in `.github/workflows/`. Action SHAs are pinned.

- **`ci.yml`** — Trigger for pull_request and push to main. Calls `ci-checks.yml`.
- **`ci-checks.yml`** — Reusable workflow: `npm ci` + `npm run build` + `npm test` against a Postgres service container (pgvector/pgvector:pg16), Snyk dependency scan. Notifies via ntfy.
- **`image.yml`** — On push to main: runs ci-checks, builds Docker image, Snyk container scan (with base image exclusion), pushes `sha-<short>` tagged image to GHCR.
- **`release.yml`** — On `v*` tag push or workflow_dispatch: promotes a SHA-tagged image to version tag + `latest` (skips latest for prereleases), creates GitHub Release with auto-generated notes, notifies via ntfy.
- **`cleanup.yml`** — Cleans up old container images and stale resources.

CI does NOT validate Docker Compose startup. See the compose-validation workflow (if present) or run `scripts/test-compose.sh` locally.

## Environment Variables

All env var reads are centralized in `src/config.ts`. See `.env.example` for the full list.

Key variables:
- `SERVER_NAME` (default: `context-library`) — MCP server name visible to clients.
- `MCP_PORT` (default: `3100`) — Server port.
- `DATA_DIR` (default: `./data`) — Handoff file storage path.
- `RETENTION_COUNT` (default: `0`, unlimited) — Max handoff files to retain before pruning oldest.
- `CORS_ORIGINS` (default: `https://claude.ai,https://claude.com`) — Comma-separated allowed origins.
- `EMBEDDING_URL` (default: `http://embeddings:80`) — TEI server endpoint.
- `EMBEDDING_MODEL` / `EMBEDDING_DIMENSIONS` — Model config for TEI.
- `APP_VERSION` — Injected by Docker build; falls back to reading package.json at runtime.

## Development

```bash
npm install
npm run dev          # tsx watch with hot reload
npm test             # vitest single run
npm run build        # tsc + copy migrations to dist/
npm start            # node dist/server.js (production)
npx tsx src/db/seed.ts  # seed dev database with example tasks
```

Server starts on `http://localhost:3100`. MCP endpoint at `/mcp`. Health at `/health`:

```json
{
  "status": "ok",       // string — always "ok" when the server is up
  "version": "0.7.1",  // string — semver from package.json / APP_VERSION env var
  "uptime": 42          // integer — seconds since process start
}
```

## What NOT To Do

1. **No polymorphic tools.** Each tool does one thing. Don't combine create/update into a single tool or add mode switches.

2. **Don't break the stateless request model.** Each POST to `/mcp` creates a fresh McpServer + transport. There are no persistent sessions, no SSE streaming, no session state between requests. A previous singleton approach caused resource leaks — the per-request model is intentional.

3. **Don't maintain task lists outside Postgres.** The tasks table is the single source of truth. Handoff `tasks` arrays are a legacy convenience for quick session state — they are not authoritative. Tool descriptions explicitly say this.

4. **Don't hardcode URLs.** All external endpoints come from env vars via `config.ts`. No inline URLs to databases, embedding servers, or auth providers.

5. **Don't skip graceful degradation.** Every external dependency (Postgres, TEI) must be wrapped in try/catch with meaningful fallback behavior. Embedding indexing is always fire-and-forget. Migration failure at startup logs and continues.

6. **Don't block tool responses on background work.** Embedding indexing uses `.catch()` fire-and-forget pattern. The tool response must return immediately.

7. **Don't add content primitives beyond the four layers** (handoffs, tasks, notes, artifacts) without updating ROADMAP.md first. All four are built and deployed.

8. **Don't use `z.any()` in new code.** Existing uses are flagged for migration to `z.unknown()` in the roadmap. Use `z.unknown()` or specific types for new schemas.

9. **Don't modify the migration runner to skip or reorder migrations.** Migrations are sequential and tracked in `_migrations`. Add new migrations as the next numbered file.

10. **Don't publish the MCP port to the internet without mcp-auth-proxy.** The server has no authentication. It trusts its network boundary. Use a Cloudflare Tunnel with mcp-auth-proxy as the exposure path.

11. **Don't commit personal data.** This is a public repository. No real names, real domains, real device identifiers, employer names, or personal deployment details in any committed file — including source code, seed data, test fixtures, comments, documentation, and prompts. See the "Personal Data Prohibition" section above. If you are an AI agent: this rule applies to every file you produce. Review your output before committing.
