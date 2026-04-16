-- Entity table for JIT context envelope (v0.5.1)
-- Stores canonical entities with scope, aliases, and constraints.
-- Schema only — actual entity data loads from deployment-local seed files.

CREATE TABLE IF NOT EXISTS entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL CHECK (scope IN ('work', 'personal', 'shared')),
  aliases TEXT[] DEFAULT '{}',
  constraints TEXT[] DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  last_referenced TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_entities_scope ON entities(scope);
CREATE INDEX idx_entities_canonical ON entities(canonical_name);
CREATE INDEX idx_entities_aliases ON entities USING GIN(aliases);

-- Auto-update updated_at trigger (same pattern as tasks table)
CREATE OR REPLACE FUNCTION update_entities_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_entities_updated_at
  BEFORE UPDATE ON entities
  FOR EACH ROW
  EXECUTE FUNCTION update_entities_updated_at();
