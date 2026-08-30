import "dotenv/config";

const defaultCorsOrigins = ["https://claude.ai", "https://claude.com"];

/** Handoff compaction strategy. See `compactionMode` on the config object. */
export type CompactionMode = "archive" | "in-place" | "off";

export const config = {
  serverName: process.env.SERVER_NAME ?? "context-library",
  port: parseInt(process.env.MCP_PORT ?? "3100", 10),
  dataDir: process.env.DATA_DIR ?? "./data",
  retentionCount: parseInt(process.env.RETENTION_COUNT ?? "0", 10),
  // How store_handoff treats the handoff it supersedes.
  //   archive  (default) — copy the original byte-exact to handoffs/archive/
  //                        before rewriting it in place. Lossless on disk.
  //   off                — never rewrite. The archival-deployment setting:
  //                        every handoff stays full-fidelity forever.
  //   in-place           — legacy: rewrite with no copy. LOSSY — active_context
  //                        collapses to a one-line summary and the original
  //                        text survives only in the embeddings index.
  // Unrecognised values fall back to `archive` — the safe direction, so a typo
  // can never silently select the destructive path.
  compactionMode: (function () {
    const raw = (process.env.COMPACTION_MODE ?? "").trim().toLowerCase();
    if (raw === "" || raw === "archive") return "archive";
    if (raw === "off" || raw === "in-place") return raw;
    console.warn(
      `[config] Unrecognised COMPACTION_MODE "${raw}" — falling back to "archive". ` +
        `Valid values: archive | in-place | off.`
    );
    return "archive";
  })() as CompactionMode,
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
  // Whole-request ceiling on /sync/push. Each op's `payload` and
  // `precondition` are z.unknown()/z.record(z.unknown()) so field-level Zod
  // caps don't help; we cap the wire body instead to keep a
  // bearer-authenticated client from posting a 200-op batch of multi-MB
  // artifact content.
  syncPushMaxBytes: (function () {
    const v = parseInt(process.env.SYNC_PUSH_MAX_BYTES ?? "5242880", 10); // 5 MiB
    return Number.isFinite(v) && v > 0 ? v : 5242880;
  })(),
  // Per-op cap. Guards against one 5MB blob smuggled into a small batch —
  // large artifact `content` should be handled via a separate upload flow,
  // not stuffed into a sync op. Chosen so 200 max-sized ops still fit under
  // syncPushMaxBytes with headroom.
  syncPushMaxOpBytes: (function () {
    const v = parseInt(process.env.SYNC_PUSH_MAX_OP_BYTES ?? "131072", 10); // 128 KiB
    return Number.isFinite(v) && v > 0 ? v : 131072;
  })(),
} as const;
