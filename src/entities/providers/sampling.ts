/**
 * MCP Sampling provider for entity extraction.
 *
 * Uses the MCP sampling/createMessage primitive to request entity extraction
 * from the connected client's LLM. Extraction quality scales with whatever
 * model the user's client is running — Context Library does not manage API
 * keys or model selection for this provider.
 *
 * CONSTRAINT: This provider can only be used during tool execution within an
 * active MCP request. The sampling/createMessage RPC requires a live client
 * connection established by the current request. It is not suitable for
 * background jobs, startup-time extraction, or any context where no MCP
 * session is active. Always check available() before calling extract().
 */

import { buildExtractionPrompt, parseTriples } from "../prompts.js";
import type { EntityExtractor, ExtractionResult } from "../types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { config } from "../../config.js";

const PROVIDER_NAME = "mcp-sampling";
const PROVIDER_VERSION = "1.0.0";

export interface SamplingProviderOptions {
  minConfidence?: number;
  maxTokens?: number;
}

export class SamplingProvider implements EntityExtractor {
  readonly provider = PROVIDER_NAME;
  readonly version = PROVIDER_VERSION;

  private readonly server: Server;
  private readonly minConfidence: number;
  private readonly maxTokens: number;

  constructor(server: Server, opts: SamplingProviderOptions = {}) {
    this.server = server;
    this.minConfidence = opts.minConfidence ?? config.entityMinConfidence;
    this.maxTokens = opts.maxTokens ?? 2048;
  }

  async available(): Promise<boolean> {
    const caps = this.server.getClientCapabilities();
    return caps?.sampling != null;
  }

  async extract(
    content: string,
    contentType: "handoff" | "note" | "task",
    contentId: string
  ): Promise<ExtractionResult> {
    const start = Date.now();
    const prompt = buildExtractionPrompt(content);

    const result = await this.server.createMessage({
      messages: [{ role: "user", content: { type: "text", text: prompt } }],
      maxTokens: this.maxTokens,
    });

    const rawText = result.content.type === "text" ? result.content.text : "";
    // Report the client's chosen model as the provider version for traceability
    const modelName = result.model ?? "unknown";

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
