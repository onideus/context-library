import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { readFile, readdir, rm, mkdir, writeFile } from "node:fs/promises";
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
  const result = spawnSync("npx", ["tsx", script, ...args], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    timeout: SCRIPT_TIMEOUT_MS,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// ── Fresh DB + migrations ─────────────────────────────────────────

async function applyMigrationsFresh(): Promise<void> {
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
      .filter((f) => f.endsWith(".sql"))
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

// ── Tests ─────────────────────────────────────────────────────────

describe.skipIf(!pgAvailable)("export/import round-trip", () => {
  let client: InstanceType<typeof Client>;

  beforeAll(async () => {
    await rm(TEST_ROOT, { recursive: true, force: true });
    await mkdir(TEST_ROOT, { recursive: true });

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
  }, SCRIPT_TIMEOUT_MS);

  afterAll(async () => {
    await client.end();
    await rm(TEST_ROOT, { recursive: true, force: true });
  });

  it("full round-trip: export → wipe → import restores every table + handoff", async () => {
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

    // ── wipe destination ─────────────────────────────────────
    await applyMigrationsFresh();
    await rm(join(TEST_DATA_DIR, "handoffs"), { recursive: true, force: true });

    // Reconnect since applyMigrationsFresh's DROP SCHEMA severed our tables.
    await client.end();
    client = new Client({
      host: PG_HOST,
      port: parseInt(PG_PORT),
      user: PG_USER,
      password: PG_PASSWORD,
      database: PG_DATABASE,
    });
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

    // ── handoff file spot-check ──────────────────────────────
    const handoffFiles = await readdir(join(TEST_DATA_DIR, "handoffs"));
    expect(handoffFiles).toContain(FIXTURES.handoff.filename);
    const raw = await readFile(
      join(TEST_DATA_DIR, "handoffs", FIXTURES.handoff.filename),
      "utf-8"
    );
    const parsed = JSON.parse(raw);
    expect(parsed.user_note).toBe(FIXTURES.handoff.body.user_note);
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
});
