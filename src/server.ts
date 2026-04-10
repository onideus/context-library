import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { config } from "./config.js";
import { registerHandoffTools } from "./tools/handoff.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerSearchTools } from "./tools/search.js";
import { ensureDataDir } from "./storage/json-store.js";
import { runMigrations } from "./db/migrate.js";
import { pool } from "./db/client.js";
import { stat } from "node:fs/promises";

const app = new Hono();

// CORS for browser-based MCP clients
app.use(
  "/*",
  cors({
    origin: ["https://claude.ai", "https://claude.com"],
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "mcp-session-id"],
    exposeHeaders: ["WWW-Authenticate", "mcp-session-id"],
  })
);

// ── Request logger ────────────────────────────────────
app.use("/*", async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  console.log(`[${new Date().toISOString()}] [req] ${c.req.method} ${c.req.path} ${c.res.status} ${ms}ms`);
});

// Health check
app.get("/health", (c) =>
  c.json({
    status: "ok",
    version: "0.5.0",
    uptime: Math.floor(process.uptime()),
  })
);

// Health readiness check
app.get("/health/ready", async (c) => {
  let archiveWritable = false;
  try {
    await stat(config.dataDir);
    archiveWritable = true;
  } catch {
    archiveWritable = false;
  }
  return c.json({
    status: archiveWritable ? "ok" : "degraded",
    archive: archiveWritable,
    uptime: Math.floor(process.uptime()),
  });
});

// ── MCP transport route (authenticated) ─────────────────
// Factory for stateless MCP server instances (one per request, per SDK pattern)
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: config.serverName,
    version: "0.5.0",
  });
  registerHandoffTools(server);
  registerTaskTools(server);
  registerSearchTools(server);
  return server;
}

app.post("/mcp", async (c) => {
  const server = createMcpServer();
  try {
    const transport = new StreamableHTTPTransport();
    await server.connect(transport);
    const response = await transport.handleRequest(c);
    if (response) {
      return response;
    }
    console.error(`[${new Date().toISOString()}] [mcp] transport.handleRequest returned undefined`);
    server.close();
    return c.json({ jsonrpc: "2.0", error: { code: -32603, message: "No response" }, id: null }, 500);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [mcp] Handler error:`, err);
    server.close();
    return c.json(
      { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null },
      500
    );
  }
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

  serve(
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

// Graceful shutdown — drain pg pool on container stop
async function shutdown(signal: string) {
  console.log(`[shutdown] ${signal} received, draining...`);
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
