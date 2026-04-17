import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Pending embeddings queue tests.
 *
 * Requires a running PostgreSQL instance. The suite is skipped at collection
 * time (describe.skipIf + top-level await) when Postgres isn't reachable —
 * matches the pattern in tasks.test.ts.
 *
 * TEI (the embedding server) is NOT required: these tests drive the queue
 * directly and stub the connectivity check through environment state.
 */

const PG_DATABASE = "cl_test_pending";
const PG_USER = process.env.PGUSER ?? "cl";
const PG_PASSWORD = process.env.PGPASSWORD ?? "test";
const PG_HOST = process.env.PGHOST ?? "localhost";
const PG_PORT = process.env.PGPORT ?? "5432";
const TEST_DATA_DIR = join(process.cwd(), "data", "test-pending");

async function checkPostgres(): Promise<boolean> {
  try {
    const pg = await import("pg");
    const admin = new pg.default.Client({
      host: PG_HOST,
      port: parseInt(PG_PORT),
      user: PG_USER,
      password: PG_PASSWORD,
      database: "postgres",
    });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${PG_DATABASE}`);
    await admin.query(`CREATE DATABASE ${PG_DATABASE}`);
    await admin.end();
    return true;
  } catch {
    return false;
  }
}

const pgAvailable = await checkPostgres();

if (!pgAvailable) {
  console.log("\n" + "=".repeat(60));
  console.log("  NOTICE: PostgreSQL not available");
  console.log("  Pending Embeddings suite will be SKIPPED");
  console.log("=".repeat(60) + "\n");
}

describe.skipIf(!pgAvailable)("Pending Embeddings Queue", () => {
  beforeAll(async () => {
    // Configure env BEFORE importing modules that read config on load.
    process.env.PGHOST = PG_HOST;
    process.env.PGPORT = PG_PORT;
    process.env.PGUSER = PG_USER;
    process.env.PGPASSWORD = PG_PASSWORD;
    process.env.PGDATABASE = PG_DATABASE;
    process.env.DATA_DIR = TEST_DATA_DIR;
    // Point embeddings at a definitely-unreachable URL so the TEI path fails
    // as a connectivity error during the failure-path test.
    process.env.EMBEDDING_URL = "http://127.0.0.1:1"; // will ECONNREFUSED

    await rm(TEST_DATA_DIR, { recursive: true, force: true });
    await mkdir(join(TEST_DATA_DIR, "handoffs"), { recursive: true });

    const { runMigrations } = await import("../db/migrate.js");
    await runMigrations();
  }, 30_000);

  afterAll(async () => {
    const { pool } = await import("../db/client.js");
    await pool.end();
    await rm(TEST_DATA_DIR, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const { query } = await import("../db/client.js");
    await query("DELETE FROM pending_embeddings");
    await query("DELETE FROM embeddings");
  });

  it("migration created the pending_embeddings table with expected columns", async () => {
    const { query } = await import("../db/client.js");
    const result = await query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_name = 'pending_embeddings'
       ORDER BY ordinal_position`
    );
    const names = result.rows.map((r) => r.column_name);
    expect(names).toContain("id");
    expect(names).toContain("content_type");
    expect(names).toContain("content_id");
    expect(names).toContain("created_at");
    expect(names).toContain("retry_count");
    expect(names).toContain("last_error");
  });

  it("getPendingEmbeddingsCount returns the row count", async () => {
    const { query } = await import("../db/client.js");
    const { getPendingEmbeddingsCount } = await import("../embeddings/indexer.js");

    expect(await getPendingEmbeddingsCount()).toBe(0);

    await query(
      `INSERT INTO pending_embeddings (content_type, content_id) VALUES ('handoff', 'fake-1.json'), ('task', 'task-1')`
    );
    expect(await getPendingEmbeddingsCount()).toBe(2);
  });

  it("indexHandoff enqueues a pending row when TEI is unreachable", async () => {
    const { indexHandoff } = await import("../embeddings/indexer.js");
    const { query } = await import("../db/client.js");

    // EMBEDDING_URL points at 127.0.0.1:1 → ECONNREFUSED → connectivity error.
    await indexHandoff("test-queue-1.json", {
      stored_at: "2026-04-17T10:00:00Z",
      tone_notes: "queued-on-failure",
      active_context: { session: "test" },
    });

    const result = await query<{ content_type: string; content_id: string }>(
      `SELECT content_type, content_id FROM pending_embeddings`
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].content_type).toBe("handoff");
    expect(result.rows[0].content_id).toBe("test-queue-1.json");
  });

  it("indexHandoff on second failure does not duplicate the pending row", async () => {
    const { indexHandoff } = await import("../embeddings/indexer.js");
    const { query } = await import("../db/client.js");

    const handoff = {
      stored_at: "2026-04-17T10:00:00Z",
      tone_notes: "dup test",
    };
    await indexHandoff("dup-test.json", handoff);
    await indexHandoff("dup-test.json", handoff);

    const result = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pending_embeddings WHERE content_id = 'dup-test.json'`
    );
    expect(result.rows[0].count).toBe("1");
  });

  it("drainPendingEmbeddings processes zero rows when queue is empty", async () => {
    const { drainPendingEmbeddings } = await import("../embeddings/indexer.js");
    const result = await drainPendingEmbeddings();
    expect(result.processed).toBe(0);
    expect(result.remaining).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("drainPendingEmbeddings bumps retry_count and stops on persistent TEI failure", async () => {
    const { indexHandoff, drainPendingEmbeddings } = await import(
      "../embeddings/indexer.js"
    );
    const { query } = await import("../db/client.js");

    // Write a real handoff file so the drain can load it.
    const filename = "drain-retry.json";
    const filepath = join(TEST_DATA_DIR, "handoffs", filename);
    await writeFile(
      filepath,
      JSON.stringify({
        stored_at: "2026-04-17T10:00:00Z",
        tone_notes: "retry me",
      }),
      "utf-8"
    );

    // Queue it via the failure path.
    await indexHandoff(filename, {
      stored_at: "2026-04-17T10:00:00Z",
      tone_notes: "retry me",
    });

    const drain = await drainPendingEmbeddings();
    expect(drain.processed).toBe(0);
    expect(drain.errors).toBeGreaterThan(0);
    expect(drain.remaining).toBe(1);

    const row = await query<{ retry_count: number; last_error: string | null }>(
      `SELECT retry_count, last_error FROM pending_embeddings WHERE content_id = $1`,
      [filename]
    );
    expect(row.rows[0].retry_count).toBe(1);
    expect(row.rows[0].last_error).toBeTruthy();
  });

  it("drainPendingEmbeddings drops rows whose source file is missing", async () => {
    const { query } = await import("../db/client.js");
    const { drainPendingEmbeddings } = await import("../embeddings/indexer.js");

    await query(
      `INSERT INTO pending_embeddings (content_type, content_id) VALUES ('handoff', 'nonexistent-handoff.json')`
    );

    const drain = await drainPendingEmbeddings();
    expect(drain.errors).toBe(1);
    expect(drain.processed).toBe(0);
    expect(drain.remaining).toBe(0);
  });
});
