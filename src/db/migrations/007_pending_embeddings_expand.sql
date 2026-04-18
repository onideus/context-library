-- Expand pending_embeddings.content_type CHECK constraint to include
-- 'note' and 'artifact' so the resilience queue can hold all indexable
-- primitives (not just handoffs and tasks).

ALTER TABLE pending_embeddings
    DROP CONSTRAINT IF EXISTS pending_embeddings_content_type_check;

ALTER TABLE pending_embeddings
    ADD CONSTRAINT pending_embeddings_content_type_check
    CHECK (content_type IN ('handoff', 'task', 'note', 'artifact'));
