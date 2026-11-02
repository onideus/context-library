import { describe, it, expect } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { TOOL_ALIASES } from "../tools/tool-aliases.js";
import { connectInMemory, listToolsInMemory } from "./helpers/in-memory-tools.js";

/**
 * tools/list payload budget and description contract.
 *
 * Every MCP client loads the full tools/list response before the first
 * message, so its size is a cost paid on every conversation. This measures
 * the real response (createMcpServer() over an in-memory transport, entity
 * tools on, the largest configuration) and fails if it grows.
 *
 * The whole-payload and description-sum thresholds are a RATCHET: each is the
 * measured size + 200, rounded up to the next 500, at the time it was last
 * set. When descriptions shrink, lower them the same way. Raising one needs a
 * stated reason in the PR. The per-description, per-parameter and
 * instructions caps are fixed limits, not ratchets.
 *
 * Everything runs in memory (no Postgres), so the exact-string assertions
 * below also guard wording that Postgres-gated suites check in CI.
 */

/** JSON.stringify({ tools }).length with LEGACY_TOOL_NAMES=false. */
const MAX_TOOLS_LIST_CHARS_LEGACY_OFF = 48_000;
/** JSON.stringify({ tools }).length with the deprecated aliases registered. */
const MAX_TOOLS_LIST_CHARS_LEGACY_ON = 58_500;
/** Sum of description lengths over non-alias tools, legacy off. */
const MAX_DESCRIPTION_SUM = 18_000;
/** Longest single non-alias tool description, legacy off (fixed cap). */
const MAX_SINGLE_DESCRIPTION = 1_400;
/** Longest top-level parameter (or edits[] item) description (fixed cap). */
const MAX_PARAMETER_DESCRIPTION = 160;
/** Server instructions length cap (fixed; clients that show them add it on top of tools/list). */
const MAX_INSTRUCTIONS_CHARS = 6_000;

/** The tools that keep all three steering labels; no other tool carries them. */
const STEERED_TOOLS = [
  "get_latest_handoff",
  "get_note_history",
  "search_artifacts",
  "search_context",
  "search_notes",
  "search_tasks",
];

/** A token in the instructions that looks like a tool name. */
const TOOL_NAME_TOKEN =
  /\b(create|get|list|search|update|edit|append|delete|supersede|prune|extract|compare)_[a-z_]+\b/g;

type JsonSchemaProperty = {
  description?: string;
  items?: { properties?: Record<string, JsonSchemaProperty> };
};

function payloadChars(tools: Tool[]): number {
  return JSON.stringify({ tools }).length;
}

/** Non-alias tools with LEGACY_TOOL_NAMES=false, entity tools on. */
async function currentTools(): Promise<Tool[]> {
  const tools = await listToolsInMemory({ legacyToolNames: false, entityTools: "true" });
  return tools.filter((t) => !(t.name in TOOL_ALIASES));
}

/** Every top-level property, plus the item properties of an `edits` array. */
function describedProperties(tool: Tool): Array<{ path: string; description: string | undefined }> {
  const props = (tool.inputSchema.properties ?? {}) as Record<string, JsonSchemaProperty>;
  const out: Array<{ path: string; description: string | undefined }> = [];
  for (const [name, prop] of Object.entries(props)) {
    out.push({ path: `${tool.name}.${name}`, description: prop.description });
    if (name === "edits") {
      for (const [item, itemProp] of Object.entries(prop.items?.properties ?? {})) {
        out.push({ path: `${tool.name}.edits[].${item}`, description: itemProp.description });
      }
    }
  }
  return out;
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
    const tools = await currentTools();
    const lengths = tools.map((t) => ({ name: t.name, length: (t.description ?? "").length }));
    const sum = lengths.reduce((total, t) => total + t.length, 0);
    expect(sum).toBeLessThanOrEqual(MAX_DESCRIPTION_SUM);
    const longest = lengths.reduce((a, b) => (b.length > a.length ? b : a));
    expect(longest.length, `longest description: ${longest.name}`).toBeLessThanOrEqual(
      MAX_SINGLE_DESCRIPTION
    );
  });

  it(`keeps every parameter description within ${MAX_PARAMETER_DESCRIPTION} chars`, async () => {
    for (const tool of await currentTools()) {
      for (const { path, description } of describedProperties(tool)) {
        expect((description ?? "").length, path).toBeLessThanOrEqual(MAX_PARAMETER_DESCRIPTION);
      }
    }
  });
});

describe("tool description contract", () => {
  it("every tool has a description and every parameter is described", async () => {
    for (const tool of await currentTools()) {
      expect(tool.description?.trim().length ?? 0, tool.name).toBeGreaterThan(0);
      for (const { path, description } of describedProperties(tool)) {
        expect(description?.trim().length ?? 0, path).toBeGreaterThan(0);
      }
    }
  });

  it("search and retrieval tools keep the three steering labels; no other tool does", async () => {
    const tools = await currentTools();
    for (const tool of tools) {
      const text = tool.description ?? "";
      if (STEERED_TOOLS.includes(tool.name)) {
        expect(text, tool.name).toContain("CALL THIS WHEN:");
        expect(text, tool.name).toContain("DO NOT CALL WHEN:");
        expect(text, tool.name).toContain("CONSEQUENCE OF SKIPPING:");
      } else {
        expect(text.includes("CALL THIS WHEN"), tool.name).toBe(false);
      }
    }
  });

  // Ungated copies of the wording checks in search-lifecycle.test.ts,
  // note-lifecycle.test.ts, server.test.ts and tool-aliases.test.ts.
  it("keeps the exact phrases the lifecycle and server tests require", async () => {
    const tools = await currentTools();
    const byName = (name: string): Tool => {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      return tool!;
    };
    const desc = (name: string) => byName(name).description ?? "";

    for (const name of ["search_notes", "search_context"]) {
      const props = byName(name).inputSchema.properties as Record<string, { type?: string }>;
      expect(props.include_superseded.type, name).toBe("boolean");
      expect(props.include_expired.type, name).toBe("boolean");
      const text = desc(name);
      for (const phrase of [
        "CALL THIS WHEN",
        "DO NOT CALL",
        "CONSEQUENCE OF SKIPPING",
        "Lifecycle",
        "lifecycle_notices",
        "matched_via",
        "redirected",
      ]) {
        expect(text, `${name}: ${phrase}`).toContain(phrase);
      }
      expect(text, name).toMatch(/which expired|chain ends in an expired note/);
    }

    expect(desc("search_context")).toContain("note_status");
    expect(desc("search_context")).toContain("successor shown by a redirect");
    expect(desc("search_context")).toContain("pass include_superseded: true when asking about historical state");
    expect(desc("search_context")).toMatch(/after/i);
    expect(desc("search_context")).toMatch(/before/i);
    expect(desc("search_notes")).toContain("scope and domain filters apply to the successor too");

    expect(desc("supersede_note")).toContain("redirect");
    expect(desc("supersede_note")).toContain("lifecycle_notices");
    expect(desc("supersede_note")).not.toMatch(/does not (yet )?redirect/i);

    expect(desc("create_handoff")).not.toMatch(/[Oo]verwrites?/);
    // mergeHandoff is a one-level merge; the description must not promise more.
    expect(desc("update_handoff")).not.toMatch(/deep[- ]?merge/i);

    for (const tool of tools) {
      expect(tool.description ?? "", tool.name).not.toMatch(/SCOPE AWARENESS/);
    }
  });

  it("names no deprecated tool and no bare reindex", async () => {
    const oldNames = Object.keys(TOOL_ALIASES);
    const oldNamePattern = new RegExp(
      `\\b(${[...oldNames.filter((n) => n !== "str_replace_note"), "reindex"].join("|")})\\b`
    );
    for (const tool of await currentTools()) {
      // entity_relations is also a table name; `npm run reindex` is the operator script.
      const text = (tool.description ?? "")
        .replace(/entity_relations table/g, "")
        .replace(/npm run reindex/g, "");
      expect(text.match(oldNamePattern)?.[0], tool.name).toBeUndefined();
      if (tool.name !== "get_note_history") {
        expect((tool.description ?? "").includes("str_replace_note"), tool.name).toBe(false);
      }
    }
  });
});

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
