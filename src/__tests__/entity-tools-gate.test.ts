import { describe, it, expect, vi } from "vitest";
import { resolveEntityToolsEnabled } from "../config.js";
import { TOOL_ALIASES } from "../tools/tool-aliases.js";
import { listToolsInMemory } from "./helpers/in-memory-tools.js";

/**
 * ENTITY_TOOLS: the pure resolver, and what createMcpServer() lists under it.
 * The factory cases build the real server in memory (no Postgres, no spawned
 * process) and set ENTITY_TOOLS explicitly, so a local .env cannot change them.
 */

const ENTITY_TOOL_NAMES = [
  "extract_entities",
  "list_entities",
  "get_entity_relations",
  "create_extraction_run",
  "compare_extraction_runs",
  "list_extraction_runs",
];
const ENTITY_ALIASES = Object.entries(TOOL_ALIASES)
  .filter(([, target]) => ENTITY_TOOL_NAMES.includes(target))
  .map(([old]) => old);

type EntityEnv = Parameters<typeof resolveEntityToolsEnabled>[1];
const OFF: EntityEnv = { extractionEnabled: false, graphEnabled: false, provider: undefined };

function resolve(raw: string | undefined, env: Partial<EntityEnv> = {}) {
  const warn = vi.fn();
  const enabled = resolveEntityToolsEnabled(raw, { ...OFF, ...env }, warn);
  return { enabled, warn };
}

describe("resolveEntityToolsEnabled", () => {
  it("treats undefined and empty as auto, without warning", () => {
    for (const raw of [undefined, ""]) {
      const { enabled, warn } = resolve(raw);
      expect(enabled).toBe(false);
      expect(warn).not.toHaveBeenCalled();
      expect(resolve(raw, { graphEnabled: true }).enabled).toBe(true);
    }
  });

  it("auto is off when no entity feature or provider is configured", () => {
    const { enabled, warn } = resolve("auto");
    expect(enabled).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("auto is on when extraction is enabled", () => {
    expect(resolve("auto", { extractionEnabled: true }).enabled).toBe(true);
  });

  it("auto is on when graph retrieval is enabled", () => {
    expect(resolve("auto", { graphEnabled: true }).enabled).toBe(true);
  });

  it("auto is on when a provider other than none is configured", () => {
    expect(resolve("auto", { provider: "ollama" }).enabled).toBe(true);
    expect(resolve("auto", { provider: " API " }).enabled).toBe(true);
  });

  it('auto counts an empty, "None" or undefined provider as none', () => {
    for (const provider of ["", "None", " none ", undefined]) {
      expect(resolve("auto", { provider }).enabled).toBe(false);
    }
  });

  it("true is on and false is off regardless of the entity settings", () => {
    expect(resolve("true").enabled).toBe(true);
    const all = { extractionEnabled: true, graphEnabled: true, provider: "ollama" };
    expect(resolve("false", all).enabled).toBe(false);
  });

  it("ignores case and surrounding whitespace", () => {
    expect(resolve(" TRUE ").enabled).toBe(true);
    expect(resolve("False", { graphEnabled: true }).enabled).toBe(false);
    expect(resolve(" Auto ", { extractionEnabled: true }).enabled).toBe(true);
    for (const raw of [" TRUE ", "False", " Auto "]) expect(resolve(raw).warn).not.toHaveBeenCalled();
  });

  it("warns about an invalid value, naming the valid ones, and behaves as auto", () => {
    const off = resolve("yes");
    expect(off.enabled).toBe(false);
    expect(off.warn).toHaveBeenCalledTimes(1);
    expect(off.warn.mock.calls[0][0]).toMatch(/auto \| true \| false/);
    // The message quotes the value as set, not the trimmed, lower-cased one.
    expect(resolve(" Yes").warn.mock.calls[0][0]).toContain('ENTITY_TOOLS " Yes"');

    const on = resolve("yes", { provider: "ollama" });
    expect(on.enabled).toBe(true);
    expect(on.warn).toHaveBeenCalledTimes(1);
  });

  it("warns on every call (the resolver keeps no state)", () => {
    const warn = vi.fn();
    resolveEntityToolsEnabled("1", OFF, warn);
    resolveEntityToolsEnabled("1", OFF, warn);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("createMcpServer under ENTITY_TOOLS", () => {
  it("lists none of the entity tools or their aliases with ENTITY_TOOLS=false", async () => {
    for (const legacyToolNames of [true, false]) {
      const names = (await listToolsInMemory({ legacyToolNames, entityTools: "false" })).map((t) => t.name);
      for (const name of [...ENTITY_TOOL_NAMES, ...ENTITY_ALIASES]) expect(names).not.toContain(name);
      // The rest of the server is still registered.
      expect(names).toContain("search_context");
    }
  });

  it("lists all six entity tools and, with legacy names on, their four aliases with ENTITY_TOOLS=true", async () => {
    expect([...ENTITY_ALIASES].sort()).toEqual(
      ["browse_entities", "compare_extractions", "entity_relations", "run_extraction"]
    );

    const on = (await listToolsInMemory({ legacyToolNames: true, entityTools: "true" })).map((t) => t.name);
    for (const name of [...ENTITY_TOOL_NAMES, ...ENTITY_ALIASES]) expect(on).toContain(name);

    const off = (await listToolsInMemory({ legacyToolNames: false, entityTools: "true" })).map((t) => t.name);
    for (const name of ENTITY_TOOL_NAMES) expect(off).toContain(name);
    for (const name of ENTITY_ALIASES) expect(off).not.toContain(name);
  });

  it("restores ENTITY_TOOLS after listing", async () => {
    const saved = process.env.ENTITY_TOOLS;
    process.env.ENTITY_TOOLS = "auto";
    try {
      await listToolsInMemory({ legacyToolNames: false, entityTools: "true" });
      expect(process.env.ENTITY_TOOLS).toBe("auto");
    } finally {
      if (saved === undefined) delete process.env.ENTITY_TOOLS;
      else process.env.ENTITY_TOOLS = saved;
    }
  });
});
