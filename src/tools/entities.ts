/**
 * Entity lookup and context envelope computation for JIT context (v0.5.1).
 *
 * Design constraints:
 * - No module-level DB import — uses lazy dynamic import for graceful degradation.
 * - computeEnvelope is a pure function (testable without DB).
 * - Entity matching is case-insensitive against canonical_name and aliases.
 */

// ── Types ────────────────────────────────────────────────────────

export interface EntityInfo {
  canonical_name: string;
  scope: "work" | "personal" | "shared";
  aliases: string[];
  constraints: string[];
}

export interface ContextEnvelope {
  scope_flags: string[];
  boundary_detected: boolean;
  constraint_alerts: string[];
  entity_map: Record<string, EntityInfo>;
  active_constraints: string[];
}

interface EntityRow {
  canonical_name: string;
  scope: string;
  aliases: string[];
  constraints: string[];
}

// ── Matching helpers ─────────────────────────────────────────────

/**
 * Word-boundary-aware case-insensitive match. Avoids substring false
 * positives like "Ian" matching "Kubernetes" or "CB" matching "SCBRS".
 * Exported for unit testing.
 */
export function matchesWordBoundary(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\b${escaped}\\b`, "i");
  return pattern.test(text);
}

// ── Empty Envelope ───────────────────────────────────────────────

export function emptyEnvelope(): ContextEnvelope {
  return {
    scope_flags: [],
    boundary_detected: false,
    constraint_alerts: [],
    entity_map: {},
    active_constraints: [],
  };
}

// ── Entity Lookup (DB) ───────────────────────────────────────────

/**
 * Look up entities that appear in the given texts.
 * Matches case-insensitively against canonical_name and aliases.
 * Returns empty array if DB is unavailable (graceful degradation).
 *
 * Side effect: when entities are matched, their `last_referenced` column is
 * updated to NOW() via a single batched UPDATE. Failures are swallowed —
 * bookkeeping must never fail an active search.
 */
export async function lookupEntities(texts: string[]): Promise<EntityInfo[]> {
  if (texts.length === 0) return [];

  let queryFn: (text: string, params?: unknown[]) => Promise<{ rows: EntityRow[] }>;
  try {
    const { query } = await import("../db/client.js");
    queryFn = query;
  } catch {
    return [];
  }

  try {
    // Fetch all entities — table is expected to be small (< 100 rows typically)
    const result = await queryFn(
      "SELECT canonical_name, scope, aliases, constraints FROM entities"
    );

    if (result.rows.length === 0) return [];

    // Combine all texts into one searchable blob for matching.
    // We keep original case since matchesWordBoundary is case-insensitive;
    // lowercasing throws away boundary info for things like "CamelCase".
    const combined = texts.join("\n");

    const matched: EntityInfo[] = [];
    for (const row of result.rows) {
      const names = [row.canonical_name, ...(row.aliases || [])]
        // Single-character names are too ambiguous — too many false positives.
        .filter((n) => typeof n === "string" && n.length > 1);
      const found = names.some((name) => matchesWordBoundary(combined, name));
      if (found) {
        matched.push({
          canonical_name: row.canonical_name,
          scope: row.scope as "work" | "personal" | "shared",
          aliases: row.aliases || [],
          constraints: row.constraints || [],
        });
      }
    }

    if (matched.length > 0) {
      try {
        await queryFn(
          "UPDATE entities SET last_referenced = NOW() WHERE canonical_name = ANY($1)",
          [matched.map((e) => e.canonical_name)]
        );
      } catch {
        // Non-fatal — bookkeeping failure must not break search
      }
    }

    return matched;
  } catch {
    // DB query failed — graceful degradation
    return [];
  }
}

// ── Envelope Computation (Pure) ──────────────────────────────────

/**
 * Compute a context envelope from matched entities.
 * Pure function — no DB access, fully testable.
 */
export function computeEnvelope(entities: EntityInfo[]): ContextEnvelope {
  if (entities.length === 0) return emptyEnvelope();

  const scopeSet = new Set<string>();
  const entityMap: Record<string, EntityInfo> = {};
  const allConstraints: string[] = [];
  const constraintAlerts: string[] = [];

  for (const entity of entities) {
    scopeSet.add(entity.scope);
    entityMap[entity.canonical_name] = entity;

    for (const constraint of entity.constraints) {
      allConstraints.push(constraint);
      constraintAlerts.push(`${entity.canonical_name}: ${constraint}`);
    }
  }

  const scopeFlags = Array.from(scopeSet).sort();
  const boundaryDetected = scopeFlags.length > 1;

  return {
    scope_flags: scopeFlags,
    boundary_detected: boundaryDetected,
    constraint_alerts: constraintAlerts,
    entity_map: entityMap,
    active_constraints: allConstraints,
  };
}

// ── Boundary Notice Generation ───────────────────────────────────

/**
 * Generate a prose BOUNDARY NOTICE when results span multiple scopes.
 */
export function generateBoundaryNotice(envelope: ContextEnvelope): string | null {
  if (!envelope.boundary_detected) return null;

  const scopeList = envelope.scope_flags.join(", ");
  const lines: string[] = [
    `\u26a0\ufe0f BOUNDARY NOTICE: These results span [${scopeList}] scopes.`,
  ];

  // Group constraints by scope
  const byScope: Record<string, string[]> = {};
  for (const [name, entity] of Object.entries(envelope.entity_map)) {
    if (entity.constraints.length > 0) {
      if (!byScope[entity.scope]) byScope[entity.scope] = [];
      for (const c of entity.constraints) {
        byScope[entity.scope].push(`${name} — ${c}`);
      }
    }
  }

  for (const scope of envelope.scope_flags) {
    const constraints = byScope[scope] ?? [];
    if (constraints.length > 0) {
      lines.push(`Constraints from ${scope} scope: ${constraints.join("; ")}`);
    }
  }

  lines.push("DO NOT blend recommendations across scopes without explicitly acknowledging the boundary.");

  return lines.join("\n");
}
