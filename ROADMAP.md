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

## Current: v0.5.0 Initial Release

- Security audit (logging sanitization, secrets parameterization)
- Test coverage (unit tests for merge logic, extraction, chunking)
- Documentation (README, ROADMAP, CLAUDE.md)
- Tool description accuracy audit

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

### Infrastructure
- CI/CD pipeline (GitHub Actions)
- Contributor guide (CONTRIBUTING.md)
