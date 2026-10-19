-- Note lifecycle, provenance, and version history.
-- Design: docs/design/note-lifecycle.md
--
-- 1. Lifecycle columns on notes: status (active | superseded), superseded_by,
--    superseded_at, valid_until. `expired` is NOT a stored status — it is
--    computed at read time from valid_until (design §3.3), so there is one
--    source of truth and nothing needs a cron to flip it.
--
-- 2. provenance: where the note's content came from (stated | decided |
--    inferred | fetched | derived). Nullable; every pre-existing row stays
--    NULL ("not recorded"). Deliberately no default — a defaulted provenance
--    is a false one.
--
-- 3. version + note_versions: a BEFORE UPDATE trigger bumps `version` and
--    snapshots the prior row into note_versions on every effective update.
--    Putting the invariant in the database means it holds for every writer
--    — MCP tools, /sync/push, future tools, an operator's psql — not just the
--    paths that remember to call a helper. A no-op UPDATE (nothing but
--    updated_at would change) is a true no-op: no bump, no history row.
--
-- The superseded_by FK is NO ACTION (a raw DELETE of a successor fails loudly
-- instead of leaving a predecessor "superseded by nothing"), DEFERRABLE so a
-- restore can load self-referencing rows in id order under SET CONSTRAINTS
-- ALL DEFERRED, and INITIALLY IMMEDIATE so ordinary writes see FK errors at
-- statement time rather than at COMMIT.
--
-- Every statement is idempotent; the file is safe to re-run. Constraints are
-- added by explicit name inside the DO block (never inline on ADD COLUMN IF
-- NOT EXISTS) so a re-run neither errors nor duplicates them.

ALTER TABLE notes ADD COLUMN IF NOT EXISTS status        TEXT        NOT NULL DEFAULT 'active';
ALTER TABLE notes ADD COLUMN IF NOT EXISTS superseded_by UUID;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS valid_until   TIMESTAMPTZ;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS provenance    TEXT;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS version       INTEGER     NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'notes'::regclass AND conname = 'chk_notes_status') THEN
    ALTER TABLE notes ADD CONSTRAINT chk_notes_status
      CHECK (status IN ('active', 'superseded'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'notes'::regclass AND conname = 'chk_notes_provenance') THEN
    ALTER TABLE notes ADD CONSTRAINT chk_notes_provenance
      CHECK (provenance IS NULL OR provenance IN ('stated', 'decided', 'inferred', 'fetched', 'derived'));
  END IF;

  -- A superseded note always names its successor; an active note never does.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'notes'::regclass AND conname = 'chk_notes_superseded_shape') THEN
    ALTER TABLE notes ADD CONSTRAINT chk_notes_superseded_shape
      CHECK ((status = 'superseded') = (superseded_by IS NOT NULL));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'notes'::regclass AND conname = 'chk_notes_superseded_at') THEN
    ALTER TABLE notes ADD CONSTRAINT chk_notes_superseded_at
      CHECK ((status = 'superseded') = (superseded_at IS NOT NULL));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'notes'::regclass AND conname = 'chk_notes_no_self_supersede') THEN
    ALTER TABLE notes ADD CONSTRAINT chk_notes_no_self_supersede
      CHECK (superseded_by IS NULL OR superseded_by <> id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'notes'::regclass AND conname = 'fk_notes_superseded_by') THEN
    ALTER TABLE notes ADD CONSTRAINT fk_notes_superseded_by
      FOREIGN KEY (superseded_by) REFERENCES notes(id)
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

-- Reverse lookup ("what did this note replace?"), chain walks, and the
-- delete-time splice all look up predecessors by superseded_by.
CREATE INDEX IF NOT EXISTS idx_notes_superseded_by ON notes (superseded_by)
    WHERE superseded_by IS NOT NULL;

-- Lifecycle predicates used by list_notes' status filter and by the search
-- tools' candidate selection (valid_until IS NULL OR valid_until > now(),
-- optionally AND status = 'active').
CREATE INDEX IF NOT EXISTS idx_notes_lifecycle ON notes (status, valid_until);

-- Row (note_id, k) is the note as it was at version k. History of a note is
-- its note_versions rows (v1 .. vN-1) plus the current row (vN). Composite PK,
-- no surrogate id: it round-trips through export/import verbatim and gives a
-- deterministic ORDER BY note_id, version. Cascades with the note — delete_note
-- promises permanent deletion, and orphan history would make "delete" not
-- delete content.
CREATE TABLE IF NOT EXISTS note_versions (
    note_id        UUID         NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    version        INTEGER      NOT NULL,
    snapshot       JSONB        NOT NULL,
    changed_fields TEXT[]       NOT NULL,
    changed_via    TEXT         NOT NULL,
    changed_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    PRIMARY KEY (note_id, version)
);

-- Versioning trigger. Fires AFTER notes_updated_at by name order ('u' < 'v'),
-- which is what lets the no-op branch undo that trigger's timestamp bump.
--
-- changed_via comes from a transaction-local GUC the write path sets with
-- set_config('app.changed_via', <writer>, true). A writer that never sets it
-- (raw SQL) is recorded as 'sql'. When the GUC has been set once in a
-- session and later reset, current_setting returns '' — hence NULLIF.
CREATE OR REPLACE FUNCTION notes_version_history()
RETURNS TRIGGER AS $$
DECLARE
  old_j   JSONB := to_jsonb(OLD);
  new_j   JSONB := to_jsonb(NEW);
  changed TEXT[];
BEGIN
  SELECT COALESCE(array_agg(o.key ORDER BY o.key), '{}')
    INTO changed
    FROM jsonb_each(old_j) AS o
   WHERE o.key NOT IN ('version', 'updated_at')
     AND (new_j -> o.key) IS DISTINCT FROM o.value;

  IF cardinality(changed) = 0 THEN
    NEW.updated_at := OLD.updated_at;
    NEW.version    := OLD.version;
    RETURN NEW;
  END IF;

  INSERT INTO note_versions (note_id, version, snapshot, changed_fields, changed_via)
  VALUES (
    OLD.id,
    OLD.version,
    old_j - 'id' - 'version' - 'created_at',
    changed,
    COALESCE(NULLIF(current_setting('app.changed_via', true), ''), 'sql')
  );

  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notes_version_history ON notes;
CREATE TRIGGER notes_version_history
    BEFORE UPDATE ON notes
    FOR EACH ROW
    EXECUTE FUNCTION notes_version_history();
