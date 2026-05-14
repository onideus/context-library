import { config } from "../../config.js";
import { buildExtractionPrompt, parseTriples } from "../prompts.js";
import type { EntityExtractor, ExtractionResult } from "../types.js";

const PROVIDER_NAME = "ollama";
const PROVIDER_VERSION = "1.0.0";
const AVAILABLE_TIMEOUT_MS = 3000;

interface OllamaOptions {
  baseUrl: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  minConfidence?: number;
  timeoutMs?: number;
}

interface OllamaChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
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
        signal: AbortSignal.timeout(AVAILABLE_TIMEOUT_MS),
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

    const prompt = buildExtractionPrompt(content);

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
    const rawText = data?.choices?.[0]?.message?.content ?? "";

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
