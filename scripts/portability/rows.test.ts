import { describe, it, expect } from "vitest";
import { buildInsert, checkNotesConsistency } from "./rows.js";
import { TABLES, specForTable, type TableSpec } from "./tables.js";

/**
 * Pure unit tests — no Postgres, no filesystem. Fixtures are generic; this
 * repo is public.
 */

const NOTE_ID = "20000000-0000-0000-0000-0000000000a1";
const SUCCESSOR_ID = "20000000-0000-0000-0000-0000000000a2";

/** A notes row exactly as the exporter writes it: every column present. */
function fullNotesRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: NOTE_ID,
    title: "Acme Corp deploy freeze",
    content: "Acme Corp froze Friday deploys.",
    domain: "operations",
    tags: ["deploys", "acme"],
    scope: "shared",
    source_url: null,
    related_task_ids: [],
    status: "superseded",
    superseded_by: SUCCESSOR_ID,
    superseded_at: "2026-05-02T09:30:00.000Z",
    valid_until: "2026-12-31T00:00:00.000Z",
    provenance: "decided",
    version: 3,
    created_at: "2026-03-01T10:00:00.000Z",
    updated_at: "2026-05-02T09:30:00.000Z",
    ...overrides,
  };
}

const NEW_NOTES_COLUMNS = [
  "status",
  "superseded_by",
  "superseded_at",
  "valid_until",
  "provenance",
  "version",
];

function notesSpec(): TableSpec {
  const spec = specForTable("notes");
  if (!spec) throw new Error("notes spec missing from TABLES");
  return spec;
}

function noteVersionsSpec(): TableSpec {
  const spec = specForTable("note_versions");
  if (!spec) throw new Error("note_versions spec missing from TABLES");
  return spec;
}

describe("buildInsert", () => {
  it("binds every column, in spec order, when all columns are present", () => {
    const spec = notesSpec();
    const row = fullNotesRow();
    const { sql, values } = buildInsert(spec, row);

    expect(sql).toBe(
      `INSERT INTO notes (${spec.columns.join(", ")}) VALUES (` +
        spec.columns.map((_, i) => `$${i + 1}`).join(", ") +
        ")"
    );
    expect(values).toEqual(spec.columns.map((c) => row[c]));
    expect(sql).not.toContain("DEFAULT");
  });

  it("emits DEFAULT for an absent column and renumbers placeholders consecutively", () => {
    const spec: TableSpec = { name: "t", columns: ["a", "b", "c", "d"], orderBy: "a" };
    const { sql, values } = buildInsert(spec, { a: 1, c: 3 });

    expect(sql).toBe("INSERT INTO t (a, b, c, d) VALUES ($1, DEFAULT, $2, DEFAULT)");
    expect(values).toEqual([1, 3]);
  });

  it("binds NULL for a column that is present with null (absent and null are different)", () => {
    const spec: TableSpec = { name: "t", columns: ["a", "b", "c"], orderBy: "a" };
    const { sql, values } = buildInsert(spec, { a: 1, b: null });

    expect(sql).toBe("INSERT INTO t (a, b, c) VALUES ($1, $2, DEFAULT)");
    expect(values).toEqual([1, null]);
  });

  it("emits DEFAULT for every column when the row is empty", () => {
    const spec: TableSpec = { name: "t", columns: ["a", "b"], orderBy: "a" };
    const { sql, values } = buildInsert(spec, {});

    expect(sql).toBe("INSERT INTO t (a, b) VALUES (DEFAULT, DEFAULT)");
    expect(values).toEqual([]);
  });

  it("stringifies a jsonb value and keeps the ::jsonb cast", () => {
    const spec = noteVersionsSpec();
    const snapshot = { title: "Acme Corp Friday deploys", tags: ["deploys"], nested: { k: 1 } };
    const { sql, values } = buildInsert(spec, {
      note_id: NOTE_ID,
      version: 1,
      snapshot,
      changed_fields: ["content", "title"],
      changed_via: "update_note",
      changed_at: "2026-04-01T08:00:00.000Z",
    });

    expect(sql).toBe(
      "INSERT INTO note_versions (note_id, version, snapshot, changed_fields, changed_via, changed_at) " +
        "VALUES ($1, $2, $3::jsonb, $4, $5, $6)"
    );
    // The jsonb parameter must be a JSON *string*, not the object (node-pg would
    // otherwise serialise a JS array as a Postgres array literal).
    expect(values[2]).toBe(JSON.stringify(snapshot));
    // A text[] column is passed as a plain array for node-pg to convert.
    expect(values[3]).toEqual(["content", "title"]);
  });

  it("binds a null jsonb value as NULL (not the string \"null\") with the cast kept", () => {
    const spec: TableSpec = {
      name: "t",
      columns: ["id", "metadata"],
      orderBy: "id",
      casts: { metadata: "jsonb" },
    };
    const { sql, values } = buildInsert(spec, { id: "x", metadata: null });

    expect(sql).toBe("INSERT INTO t (id, metadata) VALUES ($1, $2::jsonb)");
    expect(values).toEqual(["x", null]);
  });

  it("emits DEFAULT with no cast for an absent cast column and renumbers after it", () => {
    const spec: TableSpec = {
      name: "t",
      columns: ["id", "metadata", "status", "name"],
      orderBy: "id",
      casts: { metadata: "jsonb", status: "task_status" },
    };
    const { sql, values } = buildInsert(spec, { id: "x", name: "n" });

    expect(sql).toBe("INSERT INTO t (id, metadata, status, name) VALUES ($1, DEFAULT, DEFAULT, $2)");
    expect(sql).not.toMatch(/DEFAULT::/);
    expect(values).toEqual(["x", "n"]);
  });

  it("keeps a non-jsonb cast on a present column and numbers it over bound values only", () => {
    const spec: TableSpec = {
      name: "t",
      columns: ["id", "status", "name"],
      orderBy: "id",
      casts: { status: "task_status" },
    };
    const { sql, values } = buildInsert(spec, { id: "x", status: "open", name: "n" });

    expect(sql).toBe("INSERT INTO t (id, status, name) VALUES ($1, $2::task_status, $3)");
    expect(values).toEqual(["x", "open", "n"]);
  });

  it("restores a pre-013 notes row (lacking the six lifecycle columns) with DEFAULT for each", () => {
    const spec = notesSpec();
    const row = fullNotesRow();
    for (const col of NEW_NOTES_COLUMNS) delete row[col];

    const { sql, values } = buildInsert(spec, row);

    // One DEFAULT per missing column, in spec order.
    expect(sql.match(/DEFAULT/g)).toHaveLength(NEW_NOTES_COLUMNS.length);
    expect(sql).toBe(
      `INSERT INTO notes (${spec.columns.join(", ")}) VALUES (` +
        "$1, $2, $3, $4, $5, $6, $7, $8, " + // id .. related_task_ids
        "DEFAULT, DEFAULT, DEFAULT, DEFAULT, DEFAULT, DEFAULT, " + // the six new columns
        "$9, $10)" // created_at, updated_at — renumbered, no gap
    );
    expect(values).toEqual([
      row.id,
      row.title,
      row.content,
      row.domain,
      row.tags,
      row.scope,
      row.source_url,
      row.related_task_ids,
      row.created_at,
      row.updated_at,
    ]);
  });

  it("ignores keys in the row that are not in the spec's column list", () => {
    const spec: TableSpec = { name: "t", columns: ["a"], orderBy: "a" };
    const { sql, values } = buildInsert(spec, { a: 1, unknown_future_column: "x" });

    expect(sql).toBe("INSERT INTO t (a) VALUES ($1)");
    expect(values).toEqual([1]);
  });

  it("does not treat inherited Object.prototype keys as present", () => {
    const spec: TableSpec = { name: "t", columns: ["a", "constructor"], orderBy: "a" };
    const { sql, values } = buildInsert(spec, { a: 1 });

    expect(sql).toBe("INSERT INTO t (a, constructor) VALUES ($1, DEFAULT)");
    expect(values).toEqual([1]);
  });
});

describe("table registry", () => {
  it("registers note_versions immediately after notes", () => {
    const names = TABLES.map((t) => t.name);
    expect(names.indexOf("note_versions")).toBe(names.indexOf("notes") + 1);
  });

  it("exports the six lifecycle columns on notes, after related_task_ids and before created_at", () => {
    const cols = notesSpec().columns;
    const start = cols.indexOf("related_task_ids") + 1;
    expect(cols.slice(start, start + NEW_NOTES_COLUMNS.length)).toEqual(NEW_NOTES_COLUMNS);
    expect(cols[start + NEW_NOTES_COLUMNS.length]).toBe("created_at");
  });

  it("casts note_versions.snapshot to jsonb and orders by (note_id, version)", () => {
    const spec = noteVersionsSpec();
    expect(spec.columns).toEqual([
      "note_id",
      "version",
      "snapshot",
      "changed_fields",
      "changed_via",
      "changed_at",
    ]);
    expect(spec.casts).toEqual({ snapshot: "jsonb" });
    expect(spec.orderBy).toBe("note_id, version");
  });
});

describe("checkNotesConsistency", () => {
  const note = (id: string, version: number) => ({ id, version });
  const hist = (note_id: string, version: number) => ({ note_id, version });

  it("accepts history rows strictly older than the note's current version", async () => {
    await expect(
      checkNotesConsistency(
        [note(NOTE_ID, 3), note(SUCCESSOR_ID, 1)],
        [hist(NOTE_ID, 1), hist(NOTE_ID, 2)]
      )
    ).resolves.toBeUndefined();
  });

  it("accepts empty history and empty notes", async () => {
    await expect(checkNotesConsistency([], [])).resolves.toBeUndefined();
    await expect(
      checkNotesConsistency([note(NOTE_ID, 1)], [])
    ).resolves.toBeUndefined();
  });

  it("rejects a history row whose version equals the note's version", async () => {
    await expect(
      checkNotesConsistency([note(NOTE_ID, 3)], [hist(NOTE_ID, 3)])
    ).rejects.toThrow(/Tarball inconsistent: note_versions row \(20000000-0000-0000-0000-0000000000a1, v3\)/);
  });

  it("rejects a history row whose version exceeds the note's version", async () => {
    await expect(
      checkNotesConsistency([note(NOTE_ID, 2)], [hist(NOTE_ID, 1), hist(NOTE_ID, 5)])
    ).rejects.toThrow(/Tarball inconsistent: note_versions row \(.*, v5\).*v2/s);
  });

  it("rejects a history row whose note is not in notes", async () => {
    await expect(
      checkNotesConsistency([note(SUCCESSOR_ID, 2)], [hist(NOTE_ID, 1)])
    ).rejects.toThrow(/Tarball inconsistent: note_versions row \(.*a1, v1\).*not in notes\.jsonl/s);
  });

  it("treats a notes row with no version key as version 1 (pre-013 note)", async () => {
    // Restores with the column default (1), so any history row would collide.
    await expect(
      checkNotesConsistency([{ id: NOTE_ID }], [hist(NOTE_ID, 1)])
    ).rejects.toThrow(/Tarball inconsistent/);
    await expect(
      checkNotesConsistency([{ id: NOTE_ID }], [])
    ).resolves.toBeUndefined();
  });

  it("rejects a notes row with a non-integer version", async () => {
    await expect(
      checkNotesConsistency([{ id: NOTE_ID, version: "3" }], [])
    ).rejects.toThrow(/Tarball inconsistent: notes row .* invalid version/);
  });

  it("treats an empty notes set as valid input, so any history row is an orphan", async () => {
    // notes.jsonl absent from the tarball is passed as [] — history for notes
    // that do not exist must not be waved through.
    await expect(checkNotesConsistency([], [hist(NOTE_ID, 1)])).rejects.toThrow(
      /Tarball inconsistent: note_versions row \(.*a1, v1\).*not in notes\.jsonl/s
    );
  });

  describe("superseded_by references", () => {
    const superseded = (id: string, by: unknown, version = 3) => ({
      id,
      version,
      status: "superseded",
      superseded_by: by,
    });

    it("accepts a reference to a note present later in the file (forward reference)", async () => {
      // The superseded note sorts first; the FK is deferred on import.
      await expect(
        checkNotesConsistency([superseded(NOTE_ID, SUCCESSOR_ID), note(SUCCESSOR_ID, 1)], [])
      ).resolves.toBeUndefined();
    });

    it("accepts a reference to a note present earlier in the file", async () => {
      await expect(
        checkNotesConsistency([note(NOTE_ID, 1), superseded(SUCCESSOR_ID, NOTE_ID)], [])
      ).resolves.toBeUndefined();
    });

    it("accepts null and absent superseded_by", async () => {
      await expect(
        checkNotesConsistency(
          [{ id: NOTE_ID, version: 1, superseded_by: null }, { id: SUCCESSOR_ID, version: 1 }],
          []
        )
      ).resolves.toBeUndefined();
    });

    it("rejects a reference to a note that is not in notes.jsonl", async () => {
      await expect(
        checkNotesConsistency([superseded(NOTE_ID, SUCCESSOR_ID)], [])
      ).rejects.toThrow(
        `Tarball inconsistent: note ${NOTE_ID} superseded_by ${SUCCESSOR_ID} which is not in notes.jsonl`
      );
    });

    it("rejects a dangling reference even when the history rows are fine", async () => {
      await expect(
        checkNotesConsistency([superseded(NOTE_ID, SUCCESSOR_ID)], [hist(NOTE_ID, 1)])
      ).rejects.toThrow(/superseded_by .* which is not in notes\.jsonl/);
    });
  });

  it("accepts async iterables (streaming JSONL readers)", async () => {
    async function* rows(items: Record<string, unknown>[]) {
      for (const r of items) yield r;
    }
    await expect(
      checkNotesConsistency(rows([note(NOTE_ID, 2)]), rows([hist(NOTE_ID, 1)]))
    ).resolves.toBeUndefined();
    await expect(
      checkNotesConsistency(rows([note(NOTE_ID, 2)]), rows([hist(NOTE_ID, 2)]))
    ).rejects.toThrow(/Tarball inconsistent/);
  });
});
