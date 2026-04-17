import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The module reads config.searchAliasPath lazily on first call, so we need
// to point the config at a temp file BEFORE importing it. Use vi.resetModules
// between tests to get a fresh cache.

describe("expandQuery (search alias expansion)", () => {
  let tmpDir: string;
  let aliasFile: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cl-aliases-"));
    aliasFile = join(tmpDir, "search-aliases.json");
    process.env.SEARCH_ALIAS_PATH = aliasFile;
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.SEARCH_ALIAS_PATH;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appends expansion when alias key appears as a whole word", async () => {
    writeFileSync(
      aliasFile,
      JSON.stringify({ PA: "Project Alpha PA" })
    );
    const { expandQuery } = await import("../tools/search-aliases.js");
    const result = expandQuery("what did I decide about PA last week");
    expect(result).toContain("Project Alpha PA");
    // Original query is preserved
    expect(result).toContain("what did I decide about PA");
  });

  it("is case-insensitive on the alias key", async () => {
    writeFileSync(aliasFile, JSON.stringify({ PA: "Project Alpha" }));
    const { expandQuery } = await import("../tools/search-aliases.js");
    expect(expandQuery("notes on pa")).toContain("Project Alpha");
  });

  it("does NOT expand when the key only appears as a substring", async () => {
    writeFileSync(aliasFile, JSON.stringify({ CB: "Context Library" }));
    const { expandQuery } = await import("../tools/search-aliases.js");
    // "CB" is a substring of "SCBRS" — must not trigger expansion.
    const result = expandQuery("SCBRS alert analysis");
    expect(result).toBe("SCBRS alert analysis");
  });

  it("passes unknown terms through unchanged", async () => {
    writeFileSync(aliasFile, JSON.stringify({ PA: "Project Alpha" }));
    const { expandQuery } = await import("../tools/search-aliases.js");
    expect(expandQuery("unrelated topic query")).toBe("unrelated topic query");
  });

  it("is a no-op when the alias file is missing", async () => {
    // Point to a path that does not exist — must not throw.
    process.env.SEARCH_ALIAS_PATH = join(tmpDir, "does-not-exist.json");
    vi.resetModules();
    const { expandQuery } = await import("../tools/search-aliases.js");
    expect(expandQuery("PA notes")).toBe("PA notes");
  });

  it("applies multiple expansions in one query", async () => {
    writeFileSync(
      aliasFile,
      JSON.stringify({ PA: "Project Alpha", NAS: "Home Server NAS" })
    );
    const { expandQuery } = await import("../tools/search-aliases.js");
    const result = expandQuery("backup strategy for PA on the NAS");
    expect(result).toContain("Project Alpha");
    expect(result).toContain("Home Server NAS");
  });

  it("handles keys with regex metacharacters safely", async () => {
    writeFileSync(
      aliasFile,
      JSON.stringify({ "box.example.com": "production server" })
    );
    const { expandQuery } = await import("../tools/search-aliases.js");
    const result = expandQuery("ssh into box.example.com for logs");
    expect(result).toContain("production server");
    // Literal dot — "boxXexampleXcom" must not trigger the expansion
    const result2 = expandQuery("boxXexampleXcom is a fake");
    expect(result2).toBe("boxXexampleXcom is a fake");
  });

  it("is a no-op when the alias file contains malformed JSON", async () => {
    writeFileSync(aliasFile, "this is not json {{{");
    vi.resetModules();
    const { expandQuery } = await import("../tools/search-aliases.js");
    expect(expandQuery("PA notes")).toBe("PA notes");
  });
});
