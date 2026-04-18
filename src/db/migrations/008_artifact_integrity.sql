-- Artifact integrity follow-ups to the v0.7.0 artifact layer.
--
-- 1. Partial unique index enforces unique execution_order within each
--    artifact_type when execution_order is set. NULL execution_orders remain
--    unconstrained so artifacts without an assigned slot can coexist freely
--    (this preserves backward compatibility with v0.7.0 rows).
--
-- 2. GIN index on the dependencies array enables efficient reverse-lookup
--    queries ("what artifacts depend on X?"). Full referential integrity via
--    a junction table with foreign keys is deferred to v0.8; write-time
--    validation in the MCP tools closes the immediate gap.

CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_type_exec_order_unique
    ON artifacts (artifact_type, execution_order)
    WHERE execution_order IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_artifacts_dependencies
    ON artifacts USING GIN (dependencies);
