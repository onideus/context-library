import { config } from "../config.js";

/**
 * Generate embeddings via local TEI server.
 * TEI exposes an OpenAI-compatible /v1/embeddings endpoint.
 * Falls back gracefully if embedding server is unavailable.
 */

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
  return data.data
    .sort((a: any, b: any) => a.index - b.index)
    .map((d: any) => d.embedding);
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
