/**
 * Pure string helpers for str_replace_note / append_note / patch_artifact. Kept
 * dependency-free so unit tests can import them without loading config, the
 * pg pool, or the indexer.
 */

/** Count non-overlapping literal occurrences of `needle` in `haystack`. */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  return haystack.split(needle).length - 1;
}

/**
 * Literal replacement — no regex, no `$&`/`$1`/`$$` substitution (which
 * `String.prototype.replace` would apply). Replaces the first occurrence, or
 * every occurrence when `replaceAll` is true.
 */
export function literalReplace(
  haystack: string,
  needle: string,
  replacement: string,
  replaceAll: boolean
): string {
  if (replaceAll) return haystack.split(needle).join(replacement);
  const idx = haystack.indexOf(needle);
  if (idx === -1) return haystack;
  return haystack.slice(0, idx) + replacement + haystack.slice(idx + needle.length);
}

/** Append `addition` on a new line, inserting at most one `\n` separator. */
export function appendWithNewline(existing: string, addition: string): string {
  if (existing.length === 0) return addition;
  return existing.endsWith("\n") ? existing + addition : `${existing}\n${addition}`;
}

export interface LiteralEdit {
  old_str: string;
  new_str: string;
  replace_all?: boolean;
}

export type ApplyEditsResult =
  | { ok: true; content: string; replacements: number[] }
  | { ok: false; code: "NO_MATCH" | "AMBIGUOUS_MATCH"; edit_index: number; match_count: number };

/**
 * Apply literal edits in order, each against the result of the previous one.
 * An edit without `replace_all` must match exactly once; with `replace_all`
 * it must match at least once. The first failing edit aborts the whole batch
 * (all edits or none) and is reported by its zero-based index.
 */
export function applyEdits(content: string, edits: LiteralEdit[]): ApplyEditsResult {
  let current = content;
  const replacements: number[] = [];
  for (let i = 0; i < edits.length; i++) {
    const { old_str, new_str, replace_all } = edits[i];
    const matchCount = countOccurrences(current, old_str);
    if (matchCount === 0) {
      return { ok: false, code: "NO_MATCH", edit_index: i, match_count: 0 };
    }
    if (matchCount > 1 && !replace_all) {
      return { ok: false, code: "AMBIGUOUS_MATCH", edit_index: i, match_count: matchCount };
    }
    current = literalReplace(current, old_str, new_str, replace_all === true);
    replacements.push(replace_all ? matchCount : 1);
  }
  return { ok: true, content: current, replacements };
}
