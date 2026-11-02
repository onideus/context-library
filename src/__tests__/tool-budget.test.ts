import { describe, it, expect } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { TOOL_ALIASES } from "../tools/tool-aliases.js";
import { connectInMemory, listToolsInMemory } from "./helpers/in-memory-tools.js";

/**
 * tools/list payload budget.
 *
 * Every MCP client loads the full tools/list response before the first
 * message, so its size is a cost paid on every conversation. This measures
 * the real response (createMcpServer() over an in-memory transport, entity
 * tools on, the largest configuration) and fails if it grows.
 *
 * The thresholds are a RATCHET: each is the measured size, rounded up to the
 * next 1,000, at the time it was last set. When descriptions shrink, lower
 * them to the new measurement rounded up the same way. Raising one needs a
 * stated reason in the PR.
 */

/** JSON.stringify({ tools }).length with LEGACY_TOOL_NAMES=false. */
const MAX_TOOLS_LIST_CHARS_LEGACY_OFF = 93_000;
/** JSON.stringify({ tools }).length with the deprecated aliases registered. */
const MAX_TOOLS_LIST_CHARS_LEGACY_ON = 104_000;
/** Sum of description lengths over non-alias tools, legacy off. */
const MAX_DESCRIPTION_SUM = 61_000;
/** Longest single non-alias tool description, legacy off. */
const MAX_SINGLE_DESCRIPTION = 6_000;

function payloadChars(tools: Tool[]): number {
  return JSON.stringify({ tools }).length;
}

describe("tools/list payload budget", () => {
  it(`stays within ${MAX_TOOLS_LIST_CHARS_LEGACY_OFF} chars with legacy names off`, async () => {
    const tools = await listToolsInMemory({ legacyToolNames: false, entityTools: "true" });
    expect(tools.some((t) => t.name in TOOL_ALIASES)).toBe(false);
    expect(payloadChars(tools)).toBeLessThanOrEqual(MAX_TOOLS_LIST_CHARS_LEGACY_OFF);
  });

  it(`stays within ${MAX_TOOLS_LIST_CHARS_LEGACY_ON} chars with legacy names on`, async () => {
    const tools = await listToolsInMemory({ legacyToolNames: true, entityTools: "true" });
    expect(tools.some((t) => t.name in TOOL_ALIASES)).toBe(true);
    expect(payloadChars(tools)).toBeLessThanOrEqual(MAX_TOOLS_LIST_CHARS_LEGACY_ON);
  });

  it("keeps tool descriptions within their total and per-tool budgets", async () => {
    const tools = await listToolsInMemory({ legacyToolNames: false, entityTools: "true" });
    const lengths = tools
      .filter((t) => !(t.name in TOOL_ALIASES))
      .map((t) => ({ name: t.name, length: (t.description ?? "").length }));
    const sum = lengths.reduce((total, t) => total + t.length, 0);
    expect(sum).toBeLessThanOrEqual(MAX_DESCRIPTION_SUM);
    const longest = lengths.reduce((a, b) => (b.length > a.length ? b : a));
    expect(longest.length, `longest description: ${longest.name}`).toBeLessThanOrEqual(
      MAX_SINGLE_DESCRIPTION
    );
  });
});

/** Server instructions length cap (fixed; clients that show them add it on top of tools/list). */
const MAX_INSTRUCTIONS_CHARS = 6_000;

/** A token in the instructions that looks like a tool name. */
const TOOL_NAME_TOKEN =
  /\b(create|get|list|search|update|edit|append|delete|supersede|prune|extract|compare)_[a-z_]+\b/g;

describe("server instructions", () => {
  it(`are non-empty and within ${MAX_INSTRUCTIONS_CHARS} chars`, async () => {
    const { instructions } = await connectInMemory({ legacyToolNames: false, entityTools: "true" });
    expect(instructions?.trim().length ?? 0).toBeGreaterThan(0);
    expect(instructions!.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS_CHARS);
  });

  it("name only tools that are always registered, never a deprecated alias", async () => {
    const { tools, instructions } = await connectInMemory({ legacyToolNames: true, entityTools: "false" });
    const registered = new Set(tools.map((t) => t.name));
    const named = [...(instructions ?? "").matchAll(TOOL_NAME_TOKEN)].map((m) => m[0]);
    expect(named.length).toBeGreaterThan(0);
    for (const name of named) {
      expect(name in TOOL_ALIASES, name).toBe(false);
      expect(registered.has(name), name).toBe(true);
    }
    for (const oldName of Object.keys(TOOL_ALIASES)) {
      expect(instructions!.includes(oldName), oldName).toBe(false);
    }
  });
});
