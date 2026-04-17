/**
 * Search alias expansion (v0.6).
 *
 * A small deployment-local lookup table that appends expansions for known
 * abbreviations or ambiguous terms before embedding the query. The goal is
 * to help both vector and FTS search match when the user types "RE9" but
 * the corpus contains "Resident Evil 9 Requiem".
 *
 * The original query text is preserved — expansions are appended — so both
 * the abbreviation and the expansion contribute to retrieval.
 *
 * The alias file is deployment-local (`.gitignore`'d) and loaded lazily on
 * first use. Missing file → graceful degradation (expansion is a no-op).
 */

import { readFileSync } from "node:fs";
import { config } from "../config.js";

let aliases: Record<string, string> | null = null;
let loaded = false;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Load the alias file from disk and cache in memory. Safe to call multiple
 * times — reads exactly once per process. On missing/invalid file this
 * records an empty map so expandQuery() is a no-op.
 */
export function loadAliases(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = readFileSync(config.searchAliasPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Object.values(parsed).every((v) => typeof v === "string")
    ) {
      aliases = parsed as Record<string, string>;
    } else {
      aliases = {};
      console.warn(
        `[search-aliases] ${config.searchAliasPath} is not a flat string→string object — ignoring`
      );
    }
  } catch (err) {
    // Missing file is the common case — keep quiet unless the error is
    // something other than ENOENT (e.g., malformed JSON).
    aliases = {};
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.warn(
        `[search-aliases] Failed to load ${config.searchAliasPath}: ${(err as Error).message}`
      );
    }
  }
}

/**
 * Test-only: reset the module cache so tests can reload from disk.
 * Not used in production code paths.
 */
export function resetAliasesForTests(): void {
  aliases = null;
  loaded = false;
}

/**
 * For any alias key that appears as a whole word in the query, append the
 * expansion text. Returns the original query if no aliases match or the
 * alias file is unavailable. The original query is always preserved.
 */
export function expandQuery(query: string): string {
  loadAliases();
  if (!aliases || Object.keys(aliases).length === 0) return query;

  const expansions: string[] = [];
  for (const [key, expansion] of Object.entries(aliases)) {
    if (!key) continue;
    const pattern = new RegExp(`\\b${escapeRegex(key)}\\b`, "i");
    if (pattern.test(query)) expansions.push(expansion);
  }

  if (expansions.length === 0) return query;
  return `${query} ${expansions.join(" ")}`;
}
