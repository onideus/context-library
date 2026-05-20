import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { config } from "./config.js";
import { registerHandoffTools } from "./tools/handoff.js";
import { registerHandoffNavTools } from "./tools/handoff-nav.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerNoteTools } from "./tools/notes.js";
import { registerArtifactTools } from "./tools/artifacts.js";
import { registerSearchTools } from "./tools/search.js";
import { registerPrompts } from "./tools/prompts.js";
import { registerEntityTools } from "./tools/entity-tools.js";
import { registerProvider } from "./entities/registry.js";
import { createOllamaProviderFromConfig } from "./entities/providers/ollama.js";
import { createApiProviderFromConfig } from "./entities/providers/api.js";
import { ensureDataDir } from "./storage/json-store.js";
import { runMigrations } from "./db/migrate.js";
import { pool } from "./db/client.js";
import { isEmbeddingAvailable } from "./embeddings/client.js";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

// Read version: prefer APP_VERSION env var, fall back to package.json
function getVersion(): string {
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}
const version = getVersion();

const app = new Hono();

// CORS for browser-based MCP clients
app.use(
  "/*",
  cors({
    origin: config.corsOrigins,
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "mcp-session-id"],
    exposeHeaders: ["WWW-Authenticate", "mcp-session-id"],
  })
);

// ── Request logger ────────────────────────────────────────
app.use("/*", async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  console.log(`[${new Date().toISOString()}] [req] ${c.req.method} ${c.req.path} ${c.res.status} ${ms}ms`);
});

// Cache the embedding-availability probe so frequent /health polls (load
// balancers, NAS watchdogs) don't hammer the TEI backend on every request,
// and so a slow/degraded TEI doesn't add its full 2s timeout to every health
// check. TTL is short enough that a real outage is reflected within ~10s.
const HEALTH_EMBED_CACHE_MS = 10_000;
let cachedEmbeddingAvailable: boolean | null = null;
let cachedEmbeddingCheckedAt = 0;

async function getEmbeddingAvailableForHealth(): Promise<boolean | null> {
  const now = Date.now();
  if (now - cachedEmbeddingCheckedAt < HEALTH_EMBED_CACHE_MS) {
    return cachedEmbeddingAvailable;
  }
  try {
    cachedEmbeddingAvailable = await isEmbeddingAvailable();
  } catch {
    cachedEmbeddingAvailable = null;
  }
  cachedEmbeddingCheckedAt = now;
  return cachedEmbeddingAvailable;
}

// ── Health endpoint — intentional auth bypass ──────────────────────────────
// Authentication is enforced upstream by mcp-auth-proxy; there is no
// in-process auth middleware. This is the only route that must remain
// reachable without going through that proxy. Response is intentionally
// minimal — no user data, no system state, no infrastructure topology —
// to limit exposure on this unauthenticated surface. Do NOT add additional
// unauthenticated paths; this exception is scoped to operational monitoring.
app.get("/health", async (c) => {
  // embedding_status.available is a fast HEAD-style check (~2s cap) with
  // graceful failure — cached for HEALTH_EMBED_CACHE_MS so health polls don't
  // probe TEI on every request.
  const embeddingAvailable = await getEmbeddingAvailableForHealth();
  return c.json({
    status: "ok",
    version,
    uptime: Math.floor(process.uptime()),
    embedding_status: { available: embeddingAvailable },
  });
});

// ── MCP transport route (authenticated) ─────────────────────
// Factory for stateless MCP server instances (one per request, per SDK pattern)
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: config.serverName,
    version,
  });
  registerHandoffTools(server);
  registerHandoffNavTools(server);
  registerTaskTools(server);
  registerNoteTools(server);
  registerArtifactTools(server);
  registerSearchTools(server);
  registerEntityTools(server);
  registerPrompts(server);
  return server;
}

/**
 * Extract the SSE `data:` payload from a buffered MCP response body so we
 * can derive the JSON-RPC status (success vs. error) for structured response
 * logs. Returns null when the body is not parseable — callers fall back to
 * the "unknown" status.
 *
 * Concatenates consecutive `data:` lines per the SSE spec (multi-line
 * payloads are joined with "\n" before being parsed as JSON). Today MCP
 * single-lines its payloads, but supporting the multi-line form keeps status
 * detection working if the transport ever emits chunked SSE data.
 */
function parseSseDataPayload(text: string): Record<string, unknown> | null {
  const dataLines: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (dataLines.length === 0) return null;
  try {
    return JSON.parse(dataLines.join("\n").trim()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Inspect a parsed JSON-RPC envelope to derive a friendly tool label for
 * logs. For tools/call, returns the tool name. For other methods (tools/list,
 * initialize, etc.), returns the bare method. Null when shape is unrecognized.
 */
function deriveToolLabel(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const env = body as Record<string, unknown>;
  const method = typeof env.method === "string" ? env.method : null;
  if (method === "tools/call") {
    const params = env.params as Record<string, unknown> | undefined;
    const name = params?.name;
    return typeof name === "string" ? name : method;
  }
  return method;
}

// Truncation cap for the optional body field on response logs. Even with
// LOG_RESPONSE_BODIES=true we never want a single search hit to balloon log
// pipeline storage — large payloads are summarized.
const RESPONSE_BODY_LOG_MAX_BYTES = 4096;

app.post("/mcp", async (c) => {
  const correlationId = randomUUID();
  const start = Date.now();
  const logResponseBodies = process.env.LOG_RESPONSE_BODIES === "true";

  // Tee the request body so the logger can derive the tool label and JSON-RPC
  // id without blocking the request path. The clone itself is a cheap Request
  // wrapper — the expensive .json() buffer/parse happens inside the
  // queueMicrotask below, after the response is already on the wire.
  const requestClone = c.req.raw.clone();

  const server = createMcpServer();
  let response: Response;
  let handlerError: Error | null = null;
  try {
    const transport = new StreamableHTTPTransport();
    await server.connect(transport);
    const transportResponse = await transport.handleRequest(c);
    if (transportResponse) {
      response = transportResponse;
    } else {
      console.error(`[${new Date().toISOString()}] [mcp] transport.handleRequest returned undefined`);
      server.close();
      response = c.json(
        { jsonrpc: "2.0", error: { code: -32603, message: "No response" }, id: null },
        500
      );
    }
  } catch (err) {
    handlerError = err as Error;
    console.error(`[${new Date().toISOString()}] [mcp] Handler error:`, err);
    server.close();
    response = c.json(
      { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null },
      500
    );
  }

  // Tee the body before returning so the async logger reads the clone while
  // the framework streams the original to the client. The actual buffered
  // read happens after we hand back the response — body size/status detection
  // must not add latency to the request path (spec constraint).
  const cloned = response.clone();
  const httpStatus = response.status;
  // Snapshot server latency BEFORE queueing the microtask. Computing this
  // inside logMcpResponse (after awaiting both body reads) would inflate the
  // metric with microtask scheduling + body buffering time, especially for
  // large search_context / handoff payloads.
  const durationMs = Date.now() - start;
  queueMicrotask(() => {
    void logMcpResponse({
      requestClone,
      cloned,
      handlerError,
      logResponseBodies,
      correlationId,
      httpStatus,
      durationMs,
    });
  });

  return response;
});

interface ResponseLogOptions {
  requestClone: Request;
  cloned: Response;
  handlerError: Error | null;
  logResponseBodies: boolean;
  correlationId: string;
  httpStatus: number;
  durationMs: number;
}

/**
 * Read the cloned response body and emit a structured log line. Runs after
 * the response has been handed back so it adds zero latency to the request
 * path. Reading must be fully best-effort — a stream error here cannot
 * affect what the client receives.
 */
async function logMcpResponse(opts: ResponseLogOptions): Promise<void> {
  // Outer try/catch ensures a logging bug (e.g. a synchronous throw while
  // assembling the entry) becomes a warning, not an unhandled rejection.
  try {
    // Parse the cloned request body here (off the hot path) to derive the tool
    // label and JSON-RPC id for the log entry. A malformed body just means the
    // log line lacks those fields — the transport rejected it on its own clone.
    let toolLabel: string | null = null;
    let requestId: unknown = null;
    try {
      const parsedReq = await opts.requestClone.json();
      toolLabel = deriveToolLabel(parsedReq);
      if (parsedReq && typeof parsedReq === "object") {
        requestId = (parsedReq as Record<string, unknown>).id ?? null;
      }
    } catch {
      // Malformed JSON — leave label/id null.
    }

    let resultStatus: "success" | "error" | "unknown" = opts.handlerError ? "error" : "unknown";
    let sizeBytes = 0;
    let bodyForLog: string | null = null;
    try {
      const bodyText = await opts.cloned.text();
      sizeBytes = Buffer.byteLength(bodyText, "utf-8");
      if (opts.logResponseBodies) {
        bodyForLog =
          sizeBytes > RESPONSE_BODY_LOG_MAX_BYTES
            ? bodyText.slice(0, RESPONSE_BODY_LOG_MAX_BYTES) + "...[truncated]"
            : bodyText;
      }

      const sseData = parseSseDataPayload(bodyText);
      if (sseData) {
        if (sseData.error) resultStatus = "error";
        else if (sseData.result) resultStatus = "success";
      } else {
        // Non-SSE responses (transport errors, 405s) are plain JSON.
        try {
          const parsed = JSON.parse(bodyText) as Record<string, unknown>;
          if (parsed.error) resultStatus = "error";
          else if (parsed.result) resultStatus = "success";
        } catch {
          // Best-effort — leave resultStatus as is.
        }
      }
    } catch {
      // Cloning/reading must never break logging; emit with whatever we have.
    }

    const logEntry: Record<string, unknown> = {
      level: opts.handlerError ? "error" : "info",
      type: "mcp_response",
      correlation_id: opts.correlationId,
      tool: toolLabel,
      request_id: requestId,
      status: resultStatus,
      http_status: opts.httpStatus,
      duration_ms: opts.durationMs,
      size_bytes: sizeBytes,
    };
    if (bodyForLog !== null) logEntry.body = bodyForLog;
    console.log(JSON.stringify(logEntry));
  } catch (err) {
    console.warn(`[mcp] response logger failed:`, (err as Error)?.message ?? err);
  }
}

// Stateless mode: GET and DELETE are not supported
app.get("/mcp", async (c) => {
  return c.json(
    {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    },
    405
  );
});

app.delete("/mcp", async (c) => {
  return c.json(
    {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    },
    405
  );
});

// Initialize and start
let httpServer: ReturnType<typeof serve>;

async function main() {
  await ensureDataDir();
  try {
    await runMigrations();
  } catch (err) {
    console.warn(
      "[startup] Postgres migrations skipped — database not available:",
      (err as Error).message
    );
  }

  // Register entity extraction providers based on config
  try {
    if (config.ollamaBaseUrl) {
      registerProvider(createOllamaProviderFromConfig());
      console.log("[startup] Registered entity provider: ollama");
    }
    if (config.entityApiKey) {
      const apiProvider = createApiProviderFromConfig();
      if (apiProvider) {
        registerProvider(apiProvider);
        console.log("[startup] Registered entity provider: api");
      }
    }
    // mcp-sampling registers its available() check per-request; no startup registration needed
  } catch (err) {
    console.warn("[startup] Entity provider registration skipped:", (err as Error).message);
  }

  // Seed entities from deployment-local file (graceful — skips if file or DB missing)
  try {
    const { seedEntities } = await import("./db/seed-entities.js");
    await seedEntities();
  } catch (err) {
    console.warn("[startup] Entity seeding skipped:", (err as Error).message);
  }

  // Drain any pending embeddings queued during a previous TEI outage (best-effort).
  try {
    if (await isEmbeddingAvailable()) {
      const { drainPendingEmbeddings } = await import("./embeddings/indexer.js");
      const result = await drainPendingEmbeddings();
      if (result.processed > 0 || result.errors > 0) {
        console.log(
          `[startup] Drained pending embeddings: processed=${result.processed}, remaining=${result.remaining}, errors=${result.errors}`
        );
      }
    }
  } catch (err) {
    console.warn("[startup] Pending embeddings drain skipped:", (err as Error).message);
  }

  httpServer = serve(
    {
      fetch: app.fetch,
      port: config.port,
      hostname: "0.0.0.0",
    },
    (info) => {
      console.log(
        `${config.serverName} MCP server running on http://localhost:${info.port}`
      );
    }
  );
}

// Graceful shutdown — close HTTP server and drain pg pool on container stop
async function shutdown(signal: string) {
  console.log(`[shutdown] ${signal} received, draining...`);
  httpServer?.close();
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
