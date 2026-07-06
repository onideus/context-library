/**
 * Manifest shape for export tarballs.
 *
 * The manifest is the single source of truth for import validation:
 *   - `applied_migrations` — verified against the destination `_migrations`
 *     table; the destination must be at or beyond every migration listed
 *     here or import refuses to proceed
 *   - `row_counts` — verified after each JSONL load; a mismatch aborts the
 *     table's transaction
 *   - `embedding_model` / `embedding_dimensions` — compared against the
 *     destination's current config to decide whether to re-embed
 *   - `handoff_schema_versions` — informational; the reader tolerates any
 *     schema_version present in the handoff files
 */

export const MANIFEST_VERSION = 1;

export interface ExportManifest {
  /** Schema version for the manifest itself. Bump when this shape changes. */
  manifest_version: number;
  /** Semver from package.json / APP_VERSION at export time. */
  app_version: string;
  /**
   * ISO-8601 timestamp when the export ran. OPTIONAL.
   *
   * Historical exports (manifest v1 prior to the deterministic-diff fix)
   * included this field, and the import path still reads it when present
   * for human-friendly logging. Fresh exports omit it so that consecutive
   * exports of an unchanged database produce byte-identical `manifest.json`
   * output — the timestamp is already carried in the tarball filename, so
   * losing it here does not lose information. See `docs/backup-restore.md`
   * "Nightly export" for the diff-committed backup pattern this enables.
   */
  exported_at?: string;
  /** Applied migration filenames (e.g. "007_pending_embeddings_expand.sql"). */
  applied_migrations: string[];
  /** Distinct schema_version values observed in handoff files. */
  handoff_schema_versions: number[];
  /** Number of handoff JSON files in the tarball. */
  handoff_file_count: number;
  /** Embedding model name at export time (informational for the operator). */
  embedding_model: string;
  /** Vector dimensions at export time. */
  embedding_dimensions: number;
  /** true when --include-embeddings was passed at export. */
  includes_embeddings: boolean;
  /** Rows per table (JSONL file). Missing tables are treated as zero. */
  row_counts: Record<string, number>;
}
