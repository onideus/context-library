-- Entity graph extraction schema.
-- Provides storage for knowledge graph triples extracted from content (notes, tasks, handoffs).
-- These tables support graph-augmented retrieval in search_context (future roadmap).
--
-- Note: The existing 'entities' table (003_entities.sql) stores seed-based context
-- envelope entities. This migration adds separate tables for extracted entity knowledge
-- graphs with a different schema and semantics (type-aware, mention-counted).

-- Canonical entities deduplicated across all extraction runs.
-- UNIQUE(canonical_name, entity_type) allows the same name to represent
-- different entity types (e.g., "Python" as both a language and a project).
CREATE TABLE IF NOT EXISTS entity_nodes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    entity_type     TEXT NOT NULL,
    canonical_name  TEXT NOT NULL,
    first_seen      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    mention_count   INTEGER NOT NULL DEFAULT 1,
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(canonical_name, entity_type)
);

CREATE INDEX IF NOT EXISTS idx_entity_nodes_canonical ON entity_nodes(canonical_name);
CREATE INDEX IF NOT EXISTS idx_entity_nodes_type ON entity_nodes(entity_type);

-- Entity relations: triples extracted from content.
-- Each triple links two entity_nodes with a typed predicate, attributed to a
-- specific provider/run and back-referenced to the source content item.
CREATE TABLE IF NOT EXISTS entity_relations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_entity_id    UUID NOT NULL REFERENCES entity_nodes(id) ON DELETE CASCADE,
    target_entity_id    UUID NOT NULL REFERENCES entity_nodes(id) ON DELETE CASCADE,
    relation_type       TEXT NOT NULL,
    confidence          REAL NOT NULL DEFAULT 1.0,
    provider            TEXT NOT NULL,
    provider_version    TEXT,
    extraction_run_id   UUID,
    source_content_type TEXT NOT NULL,
    source_content_id   UUID NOT NULL,
    context_snippet     TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_entity_relations_source ON entity_relations(source_entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_relations_target ON entity_relations(target_entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_relations_provider ON entity_relations(provider);
CREATE INDEX IF NOT EXISTS idx_entity_relations_run ON entity_relations(extraction_run_id);
CREATE INDEX IF NOT EXISTS idx_entity_relations_content ON entity_relations(source_content_type, source_content_id);

-- Extraction runs: metadata for tracking and A/B comparison across providers.
CREATE TABLE IF NOT EXISTS extraction_runs (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider         TEXT NOT NULL,
    provider_version TEXT,
    status           TEXT NOT NULL DEFAULT 'running',
    content_scope    TEXT,
    content_count    INTEGER DEFAULT 0,
    triple_count     INTEGER DEFAULT 0,
    started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at     TIMESTAMPTZ,
    config           JSONB DEFAULT '{}',
    error            TEXT
);
