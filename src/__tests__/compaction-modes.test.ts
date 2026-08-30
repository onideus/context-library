import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rm, mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * COMPACTION_MODE behaviour tests.
 *
 * These exercise the seam between the compaction decision and the filesystem,
 * so they stub the two external dependencies rather than requiring them:
 *
 *  - hasPendingEmbedding (Postgres): returns false so the pending-embedding
 *    gate never masks the behaviour under test. Its conservative
 *    fail-closed-to-true semantics are asserted elsewhere.
 *  - db/client query (Postgres): retention pruning best-effort deletes
 *    embedding rows; no-op here.
 *
 * config.ts reads process.env once at module load, so every case stubs the
 * env and re-imports through vi.resetModules().
 *
 * All fixtures are synthetic and generic — this repo is public.
 */

vi.mock("../embeddings/indexer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../embeddings/indexer.js")>();
  return { ...actual, hasPendingEmbedding: async () => false };
});

vi.mock("../db/client.js", () => ({
  pool: { query: async () => ({ rows: [] }), connect: async () => ({}) },
  query: async () => ({ rows: [], rowCount: 0 }),
  getClient: async () => ({}),
}));

const TEST_DATA_DIR = join(process.cwd(), "data", "test-compaction-modes");
const HANDOFFS_DIR = join(TEST_DATA_DIR, "handoffs");
const ARCHIVE_DIR = join(HANDOFFS_DIR, "archive");

/** A generic handoff with enough active_context that compaction actually shrinks it. */
function makeHandoff(label = "session-01") {
  return {
    operational_state: { focus: "high", blockers: "none" },
    active_context: {
      session_meta: { label, surface: "test", model: "test-model" },
      conversation_arc:
        "Reviewed the widget pipeline end to end and agreed on a three-stage rollout.",
      key_decisions: [
        "Stage the rollout behind a flag",
        "Backfill the widget index before enabling it",
      ],
      research_notes:
        "Background reading on queue depth, retry budgets, and backpressure across the fleet. " +
        "Enough prose here that collapsing it to a one-line summary is a measurable loss.",
    },
    tone_notes: "Be terse.",
    stored_at: "2026-04-17T10:00:00.000Z",
    schema_version: "1.3",
  };
}

/**
 * Reset modules with the given env, then re-import everything that reads config.
 * Returns the freshly-loaded modules.
 */
async function loadWithEnv(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  const config = (await import("../config.js")).config;
  const jsonStore = await import("../storage/json-store.js");
  const handoff = await import("../tools/handoff.js");
  return { config, jsonStore, handoff };
}

/** Write a handoff file with caller-controlled bytes (so byte-exactness is provable). */
async function seedHandoff(filename: string, bytes: string): Promise<void> {
  await mkdir(HANDOFFS_DIR, { recursive: true });
  await writeFile(join(HANDOFFS_DIR, filename), bytes, "utf-8");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  await rm(TEST_DATA_DIR, { recursive: true, force: true });
  await mkdir(HANDOFFS_DIR, { recursive: true });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(TEST_DATA_DIR, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────
// Config parsing
// ─────────────────────────────────────────────────────────────────

describe("COMPACTION_MODE config parsing", () => {
  it("defaults to archive when unset", async () => {
    const { config } = await loadWithEnv({
      DATA_DIR: TEST_DATA_DIR,
      COMPACTION_MODE: undefined,
    });
    expect(config.compactionMode).toBe("archive");
  });

  it("accepts archive, in-place and off", async () => {
    for (const mode of ["archive", "in-place", "off"] as const) {
      const { config } = await loadWithEnv({
        DATA_DIR: TEST_DATA_DIR,
        COMPACTION_MODE: mode,
      });
      expect(config.compactionMode).toBe(mode);
    }
  });

  it("is case- and whitespace-insensitive", async () => {
    const { config } = await loadWithEnv({
      DATA_DIR: TEST_DATA_DIR,
      COMPACTION_MODE: "  OFF  ",
    });
    expect(config.compactionMode).toBe("off");
  });

  it("falls back to archive (never in-place) on an unrecognised value", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { config } = await loadWithEnv({
      DATA_DIR: TEST_DATA_DIR,
      COMPACTION_MODE: "in place",
    });
    expect(config.compactionMode).toBe("archive");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────
// archiveHandoff primitive
// ─────────────────────────────────────────────────────────────────

describe("archiveHandoff", () => {
  it("copies the original byte-for-byte, without re-serialising", async () => {
    const { jsonStore } = await loadWithEnv({ DATA_DIR: TEST_DATA_DIR });
    // Deliberately compact, non-pretty bytes: writeHandoffInPlace writes
    // 2-space-indented JSON, so an archive that matches these bytes proves
    // the copy is verbatim rather than a re-encode.
    const bytes = JSON.stringify(makeHandoff());
    await seedHandoff("h1.json", bytes);

    const outcome = await jsonStore.archiveHandoff("h1.json");

    expect(outcome).toBe("archived");
    expect(await readFile(join(ARCHIVE_DIR, "h1.json"), "utf-8")).toBe(bytes);
  });

  it("creates the archive directory on demand", async () => {
    const { jsonStore } = await loadWithEnv({ DATA_DIR: TEST_DATA_DIR });
    expect(await pathExists(ARCHIVE_DIR)).toBe(false);
    await seedHandoff("h1.json", JSON.stringify(makeHandoff()));
    await jsonStore.archiveHandoff("h1.json");
    expect(await pathExists(ARCHIVE_DIR)).toBe(true);
  });

  it("first archive wins — a second call never overwrites the original copy", async () => {
    const { jsonStore } = await loadWithEnv({ DATA_DIR: TEST_DATA_DIR });
    const original = JSON.stringify(makeHandoff());
    await seedHandoff("h1.json", original);
    expect(await jsonStore.archiveHandoff("h1.json")).toBe("archived");

    // Simulate the source having since been gutted, then archive again.
    await seedHandoff("h1.json", JSON.stringify({ _compacted: true }));
    expect(await jsonStore.archiveHandoff("h1.json")).toBe("exists");

    expect(await readFile(join(ARCHIVE_DIR, "h1.json"), "utf-8")).toBe(original);
  });

  it("throws ENOENT when the source handoff is missing", async () => {
    const { jsonStore } = await loadWithEnv({ DATA_DIR: TEST_DATA_DIR });
    await expect(jsonStore.archiveHandoff("nope.json")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("leaves no .tmp- residue behind", async () => {
    const { jsonStore } = await loadWithEnv({ DATA_DIR: TEST_DATA_DIR });
    await seedHandoff("h1.json", JSON.stringify(makeHandoff()));
    await jsonStore.archiveHandoff("h1.json");
    const entries = await readdir(ARCHIVE_DIR);
    expect(entries.filter((f) => f.startsWith(".tmp-"))).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────
// Mode behaviour through the store_handoff compaction path
// ─────────────────────────────────────────────────────────────────

describe("compactPreviousHandoff — off", () => {
  it("leaves the previous handoff byte-identical and writes no archive", async () => {
    const { handoff, jsonStore } = await loadWithEnv({
      DATA_DIR: TEST_DATA_DIR,
      COMPACTION_MODE: "off",
    });
    const original = JSON.stringify(makeHandoff(), null, 2);
    await seedHandoff("h1.json", original);

    await handoff.compactPreviousHandoff("h1.json");

    expect(await readFile(join(HANDOFFS_DIR, "h1.json"), "utf-8")).toBe(original);
    expect(await pathExists(ARCHIVE_DIR)).toBe(false);
    // Untouched means untouched: no _compacted flag either.
    const parsed = JSON.parse(await readFile(join(HANDOFFS_DIR, "h1.json"), "utf-8"));
    expect(parsed._compacted).toBeUndefined();
    expect(parsed.active_context.research_notes).toBeDefined();
    expect(jsonStore.ARCHIVE_DIRNAME).toBe("archive");
  });
});

describe("compactPreviousHandoff — archive (default)", () => {
  it("archives the byte-exact original, then compacts in place", async () => {
    const { handoff } = await loadWithEnv({
      DATA_DIR: TEST_DATA_DIR,
      COMPACTION_MODE: "archive",
    });
    const original = JSON.stringify(makeHandoff());
    await seedHandoff("h1.json", original);

    await handoff.compactPreviousHandoff("h1.json");

    // Archive holds the original bytes.
    expect(await readFile(join(ARCHIVE_DIR, "h1.json"), "utf-8")).toBe(original);

    // Live file is compacted.
    const live = JSON.parse(await readFile(join(HANDOFFS_DIR, "h1.json"), "utf-8"));
    expect(live._compacted).toBe(true);
    expect(live.active_context.compacted_summary).toBeTypeOf("string");
    expect(live.active_context.research_notes).toBeUndefined();

    // The archived copy still has everything the live file lost.
    const archived = JSON.parse(await readFile(join(ARCHIVE_DIR, "h1.json"), "utf-8"));
    expect(archived.active_context.research_notes).toBeDefined();
    expect(archived.active_context.key_decisions).toHaveLength(2);
    expect(archived._compacted).toBeUndefined();
  });

  it("is the mode used when COMPACTION_MODE is unset", async () => {
    const { handoff } = await loadWithEnv({
      DATA_DIR: TEST_DATA_DIR,
      COMPACTION_MODE: undefined,
    });
    await seedHandoff("h1.json", JSON.stringify(makeHandoff()));
    await handoff.compactPreviousHandoff("h1.json");
    expect(await pathExists(join(ARCHIVE_DIR, "h1.json"))).toBe(true);
  });

  it("never archives an already-compacted file", async () => {
    const { handoff } = await loadWithEnv({
      DATA_DIR: TEST_DATA_DIR,
      COMPACTION_MODE: "archive",
    });
    const gutted = JSON.stringify({
      ...makeHandoff(),
      active_context: { compacted_summary: "Session session-01: rollout agreed." },
      _compacted: true,
    });
    await seedHandoff("h1.json", gutted);

    await handoff.compactPreviousHandoff("h1.json");

    // No archive written — there is no original left to save, and archiving
    // the gutted file would misrepresent it as one.
    expect(await pathExists(join(ARCHIVE_DIR, "h1.json"))).toBe(false);
    expect(await readFile(join(HANDOFFS_DIR, "h1.json"), "utf-8")).toBe(gutted);
  });

  it("double compaction is idempotent and keeps the first archive", async () => {
    const { handoff } = await loadWithEnv({
      DATA_DIR: TEST_DATA_DIR,
      COMPACTION_MODE: "archive",
    });
    const original = JSON.stringify(makeHandoff());
    await seedHandoff("h1.json", original);

    await handoff.compactPreviousHandoff("h1.json");
    const afterFirst = await readFile(join(HANDOFFS_DIR, "h1.json"), "utf-8");

    await handoff.compactPreviousHandoff("h1.json");
    const afterSecond = await readFile(join(HANDOFFS_DIR, "h1.json"), "utf-8");

    expect(afterSecond).toBe(afterFirst);
    expect(await readFile(join(ARCHIVE_DIR, "h1.json"), "utf-8")).toBe(original);
  });

  it("aborts the in-place rewrite when archiving fails", async () => {
    const { handoff, jsonStore } = await loadWithEnv({
      DATA_DIR: TEST_DATA_DIR,
      COMPACTION_MODE: "archive",
    });
    const original = JSON.stringify(makeHandoff());
    await seedHandoff("h1.json", original);

    const spy = vi
      .spyOn(jsonStore, "archiveHandoff")
      .mockRejectedValue(new Error("disk full"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await handoff.compactPreviousHandoff("h1.json");

    // The live file must survive intact — a failed archive may not be
    // followed by a destructive rewrite.
    expect(await readFile(join(HANDOFFS_DIR, "h1.json"), "utf-8")).toBe(original);
    expect(warn).toHaveBeenCalled();
    spy.mockRestore();
    warn.mockRestore();
  });
});

describe("compactPreviousHandoff — in-place (legacy)", () => {
  it("rewrites with no archive copy, matching legacy behaviour", async () => {
    const { handoff } = await loadWithEnv({
      DATA_DIR: TEST_DATA_DIR,
      COMPACTION_MODE: "in-place",
    });
    const source = makeHandoff();
    await seedHandoff("h1.json", JSON.stringify(source));

    await handoff.compactPreviousHandoff("h1.json");

    expect(await pathExists(ARCHIVE_DIR)).toBe(false);

    const { compactHandoff } = await import("../tools/compaction.js");
    const expected = JSON.stringify(compactHandoff(source as never).compacted, null, 2);
    expect(await readFile(join(HANDOFFS_DIR, "h1.json"), "utf-8")).toBe(expected);
  });
});

// ─────────────────────────────────────────────────────────────────
// archive/ vs retention and latest-file resolution
// ─────────────────────────────────────────────────────────────────

describe("archive/ is invisible to handoff listing and retention", () => {
  it("getLatestHandoffFilename ignores archive/ even when it sorts last", async () => {
    const { jsonStore } = await loadWithEnv({ DATA_DIR: TEST_DATA_DIR });
    await seedHandoff("2026-01-01-aaa.json", JSON.stringify(makeHandoff()));
    await seedHandoff("2026-06-01-bbb.json", JSON.stringify(makeHandoff()));
    // A name that would sort after every real handoff if the directory entry
    // or its contents ever leaked into the listing.
    await mkdir(ARCHIVE_DIR, { recursive: true });
    await writeFile(join(ARCHIVE_DIR, "9999-01-01-zzz.json"), "{}", "utf-8");

    expect(await jsonStore.getLatestHandoffFilename()).toBe("2026-06-01-bbb.json");
    expect(await jsonStore.getHandoffCount()).toBe(2);
  });

  it("retention pruning never deletes archived originals", async () => {
    const { jsonStore } = await loadWithEnv({
      DATA_DIR: TEST_DATA_DIR,
      RETENTION_COUNT: "2",
    });

    // Archive an original whose live file is about to be pruned away.
    await mkdir(ARCHIVE_DIR, { recursive: true });
    const archivedBytes = JSON.stringify(makeHandoff("oldest"));
    await writeFile(join(ARCHIVE_DIR, "old.json"), archivedBytes, "utf-8");

    // Push past the retention limit.
    for (let i = 0; i < 4; i++) {
      await jsonStore.writeHandoff(makeHandoff(`s-${i}`));
    }

    expect(await jsonStore.getHandoffCount()).toBe(2);
    // The archived original is untouched — archive/ is outside retention.
    expect(await readFile(join(ARCHIVE_DIR, "old.json"), "utf-8")).toBe(archivedBytes);
    expect(await pathExists(ARCHIVE_DIR)).toBe(true);
  });
});
