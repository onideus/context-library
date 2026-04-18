-- Artifact layer: permanent, searchable generated outputs with lifecycle state.
-- Fourth primitive alongside handoffs (ephemeral), tasks (lifecycle), notes (knowledge).

CREATE TABLE IF NOT EXISTS artifacts (
    id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    title             TEXT          NOT NULL,
    artifact_type     TEXT          NOT NULL,  -- 'cc-prompt', 'research', 'blog-post', 'template', 'presentation'
    content           TEXT,                    -- inline content for small artifacts (prompts, short docs)
    pointer           JSONB,                   -- {type: 'git', repo, branch, path} | {type: 'local', path} | {type: 'url', href}
    status            TEXT          NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'ready', 'executing', 'completed', 'superseded')),
    scope             TEXT          NOT NULL CHECK (scope IN ('work', 'personal', 'shared')),
    tags              TEXT[]        DEFAULT '{}',
    dependencies      UUID[]        DEFAULT '{}',   -- other artifact IDs that must complete first
    execution_order   INTEGER,                       -- ordering within a batch (1, 2, 3...)
    related_task_ids  UUID[]        DEFAULT '{}',
    metadata          JSONB         DEFAULT '{}',    -- flexible: {branch_target, model, surface, batch_label}
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts (artifact_type);
CREATE INDEX IF NOT EXISTS idx_artifacts_status ON artifacts (status);
CREATE INDEX IF NOT EXISTS idx_artifacts_scope ON artifacts (scope);
CREATE INDEX IF NOT EXISTS idx_artifacts_tags ON artifacts USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_artifacts_created ON artifacts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_execution_order ON artifacts (execution_order);

-- Full-text search on title + content
CREATE INDEX IF NOT EXISTS idx_artifacts_fts ON artifacts
    USING GIN (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, '')));

-- Reuse update_updated_at() trigger function from 001_tasks.sql
DROP TRIGGER IF EXISTS artifacts_updated_at ON artifacts;
CREATE TRIGGER artifacts_updated_at
    BEFORE UPDATE ON artifacts
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();
