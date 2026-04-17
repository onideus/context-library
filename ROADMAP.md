# Context Library — Roadmap

## Design Philosophy: Three Primitives

Context Library is built around three distinct data types that map to three questions:

- **Handoffs** → *Where am I?* — Operational state captured at session boundaries. Ephemeral, append-only, scoped by time.
- **Tasks** → *What do I need to do?* — Action items with lifecycles (open → completed/cancelled/deferred). Queryable, filterable, finite.
- **Knowledge** *(planned)* → *What do I know?* — Captured thinking, article takeaways, pattern recognition, connections between ideas. Accrues indefinitely. No status lifecycle. Retrieved by meaning, not by deadline.

All three primitives share a unified semantic search index (pgvector + FTS with RRF fusion), enabling cross-type retrieval: a search for "authentication architecture" returns relevant handoff context, open tasks, and accumulated knowledge together.

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

> **Note on version gaps:** Tags v0.5.2 and v0.5.3 were consumed during release pipeline testing (Snyk container scan failures). v0.5.4-rc.0 and v0.5.4-test.1 verified the new promotion model. The next release is v0.5.4.

## Current: v0.5.4 — Server-Side Enforcement & Cleanup

- `evidence_pulled` field for judgment-class request gating (advisory, not blocking)
- Per-model response format tuning in tool descriptions
- CLI `extract-entities` bootstrap script (batch entity extraction from handoff corpus)
- `last_referenced` timestamp population on entity table
- `z.any()` → `z.unknown()` migration in handoff schemas and tool parameters
- Docker Compose embeddings port mapping for externalized TEI deployments
- Tool description updates for new capabilities
- Version bump to 0.5.4

## Next: v0.6 — Resilience, Retrieval & Knowledge

Focus: make the system self-healing, observable, harder to misuse — and introduce the third primitive.

- **Knowledge layer (third primitive):** `notes` table in PostgreSQL with MCP tools (`create_note`, `get_note`, `list_notes`, `search_notes`, `update_note`, `delete_note`); embedded into pgvector for unified semantic search; `'note'` added to `search_context` `content_types`; distinct from artifacts — knowledge is interpretation, not output
- **Embedding resilience:** `embedding_status` field in `get_latest_handoff` response (TEI health + pending count); pending embeddings queue with dead-letter pattern for TEI outage recovery (O(k) recovery vs O(n) full reindex)
- **Handoff navigation:** `list_handoffs` and `get_handoff` MCP tools for historical handoff browsing and retrieval
- **Dynamic task summary:** Server-side computed task summary in `get_latest_handoff` — critical items, due this week, recently completed, blocked chains (replaces basic counts)
- **Security hardening:** Scope enforcement on task tools (propagate handoff scope as session default); input size limits on store/patch/create operations
- **Retrieval quality:** Cross-encoder rerank stage after RRF fusion (TEI with MiniLM, ~30-50 lines in search.ts); search alias expansion table for abbreviation/term mapping; entity word-boundary matching; date-range filtering on `search_context`
- **Automated handoff compaction:** Session-boundary pruning with vector archival — keeps handoffs small, history searchable
- **Schema hygiene:** `schema_version` field on handoffs for forward/backward compatibility

## Future: v0.7 — New Primitives

Focus: expand beyond the three primitives into richer structure and artifact storage.

- **Artifact storage:** File/content tracking with metadata, SHA-256 hashing, and versioning; prompt library via tagging convention
- **Task schema evolution:** Subtasks (parent_id), relations (blocks/blocked-by/related), custom fields (JSONB UDAs); hierarchy is opt-in, flat tasks remain the default
- **Bitemporal entity constraints:** `valid_from`/`valid_until` on entities to prevent stale constraint application

## Horizon

Items with clear value but no target version. Some depend on external spec maturity (MCP elicitation/sampling), others on scale thresholds or ecosystem readiness.

- **MCP elicitation-based judgment gating:** Replaces `evidence_pulled` prose advisory with schema-enforced form input (depends on MCP 2025-11-25 spec reaching stable transport support)
- **MCP sampling for entity extraction:** Collapses CLI `extract-entities` into an MCP tool via `requestSampling`, removing `@anthropic-ai/sdk` dependency
- **Conversation transcript indexing:** New `transcript` content type in embedding pipeline; requires chunking strategy and conversation export path
- **Health/wearable data integration:** Oura Ring API pipeline for sleep, HRV, activity data
- **Static ICS calendar feed:** Generate `.ics` from tasks with `due_date`/`scheduled_date` for calendar subscription
- **TTFT measurement tool:** React artifact for A/B testing context injection latency across payload sizes
- **LLM bootstrap files:** Per-environment config for AI assistants beyond Claude Code (`.cursorrules`, `AGENTS.md`, custom system prompts)
- **Handoff migration to PostgreSQL:** Evaluate moving append-only JSON handoffs to a Postgres events table
- **Query builder refactor:** Replace dynamic SQL assembly in search tools with a query builder pattern
- **Model-agnostic tool description compatibility:** Two-tier system for tool descriptions that adapts to model capability
- **Entity/keyword metadata extraction:** Automated entity extraction during embedding pipeline (Phase E concept linking enabler)
- **Search alias expansion via entity graph:** Entity-graph-augmented retrieval that catches relevant docs neither keyword nor embedding similarity surfaces
