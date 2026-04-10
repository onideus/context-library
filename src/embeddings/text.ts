/**
 * Pure text extraction and chunking utilities.
 * No database or embedding client dependencies — safe for unit testing.
 */

/** Keys to skip during recursive extraction (structural metadata, not content). */
const SKIP_KEYS = new Set([
  "id", "stored_at", "retrieved_at", "elapsed_seconds", "schema_version",
  "patched_from", "stored_at_local", "timezone", "session_meta",
  "same_calendar_day", "handoff_count", "applied_scope", "filtered_fields",
  "task_summary",
]);

/** Detect values that are purely structural (UUIDs, ISO timestamps, version strings). */
function isStructuralValue(value: string): boolean {
  // UUID pattern
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return true;
  // ISO timestamp
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) return true;
  // Semver-like version strings
  if (/^\d+\.\d+(\.\d+)?$/.test(value)) return true;
  return false;
}

/**
 * Recursively extract all searchable text from a JSON object.
 * Produces labeled key: value lines so embeddings capture what each value means.
 */
function recursiveExtract(obj: unknown, keyPath: string, parts: string[]): void {
  if (obj === null || obj === undefined) return;

  if (typeof obj === "string") {
    if (obj.trim() && !isStructuralValue(obj)) {
      parts.push(keyPath ? `${keyPath}: ${obj}` : obj);
    }
    return;
  }

  if (typeof obj === "number" || typeof obj === "boolean") {
    if (keyPath) {
      parts.push(`${keyPath}: ${String(obj)}`);
    }
    return;
  }

  if (Array.isArray(obj)) {
    // Array of strings — join with ". " and label
    const strings = obj.filter((item): item is string =>
      typeof item === "string" && item.trim().length > 0 && !isStructuralValue(item)
    );
    if (strings.length > 0 && strings.length === obj.length) {
      parts.push(keyPath ? `${keyPath}: ${strings.join(". ")}` : strings.join(". "));
      return;
    }
    // Mixed array or array of objects — recurse into each element
    for (let i = 0; i < obj.length; i++) {
      recursiveExtract(obj[i], keyPath, parts);
    }
    return;
  }

  if (typeof obj === "object") {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (SKIP_KEYS.has(key)) continue;
      const childPath = keyPath ? `${keyPath} ${key}` : key;
      recursiveExtract(value, childPath, parts);
    }
  }
}

/** Extract all searchable text from a handoff JSON object using recursive walking. */
export function extractHandoffText(handoff: Record<string, unknown>): string {
  const parts: string[] = [];
  recursiveExtract(handoff, "", parts);
  return parts.join("\n\n");
}

// ── Chunking ──────────────────────────────────────────────────

const TARGET_CHUNK_SIZE = 2000;
const MIN_CHUNK_SIZE = 200;

/**
 * Split extracted text into chunks suitable for embedding.
 * Splits on double newlines first, then single newlines, then sentence boundaries.
 */
export function chunkText(text: string): string[] {
  if (text.length <= TARGET_CHUNK_SIZE) {
    return text.trim() ? [text] : [];
  }

  // Split on double newlines (natural section boundaries from recursive extraction)
  const sections = text.split("\n\n").filter((s) => s.trim());
  const chunks: string[] = [];
  let current = "";

  for (const section of sections) {
    // If adding this section stays under target, accumulate
    if (current && current.length + 2 + section.length <= TARGET_CHUNK_SIZE) {
      current += "\n\n" + section;
      continue;
    }

    // Flush current chunk if it has content
    if (current) {
      chunks.push(current);
      current = "";
    }

    // If section itself fits in a chunk, start a new accumulator
    if (section.length <= TARGET_CHUNK_SIZE) {
      current = section;
      continue;
    }

    // Section exceeds target — split on single newlines
    const lines = section.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      if (current && current.length + 1 + line.length <= TARGET_CHUNK_SIZE) {
        current += "\n" + line;
        continue;
      }

      if (current) {
        chunks.push(current);
        current = "";
      }

      if (line.length <= TARGET_CHUNK_SIZE) {
        current = line;
        continue;
      }

      // Single line exceeds target — split at sentence boundaries
      const sentences = line.split(/(?<=\. )/);
      for (const sentence of sentences) {
        if (current && current.length + sentence.length <= TARGET_CHUNK_SIZE) {
          current += sentence;
          continue;
        }
        if (current) {
          chunks.push(current);
          current = "";
        }
        current = sentence;
      }
    }
  }

  // Flush remaining
  if (current) {
    chunks.push(current);
  }

  // Merge undersized trailing chunk into previous
  if (chunks.length > 1 && chunks[chunks.length - 1].length < MIN_CHUNK_SIZE) {
    const last = chunks.pop()!;
    chunks[chunks.length - 1] += "\n\n" + last;
  }

  return chunks;
}
