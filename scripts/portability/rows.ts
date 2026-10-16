/**
 * Pure row-level helpers for import: building the INSERT for one JSONL row,
 * and the cross-row consistency check on notes and their history. No database,
 * no filesystem — everything here is unit-testable without Postgres.
 */

import type { TableSpec } from "./tables.js";

/**
 * Build the parameterised INSERT for one JSONL row of `spec`.
 *
 * Absent vs null is a deliberate distinction:
 *   - A column ABSENT from the row object is emitted as the SQL keyword
 *     `DEFAULT` — no placeholder, no cast, nothing bound. This is what lets a
 *     tarball written before a column existed (for example the notes
 *     lifecycle columns, or any NOT NULL column with a default) restore: the
 *     destination's column default supplies the value.
 *   - A column present with `null` binds SQL NULL. An explicit null in the
 *     tarball means the exporter saw NULL, and must stay NULL.
 *
 * Placeholders are numbered consecutively over the bound values only, so an
 * absent column never leaves a gap in the `$n` sequence. `jsonb` casts still
 * JSON.stringify non-null values (node-pg would otherwise serialise a JS array
 * as a Postgres array literal rather than JSON).
 *
 * Neutral for current tarballs: the exporter always writes every column, so
 * nothing is ever absent and the output matches the pre-DEFAULT behaviour.
 */
export function buildInsert(
  spec: TableSpec,
  row: Record<string, unknown>
): { sql: string; values: unknown[] } {
  const values: unknown[] = [];
  const slots: string[] = [];

  for (const col of spec.columns) {
    // hasOwn, not `in`: a JSONL key must be an own property of the parsed
    // object, never something inherited from Object.prototype.
    if (!Object.hasOwn(row, col)) {
      slots.push("DEFAULT");
      continue;
    }

    const raw = row[col] ?? null;
    const cast = spec.casts?.[col];
    const n = values.length + 1;

    if (cast === "jsonb") {
      // JSONB casts require the value to be a JSON *string*.
      values.push(raw === null ? null : JSON.stringify(raw));
      slots.push(`$${n}::jsonb`);
    } else if (cast) {
      values.push(raw);
      slots.push(`$${n}::${cast}`);
    } else {
      values.push(raw);
      slots.push(`$${n}`);
    }
  }

  const sql =
    `INSERT INTO ${spec.name} (${spec.columns.join(", ")}) ` +
    `VALUES (${slots.join(", ")})`;
  return { sql, values };
}

type RowSource = Iterable<Record<string, unknown>> | AsyncIterable<Record<string, unknown>>;

/**
 * Verify that a tarball's `notes` and `note_versions` rows can be restored
 * together, before anything is written. Three defects are caught; each would
 * otherwise surface only after a `--force` truncate:
 *
 * 1. A `note_versions` row whose version is not strictly below its note's
 *    current `version`. The trigger writes history row (note_id, k) = the
 *    note as it was at version k, so every history row must be older than the
 *    note. Restoring a row with version >= the note's would leave the note
 *    permanently uneditable: the next UPDATE tries to write history row
 *    (note_id, note.version) and collides on the primary key.
 * 2. A `note_versions` row whose note is missing from `notes` (FK failure
 *    half-way through the load).
 * 3. A `notes.superseded_by` naming a note that is not in `notes`. The FK is
 *    deferred while a table loads, so it would fail at that table's COMMIT.
 *
 * All are tarball-level defects (a pre-fix export that read tables from
 * separate snapshots, a hand-edited or truncated file), so this fails fast, in
 * the same class as "Tarball corrupt".
 *
 * An empty `notes` is a valid input: pass `[]` when notes.jsonl is absent and
 * any history row is then (correctly) an orphan. A `notes` row with no
 * `version` key (a tarball older than the lifecycle columns) restores with the
 * column default, 1, so it is treated as version 1.
 *
 * Accepts sync or async iterables so tests can pass arrays and the import
 * script can pass streaming JSONL readers.
 */
export async function checkNotesConsistency(
  notes: RowSource,
  history: RowSource
): Promise<void> {
  const noteVersions = new Map<string, number>();
  const supersededBy: Array<[id: string, successor: string]> = [];
  for await (const note of notes) {
    const id = String(note.id);
    const version = note.version === undefined || note.version === null ? 1 : note.version;
    if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
      throw new Error(
        `Tarball inconsistent: notes row ${id} has an invalid version ` +
          `(${JSON.stringify(version)}); expected a positive integer`
      );
    }
    noteVersions.set(id, version);
    if (note.superseded_by !== undefined && note.superseded_by !== null) {
      supersededBy.push([id, String(note.superseded_by)]);
    }
  }

  // Checked after the whole file is read: a successor may sort after the note
  // that points at it (ids load in order, the reference can run forward).
  for (const [id, successor] of supersededBy) {
    if (!noteVersions.has(successor)) {
      throw new Error(
        `Tarball inconsistent: note ${id} superseded_by ${successor} ` +
          `which is not in notes.jsonl`
      );
    }
  }

  for await (const row of history) {
    const noteId = String(row.note_id);
    const version = row.version;
    const current = noteVersions.get(noteId);
    if (current === undefined) {
      throw new Error(
        `Tarball inconsistent: note_versions row (${noteId}, v${String(version)}) ` +
          `references a note that is not in notes.jsonl`
      );
    }
    if (typeof version !== "number" || !Number.isInteger(version) || version >= current) {
      throw new Error(
        `Tarball inconsistent: note_versions row (${noteId}, v${String(version)}) ` +
          `is not older than the note's current version (v${current}); every history row ` +
          `must have version < the note's version, or the restored note could never be edited ` +
          `again. The export was likely taken from inconsistent snapshots or the tarball was ` +
          `edited by hand`
      );
    }
  }
}
