import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "./config.js";
import { registerHandoffTools } from "./tools/handoff.js";
import { registerHandoffNavTools } from "./tools/handoff-nav.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerNoteTools } from "./tools/notes.js";
import { registerArtifactTools } from "./tools/artifacts.js";
import { registerSearchTools } from "./tools/search.js";
import { registerPrompts } from "./tools/prompts.js";
import { registerEntityTools } from "./tools/entity-tools.js";
import { readFileSync } from "node:fs";

// The MCP server factory, kept free of import-time side effects (no listening
// socket, no migrations, no provider registration, no database connection) so
// tests can build the real server in memory. server.ts owns startup.

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
export const version = getVersion();

// Factory for stateless MCP server instances (one per request, per SDK pattern)
export function createMcpServer(): McpServer {
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
