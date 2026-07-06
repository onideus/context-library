/**
 * Shared JSONL / tar helpers for export and import.
 *
 * Kept intentionally small — no dependency on the surrounding server, so
 * these functions can be unit-tested cheaply and reused by any future
 * portability tool (e.g. a partial-export or workspace-scoped export
 * once workspaces exist).
 */

import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { spawn } from "node:child_process";

/**
 * Serialise a row (as returned by node-pg) to a canonical JSON line. Dates
 * become ISO strings, JSONB objects stay structural. Column order is fixed
 * by the caller so subsequent exports diff cleanly.
 */
export function rowToJsonLine(
  row: Record<string, unknown>,
  columns: readonly string[]
): string {
  const ordered: Record<string, unknown> = {};
  for (const col of columns) {
    const value = row[col];
    ordered[col] = normaliseValue(value);
  }
  return JSON.stringify(ordered);
}

function normaliseValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  // Arrays and plain objects pass through — JSON.stringify handles them.
  return value;
}

/** Write an array of JSON lines to a file, each terminated with \n. */
export async function writeJsonlFile(
  path: string,
  lines: readonly string[]
): Promise<void> {
  const body = lines.length === 0 ? "" : lines.join("\n") + "\n";
  await writeFile(path, body, "utf-8");
}

/** Read a JSONL file lazily, yielding one parsed row at a time. */
export async function* readJsonlFile(
  path: string
): AsyncGenerator<Record<string, unknown>> {
  const stream = createReadStream(path, { encoding: "utf-8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    yield JSON.parse(line);
  }
}

/**
 * Count JSONL rows in a file without keeping them all in memory. Used by
 * import to verify manifest row_counts before the transactional load.
 */
export async function countJsonlRows(path: string): Promise<number> {
  let count = 0;
  const stream = createReadStream(path, { encoding: "utf-8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim()) count++;
  }
  return count;
}

/** Recursively list files under `dir`, returned as paths relative to `dir`. */
export async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(sub: string) {
    let entries: string[];
    try {
      entries = await readdir(join(dir, sub));
    } catch {
      return;
    }
    for (const name of entries) {
      const rel = sub ? join(sub, name) : name;
      const st = await stat(join(dir, rel));
      if (st.isDirectory()) {
        await walk(rel);
      } else if (st.isFile()) {
        out.push(rel);
      }
    }
  }
  await walk("");
  return out.sort();
}

/** Ensure a directory exists (idempotent). */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/**
 * Create a gzipped tarball of `sourceDir` at `tarballPath`. Uses the system
 * `tar` binary — every deployment target for this project (Linux, macOS,
 * WSL) ships one, and shelling out avoids pulling a Node tar implementation
 * into the dependency graph.
 */
export function createTarball(
  sourceDir: string,
  tarballPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    // -C changes into sourceDir before adding files; without it the tarball
    // preserves the absolute path prefix and is a nightmare to extract.
    const proc = spawn(
      "tar",
      ["-czf", tarballPath, "-C", sourceDir, "."],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    const errBuf: string[] = [];
    proc.stderr?.on("data", (chunk) => errBuf.push(chunk.toString()));
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited ${code}: ${errBuf.join("")}`));
    });
  });
}

/** Extract a gzipped tarball into `destDir`. Directory must already exist. */
export function extractTarball(
  tarballPath: string,
  destDir: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "tar",
      ["-xzf", tarballPath, "-C", destDir],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    const errBuf: string[] = [];
    proc.stderr?.on("data", (chunk) => errBuf.push(chunk.toString()));
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited ${code}: ${errBuf.join("")}`));
    });
  });
}

/** Read a JSON file and parse it. Throws on invalid JSON. */
export async function readJsonFile<T>(path: string): Promise<T> {
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw) as T;
}

/** Write a JSON file (pretty-printed for human readability). */
export async function writeJsonFile(
  path: string,
  value: unknown
): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf-8");
}
