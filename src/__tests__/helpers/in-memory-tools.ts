import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { config } from "../../config.js";
import { createMcpServer } from "../../mcp-server.js";

export interface ToolsListOptions {
  /** config.legacyToolNames for the registration (read at registration time). */
  legacyToolNames: boolean;
  /** process.env.ENTITY_TOOLS for the registration; undefined deletes it. */
  entityTools: string | undefined;
}

/**
 * Build the real MCP server with createMcpServer(), connect an SDK client over
 * an in-memory transport and return what tools/list returns. No Postgres, no
 * network, no spawned process. config.legacyToolNames and ENTITY_TOOLS are
 * set for the call and restored afterwards.
 */
export async function listToolsInMemory(opts: ToolsListOptions): Promise<Tool[]> {
  // config is a plain mutable object; if it is ever Object.freeze()d, this
  // assignment throws (ESM modules are strict) and the helper needs another way in.
  const mutableConfig = config as { legacyToolNames: boolean };
  const savedLegacy = mutableConfig.legacyToolNames;
  const savedEntityTools = process.env.ENTITY_TOOLS;
  mutableConfig.legacyToolNames = opts.legacyToolNames;
  if (opts.entityTools === undefined) delete process.env.ENTITY_TOOLS;
  else process.env.ENTITY_TOOLS = opts.entityTools;

  const server = createMcpServer();
  const client = new Client({ name: "in-memory-test", version: "0.0.0" });
  try {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    return tools;
  } finally {
    await client.close();
    await server.close();
    mutableConfig.legacyToolNames = savedLegacy;
    if (savedEntityTools === undefined) delete process.env.ENTITY_TOOLS;
    else process.env.ENTITY_TOOLS = savedEntityTools;
  }
}
