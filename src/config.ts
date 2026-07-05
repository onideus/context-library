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
  // Graph-augmented retrieval — third RRF signal in search_context.
  // Disabled by default; enable once an extraction run has populated entity_nodes/entity_relations.
  entityGraphEnabled: process.env.ENTITY_GRAPH_ENABLED === "true",
  entityGraphHops: (function () {
    const v = parseInt(process.env.ENTITY_GRAPH_HOPS ?? "1", 10);
    if (!Number.isFinite(v)) return 1;
    return Math.min(Math.max(1, v), 3);
  })(),
  entityGraphRrfWeight: (function () {
    const v = parseFloat(process.env.ENTITY_GRAPH_RRF_WEIGHT ?? "0.3");
    if (!Number.isFinite(v)) return 0.3;
    return Math.min(Math.max(0, v), 1);
  })(),
  entityGraphFtsWeight: (function () {
    const v = parseFloat(process.env.ENTITY_GRAPH_FTS_WEIGHT ?? "1.0");
    if (!Number.isFinite(v)) return 1.0;
    return Math.min(Math.max(0, v), 1);
  })(),
  entityGraphVectorWeight: (function () {
    const v = parseFloat(process.env.ENTITY_GRAPH_VECTOR_WEIGHT ?? "1.0");
    if (!Number.isFinite(v)) return 1.0;
    return Math.min(Math.max(0, v), 1);
  })(),
  entityGraphMaxCandidates: (function () {
    const v = parseInt(process.env.ENTITY_GRAPH_MAX_CANDIDATES ?? "50", 10);
    return Number.isFinite(v) && v > 0 ? v : 50;
  })(),
  // Sync bearer token for the reference authenticator. The repo commits the
  // auth *boundary* (pluggable interface + static-token impl); deployments
  // choose their own value via env. If unset, the /sync/* routes reject all
  // requests — deployments must opt in to enable them.
  syncBearerToken: process.env.SYNC_BEARER_TOKEN ?? null,
  syncChangesMaxLimit: (function () {
    const v = parseInt(process.env.SYNC_CHANGES_MAX_LIMIT ?? "500", 10);
    return Number.isFinite(v) && v > 0 ? v : 500;
  })(),
  syncChangesDefaultLimit: (function () {
    const v = parseInt(process.env.SYNC_CHANGES_DEFAULT_LIMIT ?? "100", 10);
    return Number.isFinite(v) && v > 0 ? v : 100;
  })(),
} as const;
