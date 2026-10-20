import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { runScriptSync } from "./helpers/spawn-server.js";
import { readFile, readdir, rm, mkdir, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import pg from "pg";

/**
 * Round-trip integration test for scripts/export.ts + scripts/import.ts.
 *
 * Seeds synthetic fixtures across every managed primitive (tasks, notes,
 * artifacts, entities, entity_nodes, entity_relations, extraction_runs,
 * pending_embeddings, changes, sync_op_log) plus a handoff file tree,
 * runs the export script as a subprocess, wipes the database and the
 * handoff dir, runs the import script, and asserts row counts + one
 * spot-check per table.
 *
 * The second scenario exercises the re-embed policy — an export whose
 * manifest declares a different embedding model than the destination's
 * config should populate pending_embeddings on restore.
 *
 * Note lifecycle (migration 013) is covered end to end: a superseded pair
 * with edit history survives the round-trip column for column, a tarball
 * written before 013 still restores (column defaults), an inconsistent
 * note_versions file is refused before any write, and the export is proven to
 * read every table from one snapshot even when a note edit commits between
 * the `notes` read and the `note_versions` read.
 *
 * Uses a dedicated per-suite database to stay parallel-safe alongside
 * the other Postgres-gated suites. TEI is NOT required; the test never
 * calls a search tool and does not exercise TEI at all.
 */

const { Client } = pg;

const PG_DATABASE = "cl_test_export_import";
const PG_USER = process.env.PGUSER ?? "cl";
const PG_PASSWORD = process.env.PGPASSWORD ?? "test";
const PG_HOST = process.env.PGHOST ?? "localhost";
const PG_PORT = process.env.PGPORT ?? "5432";

const TEST_ROOT = join(process.cwd(), "data", "test-export-import");
const TEST_DATA_DIR = join(TEST_ROOT, "data");
const TEST_EXPORT_DIR = join(TEST_ROOT, "exports");

const EXPORT_SCRIPT = join(process.cwd(), "scripts", "export.ts");
const IMPORT_SCRIPT = join(process.cwd(), "scripts", "import.ts");
const MIGRATIONS_DIR = join(process.cwd(), "src", "db", "migrations");
// Run tsx through the current node binary rather than `npx tsx`: identical on
// POSIX, and it also works on Windows, where spawning the `npx` shim without a
// shell fails with ENOENT.
const TSX_CLI = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");

const SCRIPT_TIMEOUT_MS = 60_000;

// ── Env helpers ───────────────────────────────────────────────────

function scriptEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PGHOST: PG_HOST,
    PGPORT: PG_PORT,
    PGUSER: PG_USER,
    PGPASSWORD: PG_PASSWORD,
    PGDATABASE: PG_DATABASE,
    DATA_DIR: TEST_DATA_DIR,
    ...overrides,
  };
}

function runScript(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv
): { status: number; stdout: string; stderr: string } {
  return runScriptSync(script, args, env, SCRIPT_TIMEOUT_MS);
}

/** Async variant for the one test that must act while the script is running. */
function runScriptAsync(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv
): {
  done: Promise<{ status: number; stdout: string; stderr: string }>;
  hasExited: () => boolean;
  kill: () => void;
} {
  const proc = spawn(process.execPath, [TSX_CLI, script, ...args], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let exited = false;
  proc.stdout.on("data", (c) => (stdout += c));
  proc.stderr.on("data", (c) => (stderr += c));
  const done = new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
    proc.on("error", (err) => {
      exited = true;
      resolve({ status: 1, stdout, stderr: stderr + `\n${err.message}` });
    });
    proc.on("close", (code) => {
      exited = true;
      resolve({ status: code ?? 1, stdout, stderr });
    });
  });
  return { done, hasExited: () => exited, kill: () => void proc.kill() };
}

// ── tar helpers (system tar, like the scripts themselves) ─────────

function tarExtract(tarball: string, destDir: string): void {
  const r = spawnSync("tar", ["-xzf", tarball, "-C", destDir], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`tar -x failed (${r.status}): ${r.stderr}`);
}

function tarCreate(sourceDir: string, tarball: string): void {
  const r = spawnSync("tar", ["-czf", tarball, "-C", sourceDir, "."], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`tar -c failed (${r.status}): ${r.stderr}`);
}

function newClient(): InstanceType<typeof Client> {
  return new Client({
    host: PG_HOST,
    port: parseInt(PG_PORT),
    user: PG_USER,
    password: PG_PASSWORD,
    database: PG_DATABASE,
  });
}

// ── Fresh DB + migrations ─────────────────────────────────────────

/**
 * Drop the schema and re-apply migrations (recording each in `_migrations`).
 * `include` narrows which migration files are applied — used to stage a
 * destination that has not yet seen a newer migration.
 */
async function applyMigrationsFresh(
  include: (filename: string) => boolean = () => true
): Promise<void> {
  const client = new Client({
    host: PG_HOST,
    port: parseInt(PG_PORT),
    user: PG_USER,
    password: PG_PASSWORD,
    database: PG_DATABASE,
  });
  await client.connect();
  try {
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");

    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith(".sql") && include(f))
      .sort();
    for (const file of files) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf-8");
      await client.query(sql);
      await client.query("INSERT INTO _migrations (filename) VALUES ($1)", [file]);
    }
  } finally {
    await client.end();
  }
}

async function checkPostgres(): Promise<boolean> {
  let admin: InstanceType<typeof Client> | undefined;
  try {
    admin = new Client({
      host: PG_HOST,
      port: parseInt(PG_PORT),
      user: PG_USER,
      password: PG_PASSWORD,
      database: "postgres",
    });
    await admin.connect();
    const exists = await admin.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [PG_DATABASE]
    );
    if (exists.rowCount === 0) {
      await admin.query(`CREATE DATABASE ${PG_DATABASE}`);
    }
    await admin.end();
    admin = undefined;
    await applyMigrationsFresh();
    return true;
  } catch {
    try { await admin?.end(); } catch { /* ignore */ }
    return false;
  }
}

const pgAvailable = await checkPostgres();

if (!pgAvailable) {
  console.log("\n" + "=".repeat(60));
  console.log("  NOTICE: PostgreSQL not available");
  console.log("  export-import round-trip suite will be SKIPPED");
  console.log("=".repeat(60) + "\n");
}

// ── Fixtures ──────────────────────────────────────────────────────

/**
 * Seed values pinned so we can assert exact matches after round-trip.
 * All names are generic (Acme Corp / Jane Developer register, per
 * CLAUDE.md's Personal Data Prohibition).
 */
const FIXTURES = {
  task: {
    id: "10000000-0000-0000-0000-000000000001",
    title: "Wire up Acme Corp billing dashboard",
    context: "Q3 initiative; blocks Jane Developer's demo prep",
    status: "open" as const,
    scope: "work" as const,
    priority: "high" as const,
    tags: ["billing", "acme"],
  },
  note: {
    id: "20000000-0000-0000-0000-000000000001",
    title: "Round-trip test note",
    content: "This note should survive export → wipe → import unchanged.",
    scope: "shared" as const,
    tags: ["portability"],
  },
  /**
   * A superseded pair with edit history (migration 013). `old.id` sorts BEFORE
   * `successor.id`, so notes.jsonl lists the superseded note ahead of the note
   * it points at — restoring it exercises the deferred self-referencing FK.
   * Two UPDATEs on `old` leave two note_versions rows (v1, v2) and bring the
   * note to version 3; `successor` is never edited and stays at version 1.
   */
  lifecycle: {
    old: {
      id: "20000000-0000-0000-0000-000000000002",
      title: "Acme Corp Friday deploys",
      content: "Acme Corp deploys on Fridays.",
      revisedContent: "Acme Corp deploys on Fridays, except release weeks.",
      provenance: "stated" as const,
      validUntil: "2026-03-31T00:00:00.000Z",
    },
    successor: {
      id: "20000000-0000-0000-0000-000000000003",
      title: "Acme Corp deploy freeze",
      content: "Acme Corp froze Friday deploys.",
      provenance: "decided" as const,
      validUntil: "2030-06-30T00:00:00.000Z",
    },
  },
  artifact: {
    id: "30000000-0000-0000-0000-000000000001",
    title: "Deploy runbook — Acme staging",
    artifact_type: "cc-prompt",
    content: "Steps to deploy the staging environment for Acme Corp.",
    status: "ready" as const,
    scope: "work" as const,
    tags: ["runbook"],
    metadata: { content_hash: "a".repeat(64), target_repo: "acme/staging" },
  },
  entity: {
    id: "40000000-0000-0000-0000-000000000001",
    canonical_name: "Acme Corp",
    scope: "work" as const,
    aliases: ["Acme", "acme.example.com"],
    constraints: ["staging only"],
    metadata: { register: "generic" },
  },
  entityNode: {
    id: "50000000-0000-0000-0000-000000000001",
    name: "Jane Developer",
    entity_type: "person",
    canonical_name: "jane developer",
  },
  extractionRun: {
    id: "60000000-0000-0000-0000-000000000001",
    provider: "ollama",
    provider_version: "0.1.0",
    status: "completed",
  },
  handoff: {
    filename: "2026-07-06T12-00-00-000Z-deadbeef.json",
    body: {
      schema_version: 1,
      stored_at: "2026-07-06T12:00:00.000Z",
      active_context: { session: "portability-test" },
      user_note: "This is a synthetic handoff for the export/import round-trip.",
    },
  },
} as const;

/**
 * Builds the superseded pair the way the real write paths do: one transaction
 * per edit, with the writer recorded in the transaction-local `app.changed_via`
 * setting that the versioning trigger reads. The trigger — not this helper —
 * writes the note_versions rows and bumps `version`.
 */
async function seedNoteLifecycle(client: InstanceType<typeof Client>): Promise<void> {
  const { old, successor } = FIXTURES.lifecycle;

  await client.query(
    `INSERT INTO notes (id, title, content, scope, tags, provenance, valid_until)
     VALUES ($1, $2, $3, 'shared', $4, $5, $6), ($7, $8, $9, 'shared', $10, $11, $12)`,
    [
      old.id, old.title, old.content, ["deploys"], old.provenance, old.validUntil,
      successor.id, successor.title, successor.content, ["deploys"], successor.provenance, successor.validUntil,
    ]
  );

  // Edit 1: content change (v1 -> v2, history row for v1).
  await client.query("BEGIN");
  await client.query("SELECT set_config('app.changed_via', 'update_note', true)");
  await client.query("UPDATE notes SET content = $2 WHERE id = $1", [old.id, old.revisedContent]);
  await client.query("COMMIT");

  // Edit 2: supersede (v2 -> v3, history row for v2).
  await client.query("BEGIN");
  await client.query("SELECT set_config('app.changed_via', 'supersede_note', true)");
  await client.query(
    `UPDATE notes SET status = 'superseded', superseded_by = $2, superseded_at = now() WHERE id = $1`,
    [old.id, successor.id]
  );
  await client.query("COMMIT");
}

async function seed(client: InstanceType<typeof Client>): Promise<void> {
  await client.query(
    `INSERT INTO tasks (id, title, context, status, scope, priority, tags)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      FIXTURES.task.id,
      FIXTURES.task.title,
      FIXTURES.task.context,
      FIXTURES.task.status,
      FIXTURES.task.scope,
      FIXTURES.task.priority,
      FIXTURES.task.tags,
    ]
  );

  await client.query(
    `INSERT INTO notes (id, title, content, scope, tags)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      FIXTURES.note.id,
      FIXTURES.note.title,
      FIXTURES.note.content,
      FIXTURES.note.scope,
      FIXTURES.note.tags,
    ]
  );

  await seedNoteLifecycle(client);

  await client.query(
    `INSERT INTO artifacts (id, title, artifact_type, content, status, scope, tags, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      FIXTURES.artifact.id,
      FIXTURES.artifact.title,
      FIXTURES.artifact.artifact_type,
      FIXTURES.artifact.content,
      FIXTURES.artifact.status,
      FIXTURES.artifact.scope,
      FIXTURES.artifact.tags,
      JSON.stringify(FIXTURES.artifact.metadata),
    ]
  );

  await client.query(
    `INSERT INTO entities (id, canonical_name, scope, aliases, constraints, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      FIXTURES.entity.id,
      FIXTURES.entity.canonical_name,
      FIXTURES.entity.scope,
      FIXTURES.entity.aliases,
      FIXTURES.entity.constraints,
      JSON.stringify(FIXTURES.entity.metadata),
    ]
  );

  await client.query(
    `INSERT INTO entity_nodes (id, name, entity_type, canonical_name)
     VALUES ($1, $2, $3, $4)`,
    [
      FIXTURES.entityNode.id,
      FIXTURES.entityNode.name,
      FIXTURES.entityNode.entity_type,
      FIXTURES.entityNode.canonical_name,
    ]
  );

  await client.query(
    `INSERT INTO extraction_runs (id, provider, provider_version, status, content_count, triple_count)
     VALUES ($1, $2, $3, $4, 1, 0)`,
    [
      FIXTURES.extractionRun.id,
      FIXTURES.extractionRun.provider,
      FIXTURES.extractionRun.provider_version,
      FIXTURES.extractionRun.status,
    ]
  );

  // A pending_embeddings row — must survive the round-trip so an in-flight
  // re-embed campaign is not lost.
  await client.query(
    `INSERT INTO pending_embeddings (content_type, content_id) VALUES ('task', $1)`,
    [FIXTURES.task.id]
  );

  // A changes row and a matching sync_op_log entry.
  await client.query(
    `INSERT INTO changes (entity_type, entity_id, op) VALUES ('task', $1, 'insert')`,
    [FIXTURES.task.id]
  );
  await client.query(
    `INSERT INTO sync_op_log (op_uuid, entity_type, entity_id, op)
     VALUES ('70000000-0000-0000-0000-000000000001', 'task', $1, 'insert')`,
    [FIXTURES.task.id]
  );
}

async function seedHandoff(): Promise<void> {
  const dir = join(TEST_DATA_DIR, "handoffs");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, FIXTURES.handoff.filename),
    JSON.stringify(FIXTURES.handoff.body, null, 2),
    "utf-8"
  );
}

/**
 * Every notes column the lifecycle migration touches plus the full
 * note_versions table, as pg returns them (timestamps as ms-precision Dates,
 * which is exactly the precision the JSONL export carries — so state read
 * before an export compares equal to state read after a restore).
 */
async function readNoteState(c: InstanceType<typeof Client>) {
  const notes = await c.query(
    `SELECT id, title, content, domain, tags, scope, source_url, related_task_ids,
            status, superseded_by, superseded_at, valid_until, provenance, version,
            created_at, updated_at
       FROM notes ORDER BY id`
  );
  const versions = await c.query(
    `SELECT note_id, version, snapshot, changed_fields, changed_via, changed_at
       FROM note_versions ORDER BY note_id, version`
  );
  return { notes: notes.rows, versions: versions.rows };
}

/** Read a JSONL table file from an extracted export into parsed rows. */
async function readJsonl(dir: string, table: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(join(dir, "tables", `${table}.jsonl`), "utf-8");
  return raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

async function writeJsonl(dir: string, table: string, rows: Record<string, unknown>[]): Promise<void> {
  const body = rows.length === 0 ? "" : rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await writeFile(join(dir, "tables", `${table}.jsonl`), body, "utf-8");
}

// ── Tests ─────────────────────────────────────────────────────────

describe.skipIf(!pgAvailable)("export/import round-trip", () => {
  let client: InstanceType<typeof Client>;

  /** Fresh schema, fresh fixtures, fresh handoff dir; reconnects `client`. */
  async function resetAndSeed(): Promise<void> {
    await applyMigrationsFresh();
    await rm(join(TEST_DATA_DIR, "handoffs"), { recursive: true, force: true });
    await client.end();
    client = newClient();
    await client.connect();
    await seed(client);
    await seedHandoff();
  }

  /**
   * Wipe the schema (empty destination) and reconnect `client`. `include`
   * limits which migrations are re-applied (default: all of them).
   */
  async function wipeDestination(include?: (filename: string) => boolean): Promise<void> {
    await applyMigrationsFresh(include);
    await rm(join(TEST_DATA_DIR, "handoffs"), { recursive: true, force: true });
    await client.end();
    client = newClient();
    await client.connect();
  }

  /** Export the current database into `outDir`; returns the tarball path. */
  async function exportTo(outDir: string): Promise<string> {
    const res = runScript(EXPORT_SCRIPT, ["--out", outDir], scriptEnv());
    expect(
      res.status,
      `export exited ${res.status}.\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
    ).toBe(0);
    return join(outDir, (await readdir(outDir)).find((f) => f.endsWith(".tar.gz"))!);
  }

  /** Extract a tarball into a fresh directory under TEST_ROOT. */
  async function extractTo(tarball: string, name: string): Promise<string> {
    const dir = join(TEST_ROOT, name);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    tarExtract(tarball, dir);
    return dir;
  }

  /** Read-modify-write an extracted export's manifest.json. */
  async function editManifest(
    dir: string,
    edit: (manifest: { applied_migrations: string[]; row_counts: Record<string, number> }) => void
  ): Promise<void> {
    const path = join(dir, "manifest.json");
    const manifest = JSON.parse(await readFile(path, "utf-8"));
    edit(manifest);
    await writeFile(path, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  }

  /**
   * Rewrite an export of the current database into the shape a pre-013 export
   * had: notes rows without the six lifecycle keys, no note_versions.jsonl, no
   * manifest count for it, and no 013 in applied_migrations. Returns the new
   * tarball path.
   */
  async function makePre013Tarball(tarball: string, name: string): Promise<string> {
    const dir = await extractTo(tarball, `${name}-extract`);
    const lifecycleKeys = ["status", "superseded_by", "superseded_at", "valid_until", "provenance", "version"];
    const notes = await readJsonl(dir, "notes");
    expect(notes).toHaveLength(3);
    await writeJsonl(
      dir,
      "notes",
      notes.map((row) => {
        const stripped = { ...row };
        for (const key of lifecycleKeys) delete stripped[key];
        return stripped;
      })
    );
    await rm(join(dir, "tables", "note_versions.jsonl"));
    await editManifest(dir, (manifest) => {
      delete manifest.row_counts.note_versions;
      manifest.applied_migrations = manifest.applied_migrations.filter((m) => !m.startsWith("013_"));
    });
    const out = join(TEST_ROOT, `${name}.tar.gz`);
    tarCreate(dir, out);
    return out;
  }

  beforeAll(async () => {
    await rm(TEST_ROOT, { recursive: true, force: true });
    await mkdir(TEST_ROOT, { recursive: true });

    client = newClient();
    await client.connect();
    await seed(client);
    await seedHandoff();
  }, SCRIPT_TIMEOUT_MS);

  afterAll(async () => {
    await client.end();
    await rm(TEST_ROOT, { recursive: true, force: true });
  });

  it("full round-trip: export → wipe → import restores every table + handoff", async () => {
    // Note state as the source database holds it, for exact comparison later.
    const noteStateBefore = await readNoteState(client);
    expect(noteStateBefore.notes).toHaveLength(3);
    expect(noteStateBefore.versions).toHaveLength(2);

    // ── export ───────────────────────────────────────────────
    const exportRes = runScript(
      EXPORT_SCRIPT,
      ["--out", TEST_EXPORT_DIR],
      scriptEnv()
    );
    expect(
      exportRes.status,
      `export exited ${exportRes.status}.\nstdout:\n${exportRes.stdout}\nstderr:\n${exportRes.stderr}`
    ).toBe(0);

    const exportFiles = (await readdir(TEST_EXPORT_DIR)).filter((f) =>
      f.endsWith(".tar.gz")
    );
    expect(exportFiles.length).toBe(1);
    const tarball = join(TEST_EXPORT_DIR, exportFiles[0]);

    // The tarball carries the new registry entries: note_versions.jsonl exists
    // and the manifest counts both notes and history rows.
    const firstExtract = await extractTo(tarball, "rt-first-extract");
    const firstManifest = JSON.parse(await readFile(join(firstExtract, "manifest.json"), "utf-8"));
    expect(firstManifest.row_counts.notes).toBe(3);
    expect(firstManifest.row_counts.note_versions).toBe(2);
    expect(firstManifest.applied_migrations.some((m: string) => m.startsWith("013_"))).toBe(true);
    const exportedNote = (await readJsonl(firstExtract, "notes")).find(
      (r) => r.id === FIXTURES.lifecycle.old.id
    )!;
    for (const col of ["status", "superseded_by", "superseded_at", "valid_until", "provenance", "version"]) {
      expect(exportedNote, `notes.jsonl row is missing the "${col}" key`).toHaveProperty(col);
    }

    // ── wipe destination ─────────────────────────────────────
    await applyMigrationsFresh();
    await rm(join(TEST_DATA_DIR, "handoffs"), { recursive: true, force: true });

    // Reconnect since applyMigrationsFresh's DROP SCHEMA severed our tables.
    await client.end();
    client = newClient();
    await client.connect();

    // Sanity: destination is empty.
    const before = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM tasks"
    );
    expect(Number(before.rows[0].count)).toBe(0);

    // ── import ───────────────────────────────────────────────
    const importRes = runScript(IMPORT_SCRIPT, [tarball], scriptEnv());
    expect(
      importRes.status,
      `import exited ${importRes.status}.\nstdout:\n${importRes.stdout}\nstderr:\n${importRes.stderr}`
    ).toBe(0);

    // ── spot checks per table ────────────────────────────────
    const t = await client.query(
      "SELECT id, title, tags FROM tasks WHERE id = $1",
      [FIXTURES.task.id]
    );
    expect(t.rowCount).toBe(1);
    expect(t.rows[0].title).toBe(FIXTURES.task.title);
    expect(t.rows[0].tags).toEqual(FIXTURES.task.tags);

    const n = await client.query(
      "SELECT title, content FROM notes WHERE id = $1",
      [FIXTURES.note.id]
    );
    expect(n.rowCount).toBe(1);
    expect(n.rows[0].content).toBe(FIXTURES.note.content);

    const a = await client.query(
      "SELECT title, content, metadata FROM artifacts WHERE id = $1",
      [FIXTURES.artifact.id]
    );
    expect(a.rowCount).toBe(1);
    expect(a.rows[0].content).toBe(FIXTURES.artifact.content);
    expect(a.rows[0].metadata).toEqual(FIXTURES.artifact.metadata);

    const e = await client.query(
      "SELECT canonical_name, aliases FROM entities WHERE id = $1",
      [FIXTURES.entity.id]
    );
    expect(e.rowCount).toBe(1);
    expect(e.rows[0].canonical_name).toBe(FIXTURES.entity.canonical_name);
    expect(e.rows[0].aliases).toEqual(FIXTURES.entity.aliases);

    const en = await client.query(
      "SELECT name, entity_type FROM entity_nodes WHERE id = $1",
      [FIXTURES.entityNode.id]
    );
    expect(en.rowCount).toBe(1);
    expect(en.rows[0].name).toBe(FIXTURES.entityNode.name);

    const er = await client.query(
      "SELECT id, provider FROM extraction_runs WHERE id = $1",
      [FIXTURES.extractionRun.id]
    );
    expect(er.rowCount).toBe(1);
    expect(er.rows[0].provider).toBe(FIXTURES.extractionRun.provider);

    const pe = await client.query(
      "SELECT content_type, content_id FROM pending_embeddings WHERE content_id = $1",
      [FIXTURES.task.id]
    );
    // The row we seeded plus whatever import queued for re-embed. Either
    // way the task must appear at least once.
    expect(pe.rowCount).toBeGreaterThanOrEqual(1);

    const ch = await client.query(
      "SELECT entity_type, entity_id, op FROM changes WHERE entity_id = $1",
      [FIXTURES.task.id]
    );
    expect(ch.rowCount).toBeGreaterThanOrEqual(1);
    expect(ch.rows[0].op).toBe("insert");

    const sol = await client.query(
      "SELECT op_uuid FROM sync_op_log WHERE op_uuid = $1",
      ["70000000-0000-0000-0000-000000000001"]
    );
    expect(sol.rowCount).toBe(1);

    // ── note lifecycle + history ─────────────────────────────
    const noteStateAfter = await readNoteState(client);
    // Column for column, row for row — including timestamps, snapshots, versions.
    expect(noteStateAfter).toEqual(noteStateBefore);

    const { old, successor } = FIXTURES.lifecycle;
    const oldRow = noteStateAfter.notes.find((r) => r.id === old.id)!;
    expect(oldRow.status).toBe("superseded");
    expect(oldRow.superseded_by).toBe(successor.id);
    expect(oldRow.superseded_at).toBeInstanceOf(Date);
    expect(oldRow.valid_until.toISOString()).toBe(old.validUntil);
    expect(oldRow.provenance).toBe("stated");
    expect(oldRow.version).toBe(3);
    expect(oldRow.content).toBe(old.revisedContent);

    const successorRow = noteStateAfter.notes.find((r) => r.id === successor.id)!;
    expect(successorRow.status).toBe("active");
    expect(successorRow.superseded_by).toBeNull();
    expect(successorRow.superseded_at).toBeNull();
    expect(successorRow.valid_until.toISOString()).toBe(successor.validUntil);
    expect(successorRow.provenance).toBe("decided");
    expect(successorRow.version).toBe(1);

    // The original fixture note was never edited: lifecycle defaults intact.
    const plainRow = noteStateAfter.notes.find((r) => r.id === FIXTURES.note.id)!;
    expect(plainRow.status).toBe("active");
    expect(plainRow.provenance).toBeNull();
    expect(plainRow.valid_until).toBeNull();
    expect(plainRow.version).toBe(1);

    expect(noteStateAfter.versions.map((v) => [v.note_id, v.version])).toEqual([
      [old.id, 1],
      [old.id, 2],
    ]);
    expect(noteStateAfter.versions.map((v) => v.changed_fields)).toEqual([
      ["content"],
      ["status", "superseded_at", "superseded_by"],
    ]);
    expect(noteStateAfter.versions.map((v) => v.changed_via)).toEqual([
      "update_note",
      "supersede_note",
    ]);
    // Snapshots are the note AS IT WAS at that version.
    expect(noteStateAfter.versions[0].snapshot.title).toBe(old.title);
    expect(noteStateAfter.versions[0].snapshot.content).toBe(old.content);
    expect(noteStateAfter.versions[0].snapshot.status).toBe("active");
    expect(noteStateAfter.versions[1].snapshot.content).toBe(old.revisedContent);
    expect(noteStateAfter.versions[1].snapshot.provenance).toBe("stated");

    // The restored note is still editable: the next UPDATE writes history row
    // (old.id, 3) without colliding with a restored one. Rolled back so later
    // tests see the restored state untouched.
    await client.query("BEGIN");
    try {
      const edit = await client.query(
        "UPDATE notes SET title = title || ' (edited)' WHERE id = $1 RETURNING version",
        [old.id]
      );
      expect(edit.rows[0].version).toBe(4);
      const hist = await client.query(
        "SELECT version FROM note_versions WHERE note_id = $1 ORDER BY version",
        [old.id]
      );
      expect(hist.rows.map((r) => r.version)).toEqual([1, 2, 3]);
    } finally {
      await client.query("ROLLBACK");
    }

    // ── handoff file spot-check ──────────────────────────────
    const handoffFiles = await readdir(join(TEST_DATA_DIR, "handoffs"));
    expect(handoffFiles).toContain(FIXTURES.handoff.filename);
    const raw = await readFile(
      join(TEST_DATA_DIR, "handoffs", FIXTURES.handoff.filename),
      "utf-8"
    );
    const parsed = JSON.parse(raw);
    expect(parsed.user_note).toBe(FIXTURES.handoff.body.user_note);

    // ── fixed point: exporting the restored database reproduces the note
    // tables byte for byte (a dropped, defaulted, or re-ordered column would
    // show up here even if every individual assertion above passed).
    const secondTarball = await exportTo(join(TEST_ROOT, "rt-second-export"));
    const secondExtract = await extractTo(secondTarball, "rt-second-extract");
    for (const table of ["notes", "note_versions"]) {
      expect(
        await readFile(join(secondExtract, "tables", `${table}.jsonl`), "utf-8"),
        `tables/${table}.jsonl differs between the original export and a re-export of the restored database`
      ).toBe(await readFile(join(firstExtract, "tables", `${table}.jsonl`), "utf-8"));
    }
  }, SCRIPT_TIMEOUT_MS);

  it("import into non-empty destination refuses without --force", async () => {
    // At this point the DB has been imported into once; it is non-empty.
    const dirEntries = await readdir(TEST_EXPORT_DIR);
    const tarball = join(
      TEST_EXPORT_DIR,
      dirEntries.find((f) => f.endsWith(".tar.gz"))!
    );

    const res = runScript(IMPORT_SCRIPT, [tarball], scriptEnv());
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/not empty/i);
  }, SCRIPT_TIMEOUT_MS);

  it("--dry-run prints the plan without touching the database", async () => {
    const beforeTasks = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM tasks"
    );
    const dirEntries = await readdir(TEST_EXPORT_DIR);
    const tarball = join(
      TEST_EXPORT_DIR,
      dirEntries.find((f) => f.endsWith(".tar.gz"))!
    );

    const res = runScript(IMPORT_SCRIPT, [tarball, "--dry-run"], scriptEnv());
    expect(
      res.status,
      `dry-run exited ${res.status}.\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
    ).toBe(0);
    expect(res.stdout).toMatch(/DRY RUN/i);
    // The plan lists the new history table alongside the others.
    expect(res.stdout).toMatch(/note_versions: 2 → 2/);

    const afterTasks = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM tasks"
    );
    expect(afterTasks.rows[0].count).toBe(beforeTasks.rows[0].count);
  }, SCRIPT_TIMEOUT_MS);

  it("--force wipes the destination and re-imports cleanly", async () => {
    const dirEntries = await readdir(TEST_EXPORT_DIR);
    const tarball = join(
      TEST_EXPORT_DIR,
      dirEntries.find((f) => f.endsWith(".tar.gz"))!
    );

    // Add an extra task so we can verify --force removed pre-existing content.
    await client.query(
      `INSERT INTO tasks (id, title, scope) VALUES ($1, 'to be wiped', 'work')`,
      ["9999abcd-0000-0000-0000-000000000001"]
    );

    const res = runScript(IMPORT_SCRIPT, [tarball, "--force"], scriptEnv());
    expect(
      res.status,
      `--force exited ${res.status}.\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
    ).toBe(0);

    const extra = await client.query(
      `SELECT 1 FROM tasks WHERE id = '9999abcd-0000-0000-0000-000000000001'`
    );
    expect(extra.rowCount).toBe(0);

    const orig = await client.query(
      "SELECT 1 FROM tasks WHERE id = $1",
      [FIXTURES.task.id]
    );
    expect(orig.rowCount).toBe(1);
  }, SCRIPT_TIMEOUT_MS);

  it("consecutive exports of an unchanged database are byte-identical", async () => {
    // The nightly-commit backup pattern documented in docs/backup-restore.md
    // depends on manifest.json and every tables/*.jsonl being byte-equal
    // between consecutive exports of an unchanged database. If this ever
    // regresses (e.g. a wall-clock timestamp is added back to the manifest,
    // or a table's orderBy stops being deterministic) the diff pattern
    // silently produces a new commit every night.
    //
    // Fresh-seed both runs from an identical starting DB so the previous
    // tests' extra rows don't pollute the comparison.
    await applyMigrationsFresh();
    await rm(join(TEST_DATA_DIR, "handoffs"), { recursive: true, force: true });
    await client.end();
    client = new Client({
      host: PG_HOST,
      port: parseInt(PG_PORT),
      user: PG_USER,
      password: PG_PASSWORD,
      database: PG_DATABASE,
    });
    await client.connect();
    await seed(client);
    await seedHandoff();

    const outA = join(TEST_ROOT, "det-a");
    const outB = join(TEST_ROOT, "det-b");
    const resA = runScript(EXPORT_SCRIPT, ["--out", outA], scriptEnv());
    expect(resA.status).toBe(0);
    const resB = runScript(EXPORT_SCRIPT, ["--out", outB], scriptEnv());
    expect(resB.status).toBe(0);

    const tarA = join(outA, (await readdir(outA)).find((f) => f.endsWith(".tar.gz"))!);
    const tarB = join(outB, (await readdir(outB)).find((f) => f.endsWith(".tar.gz"))!);
    // We deliberately do NOT compare tarball bytes — mtimes inside the
    // archive shift between runs even when the entries themselves match.
    // The load-bearing invariant is manifest.json + tables/*.jsonl bytes.
    const extA = join(TEST_ROOT, "det-a-ex");
    const extB = join(TEST_ROOT, "det-b-ex");
    await mkdir(extA, { recursive: true });
    await mkdir(extB, { recursive: true });
    spawnSync("tar", ["-xzf", tarA, "-C", extA]);
    spawnSync("tar", ["-xzf", tarB, "-C", extB]);

    const manifestA = await readFile(join(extA, "manifest.json"), "utf-8");
    const manifestB = await readFile(join(extB, "manifest.json"), "utf-8");
    expect(manifestB).toBe(manifestA);

    const tablesA = (await readdir(join(extA, "tables"))).sort();
    const tablesB = (await readdir(join(extB, "tables"))).sort();
    expect(tablesB).toEqual(tablesA);
    // Guard against a vacuous pass: the history table is part of the compare
    // and actually has rows (its (note_id, version) ordering is what makes it
    // deterministic).
    expect(tablesA).toContain("note_versions.jsonl");
    expect(
      (await readFile(join(extA, "tables", "note_versions.jsonl"), "utf-8")).trim().split("\n")
    ).toHaveLength(2);
    for (const filename of tablesA) {
      const bytesA = await readFile(join(extA, "tables", filename), "utf-8");
      const bytesB = await readFile(join(extB, "tables", filename), "utf-8");
      expect(
        bytesB,
        `tables/${filename} diverges between consecutive exports — deterministic-diff invariant broken`
      ).toBe(bytesA);
    }
  }, SCRIPT_TIMEOUT_MS);

  it("sync_op_log.change_seq stays nullable in the current schema", async () => {
    // scripts/portability/tables.ts intentionally drops change_seq on
    // restore because BIGSERIAL cursors regenerate. That plan only works
    // if the column stays nullable — a future migration that makes it
    // NOT NULL would break restore silently long after this PR merged.
    // This assertion fires exactly when that drift happens.
    const res = await client.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'sync_op_log' AND column_name = 'change_seq'`
    );
    expect(res.rowCount).toBe(1);
    expect(res.rows[0].is_nullable).toBe("YES");
  });

  it("manifest model mismatch queues every indexable row for re-embed", async () => {
    // Take a fresh export, then import with EMBEDDING_MODEL/DIMENSIONS
    // overridden so the destination disagrees with the manifest.
    await applyMigrationsFresh();
    await rm(join(TEST_DATA_DIR, "handoffs"), { recursive: true, force: true });
    await client.end();
    client = new Client({
      host: PG_HOST,
      port: parseInt(PG_PORT),
      user: PG_USER,
      password: PG_PASSWORD,
      database: PG_DATABASE,
    });
    await client.connect();
    await seed(client);
    await seedHandoff();

    const freshOut = join(TEST_ROOT, "exports-mismatch");
    const exportRes = runScript(
      EXPORT_SCRIPT,
      ["--out", freshOut, "--include-embeddings"],
      scriptEnv()
    );
    expect(exportRes.status).toBe(0);
    const tarball = join(
      freshOut,
      (await readdir(freshOut)).find((f) => f.endsWith(".tar.gz"))!
    );

    await applyMigrationsFresh();
    await rm(join(TEST_DATA_DIR, "handoffs"), { recursive: true, force: true });
    await client.end();
    client = new Client({
      host: PG_HOST,
      port: parseInt(PG_PORT),
      user: PG_USER,
      password: PG_PASSWORD,
      database: PG_DATABASE,
    });
    await client.connect();

    // Import with a mismatched model — this should populate pending_embeddings.
    const importRes = runScript(
      IMPORT_SCRIPT,
      [tarball],
      scriptEnv({
        EMBEDDING_MODEL: "nomic-ai/some-other-model",
        EMBEDDING_DIMENSIONS: "1024",
      })
    );
    expect(
      importRes.status,
      `import exited ${importRes.status}.\nstdout:\n${importRes.stdout}\nstderr:\n${importRes.stderr}`
    ).toBe(0);
    expect(importRes.stdout).toMatch(/model changed/i);

    const pending = await client.query<{ content_type: string }>(
      "SELECT content_type FROM pending_embeddings"
    );
    const types = new Set(pending.rows.map((r) => r.content_type));
    expect(types.has("task")).toBe(true);
    expect(types.has("note")).toBe(true);
    expect(types.has("artifact")).toBe(true);
    expect(types.has("handoff")).toBe(true);
  }, SCRIPT_TIMEOUT_MS);

  // handoffs/archive/ (COMPACTION_MODE=archive) holds the only full copy of every
  // compacted handoff. Export must ship it, and --force must never clear it —
  // otherwise export → import --force on a compacted deployment destroys the
  // originals the archive exists to preserve.
  it("exports handoffs/archive/ and import --force merges it without clearing existing originals", async () => {
    const archive = join(TEST_DATA_DIR, "handoffs", "archive");
    await mkdir(archive, { recursive: true });
    await writeFile(join(archive, "compacted-original.json"), '{"original":true}\n', "utf-8");

    const outDir = join(TEST_ROOT, "exports-archive");
    const exp = runScript(EXPORT_SCRIPT, ["--out", outDir], scriptEnv());
    expect(exp.status, `export exited ${exp.status}.\nstdout:\n${exp.stdout}\nstderr:\n${exp.stderr}`).toBe(0);
    const tarball = join(outDir, (await readdir(outDir)).find((f) => f.endsWith(".tar.gz"))!);

    const extracted = join(TEST_ROOT, "extract-archive");
    await mkdir(extracted, { recursive: true });
    spawnSync("tar", ["-xzf", tarball, "-C", extracted]);
    const manifest = JSON.parse(await readFile(join(extracted, "manifest.json"), "utf-8"));
    expect(manifest.handoff_archive_file_count).toBe(1);
    expect(await readFile(join(extracted, "handoffs", "archive", "compacted-original.json"), "utf-8"))
      .toBe('{"original":true}\n');

    // Destination: the exported original is gone, and there is an archived
    // original the tarball knows nothing about.
    await rm(join(archive, "compacted-original.json"));
    await writeFile(join(archive, "live-only-original.json"), '{"live":true}\n', "utf-8");

    const imp = runScript(IMPORT_SCRIPT, [tarball, "--force"], scriptEnv());
    expect(imp.status, `import exited ${imp.status}.\nstdout:\n${imp.stdout}\nstderr:\n${imp.stderr}`).toBe(0);

    // Restored from the tarball...
    expect(await readFile(join(archive, "compacted-original.json"), "utf-8")).toBe('{"original":true}\n');
    // ...and --force did not wipe the one only the destination had.
    expect(await readFile(join(archive, "live-only-original.json"), "utf-8")).toBe('{"live":true}\n');
  }, SCRIPT_TIMEOUT_MS);

  // ── Note lifecycle (migration 013) ─────────────────────────────

  it("restores a tarball written before migration 013 (no lifecycle keys, no note_versions) using column defaults", async () => {
    await resetAndSeed();
    const tarball = await exportTo(join(TEST_ROOT, "pre013-export"));
    const pre013Tarball = await makePre013Tarball(tarball, "pre013");

    await wipeDestination();
    const res = runScript(IMPORT_SCRIPT, [pre013Tarball], scriptEnv());
    expect(
      res.status,
      `import exited ${res.status}.\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
    ).toBe(0);

    const { notes: restored, versions } = await readNoteState(client);
    expect(restored).toHaveLength(3);
    for (const row of restored) {
      expect(row.status, `note ${row.id}`).toBe("active");
      expect(row.version, `note ${row.id}`).toBe(1);
      expect(row.provenance, `note ${row.id}`).toBeNull();
      expect(row.superseded_by, `note ${row.id}`).toBeNull();
      expect(row.superseded_at, `note ${row.id}`).toBeNull();
      expect(row.valid_until, `note ${row.id}`).toBeNull();
    }
    expect(versions).toHaveLength(0);
    // Everything the old format did carry arrives intact.
    const oldRow = restored.find((r) => r.id === FIXTURES.lifecycle.old.id)!;
    expect(oldRow.title).toBe(FIXTURES.lifecycle.old.title);
    expect(oldRow.content).toBe(FIXTURES.lifecycle.old.revisedContent);
    expect(oldRow.tags).toEqual(["deploys"]);
  }, SCRIPT_TIMEOUT_MS);

  describe("pending local migrations", () => {
    const pre013 = (filename: string) => !filename.startsWith("013_");
    const appliedMigrations = async () =>
      (await client.query<{ filename: string }>("SELECT filename FROM _migrations")).rows.map(
        (r) => r.filename
      );
    const tableExists = async (name: string) =>
      (await client.query("SELECT to_regclass($1) AS reg", [name])).rows[0].reg !== null;

    it("are applied before the truncate and load, even when the manifest names none of them", async () => {
      // A pre-013 tarball names nothing a 001-012 destination is missing, but
      // the load writes the current registry's columns. Without applying the
      // checkout's pending migrations first, --force would truncate and then
      // fail on the missing `status` column: data loss.
      await resetAndSeed();
      const tarball = await exportTo(join(TEST_ROOT, "pending-mig-export"));
      const pre013Tarball = await makePre013Tarball(tarball, "pending-mig");

      // Destination: migrated only through 012, holding content that --force
      // must replace (a task and a note, using the pre-013 notes columns only).
      await wipeDestination(pre013);
      expect((await appliedMigrations()).some((m) => m.startsWith("013_"))).toBe(false);
      expect(await tableExists("note_versions")).toBe(false);
      await client.query(
        `INSERT INTO tasks (id, title, scope) VALUES ('9999abcd-0000-0000-0000-000000000002', 'to be wiped', 'work')`
      );
      await client.query(
        `INSERT INTO notes (id, title, content, scope) VALUES ('9999abcd-0000-0000-0000-000000000003', 'to be wiped', 'x', 'shared')`
      );

      // --dry-run reports the pending migration and applies nothing.
      const dry = runScript(IMPORT_SCRIPT, [pre013Tarball, "--dry-run"], scriptEnv());
      expect(dry.status, `dry-run exited ${dry.status}.\nstdout:\n${dry.stdout}\nstderr:\n${dry.stderr}`).toBe(0);
      expect(dry.stdout).toMatch(/\(dry-run\) Destination has 1 pending migration\(s\) \(013_note_lifecycle\.sql\)/);
      expect((await appliedMigrations()).some((m) => m.startsWith("013_"))).toBe(false);
      expect(await tableExists("note_versions")).toBe(false);
      expect((await client.query("SELECT count(*)::int AS n FROM tasks")).rows[0].n).toBe(1);

      // Real run with --force: migrates first, then truncates and restores.
      const res = runScript(IMPORT_SCRIPT, [pre013Tarball, "--force"], scriptEnv());
      expect(res.status, `import exited ${res.status}.\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBe(0);
      expect(res.stdout).toMatch(/Destination has 1 pending migration\(s\) \(013_note_lifecycle\.sql\)/);

      expect((await appliedMigrations()).filter((m) => m.startsWith("013_"))).toEqual(["013_note_lifecycle.sql"]);
      expect(await tableExists("note_versions")).toBe(true);
      const { notes, versions } = await readNoteState(client);
      expect(notes).toHaveLength(3);
      expect(notes.map((n) => n.id)).not.toContain("9999abcd-0000-0000-0000-000000000003");
      for (const row of notes) {
        expect(row.status, `note ${row.id}`).toBe("active");
        expect(row.version, `note ${row.id}`).toBe(1);
        expect(row.provenance, `note ${row.id}`).toBeNull();
      }
      expect(versions).toHaveLength(0);
      const wipedTask = await client.query(
        "SELECT 1 FROM tasks WHERE id = '9999abcd-0000-0000-0000-000000000002'"
      );
      expect(wipedTask.rowCount).toBe(0);
    }, SCRIPT_TIMEOUT_MS);

    it("a refused import (non-empty destination, no --force) leaves the destination's schema untouched", async () => {
      // The operator's PG* env may point at a live database by mistake. A
      // refusal must not have migrated it on the way to refusing.
      await resetAndSeed();
      const current = await exportTo(join(TEST_ROOT, "refused-mig-export"));
      const older = await makePre013Tarball(current, "refused-mig");

      await wipeDestination(pre013);
      await client.query(
        `INSERT INTO tasks (id, title, scope) VALUES ('9999abcd-0000-0000-0000-000000000002', 'keep me', 'work')`
      );
      await client.query(
        `INSERT INTO notes (id, title, content, scope) VALUES ('9999abcd-0000-0000-0000-000000000003', 'keep me', 'x', 'shared')`
      );

      for (const [label, tarball] of [["pre-013 tarball", older], ["current tarball", current]]) {
        const res = runScript(IMPORT_SCRIPT, [tarball], scriptEnv());
        expect(res.status, `${label}: stdout:\n${res.stdout}`).not.toBe(0);
        expect(res.stderr, label).toMatch(/Refusing to import into a non-empty destination/);
        expect(res.stdout, label).not.toMatch(/pending migration|running migrations/i);

        // Schema and data exactly as staged.
        expect((await appliedMigrations()).some((m) => m.startsWith("013_")), label).toBe(false);
        expect(await tableExists("note_versions"), label).toBe(false);
        const counts = await client.query(
          `SELECT (SELECT count(*) FROM tasks)::int AS tasks, (SELECT count(*) FROM notes)::int AS notes`
        );
        expect(counts.rows[0], label).toEqual({ tasks: 1, notes: 1 });
      }
    }, SCRIPT_TIMEOUT_MS);

    it("a manifest naming a migration this checkout lacks is still refused before any truncate", async () => {
      await resetAndSeed();
      const tarball = await exportTo(join(TEST_ROOT, "future-mig-export"));
      const dir = await extractTo(tarball, "future-mig-extract");
      await editManifest(dir, (manifest) => {
        manifest.applied_migrations.push("999_from_a_newer_release.sql");
      });
      const futureTarball = join(TEST_ROOT, "future-mig.tar.gz");
      tarCreate(dir, futureTarball);

      const res = runScript(IMPORT_SCRIPT, [futureTarball, "--force"], scriptEnv());
      expect(res.status, `stdout:\n${res.stdout}`).not.toBe(0);
      expect(res.stderr).toMatch(/still missing migrations/);
      expect(res.stderr).toMatch(/999_from_a_newer_release\.sql/);
      expect(res.stdout).not.toMatch(/Pre-wipe complete/);
      // Nothing was truncated.
      const counts = await client.query(
        `SELECT (SELECT count(*) FROM tasks)::int AS tasks, (SELECT count(*) FROM notes)::int AS notes`
      );
      expect(counts.rows[0]).toEqual({ tasks: 1, notes: 3 });
    }, SCRIPT_TIMEOUT_MS);
  });

  describe("inconsistent note history is refused before any write", () => {
    const { old } = FIXTURES.lifecycle;
    const { successor } = FIXTURES.lifecycle;
    // Each case edits an extracted export in place. Every edit keeps the
    // manifest's row counts equal to the files', so the row-count pre-flight
    // passes and only the note consistency check can catch the defect.
    const cases: Array<{
      slug: string;
      label: string;
      mutate: (dir: string) => Promise<void>;
      expected: RegExp;
    }> = [
      {
        slug: "version-not-below-note",
        label: "a history row whose version is not below its note's version",
        // `old` is at version 3; push its newest history row up to 3.
        mutate: async (dir) => {
          const rows = await readJsonl(dir, "note_versions");
          await writeJsonl(
            dir,
            "note_versions",
            rows.map((r, i) => (i === rows.length - 1 ? { ...r, version: 3 } : r))
          );
        },
        expected: new RegExp(`note_versions row \\(${old.id}, v3\\)`),
      },
      {
        slug: "orphan-history-row",
        label: "a history row for a note that is not in notes.jsonl",
        mutate: async (dir) => {
          const rows = await readJsonl(dir, "note_versions");
          await writeJsonl(
            dir,
            "note_versions",
            rows.map((r, i) => (i === 0 ? { ...r, note_id: "99999999-0000-0000-0000-000000000009" } : r))
          );
        },
        expected: /references a note that is not in notes\.jsonl/,
      },
      {
        slug: "dangling-superseded-by",
        label: "a superseded_by naming a note that is not in notes.jsonl",
        // Drop the successor: `old` still points at it. Left alone, the
        // deferred FK would fail at the notes COMMIT, after the --force truncate.
        mutate: async (dir) => {
          const notes = await readJsonl(dir, "notes");
          await writeJsonl(dir, "notes", notes.filter((r) => r.id !== successor.id));
          await editManifest(dir, (m) => {
            m.row_counts.notes = notes.length - 1;
          });
        },
        expected: new RegExp(`note ${old.id} superseded_by ${successor.id} which is not in notes\\.jsonl`),
      },
      {
        slug: "history-without-notes-file",
        label: "note_versions rows but no notes.jsonl at all",
        // A missing notes.jsonl is an empty note set, not a reason to skip the check.
        mutate: async (dir) => {
          await rm(join(dir, "tables", "notes.jsonl"));
          await editManifest(dir, (m) => {
            m.row_counts.notes = 0;
          });
        },
        expected: /references a note that is not in notes\.jsonl/,
      },
    ];

    it.each(cases)("$label", async ({ slug, mutate, expected }) => {
      await resetAndSeed();
      const tarball = await exportTo(join(TEST_ROOT, `bad-${slug}-export`));
      const dir = await extractTo(tarball, `bad-${slug}-extract`);

      await mutate(dir);
      const badTarball = join(TEST_ROOT, `bad-${slug}.tar.gz`);
      tarCreate(dir, badTarball);

      const counts = async () =>
        (
          await client.query(
            `SELECT (SELECT count(*) FROM tasks)::int AS tasks,
                    (SELECT count(*) FROM notes)::int AS notes,
                    (SELECT count(*) FROM note_versions)::int AS note_versions`
          )
        ).rows[0];
      const before = await counts();
      expect(before).toEqual({ tasks: 1, notes: 3, note_versions: 2 });

      // The destination is non-empty and --force is set: had the load started,
      // the truncate would already have destroyed these rows.
      const res = runScript(IMPORT_SCRIPT, [badTarball, "--force"], scriptEnv());
      expect(res.status, `stdout:\n${res.stdout}`).not.toBe(0);
      expect(res.stderr).toMatch(/Tarball inconsistent/);
      expect(res.stderr).toMatch(expected);
      expect(res.stdout).not.toMatch(/Pre-wipe complete/);
      expect(await counts()).toEqual(before);
      expect(await readdir(join(TEST_DATA_DIR, "handoffs"))).toContain(FIXTURES.handoff.filename);

      // --dry-run reports the same defect rather than printing a plan.
      const dry = runScript(IMPORT_SCRIPT, [badTarball, "--dry-run"], scriptEnv());
      expect(dry.status).not.toBe(0);
      expect(dry.stderr).toMatch(/Tarball inconsistent/);
    }, SCRIPT_TIMEOUT_MS);
  });

  it("export reads every table from one snapshot even when a note edit commits mid-export", async () => {
    await resetAndSeed();
    const { successor } = FIXTURES.lifecycle;
    const outDir = join(TEST_ROOT, "race-export");

    // Deterministic race, no sleeps-and-hope: hold an ACCESS EXCLUSIVE lock on
    // note_versions so the export reads `notes` and then parks on the
    // note_versions SELECT. While it is parked, commit an edit to a note — the
    // versioning trigger writes the history row (successor, 1) and bumps the
    // note to version 2 in that same transaction. A per-table autocommit export
    // would then pair `notes` at version 1 with a history row (successor, 1);
    // one REPEATABLE READ snapshot pairs them consistently.
    const writer = newClient();
    await writer.connect();
    let exportRun: ReturnType<typeof runScriptAsync> | undefined;
    try {
      await writer.query("BEGIN");
      await writer.query("LOCK TABLE note_versions IN ACCESS EXCLUSIVE MODE");
      exportRun = runScriptAsync(EXPORT_SCRIPT, ["--out", outDir], scriptEnv());

      const deadline = Date.now() + 30_000;
      for (;;) {
        const parked = await client.query(
          `SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> pg_backend_pid()
              AND wait_event_type = 'Lock'
              AND query LIKE 'SELECT note_id, %FROM note_versions ORDER BY%'`
        );
        if (parked.rowCount) break;
        if (exportRun.hasExited()) {
          const out = await exportRun.done;
          throw new Error(`export exited before reaching note_versions:\n${out.stdout}\n${out.stderr}`);
        }
        if (Date.now() > deadline) throw new Error("timed out waiting for the export to block on note_versions");
        await sleep(50);
      }

      await writer.query("SELECT set_config('app.changed_via', 'update_note', true)");
      await writer.query("UPDATE notes SET content = $2 WHERE id = $1", [
        successor.id,
        "Acme Corp froze Friday deploys until further notice.",
      ]);
      await writer.query("COMMIT");
    } catch (err) {
      await writer.query("ROLLBACK").catch(() => {});
      if (exportRun && !exportRun.hasExited()) exportRun.kill();
      throw err;
    } finally {
      await writer.end();
    }

    const res = await exportRun!.done;
    expect(res.status, `export exited ${res.status}.\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBe(0);

    // The edit really committed...
    const live = await client.query("SELECT version FROM notes WHERE id = $1", [successor.id]);
    expect(live.rows[0].version).toBe(2);

    // ...but is in neither exported table: the tarball is the database as of
    // the export's first read.
    const tarball = join(outDir, (await readdir(outDir)).find((f) => f.endsWith(".tar.gz"))!);
    const dir = await extractTo(tarball, "race-extract");
    const exportedNotes = await readJsonl(dir, "notes");
    const exportedVersions = await readJsonl(dir, "note_versions");
    const exportedSuccessor = exportedNotes.find((r) => r.id === successor.id)!;
    expect(exportedSuccessor.version).toBe(1);
    expect(exportedSuccessor.content).toBe(successor.content);
    expect(exportedVersions.filter((r) => r.note_id === successor.id)).toEqual([]);
    const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf-8"));
    expect(manifest.row_counts.note_versions).toBe(exportedVersions.length);

    // And it restores cleanly, leaving the note editable.
    await wipeDestination();
    const imp = runScript(IMPORT_SCRIPT, [tarball], scriptEnv());
    expect(imp.status, `import exited ${imp.status}.\nstdout:\n${imp.stdout}\nstderr:\n${imp.stderr}`).toBe(0);
    const edit = await client.query(
      "UPDATE notes SET content = 'edited after restore' WHERE id = $1 RETURNING version",
      [successor.id]
    );
    expect(edit.rows[0].version).toBe(2);
  }, SCRIPT_TIMEOUT_MS);
});
