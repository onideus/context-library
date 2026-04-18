/**
 * Pure merge logic for the entity seeding pipeline. Extracted from
 * extract-entities.ts so tests can exercise it without loading the
 * Anthropic SDK (a devDependency that is not installed in minimal
 * CI environments).
 */

export type Scope = "work" | "personal" | "shared";

export interface EntitySeed {
  canonical_name: string;
  scope: Scope;
  aliases: string[];
  constraints: string[];
  confidence?: number;
}

/**
 * Idempotent merge of fresh LLM-extracted entities into an existing seed list.
 *
 * - Adds new entities (case-insensitive canonical_name match).
 * - Union-merges aliases, preserving existing casing.
 * - Preserves existing constraints verbatim — humans curate those, so fresh
 *   LLM-suggested constraints never overwrite or append onto an existing entry.
 *   New entities get fresh constraints because there is nothing to preserve yet.
 * - Preserves existing scope — fresh scope assignments never overwrite an
 *   existing entry unless the existing entry has no scope set.
 * - Never deletes entries.
 *
 * Comparison is case-insensitive on canonical_name.
 */
export function mergeEntities(
  existing: EntitySeed[],
  fresh: EntitySeed[]
): { merged: EntitySeed[]; added: number; updated: number; aliasesAdded: number } {
  const byKey = new Map<string, EntitySeed>();
  const order: string[] = [];

  for (const e of existing) {
    const key = e.canonical_name.toLowerCase();
    byKey.set(key, {
      canonical_name: e.canonical_name,
      scope: e.scope,
      aliases: Array.isArray(e.aliases) ? [...e.aliases] : [],
      constraints: Array.isArray(e.constraints) ? [...e.constraints] : [],
      ...(typeof e.confidence === "number" ? { confidence: e.confidence } : {}),
    });
    order.push(key);
  }

  let added = 0;
  let updated = 0;
  let aliasesAdded = 0;

  for (const f of fresh) {
    const key = f.canonical_name.toLowerCase();
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, {
        canonical_name: f.canonical_name,
        scope: f.scope,
        aliases: Array.isArray(f.aliases) ? [...new Set(f.aliases)] : [],
        constraints: Array.isArray(f.constraints) ? [...f.constraints] : [],
        ...(typeof f.confidence === "number" ? { confidence: f.confidence } : {}),
      });
      order.push(key);
      added++;
      continue;
    }

    // Union-merge aliases (case-insensitive dedupe, preserve existing casing)
    const seen = new Set(current.aliases.map((a) => a.toLowerCase()));
    let changed = false;
    for (const alias of f.aliases ?? []) {
      if (!seen.has(alias.toLowerCase())) {
        current.aliases.push(alias);
        seen.add(alias.toLowerCase());
        aliasesAdded++;
        changed = true;
      }
    }

    if (changed) updated++;
  }

  const merged = order.map((k) => byKey.get(k)!);
  return { merged, added, updated, aliasesAdded };
}
