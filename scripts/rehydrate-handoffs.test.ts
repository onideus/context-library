import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  orderChunks,
  joinChunks,
  buildRecoveryRecord,
  recoveredSidecarName,
  rehydrate,
  CHUNK_BOUNDARY_MARKER,
  RECOVERY_METHOD,
} from "./rehydrate-handoffs.js";
import type { ChunkRow } from "./audit-compaction.js";
import type { Handoff } from "../src/storage/schemas.js";

/**
 * Rehydration is driven entirely off injected chunks here — no Postgres, and
 * no contact with any real data directory. Fixtures are generic; this repo is
 * public.
 */

const TEST_DIR = join(process.cwd(), "data", "test-rehydrate-handoffs");
const HANDOFFS = join(TEST_DIR, "handoffs");
const ARCHIVE = join(HANDOFFS, "archive");

const GUTTED = {
  operational_state: { focus: "high", blockers: "none" },
  active_context: {
    session_meta: { label: "s-2", surface: "test" },
    compacted_summary: "Session s-2: traced a latency regression.",
  },
  tone_notes: "Be terse.",
  stored_at: "2026-03-02T10:00:00.000Z",
  schema_version: "1.3",
  _compacted: true,
};

function chunk(filename: string, i: number, text: string, index: number | null = i): ChunkRow {
  return { content_id: `${filename}#chunk_${i}`, content_text: text, chunk_index: index };
}

/** Enough text that classifyRecovery clears the absolute margin. */
const LONG_A = "active_context conversation_arc: traced the regression. ".repeat(30);
const LONG_B = "active_context research_notes: cache eviction findings. ".repeat(30);

async function seedGutted(name: string): Promise<void> {
  await mkdir(HANDOFFS, { recursive: true });
  await writeFile(join(HANDOFFS, name), JSON.stringify(GUTTED, null, 2), "utf-8");
}

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(HANDOFFS, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("orderChunks", () => {
  it("orders by metadata chunk_index regardless of row order", () => {
    const rows = [chunk("f.json", 2, "c"), chunk("f.json", 0, "a"), chunk("f.json", 1, "b")];
    expect(orderChunks(rows).map((c) => c.content_text)).toEqual(["a", "b", "c"]);
  });

  it("falls back to the #chunk_N id suffix when metadata lacks the index", () => {
    const rows = [
      chunk("f.json", 2, "c", null),
      chunk("f.json", 0, "a", null),
      chunk("f.json", 1, "b", null),
    ];
    expect(orderChunks(rows).map((c) => c.content_text)).toEqual(["a", "b", "c"]);
  });

  it("sorts a legacy un-suffixed single row first", () => {
    const rows = [
      chunk("f.json", 1, "chunked", null),
      { content_id: "f.json", content_text: "legacy", chunk_index: null },
    ];
    expect(orderChunks(rows).map((c) => c.content_text)).toEqual(["legacy", "chunked"]);
  });

  it("does not mutate its input", () => {
    const rows = [chunk("f.json", 1, "b"), chunk("f.json", 0, "a")];
    orderChunks(rows);
    expect(rows.map((c) => c.content_text)).toEqual(["b", "a"]);
  });
});

describe("joinChunks", () => {
  it("marks each seam rather than guessing the original separator", () => {
    const text = joinChunks([chunk("f.json", 0, "first"), chunk("f.json", 1, "second")]);
    expect(text).toBe(`first${CHUNK_BOUNDARY_MARKER}second`);
    expect(text).toMatch(/original separator not recorded/);
  });

  it("adds no marker to a single chunk", () => {
    expect(joinChunks([chunk("f.json", 0, "only")])).toBe("only");
  });
});

describe("buildRecoveryRecord", () => {
  const chunks = [chunk("h.json", 0, LONG_A), chunk("h.json", 1, LONG_B)];

  it("records provenance and the honest limitation", () => {
    const r = buildRecoveryRecord("h.json", GUTTED as Handoff, chunks, "2026-08-28T00:00:00.000Z");
    expect(r.source_file).toBe("h.json");
    expect(r.recovered_at).toBe("2026-08-28T00:00:00.000Z");
    expect(r.recovery_method).toBe(RECOVERY_METHOD);
    expect(r.stored_at).toBe("2026-03-02T10:00:00.000Z");
    expect(r.limitation).toMatch(/TEXT of active_context, not its original key structure/);
    expect(r.chunk_count).toBe(2);
    expect(r.recovered_chars).toBe(r.recovered_text.length);
  });

  it("copies the fields that survived compaction, verbatim", () => {
    const r = buildRecoveryRecord("h.json", GUTTED as Handoff, chunks);
    expect(r.preserved.operational_state).toEqual({ focus: "high", blockers: "none" });
    expect(r.preserved.tone_notes).toBe("Be terse.");
    expect(r.preserved.session_meta).toEqual({ label: "s-2", surface: "test" });
  });

  it("carries the raw ordered chunks alongside the joined text", () => {
    const r = buildRecoveryRecord("h.json", GUTTED as Handoff, [chunks[1], chunks[0]]);
    expect(r.chunks).toEqual([LONG_A, LONG_B]);
    expect(r.recovered_text).toBe(`${LONG_A}${CHUNK_BOUNDARY_MARKER}${LONG_B}`);
  });

  it("does not fabricate active_context structure", () => {
    const r = buildRecoveryRecord("h.json", GUTTED as Handoff, chunks) as Record<string, unknown>;
    expect(r.active_context).toBeUndefined();
    expect(Object.keys(r.preserved as object).sort()).toEqual([
      "operational_state",
      "session_meta",
      "tone_notes",
    ]);
  });

  it("omits preserved fields that the compacted file does not have", () => {
    const bare = { stored_at: "2026-03-02T10:00:00.000Z", _compacted: true } as unknown as Handoff;
    const r = buildRecoveryRecord("h.json", bare, chunks);
    expect(r.preserved).toEqual({});
  });
});

describe("rehydrate", () => {
  const fetchRich = async (f: string): Promise<ChunkRow[]> => [
    chunk(f, 0, LONG_A),
    chunk(f, 1, LONG_B),
  ];

  it("dry-run is the default: reports what it would do and writes nothing", async () => {
    await seedGutted("h1.json");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const summary = await rehydrate({
      handoffsDir: HANDOFFS,
      fetchChunks: fetchRich,
      write: false,
      force: false,
    });

    expect(summary.recoverable).toBe(1);
    expect(summary.recovered).toBe(0);
    expect(summary.bytes_restored).toBeGreaterThan(0);
    // archive/ is not even created on a dry run.
    await expect(readdir(ARCHIVE)).rejects.toMatchObject({ code: "ENOENT" });
    expect(log.mock.calls.flat().join("\n")).toMatch(/would write/);
    log.mockRestore();
  });

  it("--write emits a sidecar into archive/ and leaves the source untouched", async () => {
    await seedGutted("h1.json");
    const before = await readFile(join(HANDOFFS, "h1.json"), "utf-8");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const summary = await rehydrate({
      handoffsDir: HANDOFFS,
      fetchChunks: fetchRich,
      write: true,
      force: false,
    });
    log.mockRestore();

    expect(summary.recovered).toBe(1);

    const sidecar = join(ARCHIVE, recoveredSidecarName("h1.json"));
    const record = JSON.parse(await readFile(sidecar, "utf-8"));
    expect(record.source_file).toBe("h1.json");
    expect(record.recovered_text).toContain("traced the regression");
    expect(record.recovered_text).toContain("cache eviction findings");

    // The compacted handoff itself is never rewritten — recovery is append-only.
    expect(await readFile(join(HANDOFFS, "h1.json"), "utf-8")).toBe(before);
    expect(recoveredSidecarName("h1.json")).toBe("h1.json.recovered.json");
  });

  it("skips an existing sidecar unless --force", async () => {
    await seedGutted("h1.json");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await mkdir(ARCHIVE, { recursive: true });
    const sidecar = join(ARCHIVE, recoveredSidecarName("h1.json"));
    await writeFile(sidecar, '{"hand":"edited"}', "utf-8");

    const skipped = await rehydrate({
      handoffsDir: HANDOFFS,
      fetchChunks: fetchRich,
      write: true,
      force: false,
    });
    expect(skipped.skipped_existing).toBe(1);
    expect(skipped.recovered).toBe(0);
    expect(await readFile(sidecar, "utf-8")).toBe('{"hand":"edited"}');

    const forced = await rehydrate({
      handoffsDir: HANDOFFS,
      fetchChunks: fetchRich,
      write: true,
      force: true,
    });
    log.mockRestore();
    expect(forced.recovered).toBe(1);
    expect(JSON.parse(await readFile(sidecar, "utf-8")).source_file).toBe("h1.json");
  });

  it("counts LOST files and writes nothing for them", async () => {
    await seedGutted("h1.json");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    // Index holds only a re-index of the gutted file — nothing to recover.
    const summary = await rehydrate({
      handoffsDir: HANDOFFS,
      fetchChunks: async (f) => [chunk(f, 0, "compacted_summary: Session s-2.")],
      write: true,
      force: false,
    });
    log.mockRestore();

    expect(summary.lost).toBe(1);
    expect(summary.recovered).toBe(0);
    expect(summary.recoverable).toBe(0);
    await expect(readdir(ARCHIVE)).resolves.toEqual([]);
  });

  it("counts never-indexed files as NO_ROWS", async () => {
    await seedGutted("h1.json");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const summary = await rehydrate({
      handoffsDir: HANDOFFS,
      fetchChunks: async () => [],
      write: true,
      force: false,
    });
    log.mockRestore();

    expect(summary.no_rows).toBe(1);
    expect(summary.recovered).toBe(0);
  });

  it("ignores intact handoffs entirely", async () => {
    await writeFile(
      join(HANDOFFS, "h0.json"),
      JSON.stringify({ ...GUTTED, _compacted: undefined, active_context: { notes: LONG_A } }),
      "utf-8"
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const summary = await rehydrate({
      handoffsDir: HANDOFFS,
      fetchChunks: fetchRich,
      write: true,
      force: false,
    });
    log.mockRestore();

    expect(summary).toMatchObject({ recoverable: 0, recovered: 0, lost: 0, no_rows: 0 });
  });
});
