import { mkdir, readFile, writeFile, rename, readdir, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { query } from "../db/client.js";

export async function ensureDataDir(): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
}

export async function read<T>(filepath: string): Promise<T | null> {
  try {
    const raw = await readFile(filepath, "utf-8");
    return JSON.parse(raw) as T;
  } catch (err: any) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/** Rename with retry for Windows EPERM/EACCES (file locking). */
async function safeRename(src: string, dest: string, retries = 5): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await rename(src, dest);
      return;
    } catch (err: any) {
      if ((err.code === "EPERM" || err.code === "EACCES") && i < retries - 1) {
        await new Promise((r) => setTimeout(r, 100 * (i + 1)));
        continue;
      }
      throw err;
    }
  }
}

export async function write<T>(filepath: string, data: T): Promise<void> {
  const dir = dirname(filepath);
  await mkdir(dir, { recursive: true });
  const tmpPath = join(dir, `.tmp-${randomUUID()}.json`);
  await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  await safeRename(tmpPath, filepath);
}

/**
 * Write a handoff to the append-only handoffs/ directory and update the pointer file.
 * Returns the filename of the written handoff.
 */
export async function writeHandoff<T>(data: T): Promise<string> {
  const handoffsDir = join(config.dataDir, "handoffs");
  await mkdir(handoffsDir, { recursive: true });

  // Build filename: ISO timestamp (file-safe) + short UUID
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const shortId = randomUUID().slice(0, 8);
  const filename = `${timestamp}-${shortId}.json`;
  const filepath = join(handoffsDir, filename);

  // Atomic write to the handoff file
  const tmpPath = join(handoffsDir, `.tmp-${randomUUID()}.json`);
  await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  await safeRename(tmpPath, filepath);

  // Update pointer file (atomic write)
  const pointerPath = join(config.dataDir, "handoff-latest.json");
  const pointerTmp = join(config.dataDir, `.tmp-${randomUUID()}.json`);
  await writeFile(pointerTmp, JSON.stringify(data, null, 2), "utf-8");
  await safeRename(pointerTmp, pointerPath);

  // Prune old handoffs beyond retention limit
  await pruneHandoffs(handoffsDir, config.retentionCount);

  return filename;
}

/**
 * Get the filename of the most recent handoff in the handoffs directory.
 * Returns null if no handoffs exist.
 */
export async function getLatestHandoffFilename(): Promise<string | null> {
  const handoffsDir = join(config.dataDir, "handoffs");
  try {
    const entries = (await readdir(handoffsDir))
      .filter((f) => f.endsWith(".json") && !f.startsWith(".tmp-"))
      .sort();
    return entries.length > 0 ? entries[entries.length - 1] : null;
  } catch (err: any) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Count the number of handoff files in the handoffs directory.
 */
export async function getHandoffCount(): Promise<number> {
  const handoffsDir = join(config.dataDir, "handoffs");
  try {
    const entries = (await readdir(handoffsDir))
      .filter((f) => f.endsWith(".json") && !f.startsWith(".tmp-"));
    return entries.length;
  } catch (err: any) {
    if (err.code === "ENOENT") return 0;
    throw err;
  }
}

/**
 * Remove oldest handoff files when count exceeds the retention limit.
 * Filenames sort chronologically by ISO timestamp prefix.
 */
async function pruneHandoffs(handoffsDir: string, retentionCount: number): Promise<void> {
  if (retentionCount <= 0) return; // 0 = unlimited retention

  const entries = (await readdir(handoffsDir))
    .filter((f) => f.endsWith(".json") && !f.startsWith(".tmp-"))
    .sort();

  if (entries.length <= retentionCount) return;

  const toRemove = entries.slice(0, entries.length - retentionCount);
  await Promise.all(toRemove.map((f) => unlink(join(handoffsDir, f))));

  // Clean up orphaned embedding rows for pruned handoff files
  try {
    for (const filename of toRemove) {
      await query(
        `DELETE FROM embeddings WHERE content_type = 'handoff' AND content_id LIKE $1`,
        [`${filename}%`]
      );
    }
  } catch {
    // Database may not be available — embedding cleanup is best-effort
  }
}
