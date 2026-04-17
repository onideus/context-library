-- Pending embeddings queue (dead-letter pattern for TEI outage recovery).
-- Items land here when the embedding server is unreachable during store/patch;
-- the drainPendingEmbeddings() function processes them once TEI is back online.

CREATE TABLE IF NOT EXISTS pending_embeddings (
    id              SERIAL          PRIMARY KEY,
    content_type    TEXT            NOT NULL CHECK (content_type IN ('handoff', 'task')),
    content_id      TEXT            NOT NULL,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
    retry_count     INTEGER         NOT NULL DEFAULT 0,
    last_error      TEXT,

    UNIQUE (content_type, content_id)
);

CREATE INDEX IF NOT EXISTS idx_pending_embeddings_created
    ON pending_embeddings (created_at ASC);
