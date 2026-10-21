/**
 * Pure string helpers for str_replace_note / append_note. Kept dependency-free
 * so unit tests can import them without loading config, the pg pool, or the
 * indexer.
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
