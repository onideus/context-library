import { config } from "../../config.js";
import type { EntityExtractor, ExtractionResult, ExtractedTriple } from "../types.js";

const PROVIDER_NAME = "ollama";
const PROVIDER_VERSION = "1.0.0";

const EXTRACTION_PROMPT = `Extract knowledge graph triples from the following text.
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

interface OllamaOptions {
  baseUrl: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  minConfidence?: number;
  timeoutMs?: number;
}

interface OllamaChatResponse {
  message?: { content?: string };
  done?: boolean;
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

function parseTriples(raw: string, minConfidence: number): ExtractedTriple[] {
  // Strip markdown code fences if the model wrapped the JSON
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

  // Find the first '[' and last ']' in case there's preamble
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    console.warn("[ollama] No JSON array found in response — returning empty");
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch (err) {
    console.warn("[ollama] Failed to parse JSON:", (err as Error).message);
    return [];
  }

  if (!Array.isArray(parsed)) {
    console.warn("[ollama] Parsed value is not an array");
    return [];
  }

  const triples: ExtractedTriple[] = [];
  for (const item of parsed) {
    if (!isValidRawTriple(item)) continue;

    const subject = typeof item.subject === "string" ? item.subject.trim() : "";
    const predicate = typeof item.predicate === "string" ? item.predicate.trim() : "";
    const object = typeof item.object === "string" ? item.object.trim() : "";
    const confidence = typeof item.confidence === "number" ? item.confidence : parseFloat(String(item.confidence));

    if (!subject || !predicate || !object) continue;
    if (!isFinite(confidence) || confidence < minConfidence) continue;

    triples.push({ subject, predicate, object, confidence: Math.min(1, Math.max(0, confidence)) });
  }
  return triples;
}

export class OllamaProvider implements EntityExtractor {
  readonly provider = PROVIDER_NAME;
  readonly version = PROVIDER_VERSION;

  private readonly baseUrl: string;
  private readonly model: string;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly minConfidence: number;
  private readonly timeoutMs: number;

  constructor(opts: OllamaOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.model = opts.model;
    this.temperature = opts.temperature ?? 0.1;
    this.maxTokens = opts.maxTokens ?? 2048;
    this.minConfidence = opts.minConfidence ?? config.entityMinConfidence;
    this.timeoutMs = opts.timeoutMs ?? config.entityExtractionTimeoutMs;
  }

  async available(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) return false;
      const data = await response.json() as { models?: Array<{ name?: string }> };
      const models = data?.models ?? [];
      // Check if the configured model is listed (name may include tag suffix)
      return models.some((m) => {
        const name = m?.name ?? "";
        return name === this.model || name.startsWith(`${this.model}:`);
      });
    } catch {
      return false;
    }
  }

  async extract(
    content: string,
    contentType: "handoff" | "note" | "task",
    contentId: string
  ): Promise<ExtractionResult> {
    const start = Date.now();

    const prompt = EXTRACTION_PROMPT.replace("{content}", content.slice(0, 16000));

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "user", content: prompt }],
        temperature: this.temperature,
        max_tokens: this.maxTokens,
        stream: false,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "(unreadable)");
      throw new Error(`Ollama error (${response.status}): ${errText}`);
    }

    const data = await response.json() as OllamaChatResponse;
    const rawText = data?.message?.content ?? "";

    const triples = parseTriples(rawText, this.minConfidence);

    return {
      triples,
      provider: PROVIDER_NAME,
      providerVersion: PROVIDER_VERSION,
      contentType,
      contentId,
      durationMs: Date.now() - start,
    };
  }
}

/** Construct an OllamaProvider from the active application config. */
export function createOllamaProviderFromConfig(): OllamaProvider {
  return new OllamaProvider({
    baseUrl: config.ollamaBaseUrl,
    model: config.ollamaExtractionModel,
    minConfidence: config.entityMinConfidence,
    timeoutMs: config.entityExtractionTimeoutMs,
  });
}
