-- Knowledge layer: permanent, searchable notes.
-- Distinct from tasks (no lifecycle) and handoffs (not ephemeral).

CREATE TABLE IF NOT EXISTS notes (
    id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    title             TEXT          NOT NULL,
    content           TEXT          NOT NULL,
    domain            TEXT,
    tags              TEXT[]        DEFAULT '{}',
    scope             TEXT          NOT NULL CHECK (scope IN ('work', 'personal', 'shared')),
    source_url        TEXT,
    related_task_ids  UUID[]        DEFAULT '{}',
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notes_scope ON notes (scope);
CREATE INDEX IF NOT EXISTS idx_notes_tags ON notes USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_notes_domain ON notes (domain);
CREATE INDEX IF NOT EXISTS idx_notes_created ON notes (created_at DESC);

-- Full-text search on title + content
CREATE INDEX IF NOT EXISTS idx_notes_fts ON notes
    USING GIN (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, '')));

-- Reuse update_updated_at() trigger function from 001_tasks.sql
DROP TRIGGER IF EXISTS notes_updated_at ON notes;
CREATE TRIGGER notes_updated_at
    BEFORE UPDATE ON notes
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();
