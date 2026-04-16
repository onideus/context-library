# Context Library — Roadmap

## Design Philosophy: Three Primitives

Context Library is built around three distinct data types that map to three questions:

- **Handoffs** → *Where am I?* — Operational state captured at session boundaries. Ephemeral, append-only, scoped by time.
- **Tasks** → *What do I need to do?* — Action items with lifecycles (open → completed/cancelled/deferred). Queryable, filterable, finite.
- **Knowledge** *(planned)* → *What do I know?* — Captured thinking, article takeaways, pattern recognition, connections between ideas. Accrues indefinitely. No status lifecycle. Retrieved by meaning, not by deadline.

All three primitives share a unified semantic search index (pgvector + FTS with RRF fusion), enabling cross-type retrieval: a search for "authentication architecture" returns relevant handoff context, open tasks, and accumulated knowledge together.

## Completed

- Handoff tools (store, get, patch) with append-only file storage
- Task management (CRUD + full-text search) on PostgreSQL
- Semantic search via pgvector + TEI embeddings with hybrid RRF fusion
- Recursive text extraction + chunking for handoff indexing
- OAuth delegated to mcp-auth-proxy
- Three-tier Docker Compose deployment (core → Postgres → embeddings)
- Scope filtering (full/work/personal) on handoff retrieval
- Open-source release preparation (v0.5.0)
- CI/CD pipeline with Snyk gates and GHCR publishing (GitHub Actions)
- TEI compose profiles for GPU and CPU deployment
- Entity system with context envelopes for entity-aware search

## Current: v0.5.1

- Entity system: canonical names, aliases, scope, constraints, boundary notices
- JIT context envelopes injected into search results when entities are referenced
- Proactive tool descriptions updated to reflect entity awareness
- Pipeline hardening: Dockerfile fix, Postgres CI, reusable workflows, notifications

## Next: v0.5.2

- Judgment-class request gating (`evidence_pulled` field)
- Per-model response format tuning
- CLI `extract-entities` bootstrap script
- `last_referenced` timestamp population

## Future

### LLM Bootstrap Files
- Per-environment configuration files for different AI assistants and coding tools
- Goal: anyone can use their preferred LLM/environment with a bootstrap file that provides project context
- Examples: CLAUDE.md (Claude Code), .cursorrules (Cursor), AGENTS.md (Codex), custom system prompts
- Each file teaches the respective tool about Context Library's architecture, conventions, and development workflow

### Knowledge Layer (Third Primitive)
- `notes` table in PostgreSQL: id, title, content (interpretation, not summary), source_url, source_title, scope, tags, timestamps
- MCP tools: `create_note`, `search_notes`, `list_notes`, `get_note`
- Embedded into pgvector alongside handoffs and tasks for unified semantic search
- Distinct from artifact storage (file attachments) — knowledge is first-class, not metadata on another object

### Schema Evolution
- Handoff schema versioning strategy for forward/backward compatibility
- Migration tooling for schema changes across stored handoff files
- Evaluate migrating append-only JSON handoffs to PostgreSQL events table
- Migrate `z.any()` to `z.unknown()` in handoff schemas and tool parameter definitions for stricter type safety

### Artifact Storage
- File/content storage with metadata, SHA-256 hashing, versioning
- Prompt library via tagging convention on artifacts

### Integrations
- Health/wearable data integration (e.g., Oura, Whoop, Apple Health)
- Calendar/scheduling data feeds

### Infrastructure
- Refactor dynamic SQL assembly in search tools to a query builder pattern for maintainability
