#!/usr/bin/env tsx
/**
 * extract-entities — CLI bootstrap script for entity seeding.
 *
 * Reads handoff JSON files from the configured data directory, batches them
 * to the Anthropic API for entity extraction, and writes a draft
 * `entities.seed.json` for human review. Idempotent: an existing seed file is
 * merged — human-edited constraints are preserved, aliases are union-merged,
 * new entities are added, and existing entries are never deleted.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... npm run extract-entities
 *   ANTHROPIC_API_KEY=sk-... npm run extract-entities -- --output ./entities.seed.json
 *
 * Environment:
 *   ANTHROPIC_API_KEY  Anthropic API key (required)
 *   DATA_DIR           Root data dir (default: ./data). Handoffs live in DATA_DIR/handoffs.
 *   EXTRACT_MODEL      Override model (default: claude-sonnet-4-20250514).
 *
 * Notes:
 *   - This script does NOT run in production. It is a one-shot seeding tool.
 *   - The @anthropic-ai/sdk is declared as a devDependency to keep the runtime
 *     image lean. See ROADMAP Horizon: MCP sampling will collapse this into a
 *     tool and drop the dep entirely.
 */

import { readdir, readFile, writeFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const BATCH_SIZE = 8;

// ── Types ─────────────────────────────────────────────────────────

type Scope = "work" | "personal" | "shared";

interface EntitySeed {
  canonical_name: string;
  scope: Scope;
  aliases: string[];
  constraints: string[];
  confidence?: number;
}

interface Summary {
  handoffs_read: number;
  batches_sent: number;
  batch_failures: number;
  entities_total: number;
  entities_new: number;
  entities_existing_updated: number;
  aliases_added: number;
}

// ── Arg parsing ───────────────────────────────────────────────────

function parseArgs(argv: string[]): { output: string } {
  let output = resolve(process.cwd(), "entities.seed.json");
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--output" || arg === "-o") {
      const next = argv[i + 1];
      if (!next) {
        console.error("Error: --output requires a path argument");
        process.exit(2);
      }
      output = resolve(process.cwd(), next);
      i++;
    }
  }
  return { output };
}

// ── File IO ───────────────────────────────────────────────────────

async function readHandoffs(dataDir: string): Promise<Array<{ filename: string; body: unknown }>> {
  const handoffsDir = join(dataDir, "handoffs");
  let files: string[];
  try {
    files = await readdir(handoffsDir);
  } catch {
    console.error(`No handoffs directory at ${handoffsDir} — nothing to extract.`);
    return [];
  }
  const jsonFiles = files
    .filter((f) => f.endsWith(".json") && !f.startsWith(".tmp-"))
    .sort();

  const out: Array<{ filename: string; body: unknown }> = [];
  for (const filename of jsonFiles) {
    try {
      const raw = await readFile(join(handoffsDir, filename), "utf8");
      out.push({ filename, body: JSON.parse(raw) });
    } catch (err) {
      console.warn(`[warn] Skipping unreadable handoff ${filename}: ${(err as Error).message}`);
    }
  }
  return out;
}

async function readExistingSeed(path: string): Promise<EntitySeed[]> {
  try {
    await access(path);
  } catch {
    return [];
  }
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn(`[warn] Existing seed at ${path} is not an array — ignoring.`);
      return [];
    }
    return parsed as EntitySeed[];
  } catch (err) {
    console.warn(`[warn] Could not parse existing seed at ${path}: ${(err as Error).message}`);
    return [];
  }
}

// ── Merge logic (pure, testable) ──────────────────────────────────

/**
 * Idempotent merge of freshly extracted entities into an existing seed list.
 * - New entities are added.
 * - Existing entities preserve human-edited constraints (constraints are not
 *   overwritten). Aliases are union-merged. Scope is preserved from the
 *   existing entry unless the existing entry has no scope set.
 * - No entry is ever deleted.
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

    // Preserve existing constraints. Never overwrite or append fresh
    // constraints — humans curate those. (New entities get fresh constraints
    // because there is nothing to preserve yet.)
    if (changed) updated++;
  }

  const merged = order.map((k) => byKey.get(k)!);
  return { merged, added, updated, aliasesAdded };
}

// ── Prompting ─────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are extracting canonical entities from operational handoff data.

Return ONLY a JSON array. Each element MUST have this exact shape:
{
  "canonical_name": string,
  "scope": "work" | "personal" | "shared",
  "aliases": string[],
  "constraints": string[],
  "confidence": number  // 0.0 to 1.0
}

Rules:
- canonical_name: the preferred, unambiguous form of the entity.
- scope: "work" if the entity belongs to a professional/employer context, "personal" for private/home/individual context, "shared" if it legitimately spans both.
- aliases: other names or informal references seen in the handoffs.
- constraints: short guidance on how to handle the entity (e.g. confidentiality, device ownership). Leave as [] if none are evident.
- confidence: your confidence that this is a real, stable entity worth tracking.

Only extract entities that are actually named and recurring. Do NOT invent entities.
Do NOT include any commentary, markdown fences, or prose — just the JSON array.

Example shape (generic placeholders — do not copy these as real entities):
[
  {"canonical_name": "MyProject", "scope": "work", "aliases": ["proj"], "constraints": ["Confidential"], "confidence": 0.9},
  {"canonical_name": "team-lead", "scope": "work", "aliases": [], "constraints": [], "confidence": 0.7},
  {"canonical_name": "staging-server", "scope": "shared", "aliases": ["stage"], "constraints": ["Shared with other teams"], "confidence": 0.6}
]`;

function buildUserMessage(batch: Array<{ filename: string; body: unknown }>): string {
  const lines: string[] = [
    "Extract canonical entities from the following handoff files.",
    "Each file is presented as `--- <filename> ---` followed by its JSON body.",
    "",
  ];
  for (const { filename, body } of batch) {
    lines.push(`--- ${filename} ---`);
    lines.push(JSON.stringify(body, null, 2));
    lines.push("");
  }
  return lines.join("\n");
}

function parseModelOutput(raw: string): EntitySeed[] {
  // Strip fences if the model ignored instructions and wrapped the JSON.
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const parsed = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) {
    throw new Error("Model output was not a JSON array");
  }
  const validated: EntitySeed[] = [];
  for (const row of parsed) {
    if (
      row &&
      typeof row === "object" &&
      typeof row.canonical_name === "string" &&
      (row.scope === "work" || row.scope === "personal" || row.scope === "shared")
    ) {
      validated.push({
        canonical_name: row.canonical_name,
        scope: row.scope,
        aliases: Array.isArray(row.aliases)
          ? row.aliases.filter((a: unknown) => typeof a === "string")
          : [],
        constraints: Array.isArray(row.constraints)
          ? row.constraints.filter((c: unknown) => typeof c === "string")
          : [],
        ...(typeof row.confidence === "number" ? { confidence: row.confidence } : {}),
      });
    }
  }
  return validated;
}

// ── Orchestration ─────────────────────────────────────────────────

async function extractBatch(
  client: Anthropic,
  model: string,
  batch: Array<{ filename: string; body: unknown }>
): Promise<EntitySeed[]> {
  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserMessage(batch) }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Model response contained no text block");
  }
  return parseModelOutput(textBlock.text);
}

async function run(): Promise<number> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("Error: ANTHROPIC_API_KEY is not set.");
    return 2;
  }

  const { output } = parseArgs(process.argv.slice(2));
  const dataDir = resolve(process.cwd(), process.env.DATA_DIR ?? "./data");
  const model = process.env.EXTRACT_MODEL ?? DEFAULT_MODEL;

  console.log(`[extract-entities] data dir: ${dataDir}`);
  console.log(`[extract-entities] output:   ${output}`);
  console.log(`[extract-entities] model:    ${model}`);

  const handoffs = await readHandoffs(dataDir);
  if (handoffs.length === 0) {
    console.log("No handoffs to process — exiting.");
    return 0;
  }

  const existing = await readExistingSeed(output);
  const client = new Anthropic({ apiKey });

  const summary: Summary = {
    handoffs_read: handoffs.length,
    batches_sent: 0,
    batch_failures: 0,
    entities_total: existing.length,
    entities_new: 0,
    entities_existing_updated: 0,
    aliases_added: 0,
  };

  // Accumulate across batches so we de-dupe before we merge with the existing
  // seed file. This avoids double-counting when two batches surface the same
  // entity.
  const freshByKey = new Map<string, EntitySeed>();

  for (let i = 0; i < handoffs.length; i += BATCH_SIZE) {
    const batch = handoffs.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(handoffs.length / BATCH_SIZE);
    console.log(`[extract-entities] batch ${batchNum}/${totalBatches} (${batch.length} files)`);

    summary.batches_sent++;
    try {
      const extracted = await extractBatch(client, model, batch);
      for (const e of extracted) {
        const key = e.canonical_name.toLowerCase();
        const cur = freshByKey.get(key);
        if (!cur) {
          freshByKey.set(key, {
            ...e,
            aliases: [...new Set(e.aliases)],
          });
        } else {
          const seen = new Set(cur.aliases.map((a) => a.toLowerCase()));
          for (const alias of e.aliases) {
            if (!seen.has(alias.toLowerCase())) {
              cur.aliases.push(alias);
              seen.add(alias.toLowerCase());
            }
          }
          if (typeof e.confidence === "number" && typeof cur.confidence === "number") {
            cur.confidence = Math.max(cur.confidence, e.confidence);
          }
        }
      }
    } catch (err) {
      summary.batch_failures++;
      console.warn(`[extract-entities] batch ${batchNum} failed: ${(err as Error).message}`);
      // Continue with remaining batches
    }
  }

  const fresh = Array.from(freshByKey.values());
  const { merged, added, updated, aliasesAdded } = mergeEntities(existing, fresh);

  summary.entities_total = merged.length;
  summary.entities_new = added;
  summary.entities_existing_updated = updated;
  summary.aliases_added = aliasesAdded;

  await writeFile(output, JSON.stringify(merged, null, 2) + "\n", "utf8");

  console.log("");
  console.log("[extract-entities] summary");
  console.log(`  handoffs read:                 ${summary.handoffs_read}`);
  console.log(`  batches sent:                  ${summary.batches_sent}`);
  console.log(`  batch failures:                ${summary.batch_failures}`);
  console.log(`  entities total (after merge):  ${summary.entities_total}`);
  console.log(`  entities new:                  ${summary.entities_new}`);
  console.log(`  entities updated (aliases):    ${summary.entities_existing_updated}`);
  console.log(`  aliases added:                 ${summary.aliases_added}`);
  console.log(`  output:                        ${output}`);

  return summary.batch_failures > 0 ? 1 : 0;
}

// Only run when invoked directly, not when imported by tests.
const thisFile = fileURLToPath(import.meta.url);
const invokedAsScript = process.argv[1] && resolve(process.argv[1]) === thisFile;
if (invokedAsScript) {
  run().then(
    (code) => process.exit(code),
    (err) => {
      console.error("[extract-entities] fatal:", err);
      process.exit(1);
    }
  );
}
