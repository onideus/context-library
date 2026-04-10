# Cognition Bridge — Roadmap

## Design Philosophy: Three Primitives

Cognition Bridge is built around three distinct data types that map to three questions:

- **Handoffs** → *Where am I?* — Operational state captured at session boundaries. Ephemeral, append-only, scoped by time.
- **Tasks** → *What do I need to do?* — Action items with lifecycles (open → completed/cancelled/deferred). Queryable, filterable, finite.
- **Knowledge** *(planned)* → *What do I know?* — Captured thinking, article takeaways, pattern recognition, connections between ideas. Accrues indefinitely. No status lifecycle. Retrieved by meaning, not by deadline.

All three primitives share a unified semantic search index (pgvector + FTS with RRF fusion), enabling cross-type retrieval: a search for "authentication architecture" returns relevant handoff context, open tasks, and accumulated knowledge together.

## Completed

- Handoff tools (store, get, patch) with append-only file storage
- Task management (CRUD + full-text search) on PostgreSQL
- Semantic search via pgvector + TEI embeddings with hybrid RRF fusion
- Recursive text extraction + chunking for handoff indexing
- Auth0 RS256 JWT validation
- Docker Compose deployment (NAS: CB + Postgres + auth proxy + tunnel)
- TEI embedding server on desktop (separate compose)
- Scope filtering (full/work/personal) on handoff retrieval

## Current: v0.5.0 Hardening

- Security audit (logging sanitization, secrets parameterization)
- Test coverage (unit tests for merge logic, extraction, chunking)
- Documentation updates (CLAUDE.md, README, ROADMAP)
- Tool description accuracy audit
- Codebase cleanup for open-source release

## Future

### Knowledge Layer (Third Primitive)
- `notes` table in PostgreSQL: id, title, content (interpretation, not summary), source_url, source_title, scope, tags, timestamps
- MCP tools: `create_note`, `search_notes`, `list_notes`, `get_note`
- Embedded into pgvector alongside handoffs and tasks for unified semantic search
- Distinct from artifact storage (file attachments) — knowledge is first-class, not metadata on another object

### Schema Evolution
- Handoff schema versioning strategy for forward/backward compatibility
- Migration tooling for schema changes across stored handoff files
- Evaluate migrating append-only JSON handoffs to PostgreSQL events table

### Artifact Storage
- File/content storage with metadata, SHA-256 hashing, versioning
- Prompt library via tagging convention on artifacts

### Integrations
- Oura ring health data integration
- Calendar/scheduling data feeds

### Open-Source Prep
- Remove all personal references from codebase
- Parameterize all deployment-specific configuration
- Write contributor guide
- CI/CD pipeline (GitHub Actions)
