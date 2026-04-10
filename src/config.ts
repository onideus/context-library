import "dotenv/config";

export const config = {
  serverName: process.env.SERVER_NAME ?? "context-library",
  port: parseInt(process.env.MCP_PORT ?? "3100", 10),
  dataDir: process.env.DATA_DIR ?? "./data",
  retentionCount: parseInt(process.env.RETENTION_COUNT ?? "5000", 10),
  embeddingUrl: process.env.EMBEDDING_URL ?? "http://embeddings:80",
  embeddingModel: process.env.EMBEDDING_MODEL ?? "nomic-ai/nomic-embed-text-v2-moe",
  embeddingDimensions: parseInt(process.env.EMBEDDING_DIMENSIONS ?? "768", 10),
} as const;
