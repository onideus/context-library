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

// ── Health endpoint — intentional auth bypass ──────────────────────────────
// Authentication is enforced upstream by mcp-auth-proxy; there is no
// in-process auth middleware. This is the only route that must remain
// reachable without going through that proxy. Response is intentionally
// minimal — no user data, no system state, no infrastructure topology —
// to limit exposure on this unauthenticated surface. Do NOT add additional
// unauthenticated paths; this exception is scoped to operational monitoring.
app.get("/health", async (c) => {
  // embedding_status.available is a fast HEAD-style check (~2s cap) with
  // graceful failure — wrap in try/catch so a TEI outage cannot break the
  // health endpoint that load balancers and watchdogs rely on.
  let embeddingAvailable: boolean | null;
  try {
    embeddingAvailable = await isEmbeddingAvailable();
  } catch {
    embeddingAvailable = null;
  }
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
 */
function parseSseDataPayload(text: string): Record<string, unknown> | null {
  const dataLine = text.split("\n").find((line) => line.startsWith("data:"));
  if (!dataLine) return null;
  try {
    return JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>;
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

app.post("/mcp", async (c) => {
  const correlationId = randomUUID();
  const start = Date.now();
  const logResponseBodies = process.env.LOG_RESPONSE_BODIES === "true";

  // Inspect the request body once for the tool label and JSON-RPC id. We
  // clone the underlying Request so the transport still sees an unread body.
  let toolLabel: string | null = null;
  let requestId: unknown = null;
  try {
    const cloned = c.req.raw.clone();
    const parsed = await cloned.json();
    toolLabel = deriveToolLabel(parsed);
    if (parsed && typeof parsed === "object") {
      requestId = (parsed as Record<string, unknown>).id ?? null;
    }
  } catch {
    // Malformed JSON — transport will reject; log entry just lacks the label.
  }

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

  // Structured response logging. Body logging is gated on
  // LOG_RESPONSE_BODIES=true because response bodies may contain
  // user-supplied content (handoff state, notes, search hits).
  let resultStatus: "success" | "error" | "unknown" = handlerError ? "error" : "unknown";
  let sizeBytes = 0;
  let bodySnippet: string | null = null;
  try {
    // Response.clone() tees the body so the caller still receives the
    // original stream. Reading the clone is safe for our buffered SSE
    // payloads — the transport does not stream chunks in stateless mode.
    const cloned = response.clone();
    const bodyText = await cloned.text();
    sizeBytes = Buffer.byteLength(bodyText, "utf-8");
    if (logResponseBodies) bodySnippet = bodyText;

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
    // Cloning/reading must never break the response we already produced.
  }

  const logEntry: Record<string, unknown> = {
    level: handlerError ? "error" : "info",
    type: "mcp_response",
    correlation_id: correlationId,
    tool: toolLabel,
    request_id: requestId,
    status: resultStatus,
    http_status: response.status,
    duration_ms: Date.now() - start,
    size_bytes: sizeBytes,
  };
  if (bodySnippet !== null) logEntry.body = bodySnippet;
  console.log(JSON.stringify(logEntry));

  return response;
});

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
