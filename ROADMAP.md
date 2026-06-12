# Context Library — Roadmap

## Design Philosophy: Four Primitives

Context Library is built around four distinct data types that map to four questions:

- **Handoffs** → *Where am I?* — Operational state captured at session boundaries. Ephemeral, append-only, scoped by time.
- **Tasks** → *What do I need to do?* — Action items with lifecycles (open → completed/cancelled/deferred). Queryable, filterable, finite.
- **Knowledge** → *What do I know?* — Captured thinking, article takeaways, pattern recognition, connections between ideas. Accrues indefinitely. No status lifecycle. Retrieved by meaning, not by deadline.
- **Artifacts** → *What have I produced?* — Generated outputs (CC prompts, research, blog posts, templates) with a lifecycle (draft → ready → executing → completed) and execution ordering. Bridges planning and execution sessions.

All four primitives share a unified semantic search index (pgvector + FTS with RRF fusion), enabling cross-type retrieval: a search for "authentication architecture" returns relevant handoff context, open tasks, accumulated knowledge, and related artifacts together.

## Completed

### v0.5.0 — Open Source Release
- Handoff tools (store, get, patch) with append-only file storage
- Task management (CRUD + full-text search) on PostgreSQL
- Semantic search via pgvector + TEI embeddings with hybrid RRF fusion
- Recursive text extraction + chunking for handoff indexing
- OAuth delegated to mcp-auth-proxy
- Three-tier Docker Compose deployment (core → Postgres → embeddings)
- Scope filtering (full/work/personal) on handoff retrieval
- Open-source release preparation

### v0.5.1 — JIT Context & Entity System
- Entity system: canonical names, aliases, scope, constraints, boundary notices
- JIT context envelopes injected into search results when entities are referenced
- Proactive tool descriptions updated to reflect entity awareness
- Pipeline hardening: Dockerfile fix, Postgres CI, reusable workflows, notifications

### Pipeline Refactor (post-v0.5.1)
- Tag release promotion model: insecure images never reach GHCR
- `image.yml` builds, scans (Snyk), and pushes SHA-tagged images on main merge
- `release.yml` retags validated SHA images as version + latest on tag push
- `cleanup.yml` prunes SHA images weekly (90-day retention, release tags preserved)
- `workflow_dispatch` escape hatch for manual release promotion
- CI runs on every push to main (build + scan gate before GHCR push)
- CVE suppressions via `.snyk` for upstream-unfixable vulnerabilities (zlib1g, picomatch)
- npm audit clean (path-to-regexp override to 8.4.2)
- CLAUDE.md Personal Data Prohibition section for OSS safety
- TEI compose profiles for GPU (NVIDIA CUDA) and CPU deployment

> **Note on version gaps:** Tags v0.5.2 and v0.5.3 were consumed during release pipeline testing (Snyk container scan failures). v0.5.4-rc.0 and v0.5.4-test.1 verified the new promotion model.

### v0.5.4 — Server-Side Enforcement & Cleanup

- `evidence_pulled` field for judgment-class request gating (advisory, not blocking)
- Per-model response format tuning in tool descriptions
- CLI `extract-entities` bootstrap script (batch entity extraction from handoff corpus)
- `last_referenced` timestamp population on entity table
- `z.any()` → `z.unknown()` migration in handoff schemas and tool parameters
- Docker Compose embeddings port mapping for externalized TEI deployments
- Tool description updates for new capabilities

### v0.6 — Resilience, Retrieval & Knowledge

- **Knowledge layer (third primitive):** `notes` table in PostgreSQL with MCP tools (`create_note`, `get_note`, `list_notes`, `search_notes`, `update_note`, `delete_note`); embedded into pgvector for unified semantic search; `'note'` added to `search_context` `content_types`
- **Embedding resilience:** `embedding_status` field in `get_latest_handoff` response (TEI health + pending count); pending embeddings queue with dead-letter pattern for TEI outage recovery (O(k) recovery vs O(n) full reindex)
- **Handoff navigation:** `list_handoffs` and `get_handoff` MCP tools for historical handoff browsing and retrieval
- **Dynamic task summary:** Server-side computed task summary in `get_latest_handoff` — critical items, due this week, recently completed, blocked chains (replaces basic counts)
- **Security hardening:** Scope enforcement on task tools (propagate handoff scope as session default); input size limits on store/patch/create operations
- **Retrieval quality:** Cross-encoder rerank stage after RRF fusion (TEI with MiniLM); search alias expansion table for abbreviation/term mapping; entity word-boundary matching; date-range filtering on `search_context`
- **Automated handoff compaction:** Session-boundary pruning with vector archival — keeps handoffs small, history searchable
- **Schema hygiene:** `schema_version` field on handoffs for forward/backward compatibility

### v0.7.0 — Artifact Layer & Embedding Resilience Fix

- **Artifact layer (fourth primitive):** `artifacts` table in PostgreSQL with MCP tools (`store_artifact`, `get_artifact`, `list_artifacts`, `search_artifacts`, `update_artifact`); lifecycle state (draft → ready → executing → completed → superseded) with enforced transitions; `execution_order` for sequenced prompt chains; inline content or external pointer (git/local/url); `'artifact'` added to `search_context` and `reindex` `content_types`
- **Embedding resilience (bug fix #37):** `indexNote` and `indexArtifact` now use the same TEI-connectivity → pending-queue fallback as `indexHandoff`/`indexTask`; `drainPendingEmbeddings` handles all four content types; `pending_embeddings` CHECK constraint expanded in migration `007`
- **Tooling hygiene:** `mergeEntities` split out of `scripts/extract-entities.ts` into `scripts/merge-entities.ts` so its tests no longer require the `@anthropic-ai/sdk` devDependency to load

### v0.7.1 — Artifact Integrity Fixes

Follow-up fixes surfaced during PR #39 review.

- **execution_order uniqueness (closes #40):** Partial unique index on `(artifact_type, execution_order)` where `execution_order IS NOT NULL`. `store_artifact` and `update_artifact` surface the conflict as `EXECUTION_ORDER_CONFLICT` instead of a raw `DB_ERROR`. Null slots remain unconstrained so existing v0.7.0 rows keep working.
- **dependencies validation (closes #44):** Write-time existence check on `dependencies` UUIDs in both `store_artifact` and `update_artifact`. Non-existent references return `VALIDATION_ERROR`; malformed UUIDs are caught before the database cast. Adds a GIN index on `dependencies` for efficient reverse-lookup queries. Full referential integrity (junction table with FKs) deferred to v0.8.
- Migration `008_artifact_integrity.sql` combines both index additions; idempotent and safe on top of v0.7.0 data.

### v0.8.0 — Lockable Artifacts & Pipeline Hardening

- **Artifact content hashing (PR #85):** SHA-256 `content_hash` auto-computed server-side and stored in artifact metadata; content locked against modification in `ready`/`executing`/`completed` statuses; hash cleared on revert to `draft`; `scripts/backfill-content-hashes.ts` for pre-existing locked artifacts
- **Tool description steering pattern (PR #77):** Search/retrieval tool descriptions rewritten with CALL-THIS-WHEN / DO-NOT-CALL-WHEN / CONSEQUENCE-OF-SKIPPING structure
- **Auto-version-bump workflow (PRs #87, #92):** `version-bump.yml` workflow_dispatch bumps `package.json` and opens a PR via bot PAT so the merge triggers `image.yml` normally

### v0.9.0 — Workflow Prompts & Response Steering

- **MCP prompts (PR #110):** `session_start`, `architect`, and `plan` registered as workflow entry points
- **Response steering (PR #103):** `next_step` hints added to tool responses
- **Hash auto-compute hardening (PR #115):** `content_hash` recomputed on promotion to a locked status when missing; caller-supplied hashes stripped

### Current: v0.10.0 — Entity Graph

- **Entity graph extraction (PRs #129, #138, #148):** Migration `009_entity_graph.sql` adds `entity_nodes`, `entity_relations`, and `extraction_runs` tables; provider abstraction (`src/entities/`) with Ollama, Anthropic/OpenAI-compatible API, and MCP-sampling providers; fire-and-forget extraction on handoff/note writes behind `ENTITY_EXTRACTION_ENABLED`; MCP tools `extract_entities`, `run_extraction`, `compare_extractions`, `list_extraction_runs`, `browse_entities`, `entity_relations`; `docker-compose.entities.yml` Tier 4 overlay
- **Hono security bump (PR #127)** and content_hash lifecycle fixes (PRs #161, #164)
- **`/health/ready` readiness endpoint:** verifies the data directory is writable; returns `ok`/`degraded`

## Planned

Ordered by expected leverage, not strict sequence. Version targets are tentative — entries may merge, split, or reorder as design work surfaces dependencies.

### v0.11 — Guaranteed Capture & Recall (Hooks Integration)

The whole system currently depends on the model *choosing* to call `store_handoff` and `search_context`. The steering language in tool descriptions (CALL-THIS-WHEN / CONSEQUENCE-OF-SKIPPING) fights for that choice — which is itself evidence that voluntary tool-calling is the weak link. The fix is moving capture out of the model's judgment entirely: guaranteed capture plus best-effort recall beats best-effort both.

**Rough design:**

- **Client integration package** (`integrations/claude-code/`, shipped as a documented plugin/skill): Claude Code hook definitions plus a thin hook client — a small script that speaks JSON-RPC directly to `POST /mcp` (no MCP client library needed for single tool calls).
- **Capture (`SessionEnd` + `PreCompact` hooks):** auto-store a handoff on every session boundary. Always captures mechanical state (cwd, git branch, dirty-file summary, timestamp, session label); includes model-authored handoff content when the session produced one; degrades to mechanical-only when it didn't. A session that never calls a single CB tool still produces a handoff.
- **Recall (`SessionStart` hook):** pre-fetch `get_latest_handoff` (which already carries the server-computed `task_summary`) plus the context envelope, and inject the result as hook context — recall becomes default-on instead of hoping the model searches.
- **Auth:** hooks target localhost directly in local deployments; for proxied deployments, document a hook-side bearer token pass-through. No server-side auth changes (auth stays at the boundary).
- **Scope:** MCP tools remain the interactive/manual path and the path for non-hook clients. Other assistants' equivalents (Cursor rules, AGENTS.md) stay under the LLM bootstrap files Horizon item.

### v0.12 — Memory Lifecycle: Consolidation, Supersedes Chains, Staleness

Handoffs and notes accumulate forever (`RETENTION_COUNT` defaults to unlimited) and search signal-to-noise degrades as they do. "We decided X" in March and "actually, Y" in May both match a search today, and nothing tells the model which is current. Without lifecycle management, system value peaks a few months in and declines.

**Rough design:**

- **Notes lifecycle (new migration):** add `status` (`active`/`superseded`/`expired`), `superseded_by UUID`, and `valid_until TIMESTAMPTZ` to `notes`. `update_note` gains a supersede action that links old → new (mirroring the artifact lifecycle pattern). Existing rows backfill to `active`.
- **Search awareness:** `search_context` excludes superseded/expired notes by default (opt back in via `include_superseded`), annotates any superseded result with its successor, and the context envelope states it explicitly: "decision X was superseded by Y on <date>".
- **Recency weighting:** optional exponential decay on RRF scores with a configurable half-life env var (default off until the eval harness can prove the right setting).
- **Consolidation pipeline (`npm run consolidate`):** distill handoffs older than N days into durable notes ("what's still true") using the existing entity-extraction provider abstraction (Ollama or API), then archive the raw files to `data/handoffs/archive/`. Grows out of `compact-history`. Idempotent, dry-run mode, and human-review output before any write — same review-first pattern as `extract-entities`.

### v0.13 — Retrieval Evaluation Harness

Search is the core promise, and there is currently no way to know whether a change to RRF weights, similarity thresholds, the reranker, chunking, or the embedding model makes retrieval better or worse. Every tuning decision is vibes. This also gates v0.12 — consolidation and recency decay should be *proven* to improve results.

**Rough design:**

- **Golden sets:** a committed synthetic set in `eval/` (generic fixtures, safe for the public repo) plus a deployment-local set at `data/eval/golden.json` (gitignored) built from real queries paired with expected content IDs.
- **`npm run eval`:** runs each query through the search pipeline against the current config and reports recall@k (k=1/5/10) and MRR, with JSON output and a `--compare baseline.json` mode so any change produces a before/after diff.
- **Matrix mode:** sweep similarity threshold, hybrid on/off, reranker on/off, and alias expansion in one run to find the best operating point.
- **CI:** the synthetic set runs as a smoke test on the FTS-only path (no TEI in CI); full-vector evals run locally against a live TEI.

### v0.14 — Workspace Scoping

Everything lives in one global namespace today, so use across multiple projects (or multiple agents) cross-contaminates search: a Project A decision surfaces while working on Project B. This is a schema-level change that gets harder the longer it waits, and it is the prerequisite for any future multi-agent or multi-user story.

**Rough design:**

- **Schema (new migration):** `workspace TEXT NOT NULL DEFAULT 'default'` on `tasks`, `notes`, and `artifacts` (indexed); a `workspace` field in the handoff schema (schema_version bump); workspace recorded in `embeddings.metadata` for search-time filtering. Backfill everything to `'default'`.
- **Tools:** create/list/search tools gain an optional `workspace` parameter falling back to `DEFAULT_WORKSPACE` (env) and then `'default'` — omitted parameters behave exactly as today, so the change is fully backward compatible.
- **Search:** `search_context` filters to the active workspace by default; explicit cross-workspace queries via an `all_workspaces` flag, with cross-workspace results labeled in the response so the model can attribute them correctly.

### v0.15 — Backup, Export & Portability

The data is the product; the code is replaceable. There is currently no supported way to move a deployment, recover from data loss, or migrate embedding models safely.

**Rough design:**

- **`npm run export`:** single tarball containing the handoff file tree, one JSONL file per Postgres table (tasks, notes, artifacts, entities, entity graph, pending queue), and a `manifest.json` (app version, applied migrations, handoff schema version, embedding model + dimensions). Embeddings excluded by default — they are recomputable — with `--include-embeddings` for exact restores.
- **`npm run import`:** restores into a fresh deployment — applies migrations, loads JSONL, copies handoff files, and queues re-embedding through the existing `pending_embeddings` path whenever embeddings are absent or the manifest's model/dimensions disagree with the current config. This makes embedding-model upgrades a supported flow: export → change model → import.
- **Docs:** a documented restore drill (export, wipe, import, verify counts + spot-check search) and a recommendation to schedule exports.

### v0.16 — Observability & Read-Only UI

Today there is no way to tell whether the dead-letter queue is silently growing, whether `search_context` is even being called, or why a given memory wasn't recalled — the only window into the system is through an LLM, which makes debugging trust issues painful.

**Rough design:**

- **Metrics:** an in-process counters module (no new dependencies) tracking tool calls by name, searches served/failed and which mode they fell back to, reranker usage, embedding queue depth, indexing failures, and drain results. Exposed at `/metrics` as JSON. Counts only — no content — but still served behind the proxy by default, same caution as the rest of the unauthenticated surface.
- **Read-only dashboard:** a single static HTML page at `/ui` (no build step, no framework) backed by a handful of read-only JSON endpoints: browse handoffs/tasks/notes/artifacts, run a search and inspect the raw ranked results (vector vs FTS vs reranked scores side by side), and a simple entity graph view. Directly answers "why didn't it recall that?" without an LLM in the loop.

### Smaller, scoped items

- **Graph-aware retrieval:** use the entity graph at query time, not just at write time — match query terms against `entity_nodes`, pull 1-hop `entity_relations`, append related canonical names to the embedded query, and surface the matched relations in the context envelope. (Absorbs the former "search alias expansion via entity graph" Horizon item; extraction shipped in v0.10.0.)
- **Optimistic concurrency on `patch_handoff`:** carry a `version`/etag in the handoff; `patch_handoff` takes an expected version and returns `CONFLICT` on mismatch. Becomes necessary once hooks (v0.11) and interactive sessions can write concurrently.
- **Distribution polish:** per-release GHCR images already ship via `release.yml`; remaining work is a one-line bootstrap script that scaffolds the compose files and `.env` from a fresh machine, and listing the server in MCP registries/directories.

## Future — Primitive Evolution

Focus: deepen the four primitives with richer structure and cross-primitive linking.

- **Artifact version chains:** Explicit version lineage for artifacts (supersedes relationships beyond the flat `superseded` status); SHA-256 content hashing shipped in v0.8.0
- **Artifact dependency referential integrity:** Junction table with foreign keys to replace the `dependencies UUID[]` column, giving true FK enforcement and cascade behavior on delete (v0.7.1 adds write-time validation as an interim fix)
- **Task schema evolution:** Subtasks (parent_id), relations (blocks/blocked-by/related), custom fields (JSONB UDAs); hierarchy is opt-in, flat tasks remain the default
- **Bitemporal entity constraints:** `valid_from`/`valid_until` on entities to prevent stale constraint application

## Horizon

Items with clear value but no target version. Some depend on external spec maturity (MCP elicitation/sampling), others on scale thresholds or ecosystem readiness.

- **MCP elicitation-based judgment gating:** Replaces `evidence_pulled` prose advisory with schema-enforced form input (depends on MCP 2025-11-25 spec reaching stable transport support)
- **MCP sampling for entity extraction:** Collapses CLI `extract-entities` into an MCP tool via `requestSampling`, removing `@anthropic-ai/sdk` dependency (a sampling provider exists in `src/entities/providers/sampling.ts` for in-request extraction; replacing the CLI bootstrap still depends on client-side sampling support maturing)
- **Conversation transcript indexing:** New `transcript` content type in embedding pipeline; requires chunking strategy and conversation export path
- **Health/wearable data integration:** Oura Ring API pipeline for sleep, HRV, activity data
- **Static ICS calendar feed:** Generate `.ics` from tasks with `due_date`/`scheduled_date` for calendar subscription
- **TTFT measurement tool:** React artifact for A/B testing context injection latency across payload sizes
- **LLM bootstrap files:** Per-environment config for AI assistants beyond Claude Code (`.cursorrules`, `AGENTS.md`, custom system prompts) — the Claude Code side is covered by the v0.11 hooks integration
- **Handoff migration to PostgreSQL:** Evaluate moving append-only JSON handoffs to a Postgres events table
- **Query builder refactor:** Replace dynamic SQL assembly in search tools with a query builder pattern
- **Model-agnostic tool description compatibility:** Two-tier system for tool descriptions that adapts to model capability
