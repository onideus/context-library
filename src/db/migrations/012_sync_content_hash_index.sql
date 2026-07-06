-- Sync foundation follow-up: functional index for content-on-demand lookups.
--
-- GET /sync/content/:content_hash and internal metadata lookups filter
-- artifacts on `metadata->>'content_hash' = $1`. Without an index over that
-- expression, every call scans the artifacts table — the mobile hot path
-- (iOS Phase 2b) opens an artifact whenever the user taps one, so a full
-- scan per open is unacceptable even at modest table sizes.
--
-- A B-tree functional index over the extracted text works because content
-- hashes are exact-match lookups (never range scans, never prefix scans);
-- there is no ordering semantic to preserve. IF NOT EXISTS keeps the
-- migration idempotent for re-runs and for deployments where an operator
-- may have created it by hand ahead of time.

CREATE INDEX IF NOT EXISTS idx_artifacts_content_hash
    ON artifacts ((metadata->>'content_hash'))
    WHERE metadata ? 'content_hash';
