import type { ExtractedTriple } from "./types.js";

const MAX_CONTENT_LENGTH = 16000;

/**
 * Raw prompt template — exported for testing and documentation purposes.
 * Use buildExtractionPrompt() in production code.
 */
export const EXTRACTION_PROMPT_TEMPLATE = `Extract knowledge graph triples from the following text.
Return ONLY a JSON array of objects with these fields: subject, predicate, object, confidence (0-1).
Do not include any explanation or markdown — only the JSON array.

Focus on:
- Technical decisions and their rationale
- Dependencies between components and systems
- Task status and blocking relationships
- Roles and responsibilities (use role titles, not personal names)

Examples:

Input: "Migrated from Fastify to Hono because Fastify's plugin system conflicted with MCP transport requirements."
Output: [{"subject":"application framework","predicate":"migrated_to","object":"Hono","confidence":0.95},{"subject":"Fastify","predicate":"conflicted_with","object":"MCP transport","confidence":0.85}]

Input: "The embedding pipeline is blocked until the TEI server configuration is validated on the NAS."
Output: [{"subject":"embedding pipeline","predicate":"blocked_by","object":"TEI server configuration","confidence":0.9},{"subject":"TEI server configuration","predicate":"requires_validation_on","object":"NAS","confidence":0.8}]

Input: "Decided to use pgvector for semantic search after evaluating Qdrant and Milvus — simpler ops, no separate service."
Output: [{"subject":"semantic search","predicate":"implemented_with","object":"pgvector","confidence":0.95},{"subject":"pgvector","predicate":"preferred_over","object":"Qdrant","confidence":0.75},{"subject":"pgvector","predicate":"preferred_over","object":"Milvus","confidence":0.75}]

Now extract triples from:
{content}`;

export function buildExtractionPrompt(content: string, _options?: { fewShotCount?: number }): string {
  return EXTRACTION_PROMPT_TEMPLATE.replace("{content}", content.slice(0, MAX_CONTENT_LENGTH));
}

interface RawTriple {
  subject?: unknown;
  predicate?: unknown;
  object?: unknown;
  confidence?: unknown;
}

function isValidRawTriple(v: unknown): v is RawTriple {
  return v !== null && typeof v === "object";
}

export function parseTriples(raw: string, minConfidence: number): ExtractedTriple[] {
  // Strip markdown code fences if the model wrapped the JSON
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

  // Find the first '[' and last ']' in case there's preamble
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    console.warn("[entity-prompts] No JSON array found in response — returning empty");
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch (err) {
    console.warn("[entity-prompts] Failed to parse JSON:", (err as Error).message);
    return [];
  }

  if (!Array.isArray(parsed)) {
    console.warn("[entity-prompts] Parsed value is not an array");
    return [];
  }

  const triples: ExtractedTriple[] = [];
  for (const item of parsed) {
    if (!isValidRawTriple(item)) continue;

    const subject = typeof item.subject === "string" ? item.subject.trim() : "";
    const predicate = typeof item.predicate === "string" ? item.predicate.trim() : "";
    const object = typeof item.object === "string" ? item.object.trim() : "";
    const confidence =
      typeof item.confidence === "number"
        ? item.confidence
        : parseFloat(String(item.confidence));

    if (!subject || !predicate || !object) continue;
    if (!isFinite(confidence) || confidence < minConfidence) continue;

    triples.push({ subject, predicate, object, confidence: Math.min(1, Math.max(0, confidence)) });
  }
  return triples;
}
