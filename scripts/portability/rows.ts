/**
 * Pure row-level helpers for import: building the INSERT for one JSONL row,
 * and the cross-table consistency check on note history. No database, no
 * filesystem — everything here is unit-testable without Postgres.
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
 * Verify that a tarball's `notes` and `note_versions` rows can coexist.
 *
 * `note_versions` is written by a trigger in the same transaction as every
 * note edit, and row (note_id, k) is the note as it was at version k — so
 * every history row must be strictly older than its note's current `version`.
 * If a history row had version >= the note's, restoring it would leave the
 * note permanently uneditable: the next UPDATE tries to write history row
 * (note_id, note.version) and collides on the primary key. And a history row
 * whose note is missing cannot be restored at all (FK) — after a `--force`
 * truncate that would fail half-way through the load.
 *
 * Both are tarball-level defects (a pre-fix export that read tables from
 * separate snapshots, a hand-edited file), so this fails fast, before any
 * database write, in the same class as "Tarball corrupt".
 *
 * A `notes` row with no `version` key (a tarball older than the lifecycle
 * columns) restores with the column default, 1, so it is treated as version 1.
 *
 * Accepts sync or async iterables so tests can pass arrays and the import
 * script can pass streaming JSONL readers.
 */
export async function checkNoteHistoryConsistency(
  notes: RowSource,
  history: RowSource
): Promise<void> {
  const noteVersions = new Map<string, number>();
  for await (const note of notes) {
    const version = note.version === undefined || note.version === null ? 1 : note.version;
    if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
      throw new Error(
        `Tarball inconsistent: notes row ${String(note.id)} has an invalid version ` +
          `(${JSON.stringify(version)}); expected a positive integer`
      );
    }
    noteVersions.set(String(note.id), version);
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
