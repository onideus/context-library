import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import pg from "pg";
import type { PoolClient } from "pg";
import type {
  NoteInsert,
  NoteRow,
  NoteVersionRow,
  NoteWriteConflict,
  NoteWriteResult,
} from "../notes/store.js";

/**
 * Postgres-level tests for the shared note write path (src/notes/store.ts)
 * and the migration-013 trigger that owns versioning and history.
 *
 * Design: docs/design/note-lifecycle.md (§3 schema + trigger, §5 store,
 * §7 delete splice). No server is spawned: the store helpers are called
 * directly against a disposable database, "cl_test_note_store", which this
 * file creates if missing and wipes on start.
 *
 * Requires a running PostgreSQL instance (see tasks.test.ts for setup). When
 * Postgres is unreachable the gated suites are skipped; the pure-helper suite
 * always runs.
 */

const PG_DATABASE = "cl_test_note_store";
const PG_USER = process.env.PGUSER ?? "cl";
const PG_PASSWORD = process.env.PGPASSWORD ?? "test";
const PG_HOST = process.env.PGHOST ?? "localhost";
const PG_PORT = process.env.PGPORT ?? "5432";

// The src/db/client.ts pool is built from the PG* environment the moment that
// module is imported, so the environment must be final BEFORE the dynamic
// imports below. (Static imports are hoisted above this code; only type-only
// imports and `pg` itself are static here.)
process.env.PGDATABASE = PG_DATABASE;
process.env.PGHOST = PG_HOST;
process.env.PGPORT = PG_PORT;
process.env.PGUSER = PG_USER;
process.env.PGPASSWORD = PG_PASSWORD;
// Pin the retention cap off so an ambient value cannot leak into the suites
// that assert unbounded history. "0" rather than deleting it: config.ts only
// reads the variable, and 0 means unlimited.
process.env.NOTE_HISTORY_MAX_VERSIONS = "0";

const {
  insertNoteInTx,
  updateNoteInTx,
  supersedeNoteInTx,
  deleteNoteInTx,
  pruneNoteHistoryInTx,
  resolveChainHeads,
  effectiveStatus,
  effectiveStatusSql,
  lifecyclePredicateSql,
  updatedAtMatches,
  parseIsoWithOffset,
  conflictCode,
  conflictMessage,
} = await import("../notes/store.js");
const { withTransaction } = await import("../db/changes.js");
const { pool, query } = await import("../db/client.js");
const { runMigrations } = await import("../db/migrate.js");
const { config } = await import("../config.js");

async function checkPostgres(): Promise<boolean> {
  try {
    // Ensure the test database exists: connect to the default 'postgres'
    // database first.
    const admin = new pg.Client({
      host: PG_HOST,
      port: parseInt(PG_PORT),
      user: PG_USER,
      password: PG_PASSWORD,
      database: "postgres",
    });
    await admin.connect();
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [PG_DATABASE]);
    if (exists.rowCount === 0) {
      await admin.query(`CREATE DATABASE ${PG_DATABASE}`);
    }
    await admin.end();

    const client = new pg.Client({
      host: PG_HOST,
      port: parseInt(PG_PORT),
      user: PG_USER,
      password: PG_PASSWORD,
      database: PG_DATABASE,
    });
    await client.connect();
    // Clean slate. Drop the whole schema rather than individual tables so a
    // table left over from a previous run cannot abort the migration runner.
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
    await client.end();
    return true;
  } catch {
    return false;
  }
}

const pgAvailable = await checkPostgres();

if (!pgAvailable) {
  console.log("\n" + "=".repeat(60));
  console.log("  NOTICE: PostgreSQL not available");
  console.log("  Note store Postgres suites will be SKIPPED");
  console.log("=".repeat(60) + "\n");
}

// Ends the module-level pool so vitest exits cleanly. Runs after every suite.
afterAll(async () => {
  await pool.end();
});

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

const MIGRATIONS_DIR = fileURLToPath(new URL("../db/migrations/", import.meta.url));
const MIGRATION_013 = "013_note_lifecycle.sql";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let titleCounter = 0;
function uniq(prefix: string): string {
  return `${prefix} ${process.pid}-${++titleCounter}-${randomUUID().slice(0, 8)}`;
}

async function listMigrationFiles(): Promise<string[]> {
  return (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
}

async function resetSchema(): Promise<void> {
  await pool.query("DROP SCHEMA public CASCADE");
  await pool.query("CREATE SCHEMA public");
}

/** Run the real migration runner, capturing (and silencing) its console output. */
async function migrateQuietly(): Promise<string[]> {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await runMigrations();
    return spy.mock.calls.map((c) => String(c[0]));
  } finally {
    spy.mockRestore();
  }
}

async function freshSchema(): Promise<void> {
  await resetSchema();
  await migrateQuietly();
}

function ok<T>(r: NoteWriteResult<T>): T {
  if (!r.ok) throw new Error(`expected ok result, got conflict ${JSON.stringify(r.conflict)}`);
  return r.value;
}

function conflictOfKind<K extends NoteWriteConflict["kind"]>(
  r: NoteWriteResult<unknown>,
  kind: K
): Extract<NoteWriteConflict, { kind: K }> {
  if (r.ok) throw new Error(`expected a ${kind} conflict, got an ok result`);
  if (r.conflict.kind !== kind) {
    throw new Error(`expected a ${kind} conflict, got ${JSON.stringify(r.conflict)}`);
  }
  return r.conflict as Extract<NoteWriteConflict, { kind: K }>;
}

async function mkNote(overrides: Partial<NoteInsert> = {}): Promise<NoteRow> {
  return withTransaction(async (c) => {
    const { row } = await insertNoteInTx(c, {
      title: uniq("Note"),
      content: "Initial content for the fixture note.",
      scope: "work",
      ...overrides,
    });
    return row;
  });
}

type Preconditions = { expectedVersion?: number; expectedStatus?: string; baseUpdatedAt?: string };

const update = (id: string, patch: Parameters<typeof updateNoteInTx>[2], pre: Preconditions = {}) =>
  withTransaction((c) => updateNoteInTx(c, id, patch, { via: "update_note", ...pre }));

const supersede = (id: string, successorId: string, pre: Omit<Preconditions, "baseUpdatedAt"> = {}) =>
  withTransaction((c) => supersedeNoteInTx(c, id, successorId, { via: "supersede_note", ...pre }));

const remove = (id: string) => withTransaction((c) => deleteNoteInTx(c, id, { via: "delete_note" }));

async function getNote(id: string): Promise<NoteRow | undefined> {
  return (await query<NoteRow>("SELECT * FROM notes WHERE id = $1", [id])).rows[0];
}

async function history(id: string): Promise<NoteVersionRow[]> {
  return (
    await query<NoteVersionRow>("SELECT * FROM note_versions WHERE note_id = $1 ORDER BY version", [id])
  ).rows;
}

async function changesFor(id: string): Promise<Array<{ seq: string; op: string }>> {
  return (
    await query<{ seq: string; op: string }>(
      "SELECT seq::text AS seq, op FROM changes WHERE entity_type = 'note' AND entity_id = $1 ORDER BY seq",
      [id]
    )
  ).rows;
}

/** A column rendered with full microsecond precision, for byte-exact comparisons. */
async function stamp(column: "updated_at" | "superseded_at", id: string): Promise<string | null> {
  const r = await query<{ v: string | null }>(`SELECT ${column}::text AS v FROM notes WHERE id = $1`, [id]);
  return r.rows[0]?.v ?? null;
}

const asPool = (raw: pg.Client): PoolClient => raw as unknown as PoolClient;

async function runInTx<T>(raw: pg.Client, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  await raw.query("BEGIN");
  try {
    const v = await fn(asPool(raw));
    await raw.query("COMMIT");
    return v;
  } catch (err) {
    await raw.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

/** Poll pg_stat_activity until the backend behind `raw` is waiting on a heavyweight lock. */
async function waitUntilBlocked(raw: pg.Client, timeoutMs = 5_000): Promise<string> {
  const pid = (raw as unknown as { processID: number }).processID;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await pool.query<{ wait_event_type: string | null; wait_event: string | null }>(
      "SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE pid = $1",
      [pid]
    );
    if (r.rows[0]?.wait_event_type === "Lock") return r.rows[0].wait_event ?? "";
    await sleep(25);
  }
  throw new Error(`backend ${pid} never started waiting on a lock`);
}

function fakeRow(over: Partial<NoteRow> = {}): NoteRow {
  return {
    id: randomUUID(),
    title: "Fixture",
    content: "Fixture body",
    domain: null,
    tags: [],
    scope: "work",
    source_url: null,
    related_task_ids: [],
    status: "active",
    superseded_by: null,
    superseded_at: null,
    valid_until: null,
    provenance: null,
    version: 1,
    created_at: new Date(0),
    updated_at: new Date(0),
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────
// A. Pure helpers (no Postgres)
// ─────────────────────────────────────────────────────────────────

describe("note store: pure helpers", () => {
  describe("effectiveStatus", () => {
    const now = new Date("2026-06-01T12:00:00.000Z");
    const past = new Date("2026-05-01T00:00:00.000Z");
    const future = new Date("2026-07-01T00:00:00.000Z");

    it("is active when there is no expiry", () => {
      expect(effectiveStatus({ status: "active", valid_until: null }, now)).toBe("active");
    });

    it("is active before valid_until and expired after (Date input)", () => {
      expect(effectiveStatus({ status: "active", valid_until: future }, now)).toBe("active");
      expect(effectiveStatus({ status: "active", valid_until: past }, now)).toBe("expired");
    });

    it("accepts ISO strings for valid_until", () => {
      expect(effectiveStatus({ status: "active", valid_until: past.toISOString() }, now)).toBe("expired");
      expect(effectiveStatus({ status: "active", valid_until: future.toISOString() }, now)).toBe("active");
    });

    it("treats valid_until === now as expired (<=)", () => {
      expect(effectiveStatus({ status: "active", valid_until: now }, now)).toBe("expired");
    });

    it("lets superseded win over a passed expiry", () => {
      expect(effectiveStatus({ status: "superseded", valid_until: past }, now)).toBe("superseded");
      expect(effectiveStatus({ status: "superseded", valid_until: null }, now)).toBe("superseded");
    });

    it("ignores an unparseable valid_until instead of calling the note expired", () => {
      expect(effectiveStatus({ status: "active", valid_until: "not a date" }, now)).toBe("active");
    });

    it("defaults `now` to the real clock", () => {
      expect(effectiveStatus({ status: "active", valid_until: new Date(Date.now() - 60_000) })).toBe("expired");
      expect(effectiveStatus({ status: "active", valid_until: new Date(Date.now() + 3_600_000) })).toBe("active");
    });
  });

  describe("lifecyclePredicateSql", () => {
    it("returns TRUE when nothing is excluded", () => {
      expect(lifecyclePredicateSql("n", { excludeSuperseded: false, excludeExpired: false })).toBe("TRUE");
    });

    it("excludes superseded only", () => {
      expect(lifecyclePredicateSql("n", { excludeSuperseded: true, excludeExpired: false })).toBe(
        "(n.status = 'active')"
      );
    });

    it("excludes expired only", () => {
      // The single clause carries its own parentheses and is wrapped again by
      // the joiner; the doubled parens are harmless and keep the fragment safe
      // to AND into a larger WHERE.
      expect(lifecyclePredicateSql("n", { excludeSuperseded: false, excludeExpired: true })).toBe(
        "((n.valid_until IS NULL OR n.valid_until > now()))"
      );
    });

    it("excludes both, ANDed", () => {
      expect(lifecyclePredicateSql("n", { excludeSuperseded: true, excludeExpired: true })).toBe(
        "(n.status = 'active' AND (n.valid_until IS NULL OR n.valid_until > now()))"
      );
    });

    it("qualifies every column with the given alias", () => {
      const sql = lifecyclePredicateSql("notes_alias", { excludeSuperseded: true, excludeExpired: true });
      expect(sql).toContain("notes_alias.status");
      expect(sql.match(/notes_alias\.valid_until/g)).toHaveLength(2);
      expect(sql).not.toMatch(/(^|[^.\w])(status|valid_until)\b/);
    });
  });

  describe("updatedAtMatches", () => {
    const iso = "2026-03-04T05:06:07.089Z";

    it("matches the exact ISO string of a Date", () => {
      expect(updatedAtMatches(new Date(iso), iso)).toBe(true);
    });

    it("matches +00:00 and Z spellings of the same instant", () => {
      expect(updatedAtMatches(new Date(iso), "2026-03-04T05:06:07.089+00:00")).toBe(true);
      expect(updatedAtMatches("2026-03-04T05:06:07.089+00:00", iso)).toBe(true);
    });

    it("matches the same instant written with a different offset", () => {
      expect(updatedAtMatches(new Date(iso), "2026-03-04T10:36:07.089+05:30")).toBe(true);
    });

    it("rejects a different instant", () => {
      expect(updatedAtMatches(new Date(iso), "2026-03-04T05:06:07.090Z")).toBe(false);
      expect(updatedAtMatches(iso, "2026-03-04T05:06:08.089Z")).toBe(false);
    });

    it("rejects an unparseable claim", () => {
      expect(updatedAtMatches(new Date(iso), "yesterday-ish")).toBe(false);
      expect(updatedAtMatches(new Date(iso), "")).toBe(false);
    });
  });

  describe("parseIsoWithOffset", () => {
    it("accepts Z and normalises to UTC ISO", () => {
      expect(parseIsoWithOffset("2026-01-01T00:00:00Z")).toBe("2026-01-01T00:00:00.000Z");
    });

    it("accepts positive and negative hh:mm offsets and converts to UTC", () => {
      expect(parseIsoWithOffset("2026-01-01T05:30:00+05:30")).toBe("2026-01-01T00:00:00.000Z");
      expect(parseIsoWithOffset("2026-01-01T00:00:00-08:00")).toBe("2026-01-01T08:00:00.000Z");
    });

    it("accepts fractional seconds and a missing seconds field", () => {
      expect(parseIsoWithOffset("2026-01-01T00:00:00.123Z")).toBe("2026-01-01T00:00:00.123Z");
      expect(parseIsoWithOffset("2026-01-01T10:15Z")).toBe("2026-01-01T10:15:00.000Z");
    });

    it("rejects an offset-less date-time (ambiguous local time)", () => {
      expect(parseIsoWithOffset("2026-01-01T00:00:00")).toBeNull();
    });

    it("rejects garbage and date-only values", () => {
      expect(parseIsoWithOffset("garbage")).toBeNull();
      expect(parseIsoWithOffset("")).toBeNull();
      expect(parseIsoWithOffset("2026-01-01")).toBeNull();
    });

    it("rejects a well-shaped but impossible instant", () => {
      expect(parseIsoWithOffset("2026-13-45T00:00:00Z")).toBeNull();
    });
  });

  describe("conflictCode / conflictMessage", () => {
    const row = fakeRow();
    const cases: Array<[NoteWriteConflict, string]> = [
      [{ kind: "not_found" }, "NOT_FOUND"],
      [{ kind: "version_conflict", current: row }, "VERSION_CONFLICT"],
      [{ kind: "status_conflict", current: row }, "STATUS_CONFLICT"],
      [{ kind: "stale_base", current: row }, "STALE_BASE"],
      [{ kind: "invalid_successor", reason: "bad successor", current: row, successor: null }, "INVALID_SUCCESSOR"],
    ];

    it.each(cases)("maps %j to its error code", (conflict, code) => {
      expect(conflictCode(conflict)).toBe(code);
    });

    it("produces actionable messages", () => {
      const v = fakeRow({ version: 7 });
      expect(conflictMessage({ kind: "version_conflict", current: v }, v.id)).toContain("version 7");
      expect(conflictMessage({ kind: "not_found", missing: "superseded_by" }, "x")).toMatch(/successor/i);
      expect(conflictMessage({ kind: "not_found", missing: "id" }, "abc")).toContain("abc");
      expect(
        conflictMessage({ kind: "invalid_successor", reason: "because", current: v, successor: null }, v.id)
      ).toBe("because");
    });
  });
});

// ─────────────────────────────────────────────────────────────────
// B. Migration 013 over existing rows
// ─────────────────────────────────────────────────────────────────

describe.skipIf(!pgAvailable)("note store: migration 013 over existing rows", () => {
  const noteIds: string[] = [];
  const updatedAtBefore = new Map<string, string>();
  let preApplied: Array<{ filename: string; applied_at: Date }> = [];
  let firstRunLogs: string[] = [];
  let sql013 = "";

  beforeAll(async () => {
    await resetSchema();

    // Exactly what runMigrations() creates, so the runner treats 001..012 as applied.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const files = await listMigrationFiles();
    const idx013 = files.indexOf(MIGRATION_013);
    expect(idx013).toBeGreaterThan(0);
    const pre013 = files.slice(0, idx013);
    expect(pre013).toHaveLength(12);
    for (const file of pre013) {
      await pool.query(await readFile(join(MIGRATIONS_DIR, file), "utf-8"));
      await pool.query("INSERT INTO _migrations (filename) VALUES ($1)", [file]);
    }
    sql013 = await readFile(join(MIGRATIONS_DIR, MIGRATION_013), "utf-8");

    // Notes written by a pre-013 build: only the original columns.
    for (const [title, content] of [
      [uniq("Legacy note one"), "Written before the lifecycle columns existed."],
      [uniq("Legacy note two"), "Also written before the lifecycle columns existed."],
    ]) {
      const r = await pool.query<{ id: string; u: string }>(
        "INSERT INTO notes (title, content, scope) VALUES ($1, $2, 'work') RETURNING id, updated_at::text AS u",
        [title, content]
      );
      noteIds.push(r.rows[0].id);
      updatedAtBefore.set(r.rows[0].id, r.rows[0].u);
    }

    preApplied = (
      await pool.query<{ filename: string; applied_at: Date }>(
        "SELECT filename, applied_at FROM _migrations ORDER BY filename"
      )
    ).rows;

    firstRunLogs = await migrateQuietly();
  }, 30_000);

  it("applies only 013 on top of the recorded 001..012", async () => {
    const applying = firstRunLogs.filter((l) => l.startsWith("[migrate] Applying:"));
    expect(applying).toEqual([`[migrate] Applying: ${MIGRATION_013}`]);

    const after = (
      await pool.query<{ filename: string; applied_at: Date }>(
        "SELECT filename, applied_at FROM _migrations ORDER BY filename"
      )
    ).rows;
    expect(preApplied).toHaveLength(12);
    expect(after).toHaveLength(13);
    expect(after.map((r) => r.filename)).toContain(MIGRATION_013);
    // The previously-recorded rows were not touched.
    for (const pre of preApplied) {
      const now = after.find((r) => r.filename === pre.filename);
      expect(now?.applied_at.getTime()).toBe(pre.applied_at.getTime());
    }
  });

  it("backfills existing rows through column defaults", async () => {
    expect(noteIds).toHaveLength(2);
    const rows = (await query<NoteRow>("SELECT * FROM notes WHERE id = ANY($1::uuid[])", [noteIds])).rows;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe("active");
      expect(row.version).toBe(1);
      expect(row.provenance).toBeNull();
      expect(row.superseded_by).toBeNull();
      expect(row.superseded_at).toBeNull();
      expect(row.valid_until).toBeNull();
    }
  });

  it("backfills without an UPDATE: updated_at is untouched and no history is written", async () => {
    for (const id of noteIds) {
      expect(await stamp("updated_at", id)).toBe(updatedAtBefore.get(id));
    }
    const versions = await query<{ n: string }>("SELECT count(*)::text AS n FROM note_versions");
    expect(versions.rows[0].n).toBe("0");
  });

  it("runMigrations() is a no-op the second time", async () => {
    const logs = await migrateQuietly();
    expect(logs.filter((l) => l.startsWith("[migrate] Applying:"))).toEqual([]);
    const count = await query<{ n: string }>("SELECT count(*)::text AS n FROM _migrations");
    expect(count.rows[0].n).toBe("13");
  });

  it("executing the raw 013 SQL again succeeds and changes nothing", async () => {
    await expect(pool.query(sql013)).resolves.toBeDefined();
    await expect(pool.query(sql013)).resolves.toBeDefined();

    const names = [
      "chk_notes_status",
      "chk_notes_provenance",
      "chk_notes_superseded_shape",
      "chk_notes_superseded_at",
      "chk_notes_no_self_supersede",
      "fk_notes_superseded_by",
    ];
    const constraints = await query<{ conname: string; n: number }>(
      `SELECT conname, count(*)::int AS n FROM pg_constraint
        WHERE conrelid = 'notes'::regclass AND conname = ANY($1)
        GROUP BY conname`,
      [names]
    );
    expect(constraints.rows.map((r) => r.conname).sort()).toEqual([...names].sort());
    for (const r of constraints.rows) expect(r.n).toBe(1);

    const triggers = await query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = 'notes'::regclass AND NOT tgisinternal ORDER BY tgname`
    );
    expect(triggers.rows.map((r) => r.tgname)).toEqual(["notes_updated_at", "notes_version_history"]);

    const rows = (await query<NoteRow>("SELECT * FROM notes WHERE id = ANY($1::uuid[])", [noteIds])).rows;
    for (const row of rows) {
      expect(row.version).toBe(1);
      expect(row.status).toBe("active");
    }
    for (const id of noteIds) {
      expect(await stamp("updated_at", id)).toBe(updatedAtBefore.get(id));
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// C. Trigger semantics
// ─────────────────────────────────────────────────────────────────

describe.skipIf(!pgAvailable)("note store: versioning trigger", () => {
  beforeAll(async () => {
    await freshSchema();
  }, 30_000);

  async function rawInsert(title: string): Promise<string> {
    const r = await pool.query<{ id: string }>(
      "INSERT INTO notes (title, content, scope) VALUES ($1, 'Original body', 'work') RETURNING id",
      [title]
    );
    return r.rows[0].id;
  }

  async function rawRow(id: string) {
    const r = await pool.query<{ version: number; u: string; uj: string }>(
      `SELECT version, updated_at::text AS u, to_jsonb(notes)->>'updated_at' AS uj FROM notes WHERE id = $1`,
      [id]
    );
    return r.rows[0];
  }

  it("a raw UPDATE of one column bumps version and snapshots the old row", async () => {
    const title = uniq("Trigger single field");
    const id = await rawInsert(title);
    const before = await rawRow(id);
    await sleep(5);

    await pool.query("UPDATE notes SET title = $2 WHERE id = $1", [id, uniq("Renamed")]);

    const after = await rawRow(id);
    expect(after.version).toBe(2);
    expect(after.u).not.toBe(before.u);

    const h = await history(id);
    expect(h).toHaveLength(1);
    expect(h[0].version).toBe(1);
    expect(h[0].changed_fields).toEqual(["title"]);
    expect(h[0].changed_via).toBe("sql");
    expect(h[0].snapshot.title).toBe(title);
    expect(Object.keys(h[0].snapshot)).not.toContain("id");
    expect(Object.keys(h[0].snapshot)).not.toContain("version");
    expect(Object.keys(h[0].snapshot)).not.toContain("created_at");
    expect(Object.keys(h[0].snapshot)).toContain("updated_at");
    // snapshot.updated_at is when version 1 began.
    expect(h[0].snapshot.updated_at).toBe(before.uj);
  });

  it("a no-op UPDATE keeps version, updated_at (byte-identical) and writes no history", async () => {
    const id = await rawInsert(uniq("Trigger no-op"));
    const before = await rawRow(id);
    await sleep(5);

    await pool.query("UPDATE notes SET title = title, content = content WHERE id = $1", [id]);

    const after = await rawRow(id);
    expect(after.version).toBe(1);
    expect(after.u).toBe(before.u);
    expect(await history(id)).toHaveLength(0);
  });

  it("an UPDATE that only touches updated_at is also a no-op", async () => {
    const id = await rawInsert(uniq("Trigger updated_at only"));
    const before = await rawRow(id);
    await sleep(5);

    await pool.query("UPDATE notes SET updated_at = now() WHERE id = $1", [id]);

    const after = await rawRow(id);
    expect(after.version).toBe(1);
    expect(after.u).toBe(before.u);
    expect(await history(id)).toHaveLength(0);
  });

  it("records both fields, sorted, when two change at once", async () => {
    const id = await rawInsert(uniq("Trigger two fields"));
    await pool.query("UPDATE notes SET title = $2, content = $3 WHERE id = $1", [
      id,
      uniq("New title"),
      "New body",
    ]);
    const h = await history(id);
    expect(h).toHaveLength(1);
    expect(h[0].changed_fields).toEqual(["content", "title"]);
  });

  it("diffs array columns", async () => {
    const id = await rawInsert(uniq("Trigger tags"));
    await pool.query("UPDATE notes SET tags = $2 WHERE id = $1", [id, ["alpha", "beta"]]);
    const h = await history(id);
    expect(h).toHaveLength(1);
    expect(h[0].changed_fields).toEqual(["tags"]);
  });

  it("keeps a monotonic version and one snapshot per effective update", async () => {
    const t0 = uniq("Trigger chain");
    const id = await rawInsert(t0);
    const titles = [uniq("T1"), uniq("T2"), uniq("T3")];
    for (const t of titles) {
      await pool.query("UPDATE notes SET title = $2 WHERE id = $1", [id, t]);
    }
    expect((await rawRow(id)).version).toBe(4);
    const h = await history(id);
    expect(h.map((r) => r.version)).toEqual([1, 2, 3]);
    expect(h.map((r) => r.snapshot.title)).toEqual([t0, titles[0], titles[1]]);
  });

  it("a write through updateNoteInTx records changed_via 'update_note'", async () => {
    const n = await mkNote();
    const r = ok(await update(n.id, { content: "Edited through the store" }));
    expect(r.changed).toBe(true);
    const h = await history(n.id);
    expect(h).toHaveLength(1);
    expect(h[0].changed_via).toBe("update_note");
    expect(h[0].changed_fields).toEqual(["content"]);
  });

  it("a raw UPDATE after a store write on the same connection is attributed to 'sql'", async () => {
    // set_config(..., is_local=true) leaves an empty-string placeholder behind
    // once the transaction ends; the trigger must treat '' as "unset".
    const n = await mkNote();
    const raw = new pg.Client();
    await raw.connect();
    try {
      await runInTx(raw, (c) => updateNoteInTx(c, n.id, { title: uniq("Via store") }, { via: "update_note" }));
      await raw.query("UPDATE notes SET title = $2 WHERE id = $1", [n.id, uniq("Via psql")]);
    } finally {
      await raw.end();
    }
    const h = await history(n.id);
    expect(h.map((r) => [r.version, r.changed_via])).toEqual([
      [1, "update_note"],
      [2, "sql"],
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────
// D. Store helpers
// ─────────────────────────────────────────────────────────────────

describe.skipIf(!pgAvailable)("note store: helpers", () => {
  beforeAll(async () => {
    await freshSchema();
    // Suites below assume unbounded history unless they say otherwise.
    expect(config.noteHistoryMaxVersions).toBe(0);
  }, 30_000);

  describe("insertNoteInTx", () => {
    it("returns version 1 and writes an insert change-log row", async () => {
      const id = randomUUID();
      const title = uniq("Insert");
      const { row, seq } = await withTransaction((c) =>
        insertNoteInTx(
          c,
          { title, content: "Body", scope: "personal", tags: ["alpha"], provenance: "stated" },
          { id }
        )
      );
      expect(row.id).toBe(id);
      expect(row.version).toBe(1);
      expect(row.status).toBe("active");
      expect(row.tags).toEqual(["alpha"]);
      expect(row.provenance).toBe("stated");
      expect(row.superseded_by).toBeNull();

      const ch = await changesFor(id);
      expect(ch).toHaveLength(1);
      expect(ch[0].op).toBe("insert");
      expect(ch[0].seq).toBe(seq);
      expect(await history(id)).toHaveLength(0);
    });

    it("rolls the change-log row back with the note", async () => {
      const id = randomUUID();
      await expect(
        withTransaction(async (c) => {
          await insertNoteInTx(c, { title: uniq("Rolled back"), content: "x", scope: "work" }, { id });
          throw new Error("boom");
        })
      ).rejects.toThrow("boom");
      expect(await getNote(id)).toBeUndefined();
      expect(await changesFor(id)).toHaveLength(0);
    });

    it("stores valid_until as the given instant", async () => {
      const n = await mkNote({ valid_until: "2031-06-01T12:00:00+02:00" });
      expect((n.valid_until as Date).toISOString()).toBe("2031-06-01T10:00:00.000Z");
    });
  });

  describe("updateNoteInTx", () => {
    it("returns not_found for a missing id", async () => {
      const r = await update(randomUUID(), { title: "x" });
      expect(conflictOfKind(r, "not_found").missing).toBe("id");
    });

    it("applies a patch: bumps version, logs an update, records history", async () => {
      const n = await mkNote();
      const out = ok(await update(n.id, { content: "Edited" }, { expectedVersion: 1 }));
      expect(out.changed).toBe(true);
      expect(out.row.version).toBe(2);
      expect(out.row.content).toBe("Edited");
      expect(typeof out.seq).toBe("string");

      const ch = await changesFor(n.id);
      expect(ch.map((c) => c.op)).toEqual(["insert", "update"]);
      expect(ch[1].seq).toBe(out.seq);

      const h = await history(n.id);
      expect(h).toHaveLength(1);
      expect(h[0].version).toBe(1);
      expect(h[0].changed_via).toBe("update_note");
      expect(h[0].snapshot.content).toBe(n.content);
    });

    it("sets, changes and clears nullable columns", async () => {
      const n = await mkNote();
      const a = ok(
        await update(n.id, {
          domain: "engineering",
          tags: ["one", "two"],
          provenance: "decided",
          valid_until: "2031-06-01T12:00:00Z",
        })
      );
      expect(a.row.domain).toBe("engineering");
      expect(a.row.tags).toEqual(["one", "two"]);
      expect(a.row.provenance).toBe("decided");
      expect((a.row.valid_until as Date).toISOString()).toBe("2031-06-01T12:00:00.000Z");

      const b = ok(await update(n.id, { domain: null, provenance: null, valid_until: null }));
      expect(b.row.domain).toBeNull();
      expect(b.row.provenance).toBeNull();
      expect(b.row.valid_until).toBeNull();
      expect(b.row.version).toBe(3);
    });

    it("returns version_conflict, with the current row, for a stale expectedVersion", async () => {
      const n = await mkNote();
      ok(await update(n.id, { content: "v2 content" }));
      const r = await update(n.id, { content: "stale write" }, { expectedVersion: 1 });
      const c = conflictOfKind(r, "version_conflict");
      expect(c.current.version).toBe(2);
      expect(c.current.content).toBe("v2 content");
      expect(conflictCode(c)).toBe("VERSION_CONFLICT");
      expect((await getNote(n.id))?.content).toBe("v2 content");
    });

    it("returns status_conflict when expectedStatus does not match the stored status", async () => {
      const n = await mkNote();
      const r = await update(n.id, { content: "x" }, { expectedStatus: "superseded" });
      const c = conflictOfKind(r, "status_conflict");
      expect(c.current.status).toBe("active");
      expect((await getNote(n.id))?.version).toBe(1);
    });

    it("accepts a matching expectedStatus", async () => {
      const n = await mkNote();
      const out = ok(await update(n.id, { content: "fine" }, { expectedStatus: "active" }));
      expect(out.changed).toBe(true);
    });

    it("enforces baseUpdatedAt: stale rejected, current accepted, then stale again", async () => {
      const n = await mkNote();
      const base = (n.updated_at as Date).toISOString();
      await sleep(5);

      const stale = await update(n.id, { content: "x" }, { baseUpdatedAt: "2020-01-01T00:00:00.000Z" });
      expect(conflictOfKind(stale, "stale_base").current.id).toBe(n.id);

      const good = ok(await update(n.id, { content: "based on current" }, { baseUpdatedAt: base }));
      expect(good.changed).toBe(true);

      // The row has moved on, so the same base is now stale.
      const again = await update(n.id, { content: "y" }, { baseUpdatedAt: base });
      conflictOfKind(again, "stale_base");
    });

    it("accepts a baseUpdatedAt spelled with +00:00 instead of Z", async () => {
      const n = await mkNote();
      const base = (n.updated_at as Date).toISOString().replace("Z", "+00:00");
      const out = ok(await update(n.id, { content: "offset spelling" }, { baseUpdatedAt: base }));
      expect(out.changed).toBe(true);
    });

    it("checks expectedVersion before expectedStatus before baseUpdatedAt", async () => {
      const n = await mkNote();
      const allWrong = {
        expectedVersion: 99,
        expectedStatus: "superseded",
        baseUpdatedAt: "2020-01-01T00:00:00.000Z",
      };
      conflictOfKind(await update(n.id, { content: "x" }, allWrong), "version_conflict");
      conflictOfKind(
        await update(n.id, { content: "x" }, { ...allWrong, expectedVersion: 1 }),
        "status_conflict"
      );
      conflictOfKind(
        await update(n.id, { content: "x" }, { ...allWrong, expectedVersion: 1, expectedStatus: "active" }),
        "stale_base"
      );
    });

    it("reports changed:false, with no version bump or change-log row, when the patch equals current values", async () => {
      const n = await mkNote();
      const changesBefore = (await changesFor(n.id)).length;
      const stampBefore = await stamp("updated_at", n.id);
      await sleep(5);

      const out = ok(await update(n.id, { title: n.title, content: n.content }, { expectedVersion: 1 }));
      expect(out.changed).toBe(false);
      expect(out.seq).toBeUndefined();
      expect(out.row.version).toBe(1);

      expect(await changesFor(n.id)).toHaveLength(changesBefore);
      expect(await history(n.id)).toHaveLength(0);
      expect(await stamp("updated_at", n.id)).toBe(stampBefore);
      expect((await getNote(n.id))?.version).toBe(1);
    });

    it("treats an empty patch as a no-op", async () => {
      const n = await mkNote();
      const out = ok(await update(n.id, {}));
      expect(out.changed).toBe(false);
      expect(out.row.version).toBe(1);
      expect(await changesFor(n.id)).toHaveLength(1);
    });

    it("ignores forged lifecycle keys in a patch (status is not a patchable column)", async () => {
      // NotePatch has no status/superseded_by; a forged key must not be applied.
      const n = await mkNote();
      const forged = { content: "ok", status: "superseded" } as unknown as Parameters<typeof updateNoteInTx>[2];
      const out = ok(await update(n.id, forged));
      expect(out.row.status).toBe("active");
      expect(out.row.content).toBe("ok");
    });

    it("keeps all history when no retention cap is set", async () => {
      const n = await mkNote();
      for (let i = 1; i <= 5; i++) ok(await update(n.id, { content: `revision ${i}` }));
      expect((await getNote(n.id))?.version).toBe(6);
      expect((await history(n.id)).map((h) => h.version)).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe("supersedeNoteInTx", () => {
    it("supersedes: marks only the old note, versions it, and logs exactly one change", async () => {
      const oldN = await mkNote();
      const succ = await mkNote();
      const oldChangesBefore = (await changesFor(oldN.id)).length;
      const succChangesBefore = (await changesFor(succ.id)).length;

      const out = ok(await supersede(oldN.id, succ.id));
      expect(out.old.status).toBe("superseded");
      expect(out.old.superseded_by).toBe(succ.id);
      expect(out.old.superseded_at).toBeInstanceOf(Date);
      expect(out.old.version).toBe(2);
      expect(out.successor.id).toBe(succ.id);
      expect(out.successor.version).toBe(1);

      const oldChanges = await changesFor(oldN.id);
      expect(oldChanges).toHaveLength(oldChangesBefore + 1);
      expect(oldChanges[oldChanges.length - 1]).toEqual({ seq: out.seq, op: "update" });
      expect(await changesFor(succ.id)).toHaveLength(succChangesBefore);

      const succNow = await getNote(succ.id);
      expect(succNow?.version).toBe(1);
      expect(succNow?.status).toBe("active");

      const h = await history(oldN.id);
      expect(h).toHaveLength(1);
      expect(h[0].changed_via).toBe("supersede_note");
      expect(h[0].changed_fields).toEqual(["status", "superseded_at", "superseded_by"]);
      expect(await history(succ.id)).toHaveLength(0);
    });

    it("rejects superseding itself as invalid_successor", async () => {
      const n = await mkNote();
      const r = await supersede(n.id, n.id);
      const c = conflictOfKind(r, "invalid_successor");
      expect(c.successor).toBeNull();
      expect(c.reason).toMatch(/itself/);
      expect(conflictCode(c)).toBe("INVALID_SUCCESSOR");
      expect((await getNote(n.id))?.status).toBe("active");
    });

    it("returns not_found(superseded_by) for a missing successor", async () => {
      const n = await mkNote();
      const r = await supersede(n.id, randomUUID());
      expect(conflictOfKind(r, "not_found").missing).toBe("superseded_by");
      expect((await getNote(n.id))?.status).toBe("active");
    });

    it("returns not_found(id) for a missing note", async () => {
      const succ = await mkNote();
      const r = await supersede(randomUUID(), succ.id);
      expect(conflictOfKind(r, "not_found").missing).toBe("id");
    });

    it("reports a missing id before a missing successor", async () => {
      const r = await supersede(randomUUID(), randomUUID());
      expect(conflictOfKind(r, "not_found").missing).toBe("id");
    });

    it("returns status_conflict when the note is already superseded", async () => {
      const a = await mkNote();
      const b = await mkNote();
      const c = await mkNote();
      ok(await supersede(a.id, b.id));
      const r = await supersede(a.id, c.id);
      const conflict = conflictOfKind(r, "status_conflict");
      expect(conflict.current.superseded_by).toBe(b.id);
      expect(conflictMessage(conflict, a.id)).toContain(b.id);
      expect((await getNote(a.id))?.superseded_by).toBe(b.id);
    });

    it("rejects a superseded successor as invalid_successor", async () => {
      const a = await mkNote();
      const b = await mkNote();
      const c = await mkNote();
      ok(await supersede(b.id, c.id));
      const r = await supersede(a.id, b.id);
      const conflict = conflictOfKind(r, "invalid_successor");
      expect(conflict.reason).toMatch(/superseded/);
      expect(conflict.successor?.id).toBe(b.id);
      expect((await getNote(a.id))?.status).toBe("active");
    });

    it("rejects an expired successor as invalid_successor", async () => {
      const a = await mkNote();
      const expired = await mkNote({ valid_until: "2020-01-01T00:00:00Z" });
      const r = await supersede(a.id, expired.id);
      const conflict = conflictOfKind(r, "invalid_successor");
      expect(conflict.reason).toMatch(/expired/);
      expect((await getNote(a.id))?.status).toBe("active");
    });

    it("enforces expectedVersion and expectedStatus on the old note", async () => {
      const a = await mkNote();
      const b = await mkNote();
      conflictOfKind(await supersede(a.id, b.id, { expectedVersion: 5 }), "version_conflict");
      conflictOfKind(await supersede(a.id, b.id, { expectedStatus: "superseded" }), "status_conflict");
      expect((await getNote(a.id))?.status).toBe("active");

      const out = ok(await supersede(a.id, b.id, { expectedVersion: 1, expectedStatus: "active" }));
      expect(out.old.status).toBe("superseded");
    });

    it("lets an expired note be superseded (only the successor must be active)", async () => {
      const expired = await mkNote({ valid_until: "2020-01-01T00:00:00Z" });
      const succ = await mkNote();
      const out = ok(await supersede(expired.id, succ.id));
      expect(out.old.status).toBe("superseded");
    });
  });

  describe("resolveChainHeads", () => {
    it("walks A→B→C to C for every member and maps an unrelated note to itself", async () => {
      const a = await mkNote();
      const b = await mkNote();
      const c = await mkNote();
      const lone = await mkNote();
      ok(await supersede(a.id, b.id));
      ok(await supersede(b.id, c.id));

      const heads = await withTransaction((client) =>
        resolveChainHeads(client, [a.id, b.id, c.id, lone.id])
      );
      expect(heads.get(a.id)).toBe(c.id);
      expect(heads.get(b.id)).toBe(c.id);
      expect(heads.get(c.id)).toBe(c.id);
      expect(heads.get(lone.id)).toBe(lone.id);
      expect(heads.size).toBe(4);
    });

    it("returns an empty map for no ids", async () => {
      const heads = await withTransaction((client) => resolveChainHeads(client, []));
      expect(heads.size).toBe(0);
    });
  });

  describe("lifecycle SQL fragments against real rows", () => {
    it("effectiveStatusSql and lifecyclePredicateSql agree with effectiveStatus()", async () => {
      const active = await mkNote();
      const future = await mkNote({ valid_until: "2099-01-01T00:00:00Z" });
      const expired = await mkNote({ valid_until: "2020-01-01T00:00:00Z" });
      const succ = await mkNote();
      const supersededPlain = await mkNote();
      const supersededAndExpired = await mkNote({ valid_until: "2020-01-01T00:00:00Z" });
      ok(await supersede(supersededPlain.id, succ.id));
      ok(await supersede(supersededAndExpired.id, succ.id));

      const ids = [active, future, expired, succ, supersededPlain, supersededAndExpired].map((n) => n.id);
      const res = await query<{ id: string; s: string }>(
        `SELECT n.id, ${effectiveStatusSql("n")} AS s FROM notes n WHERE n.id = ANY($1::uuid[])`,
        [ids]
      );
      const sql = new Map(res.rows.map((r) => [r.id, r.s]));
      expect(sql.get(active.id)).toBe("active");
      expect(sql.get(future.id)).toBe("active");
      expect(sql.get(expired.id)).toBe("expired");
      expect(sql.get(supersededPlain.id)).toBe("superseded");
      expect(sql.get(supersededAndExpired.id)).toBe("superseded");

      // JS and SQL computations agree on every row.
      const rows = (await query<NoteRow>("SELECT * FROM notes WHERE id = ANY($1::uuid[])", [ids])).rows;
      for (const row of rows) expect(effectiveStatus(row)).toBe(sql.get(row.id));

      const pred = async (excludeSuperseded: boolean, excludeExpired: boolean) =>
        (
          await query<{ id: string }>(
            `SELECT n.id FROM notes n WHERE n.id = ANY($1::uuid[]) AND ${lifecyclePredicateSql("n", {
              excludeSuperseded,
              excludeExpired,
            })}`,
            [ids]
          )
        ).rows
          .map((r) => r.id)
          .sort();
      const sorted = (xs: string[]) => [...xs].sort();

      expect(await pred(false, false)).toEqual(sorted(ids));
      expect(await pred(true, false)).toEqual(sorted([active.id, future.id, expired.id, succ.id]));
      expect(await pred(false, true)).toEqual(
        sorted([active.id, future.id, succ.id, supersededPlain.id])
      );
      expect(await pred(true, true)).toEqual(sorted([active.id, future.id, succ.id]));
    });
  });

  describe("deleteNoteInTx", () => {
    it("deleting the middle of A→B→C re-points A to C and keeps A.superseded_at", async () => {
      const a = await mkNote();
      const b = await mkNote();
      const c = await mkNote();
      ok(await supersede(a.id, b.id));
      ok(await supersede(b.id, c.id));
      const aBefore = (await getNote(a.id))!;
      const aSupersededAt = await stamp("superseded_at", a.id);
      const cBefore = (await getNote(c.id))!;

      const out = (await remove(b.id))!;
      expect(out).not.toBeNull();
      expect(out.deleted.id).toBe(b.id);
      expect(out.relinked.map((r) => r.id)).toEqual([a.id]);
      expect(out.relinked[0].superseded_by).toBe(c.id);
      expect(out.relinked[0].version).toBe(aBefore.version + 1);

      const aAfter = (await getNote(a.id))!;
      expect(aAfter.status).toBe("superseded");
      expect(aAfter.superseded_by).toBe(c.id);
      expect(await stamp("superseded_at", a.id)).toBe(aSupersededAt);
      expect(aAfter.version).toBe(aBefore.version + 1);

      // The note being deleted is gone, and so is its history.
      expect(await getNote(b.id)).toBeUndefined();
      expect(await history(b.id)).toHaveLength(0);

      // The successor is untouched.
      const cAfter = (await getNote(c.id))!;
      expect(cAfter.version).toBe(cBefore.version);
      expect(cAfter.status).toBe("active");

      // Change log: a tombstone for B, and a re-snapshot trigger for A.
      const bChanges = await changesFor(b.id);
      expect(bChanges[bChanges.length - 1]).toEqual({ seq: out.seq, op: "delete" });
      const aChanges = await changesFor(a.id);
      expect(aChanges.map((x) => x.op)).toEqual(["insert", "update", "update"]);

      // The relink is versioned and attributed to delete_note.
      const aHist = await history(a.id);
      expect(aHist.map((h) => [h.version, h.changed_via])).toEqual([
        [1, "supersede_note"],
        [2, "delete_note"],
      ]);
      expect(aHist[1].changed_fields).toEqual(["superseded_by"]);
    });

    it("deleting the end of a chain reactivates the predecessor", async () => {
      const a = await mkNote();
      const b = await mkNote();
      ok(await supersede(a.id, b.id));

      const out = (await remove(b.id))!;
      expect(out.relinked.map((r) => r.id)).toEqual([a.id]);
      expect(out.relinked[0].status).toBe("active");
      expect(out.relinked[0].superseded_by).toBeNull();
      expect(out.relinked[0].superseded_at).toBeNull();

      const aAfter = (await getNote(a.id))!;
      expect(aAfter.status).toBe("active");
      expect(aAfter.superseded_by).toBeNull();
      expect(aAfter.superseded_at).toBeNull();
      expect(aAfter.version).toBe(3);

      const aHist = await history(a.id);
      expect(aHist[aHist.length - 1].changed_via).toBe("delete_note");
      expect(aHist[aHist.length - 1].changed_fields).toEqual(["status", "superseded_at", "superseded_by"]);
    });

    it("reactivates every predecessor of a deleted successor", async () => {
      const a1 = await mkNote();
      const a2 = await mkNote();
      const c = await mkNote();
      ok(await supersede(a1.id, c.id));
      ok(await supersede(a2.id, c.id));

      const out = (await remove(c.id))!;
      expect(out.relinked.map((r) => r.id).sort()).toEqual([a1.id, a2.id].sort());
      expect((await getNote(a1.id))?.status).toBe("active");
      expect((await getNote(a2.id))?.status).toBe("active");
    });

    it("removes the history rows of the deleted note (cascade)", async () => {
      const n = await mkNote();
      ok(await update(n.id, { content: "rev 1" }));
      ok(await update(n.id, { content: "rev 2" }));
      expect(await history(n.id)).toHaveLength(2);

      const out = (await remove(n.id))!;
      expect(out.relinked).toEqual([]);
      expect(await getNote(n.id)).toBeUndefined();
      expect(await history(n.id)).toHaveLength(0);
      const ch = await changesFor(n.id);
      expect(ch[ch.length - 1].op).toBe("delete");
    });

    it("returns null for a missing id", async () => {
      expect(await remove(randomUUID())).toBeNull();
    });

    it("deleting a predecessor does not cascade to its successor", async () => {
      const a = await mkNote();
      const b = await mkNote();
      ok(await supersede(a.id, b.id));
      const out = (await remove(a.id))!;
      expect(out.relinked).toEqual([]);
      const bAfter = (await getNote(b.id))!;
      expect(bAfter.version).toBe(1);
      expect(bAfter.status).toBe("active");
    });
  });

  describe("schema constraints", () => {
    it("a raw DELETE of a successor fails with 23503 (FK NO ACTION)", async () => {
      const a = await mkNote();
      const b = await mkNote();
      ok(await supersede(a.id, b.id));
      await expect(pool.query("DELETE FROM notes WHERE id = $1", [b.id])).rejects.toMatchObject({
        code: "23503",
      });
      expect(await getNote(b.id)).toBeDefined();
      expect((await getNote(a.id))?.superseded_by).toBe(b.id);
    });

    it("SET CONSTRAINTS ALL DEFERRED lets a predecessor be inserted before its successor", async () => {
      const aId = randomUUID();
      const bId = randomUUID();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET CONSTRAINTS ALL DEFERRED");
        await client.query(
          `INSERT INTO notes (id, title, content, scope, status, superseded_by, superseded_at)
           VALUES ($1, $2, 'predecessor', 'work', 'superseded', $3, now())`,
          [aId, uniq("Restored predecessor"), bId]
        );
        await client.query(
          `INSERT INTO notes (id, title, content, scope) VALUES ($1, $2, 'successor', 'work')`,
          [bId, uniq("Restored successor")]
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
      expect((await getNote(aId))?.superseded_by).toBe(bId);
      expect(await getNote(bId)).toBeDefined();
    });

    it("without deferral the same out-of-order insert fails with 23503", async () => {
      await expect(
        pool.query(
          `INSERT INTO notes (id, title, content, scope, status, superseded_by, superseded_at)
           VALUES ($1, $2, 'orphan', 'work', 'superseded', $3, now())`,
          [randomUUID(), uniq("Orphan predecessor"), randomUUID()]
        )
      ).rejects.toMatchObject({ code: "23503" });
    });

    it("rejects status='superseded' without a successor (23514)", async () => {
      const n = await mkNote();
      const err = await pool
        .query("UPDATE notes SET status = 'superseded' WHERE id = $1", [n.id])
        .then(() => null, (e: unknown) => e as { code?: string; constraint?: string });
      expect(err?.code).toBe("23514");
      expect(err?.constraint).toMatch(/^chk_notes_superseded_(shape|at)$/);
      expect((await getNote(n.id))?.status).toBe("active");
    });

    it("rejects a provenance outside the enum (23514)", async () => {
      const n = await mkNote();
      const err = await pool
        .query("UPDATE notes SET provenance = 'rumour' WHERE id = $1", [n.id])
        .then(() => null, (e: unknown) => e as { code?: string; constraint?: string });
      expect(err?.code).toBe("23514");
      expect(err?.constraint).toBe("chk_notes_provenance");
      expect((await getNote(n.id))?.provenance).toBeNull();
    });

    it("accepts every documented provenance value", async () => {
      for (const p of ["stated", "decided", "inferred", "fetched", "derived"] as const) {
        const n = await mkNote({ provenance: p });
        expect(n.provenance).toBe(p);
      }
    });

    it("rejects a stored status of 'expired' (23514)", async () => {
      const n = await mkNote();
      await expect(
        pool.query("UPDATE notes SET status = 'expired' WHERE id = $1", [n.id])
      ).rejects.toMatchObject({ code: "23514", constraint: "chk_notes_status" });
    });

    it("rejects a note superseded by itself (23514)", async () => {
      const n = await mkNote();
      await expect(
        pool.query(
          `UPDATE notes SET status = 'superseded', superseded_by = id, superseded_at = now() WHERE id = $1`,
          [n.id]
        )
      ).rejects.toMatchObject({ code: "23514", constraint: "chk_notes_no_self_supersede" });
    });

    it("a failed constraint statement leaves no history row behind", async () => {
      const n = await mkNote();
      await pool.query("UPDATE notes SET provenance = 'rumour' WHERE id = $1", [n.id]).catch(() => {});
      expect(await history(n.id)).toHaveLength(0);
      expect((await getNote(n.id))?.version).toBe(1);
    });
  });

  describe("pruneNoteHistoryInTx", () => {
    const prune = (id: string, keepLast: number) =>
      withTransaction((c) => pruneNoteHistoryInTx(c, id, keepLast));

    async function noteWithRevisions(count: number): Promise<NoteRow> {
      const n = await mkNote();
      for (let i = 1; i <= count; i++) ok(await update(n.id, { content: `revision ${i}` }));
      return n;
    }

    it("keeps exactly keepLast newest rows and reports deleted/remaining counts", async () => {
      const n = await noteWithRevisions(5);
      expect((await history(n.id)).map((h) => h.version)).toEqual([1, 2, 3, 4, 5]);
      const changesBefore = (await changesFor(n.id)).length;

      const out = (await prune(n.id, 2))!;
      expect(out.deleted).toBe(3);
      expect(out.remaining).toBe(2);
      expect(out.row.version).toBe(6);
      expect((await history(n.id)).map((h) => h.version)).toEqual([4, 5]);

      // The note itself is unchanged: no version bump, no change-log row.
      expect((await getNote(n.id))?.version).toBe(6);
      expect(await changesFor(n.id)).toHaveLength(changesBefore);
    });

    it("is a no-op when fewer rows exist than keepLast", async () => {
      const n = await noteWithRevisions(2);
      const out = (await prune(n.id, 10))!;
      expect(out.deleted).toBe(0);
      expect(out.remaining).toBe(2);
    });

    it("purges all history for keepLast 0", async () => {
      const n = await noteWithRevisions(3);
      const out = (await prune(n.id, 0))!;
      expect(out.deleted).toBe(3);
      expect(out.remaining).toBe(0);
      expect(await history(n.id)).toHaveLength(0);
    });

    it("floors a fractional keepLast", async () => {
      const n = await noteWithRevisions(4);
      const out = (await prune(n.id, 2.9))!;
      expect(out.remaining).toBe(2);
    });

    it("returns null for a missing id", async () => {
      expect(await prune(randomUUID(), 1)).toBeNull();
    });
  });
});

// ─────────────────────────────────────────────────────────────────
// E. Concurrency: the real row-lock and advisory-lock behaviour
// ─────────────────────────────────────────────────────────────────

describe.skipIf(!pgAvailable)("note store: concurrency with two clients", () => {
  let c1: pg.Client;
  let c2: pg.Client;

  beforeAll(async () => {
    await freshSchema();
    c1 = new pg.Client();
    c2 = new pg.Client();
    await c1.connect();
    await c2.connect();
  }, 30_000);

  afterEach(async () => {
    // A failed test must not leave a transaction (and its locks) open.
    await c1.query("ROLLBACK").catch(() => {});
    await c2.query("ROLLBACK").catch(() => {});
  });

  afterAll(async () => {
    await c1?.end().catch(() => {});
    await c2?.end().catch(() => {});
  });

  it(
    "a second writer blocks on FOR UPDATE, then sees version_conflict after the first commits",
    { timeout: 15_000 },
    async () => {
      const n = await mkNote({ content: "original" });

      await c1.query("BEGIN");
      const r1 = await updateNoteInTx(
        asPool(c1),
        n.id,
        { content: "first" },
        { expectedVersion: n.version, via: "update_note" }
      );
      expect(r1.ok).toBe(true);
      // c1 holds the row lock and has NOT committed.

      await c2.query("BEGIN");
      let settled = false;
      const p2 = updateNoteInTx(
        asPool(c2),
        n.id,
        { content: "second" },
        { expectedVersion: n.version, via: "update_note" }
      );
      p2.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );

      // The server confirms c2 is parked on a lock, and it has not settled.
      await waitUntilBlocked(c2);
      await sleep(300);
      expect(settled).toBe(false);

      await c1.query("COMMIT");
      const r2 = await p2;
      expect(settled).toBe(true);

      const conflict = conflictOfKind(r2, "version_conflict");
      expect(conflict.current.version).toBe(n.version + 1);
      expect(conflict.current.content).toBe("first");
      await c2.query("ROLLBACK");

      const final = (await getNote(n.id))!;
      expect(final.content).toBe("first");
      expect(final.version).toBe(2);
      expect(await history(n.id)).toHaveLength(1);
    }
  );

  it(
    "without expectedVersion, concurrent writers serialise (last-writer-wins) and both are versioned",
    { timeout: 15_000 },
    async () => {
      const n = await mkNote();
      const [r1, r2] = await Promise.all([
        runInTx(c1, (c) => updateNoteInTx(c, n.id, { title: uniq("Writer one") }, { via: "update_note" })),
        runInTx(c2, (c) => updateNoteInTx(c, n.id, { content: "Writer two body" }, { via: "update_note" })),
      ]);
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);

      const final = (await getNote(n.id))!;
      expect(final.version).toBe(3);
      expect((await history(n.id)).map((h) => h.version)).toEqual([1, 2]);
    }
  );

  it(
    "a second supersede of the same note waits on the lifecycle advisory lock, then gets status_conflict",
    { timeout: 15_000 },
    async () => {
      const a = await mkNote();
      const b = await mkNote();
      const c = await mkNote();

      await c1.query("BEGIN");
      const r1 = await supersedeNoteInTx(asPool(c1), a.id, b.id, { via: "supersede_note" });
      expect(r1.ok).toBe(true);

      await c2.query("BEGIN");
      let settled = false;
      const p2 = supersedeNoteInTx(asPool(c2), a.id, c.id, { via: "supersede_note" });
      p2.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );

      expect(await waitUntilBlocked(c2)).toBe("advisory");
      await sleep(300);
      expect(settled).toBe(false);

      await c1.query("COMMIT");
      const r2 = await p2;
      const conflict = conflictOfKind(r2, "status_conflict");
      expect(conflict.current.superseded_by).toBe(b.id);
      await c2.query("ROLLBACK");

      const aFinal = (await getNote(a.id))!;
      expect(aFinal.version).toBe(2);
      expect(aFinal.superseded_by).toBe(b.id);
      expect(await history(a.id)).toHaveLength(1);
      expect((await getNote(c.id))?.version).toBe(1);
    }
  );

  it(
    "two racing supersedes of the same note: exactly one wins, the version advances once",
    { timeout: 20_000 },
    async () => {
      for (let i = 0; i < 5; i++) {
        const a = await mkNote();
        const b = await mkNote();
        const c = await mkNote();

        const results = await Promise.all([
          runInTx(c1, (cl) => supersedeNoteInTx(cl, a.id, b.id, { via: "supersede_note" })),
          runInTx(c2, (cl) => supersedeNoteInTx(cl, a.id, c.id, { via: "supersede_note" })),
        ]);

        const winners = results.filter((r) => r.ok);
        const losers = results.filter((r) => !r.ok);
        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(1);
        conflictOfKind(losers[0], "status_conflict");

        const aFinal = (await getNote(a.id))!;
        expect(aFinal.version).toBe(2);
        expect([b.id, c.id]).toContain(aFinal.superseded_by);
        expect(await history(a.id)).toHaveLength(1);
        const aChanges = await changesFor(a.id);
        expect(aChanges.map((x) => x.op)).toEqual(["insert", "update"]);
      }
    }
  );

  it(
    "racing deletes of adjacent chain members do not deadlock and leave a consistent chain",
    { timeout: 30_000 },
    async () => {
      for (let i = 0; i < 5; i++) {
        const a = await mkNote();
        const b = await mkNote();
        const c = await mkNote();
        ok(await supersede(a.id, b.id));
        ok(await supersede(b.id, c.id));

        // Delete-splice on B locks B then A; delete-splice on C locks C then B.
        // Without the lifecycle advisory lock these form a lock cycle.
        const results = await Promise.all([
          runInTx(c1, (cl) => deleteNoteInTx(cl, b.id, { via: "delete_note" })),
          runInTx(c2, (cl) => deleteNoteInTx(cl, c.id, { via: "delete_note" })),
        ]);
        expect(results[0]).not.toBeNull();
        expect(results[1]).not.toBeNull();

        // Whichever order they ran in, only A survives and nothing says it is superseded.
        expect(await getNote(b.id)).toBeUndefined();
        expect(await getNote(c.id)).toBeUndefined();
        const aFinal = (await getNote(a.id))!;
        expect(aFinal.status).toBe("active");
        expect(aFinal.superseded_by).toBeNull();
        expect(aFinal.superseded_at).toBeNull();
      }
    }
  );
});

// ─────────────────────────────────────────────────────────────────
// F. Retention cap (NOTE_HISTORY_MAX_VERSIONS)
// ─────────────────────────────────────────────────────────────────

describe.skipIf(!pgAvailable)("note store: history retention cap", () => {
  type StoreModule = typeof import("../notes/store.js");
  type ChangesModule = typeof import("../db/changes.js");
  type ClientModule = typeof import("../db/client.js");

  let capped: StoreModule;
  let cappedChanges: ChangesModule;
  let cappedClient: ClientModule;

  beforeAll(async () => {
    await freshSchema();

    // config.ts reads the variable at import time, so re-import everything
    // that depends on it with the cap in place. This also builds a second pool
    // (client.js is re-evaluated); it is ended in afterAll.
    process.env.NOTE_HISTORY_MAX_VERSIONS = "2";
    vi.resetModules();
    capped = await import("../notes/store.js");
    cappedChanges = await import("../db/changes.js");
    cappedClient = await import("../db/client.js");
    const cfg = await import("../config.js");
    expect(cfg.config.noteHistoryMaxVersions).toBe(2);
  }, 30_000);

  afterAll(async () => {
    delete process.env.NOTE_HISTORY_MAX_VERSIONS;
    vi.resetModules();
    await cappedClient?.pool.end();
  });

  const run = <T>(fn: (c: PoolClient) => Promise<T>) => cappedChanges.withTransaction(fn);

  async function newNote(): Promise<NoteRow> {
    return run(async (c) => {
      const { row } = await capped.insertNoteInTx(c, {
        title: uniq("Capped"),
        content: "Initial content",
        scope: "work",
      });
      return row;
    });
  }

  const cappedUpdate = (id: string, content: string) =>
    run((c) => capped.updateNoteInTx(c, id, { content }, { via: "update_note" }));

  async function cappedHistoryVersions(id: string): Promise<number[]> {
    const r = await cappedClient.query<{ version: number }>(
      "SELECT version FROM note_versions WHERE note_id = $1 ORDER BY version",
      [id]
    );
    return r.rows.map((x) => x.version);
  }

  it("keeps only the 2 newest history rows after 5 versioned updates", async () => {
    const n = await newNote();
    for (let i = 1; i <= 5; i++) ok(await cappedUpdate(n.id, `revision ${i}`));

    const current = (await cappedClient.query<{ version: number }>("SELECT version FROM notes WHERE id = $1", [
      n.id,
    ])).rows[0].version;
    expect(current).toBe(6);
    // History rows for version v are v1..v-1; keeping 2 means current-2 .. current-1.
    expect(await cappedHistoryVersions(n.id)).toEqual([current - 2, current - 1]);
    expect(await cappedHistoryVersions(n.id)).toEqual([4, 5]);
  });

  it("trims on every write, not just at the end", async () => {
    const n = await newNote();
    ok(await cappedUpdate(n.id, "r1"));
    expect(await cappedHistoryVersions(n.id)).toEqual([1]);
    ok(await cappedUpdate(n.id, "r2"));
    expect(await cappedHistoryVersions(n.id)).toEqual([1, 2]);
    ok(await cappedUpdate(n.id, "r3"));
    expect(await cappedHistoryVersions(n.id)).toEqual([2, 3]);
  });

  it("applies the cap to supersede", async () => {
    const a = await newNote();
    const b = await newNote();
    for (let i = 1; i <= 4; i++) ok(await cappedUpdate(a.id, `revision ${i}`));
    expect(await cappedHistoryVersions(a.id)).toEqual([3, 4]);

    ok(await run((c) => capped.supersedeNoteInTx(c, a.id, b.id, { via: "supersede_note" })));
    expect(await cappedHistoryVersions(a.id)).toEqual([4, 5]);
  });

  it("applies the cap to a delete-splice relink", async () => {
    const a = await newNote();
    const b = await newNote();
    for (let i = 1; i <= 3; i++) ok(await cappedUpdate(a.id, `revision ${i}`));
    ok(await run((c) => capped.supersedeNoteInTx(c, a.id, b.id, { via: "supersede_note" })));
    expect(await cappedHistoryVersions(a.id)).toEqual([3, 4]);

    const out = await run((c) => capped.deleteNoteInTx(c, b.id, { via: "delete_note" }));
    expect(out?.relinked.map((r) => r.id)).toEqual([a.id]);
    expect(await cappedHistoryVersions(a.id)).toEqual([4, 5]);
  });

  it("leaves history alone for a no-op update", async () => {
    const n = await newNote();
    ok(await cappedUpdate(n.id, "r1"));
    ok(await cappedUpdate(n.id, "r2"));
    const before = await cappedHistoryVersions(n.id);
    const out = ok(await cappedUpdate(n.id, "r2"));
    expect(out.changed).toBe(false);
    expect(await cappedHistoryVersions(n.id)).toEqual(before);
  });
});
