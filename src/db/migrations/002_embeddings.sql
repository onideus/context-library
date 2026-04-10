-- Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- Embeddings table — stores vector representations of any CB content type
CREATE TABLE IF NOT EXISTS embeddings (
    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    content_type    TEXT            NOT NULL,  -- 'handoff', 'task', 'document', 'transcript'
    content_id      TEXT            NOT NULL,  -- filename for handoffs, UUID for tasks
    content_text    TEXT            NOT NULL,  -- the raw text that was embedded
    embedding       vector(768)     NOT NULL,  -- nomic-embed-text-v2-moe native dimension
    metadata        JSONB           DEFAULT '{}',
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),

    UNIQUE(content_type, content_id)
);

-- HNSW index for cosine similarity
-- m=16, ef_construction=128 are optimal for <10K vectors
CREATE INDEX IF NOT EXISTS idx_embeddings_vector
    ON embeddings USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 128);

-- Filter indexes
CREATE INDEX IF NOT EXISTS idx_embeddings_content_type ON embeddings (content_type);
CREATE INDEX IF NOT EXISTS idx_embeddings_metadata ON embeddings USING GIN (metadata);

-- Full-text search index on content_text for hybrid search
CREATE INDEX IF NOT EXISTS idx_embeddings_fts
    ON embeddings USING GIN (to_tsvector('english', content_text));

-- Reuse update_updated_at() trigger function from 001_tasks.sql
DROP TRIGGER IF EXISTS embeddings_updated_at ON embeddings;
CREATE TRIGGER embeddings_updated_at
    BEFORE UPDATE ON embeddings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();
