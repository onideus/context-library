import { config } from "../../config.js";
import { buildExtractionPrompt, parseTriples } from "../prompts.js";
import type { EntityExtractor, ExtractionResult } from "../types.js";

const PROVIDER_NAME = "api";
const PROVIDER_VERSION = "1.0.0";

export interface ApiProviderOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens?: number;
  /** 'anthropic' uses /v1/messages with x-api-key header. 'openai' uses /v1/chat/completions with Bearer token. */
  apiFormat?: "anthropic" | "openai";
  minConfidence?: number;
  timeoutMs?: number;
}

interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string }>;
  model?: string;
}

interface OpenAIResponse {
  choices?: Array<{ message?: { content?: string } }>;
  model?: string;
}

export class ApiProvider implements EntityExtractor {
  readonly provider = PROVIDER_NAME;
  readonly version = PROVIDER_VERSION;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly apiFormat: "anthropic" | "openai";
  private readonly minConfidence: number;
  private readonly timeoutMs: number;

  constructor(opts: ApiProviderOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.model = opts.model;
    this.maxTokens = opts.maxTokens ?? 2048;
    this.apiFormat = opts.apiFormat ?? "anthropic";
    this.minConfidence = opts.minConfidence ?? config.entityMinConfidence;
    this.timeoutMs = opts.timeoutMs ?? config.entityExtractionTimeoutMs;
  }

  async available(): Promise<boolean> {
    return Boolean(this.apiKey);
  }

  async extract(
    content: string,
    contentType: "handoff" | "note" | "task",
    contentId: string
  ): Promise<ExtractionResult> {
    const start = Date.now();
    const prompt = buildExtractionPrompt(content);

    let rawText: string;
    let modelName: string;

    if (this.apiFormat === "anthropic") {
      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: this.maxTokens,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => "(unreadable)");
        throw new Error(`API error (${response.status}): ${errText}`);
      }

      const data = await response.json() as AnthropicResponse;
      rawText = data?.content?.find((b) => b.type === "text")?.text ?? "";
      modelName = data?.model ?? this.model;
    } else {
      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: this.maxTokens,
          messages: [{ role: "user", content: prompt }],
          stream: false,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => "(unreadable)");
        throw new Error(`API error (${response.status}): ${errText}`);
      }

      const data = await response.json() as OpenAIResponse;
      rawText = data?.choices?.[0]?.message?.content ?? "";
      modelName = data?.model ?? this.model;
    }

    const triples = parseTriples(rawText, this.minConfidence);

    return {
      triples,
      provider: PROVIDER_NAME,
      providerVersion: modelName,
      contentType,
      contentId,
      durationMs: Date.now() - start,
    };
  }
}

/** Construct an ApiProvider from the active application config. Returns null if no API key configured. */
export function createApiProviderFromConfig(): ApiProvider | null {
  if (!config.entityApiKey) return null;
  return new ApiProvider({
    apiKey: config.entityApiKey,
    baseUrl: config.entityApiBaseUrl,
    model: config.entityApiModel,
    apiFormat: config.entityApiFormat,
    minConfidence: config.entityMinConfidence,
    timeoutMs: config.entityExtractionTimeoutMs,
  });
}
