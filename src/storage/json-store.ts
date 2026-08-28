import { mkdir, readFile, writeFile, rename, readdir, unlink, link, access } from "node:fs/promises";
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
 * Write a handoff to the append-only handoffs/ directory.
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

  // Best-effort cleanup of the deprecated handoff-latest.json pointer file.
  // Pre-existing deployments may still have a stale pointer on disk; nothing
  // reads it any more, but removing it prevents confusion when inspecting data/.
  try {
    await unlink(join(config.dataDir, "handoff-latest.json"));
  } catch {
    // pointer file already gone or never existed — ignore
  }

  // Prune old handoffs beyond retention limit
  await pruneHandoffs(handoffsDir, config.retentionCount);

  return filename;
}

/**
 * Subdirectory of handoffs/ holding byte-exact originals saved before a
 * compaction rewrite. Deliberately NOT a `.json` name: every readdir over
 * handoffs/ filters on `.endsWith(".json")`, so the archive is invisible to
 * latest-file resolution, handoff counting, and retention pruning. Archived
 * originals are archival by definition — retention does not apply to them.
 */
export const ARCHIVE_DIRNAME = "archive";

/**
 * Copy a handoff to handoffs/archive/ byte-for-byte before it is rewritten.
 *
 * The bytes are copied verbatim rather than re-serialised — an archival copy
 * that reformats what it preserves is not an archival copy.
 *
 * First archive wins: if an archived copy already exists it is left alone and
 * "exists" is returned. The existing copy is the original; anything we could
 * write over it now is a later, already-degraded version of the same file.
 *
 * Throws ENOENT if the source handoff does not exist. Callers in the
 * compaction path MUST let that propagate — failing to archive has to abort
 * the rewrite, never silently fall through to it.
 */
export async function archiveHandoff(filename: string): Promise<"archived" | "exists"> {
  const handoffsDir = join(config.dataDir, "handoffs");
  const archiveDir = join(handoffsDir, ARCHIVE_DIRNAME);
  const dest = join(archiveDir, filename);

  await mkdir(archiveDir, { recursive: true });

  try {
    await access(dest);
    return "exists";
  } catch {
    // not archived yet — continue
  }

  const bytes = await readFile(join(handoffsDir, filename));

  const tmpPath = join(archiveDir, `.tmp-${randomUUID()}.json`);
  await writeFile(tmpPath, bytes);

  try {
    // link() is an atomic exclusive create: it fails EEXIST rather than
    // clobbering, which keeps first-archive-wins true even under a race that
    // slipped past the access() check above.
    await link(tmpPath, dest);
    await unlink(tmpPath).catch(() => {});
    return "archived";
  } catch (err: any) {
    await unlink(tmpPath).catch(() => {});
    if (err.code === "EEXIST") return "exists";
    if (err.code === "ENOENT") throw err;
    // Filesystems without hard-link support (some bind mounts): re-stage and
    // fall back to the same temp+rename dance used everywhere else here.
    const retryTmp = join(archiveDir, `.tmp-${randomUUID()}.json`);
    await writeFile(retryTmp, bytes);
    await safeRename(retryTmp, dest);
    return "archived";
  }
}

/**
 * Overwrite an existing handoff file in place (atomic via temp file + rename).
 * Unlike writeHandoff, this does NOT create a new timestamped file and does
 * NOT prune. It is used only by compaction
 * to rewrite a previously-stored handoff with archived content removed.
 * Throws ENOENT if the file doesn't exist.
 */
export async function writeHandoffInPlace<T>(filename: string, data: T): Promise<void> {
  const handoffsDir = join(config.dataDir, "handoffs");
  const filepath = join(handoffsDir, filename);

  const existing = await read<unknown>(filepath);
  if (existing === null) {
    const err = new Error(`Handoff file not found: ${filename}`) as Error & { code?: string };
    err.code = "ENOENT";
    throw err;
  }

  const tmpPath = join(handoffsDir, `.tmp-${randomUUID()}.json`);
  await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  await safeRename(tmpPath, filepath);
}

/**
 * Get the filename of the most recent handoff in the handoffs directory.
 * Returns null if no handoffs exist.
 *
 * The `.json` filter excludes the ARCHIVE_DIRNAME subdirectory, so archived
 * originals can never be resolved as the latest handoff.
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
 *
 * The ARCHIVE_DIRNAME subdirectory is outside retention entirely — the
 * `.json` filter skips it, and that is deliberate, not incidental. Archived
 * originals exist precisely because the deployment chose to keep them; a
 * retention sweep that pruned them would delete the only surviving copy of
 * the pre-compaction text.
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
