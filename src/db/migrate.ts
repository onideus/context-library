import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "./client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function runMigrations(): Promise<void> {
  // Create migrations tracking table
  await query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const migrationsDir = join(__dirname, "migrations");

  // In compiled output, migrations dir is at dist/db/migrations
  // but SQL files aren't copied by tsc. We need to resolve from source.
  // Strategy: check compiled location first, fall back to src location.
  let dir = migrationsDir;
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  } catch {
    // Fallback: resolve relative to project root (for compiled builds)
    const projectRoot = join(__dirname, "..", "..");
    dir = join(projectRoot, "src", "db", "migrations");
    files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  }

  if (files.length === 0) {
    console.log("[migrate] No migration files found");
    return;
  }

  // Check which migrations have already been applied
  const applied = await query<{ filename: string }>(
    "SELECT filename FROM _migrations"
  );
  const appliedSet = new Set(applied.rows.map((r) => r.filename));

  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`[migrate] Already applied: ${file}`);
      continue;
    }

    const sql = await readFile(join(dir, file), "utf-8");
    console.log(`[migrate] Applying: ${file}`);
    await query(sql);
    await query("INSERT INTO _migrations (filename) VALUES ($1)", [file]);
    console.log(`[migrate] Applied: ${file}`);
  }

  console.log("[migrate] All migrations complete");
}
