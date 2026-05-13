import "dotenv/config";

const defaultCorsOrigins = ["https://claude.ai", "https://claude.com"];

export const config = {
  serverName: process.env.SERVER_NAME ?? "context-library",
  port: parseInt(process.env.MCP_PORT ?? "3100", 10),
  dataDir: process.env.DATA_DIR ?? "./data",
  retentionCount: parseInt(process.env.RETENTION_COUNT ?? "0", 10),
  corsOrigins: process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(",").map((s) => s.trim())
    : defaultCorsOrigins,
  embeddingUrl: process.env.EMBEDDING_URL ?? "http://embeddings:80",
  embeddingModel: process.env.EMBEDDING_MODEL ?? "nomic-ai/nomic-embed-text-v2-moe",
  embeddingDimensions: parseInt(process.env.EMBEDDING_DIMENSIONS ?? "768", 10),
  entitySeedPath: process.env.ENTITY_SEED_PATH ?? "./data/entities.seed.json",
  searchAliasPath: process.env.SEARCH_ALIAS_PATH ?? "./data/search-aliases.json",
  rerankerUrl: process.env.RERANKER_URL ?? null,
  entityExtractionEnabled: process.env.ENTITY_EXTRACTION_ENABLED === "true",
  entityExtractionProvider: process.env.ENTITY_EXTRACTION_PROVIDER ?? "none",
  entityExtractionAsync: process.env.ENTITY_EXTRACTION_ASYNC !== "false",
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
  ollamaExtractionModel: process.env.OLLAMA_EXTRACTION_MODEL ?? "sciphi/triplex",
  entityMinConfidence: (function () {
    const v = parseFloat(process.env.ENTITY_MIN_CONFIDENCE ?? "0.5");
    return Number.isFinite(v) ? v : 0.5;
  })(),
  entityExtractionTimeoutMs: (function () {
    const v = parseInt(process.env.ENTITY_EXTRACTION_TIMEOUT_MS ?? "30000", 10);
    return Number.isFinite(v) ? v : 30000;
  })(),
  entityApiKey: process.env.ENTITY_API_KEY ?? null,
  entityApiBaseUrl: process.env.ENTITY_API_BASE_URL ?? "https://api.anthropic.com",
  entityApiModel: process.env.ENTITY_API_MODEL ?? "claude-sonnet-4-20250514",
  entityApiFormat: (process.env.ENTITY_API_FORMAT ?? "anthropic") as "anthropic" | "openai",
} as const;
