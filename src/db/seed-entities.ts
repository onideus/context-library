/**
 * Entity seed loader: Reads entities from a JSON file and upserts into the entities table.
 *
 * Design:
 * - Idempotent: ON CONFLICT (canonical_name) DO UPDATE — safe to re-run as new entities are added.
 * - Skips silently if seed file is missing (graceful degradation for deployments without entities).
 * - Skips silently if Postgres is unavailable (Tier 1 JSON-only mode).
 *
 * The seed file path is configurable via ENTITY_SEED_PATH env var (default: ./data/entities.seed.json).
 * See entities.seed.example.json in the repo root for the expected format.
 */

import { readFile } from "node:fs/promises";
import { config } from "../config.js";

interface SeedEntity {
  canonical_name: string;
  scope: "work" | "personal" | "shared";
  aliases?: string[];
  constraints?: string[];
  metadata?: Record<string, unknown>;
}

export async function seedEntities(): Promise<void> {
  const seedPath = config.entitySeedPath;

  // Read seed file — skip silently if missing
  let raw: string;
  try {
    raw = await readFile(seedPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // File doesn't exist — expected in many deployments
      return;
    }
    console.warn("[seed-entities] Failed to read seed file:", (err as Error).message);
    return;
  }

  let entities: SeedEntity[];
  try {
    entities = JSON.parse(raw);
    if (!Array.isArray(entities)) {
      console.warn("[seed-entities] Seed file is not a JSON array, skipping");
      return;
    }
  } catch (err) {
    console.warn("[seed-entities] Invalid JSON in seed file:", (err as Error).message);
    return;
  }

  if (entities.length === 0) return;

  // Lazy import to avoid module-level Postgres dependency
  let queryFn: (text: string, params?: unknown[]) => Promise<unknown>;
  try {
    const { query } = await import("./client.js");
    queryFn = query;
  } catch (err) {
    console.warn("[seed-entities] Database not available, skipping entity seed:", (err as Error).message);
    return;
  }

  let upserted = 0;
  for (const entity of entities) {
    if (!entity.canonical_name || !entity.scope) {
      console.warn(`[seed-entities] Skipping invalid entity (missing canonical_name or scope)`);
      continue;
    }

    try {
      await queryFn(
        `INSERT INTO entities (canonical_name, scope, aliases, constraints, metadata)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (canonical_name) DO UPDATE SET
           scope = EXCLUDED.scope,
           aliases = EXCLUDED.aliases,
           constraints = EXCLUDED.constraints,
           metadata = EXCLUDED.metadata`,
        [
          entity.canonical_name,
          entity.scope,
          entity.aliases ?? [],
          entity.constraints ?? [],
          entity.metadata ?? {},
        ]
      );
      upserted++;
    } catch (err) {
      console.warn(`[seed-entities] Failed to upsert "${entity.canonical_name}":`, (err as Error).message);
    }
  }

  if (upserted > 0) {
    console.log(`[seed-entities] Upserted ${upserted} entities from ${seedPath}`);
  }
}
