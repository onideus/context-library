import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import pg from "pg";

/**
 * Integration tests for scripts/backfill-content-hashes.ts.
 *
 * Requires a running PostgreSQL instance. Skips gracefully when Postgres is
 * unavailable, matching the pattern used by tasks.test.ts and artifacts.test.ts.
 *
 * Covers the two behaviors called out in the spec Verification section:
 *   1. Backfill populates missing hashes on locked artifacts.
 *   2. Backfill is idempotent — re-running leaves already-hashed rows unchanged.
 */

const { Client } = pg;

const PG_DATABASE = "cl_test_backfill";
const PG_USER = process.env.PGUSER ?? "cl";
const PG_PASSWORD = process.env.PGPASSWORD ?? "test";
const PG_HOST = process.env.PGHOST ?? "localhost";
const PG_PORT = process.env.PGPORT ?? "5432";

const SCRIPT_PATH = join(process.cwd(), "scripts", "backfill-content-hashes.ts");

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function runBackfill(): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("npx", ["tsx", SCRIPT_PATH], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PGHOST: PG_HOST,
      PGPORT: PG_PORT,
      PGUSER: PG_USER,
      PGPASSWORD: PG_PASSWORD,
      PGDATABASE: PG_DATABASE,
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

async function checkPostgres(): Promise<boolean> {
  let admin: InstanceType<typeof Client> | undefined;
  let client: InstanceType<typeof Client> | undefined;
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

    client = new Client({
      host: PG_HOST,
      port: parseInt(PG_PORT),
      user: PG_USER,
      password: PG_PASSWORD,
      database: PG_DATABASE,
    });
    await client.connect();

    // Clean slate
    await client.query("DROP TABLE IF EXISTS artifacts CASCADE");
    await client.query("DROP FUNCTION IF EXISTS update_updated_at() CASCADE");

    await client.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    await client.query(`
      CREATE OR REPLACE FUNCTION update_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN NEW.updated_at = now(); RETURN NEW; END;
      $$ LANGUAGE plpgsql
    `);

    await client.query(`
      CREATE TABLE artifacts (
        id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        title           TEXT         NOT NULL,
        artifact_type   TEXT         NOT NULL,
        content         TEXT,
        pointer         JSONB,
        status          TEXT         NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'ready', 'executing', 'completed', 'superseded')),
        scope           TEXT         NOT NULL CHECK (scope IN ('work', 'personal', 'shared')),
        tags            TEXT[]       DEFAULT '{}',
        dependencies    UUID[]       DEFAULT '{}',
        execution_order INTEGER,
        related_task_ids UUID[]      DEFAULT '{}',
        metadata        JSONB        DEFAULT '{}',
        created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      CREATE TRIGGER artifacts_updated_at
        BEFORE UPDATE ON artifacts
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at()
    `);

    await client.end();
    return true;
  } catch {
    try { await admin?.end(); } catch { /* ignore */ }
    try { await client?.end(); } catch { /* ignore */ }
    return false;
  }
}

const pgAvailable = await checkPostgres();

if (!pgAvailable) {
  console.log("\n" + "=".repeat(60));
  console.log("  NOTICE: PostgreSQL not available");
  console.log("  backfill-content-hashes suite will be SKIPPED");
  console.log("=".repeat(60) + "\n");
}

describe.skipIf(!pgAvailable)("backfill-content-hashes script", () => {
  let client: InstanceType<typeof Client>;

  beforeAll(async () => {
    client = new Client({
      host: PG_HOST,
      port: parseInt(PG_PORT),
      user: PG_USER,
      password: PG_PASSWORD,
      database: PG_DATABASE,
    });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  describe("population", () => {
    it("adds content_hash to locked artifacts that are missing it", async () => {
      const content1 = "ready artifact content";
      const content2 = "executing artifact content";
      const content3 = "completed artifact content";

      await client.query(`
        INSERT INTO artifacts (title, artifact_type, content, status, scope, metadata) VALUES
          ('Ready — no hash',     'cc-prompt', $1, 'ready',     'work', '{}'),
          ('Executing — no hash', 'cc-prompt', $2, 'executing', 'work', '{}'),
          ('Completed — no hash', 'cc-prompt', $3, 'completed', 'work', '{}'),
          ('Draft — should skip', 'cc-prompt', 'draft content', 'draft', 'work', '{}')
      `, [content1, content2, content3]);

      const result = runBackfill();
      expect(result.status, `backfill exited non-zero.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("3 updated");
      expect(result.stdout).toContain("0 errors");

      // Locked artifacts now have correct hashes
      const locked = await client.query<{ content: string; metadata: Record<string, unknown> }>(
        "SELECT content, metadata FROM artifacts WHERE status IN ('ready', 'executing', 'completed') ORDER BY title"
      );
      expect(locked.rows).toHaveLength(3);
      for (const row of locked.rows) {
        expect(row.metadata.content_hash).toBe(sha256(row.content ?? ""));
      }

      // Draft artifact remains untouched
      const draft = await client.query<{ metadata: Record<string, unknown> }>(
        "SELECT metadata FROM artifacts WHERE status = 'draft'"
      );
      expect(draft.rows[0].metadata.content_hash).toBeUndefined();
    });

    it("handles pointer-only artifacts (null content) by hashing empty string", async () => {
      await client.query(`
        INSERT INTO artifacts (title, artifact_type, content, pointer, status, scope, metadata)
        VALUES ('Pointer-only', 'research', NULL, '{"type":"url","href":"https://example.com"}'::jsonb, 'ready', 'work', '{}')
      `);

      const result = runBackfill();
      expect(result.status).toBe(0);

      const row = await client.query<{ metadata: Record<string, unknown> }>(
        "SELECT metadata FROM artifacts WHERE title = 'Pointer-only'"
      );
      expect(row.rows[0].metadata.content_hash).toBe(sha256(""));
    });
  });

  describe("idempotency", () => {
    it("re-running does not change already-hashed artifacts", async () => {
      // Capture hashes after first population
      const before = await client.query<{ id: string; metadata: Record<string, unknown> }>(
        "SELECT id, metadata FROM artifacts WHERE status IN ('ready', 'executing', 'completed') ORDER BY id"
      );

      const result = runBackfill();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("0 updated");
      expect(result.stdout).toMatch(/\d+ skipped \(already had hash\)/);

      const after = await client.query<{ id: string; metadata: Record<string, unknown> }>(
        "SELECT id, metadata FROM artifacts WHERE status IN ('ready', 'executing', 'completed') ORDER BY id"
      );

      // Hashes are identical — no rows were modified
      expect(after.rows.length).toBe(before.rows.length);
      for (let i = 0; i < before.rows.length; i++) {
        expect(after.rows[i].metadata.content_hash).toBe(
          before.rows[i].metadata.content_hash
        );
      }
    });

    it("exits 0 even when no locked artifacts exist", async () => {
      // Use a fresh table with only draft artifacts
      await client.query("DELETE FROM artifacts WHERE status IN ('ready', 'executing', 'completed')");
      const result = runBackfill();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("0 updated");
    });
  });
});
