import { config } from "../config.js";

interface EmbeddingResponseItem {
  index: number;
  embedding: number[];
}

/**
 * Generate embeddings via local TEI server.
 * TEI exposes an OpenAI-compatible /v1/embeddings endpoint.
 * Falls back gracefully if embedding server is unavailable.
 */

let lastEmbeddingSuccess: string | null = null;

/** Record that an embedding operation just succeeded. Called from generate* on success. */
export function recordEmbeddingSuccess(): void {
  lastEmbeddingSuccess = new Date().toISOString();
}

/** Returns the ISO timestamp of the most recent successful embedding operation, or null. */
export function getLastEmbeddingSuccess(): string | null {
  return lastEmbeddingSuccess;
}

export async function generateEmbedding(text: string): Promise<number[]> {
  if (!config.embeddingUrl) {
    throw new Error("EMBEDDING_URL not configured — semantic search unavailable");
  }

  const response = await fetch(`${config.embeddingUrl}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.embeddingModel,
      input: text.slice(0, 32000),
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Embedding server error (${response.status}): ${error}`);
  }

  const data = await response.json();
  if (!data?.data?.[0]?.embedding) {
    throw new Error(`Unexpected embedding response: missing data.data[0].embedding`);
  }
  recordEmbeddingSuccess();
  return data.data[0].embedding;
}

export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (!config.embeddingUrl) {
    throw new Error("EMBEDDING_URL not configured — semantic search unavailable");
  }

  const truncated = texts.map(t => t.slice(0, 32000));

  const response = await fetch(`${config.embeddingUrl}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.embeddingModel,
      input: truncated,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Embedding server error (${response.status}): ${error}`);
  }

  const data = await response.json();
  if (!Array.isArray(data?.data) || data.data.length === 0) {
    throw new Error(`Unexpected embedding response: missing or empty data.data array`);
  }
  recordEmbeddingSuccess();
  return data.data
    .sort((a: EmbeddingResponseItem, b: EmbeddingResponseItem) => a.index - b.index)
    .map((d: EmbeddingResponseItem) => d.embedding);
}

/**
 * Check if the embedding server is available.
 * Use this for health checks and graceful degradation.
 */
export async function isEmbeddingAvailable(): Promise<boolean> {
  if (!config.embeddingUrl) return false;
  try {
    const response = await fetch(`${config.embeddingUrl}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
