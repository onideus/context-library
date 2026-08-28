import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  classifyRecovery,
  scanHandoffDir,
  assessViability,
  buildReport,
  formatSummary,
  listArchivedOriginals,
  RECOVERY_MIN_MARGIN_CHARS,
  type ChunkRow,
  type FileRecord,
} from "./audit-compaction.js";

/**
 * audit-compaction is read-only and Postgres-optional, so these tests drive it
 * against a synthetic handoff directory with an injected chunk fetcher — no
 * database, and no contact with any real data directory.
 *
 * Fixtures are generic; this repo is public.
 */

const TEST_DIR = join(process.cwd(), "data", "test-audit-compaction");
const HANDOFFS = join(TEST_DIR, "handoffs");
const ARCHIVE = join(HANDOFFS, "archive");

function intactHandoff(label: string) {
  return {
    operational_state: { focus: "high" },
    active_context: {
      session_meta: { label },
      conversation_arc: "Traced a latency regression to the widget cache.",
      research_notes: "Extended prose about cache eviction and queue depth. ".repeat(20),
    },
    tone_notes: "Be terse.",
    stored_at: `2026-03-0${label.slice(-1)}T10:00:00.000Z`,
    schema_version: "1.3",
  };
}

function compactedHandoff(label: string, storedAt: string) {
  return {
    operational_state: { focus: "high" },
    active_context: {
      session_meta: { label },
      compacted_summary: `Session ${label}: traced a latency regression.`,
    },
    tone_notes: "Be terse.",
    stored_at: storedAt,
    schema_version: "1.3",
    _compacted: true,
  };
}

async function seed(name: string, body: unknown): Promise<void> {
  await writeFile(join(HANDOFFS, name), JSON.stringify(body, null, 2), "utf-8");
}

function chunk(filename: string, i: number, text: string): ChunkRow {
  return { content_id: `${filename}#chunk_${i}`, content_text: text, chunk_index: i };
}

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(HANDOFFS, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("classifyRecovery", () => {
  it("reports NO_ROWS when the file was never indexed", () => {
    expect(classifyRecovery(0, 0, 400)).toBe("NO_ROWS");
  });

  it("reports RECOVERABLE when the index holds far more than the compacted file", () => {
    expect(classifyRecovery(4, 8000, 400)).toBe("RECOVERABLE");
  });

  it("reports LOST when indexed text matches what the compacted file would produce", () => {
    // A reindex after compaction re-reads the gutted file: one small chunk.
    expect(classifyRecovery(1, 400, 400)).toBe("LOST");
  });

  it("requires an absolute margin, not just a ratio, on small files", () => {
    // 1.5x of 100 is 150, but 50 extra chars is noise — not evidence of recovery.
    expect(classifyRecovery(1, 160, 100)).toBe("LOST");
    expect(classifyRecovery(1, 100 + RECOVERY_MIN_MARGIN_CHARS, 100)).toBe("RECOVERABLE");
  });

  it("does not call a file recoverable merely because it has several rows", () => {
    // Multiple tiny rows that together only match the compacted text.
    expect(classifyRecovery(3, 420, 400)).toBe("LOST");
  });
});

describe("scanHandoffDir", () => {
  it("separates compacted from intact files and records stored_at", async () => {
    await seed("2026-03-01-aaa.json", intactHandoff("s-1"));
    await seed("2026-03-02-bbb.json", compactedHandoff("s-2", "2026-03-02T10:00:00.000Z"));

    const files = await scanHandoffDir(HANDOFFS);

    expect(files).toHaveLength(2);
    expect(files.map((f) => f.compacted)).toEqual([false, true]);
    expect(files[1].stored_at).toBe("2026-03-02T10:00:00.000Z");
    expect(files[0].bytes).toBeGreaterThan(0);
  });

  it("measures the text the CURRENT file would yield — the compaction baseline", async () => {
    await seed("2026-03-01-aaa.json", intactHandoff("s-1"));
    await seed("2026-03-02-bbb.json", compactedHandoff("s-2", "2026-03-02T10:00:00.000Z"));

    const files = await scanHandoffDir(HANDOFFS);
    const intact = files.find((f) => !f.compacted)!;
    const gutted = files.find((f) => f.compacted)!;

    expect(gutted.current_text_chars).toBeGreaterThan(0);
    expect(gutted.current_text_chars).toBeLessThan(intact.current_text_chars);
  });

  it("ignores temp files, non-JSON entries, and the archive subdirectory", async () => {
    await seed("2026-03-01-aaa.json", intactHandoff("s-1"));
    await writeFile(join(HANDOFFS, ".tmp-abc.json"), "{}", "utf-8");
    await writeFile(join(HANDOFFS, "notes.txt"), "scratch", "utf-8");
    await mkdir(ARCHIVE, { recursive: true });
    await writeFile(join(ARCHIVE, "9999-zzz.json"), "{}", "utf-8");

    const files = await scanHandoffDir(HANDOFFS);
    expect(files.map((f) => f.filename)).toEqual(["2026-03-01-aaa.json"]);
  });

  it("flags archived originals and survives corrupt JSON", async () => {
    await seed("2026-03-01-aaa.json", compactedHandoff("s-1", "2026-03-01T10:00:00.000Z"));
    await writeFile(join(HANDOFFS, "2026-03-02-bad.json"), "{not json", "utf-8");
    await mkdir(ARCHIVE, { recursive: true });
    await writeFile(join(ARCHIVE, "2026-03-01-aaa.json"), "{}", "utf-8");

    const files = await scanHandoffDir(HANDOFFS);
    expect(files.find((f) => f.filename === "2026-03-01-aaa.json")!.archived).toBe(true);
    const bad = files.find((f) => f.filename === "2026-03-02-bad.json")!;
    expect(bad.parse_error).toBeTruthy();
    expect(bad.compacted).toBe(false);
  });

  it("listArchivedOriginals returns an empty set when archive/ does not exist", async () => {
    expect(await listArchivedOriginals(HANDOFFS)).toEqual(new Set());
  });
});

describe("assessViability", () => {
  it("assesses only compacted files, using the injected fetcher", async () => {
    await seed("2026-03-01-aaa.json", intactHandoff("s-1"));
    await seed("2026-03-02-bbb.json", compactedHandoff("s-2", "2026-03-02T10:00:00.000Z"));
    const files = await scanHandoffDir(HANDOFFS);

    const asked: string[] = [];
    const viability = await assessViability(files, async (f) => {
      asked.push(f);
      return [chunk(f, 0, "original prose ".repeat(200))];
    });

    expect(asked).toEqual(["2026-03-02-bbb.json"]);
    expect(viability).toHaveLength(1);
    expect(viability[0].verdict).toBe("RECOVERABLE");
    expect(viability[0].margin_chars).toBeGreaterThan(0);
  });

  it("classifies a post-compaction reindex as LOST", async () => {
    await seed("2026-03-02-bbb.json", compactedHandoff("s-2", "2026-03-02T10:00:00.000Z"));
    const files = await scanHandoffDir(HANDOFFS);
    const gutted = files[0];

    // Simulate reindex-after-compaction: the index now holds exactly the text
    // the gutted file produces.
    const viability = await assessViability(files, async (f) => [
      chunk(f, 0, "x".repeat(gutted.current_text_chars)),
    ]);

    expect(viability[0].verdict).toBe("LOST");
  });
});

describe("buildReport", () => {
  const files: FileRecord[] = [
    {
      filename: "a.json",
      bytes: 100,
      compacted: true,
      stored_at: "2026-01-05T00:00:00.000Z",
      current_text_chars: 50,
      archived: true,
    },
    {
      filename: "b.json",
      bytes: 200,
      compacted: true,
      stored_at: "2026-02-05T00:00:00.000Z",
      current_text_chars: 60,
      archived: false,
    },
    {
      filename: "c.json",
      bytes: 400,
      compacted: false,
      stored_at: "2026-03-05T00:00:00.000Z",
      current_text_chars: 900,
      archived: false,
    },
    {
      filename: "d.json",
      bytes: 10,
      compacted: false,
      stored_at: null,
      current_text_chars: 0,
      archived: false,
      parse_error: "boom",
    },
  ];

  it("totals files, bytes and archived originals", () => {
    const r = buildReport(files, [], { dataDir: "./data", handoffsDir: "./data/handoffs", postgresAvailable: true });
    expect(r.totals).toMatchObject({
      files: 4,
      compacted: 2,
      intact: 1,
      unreadable: 1,
      archived_originals: 1,
      bytes_total: 710,
      bytes_compacted_files: 300,
      bytes_intact_files: 400,
    });
  });

  it("bounds the compaction timeline separately from the corpus timeline", () => {
    const r = buildReport(files, [], { dataDir: "./data", handoffsDir: "./data/handoffs", postgresAvailable: true });
    expect(r.timeline.earliest_compacted_stored_at).toBe("2026-01-05T00:00:00.000Z");
    expect(r.timeline.latest_compacted_stored_at).toBe("2026-02-05T00:00:00.000Z");
    expect(r.timeline.earliest_handoff_stored_at).toBe("2026-01-05T00:00:00.000Z");
    expect(r.timeline.latest_handoff_stored_at).toBe("2026-03-05T00:00:00.000Z");
  });

  it("counts verdicts, including zero buckets", () => {
    const r = buildReport(
      files,
      [
        { filename: "a.json", verdict: "RECOVERABLE", chunk_count: 3, indexed_chars: 900, current_text_chars: 50, margin_chars: 850 },
        { filename: "b.json", verdict: "LOST", chunk_count: 1, indexed_chars: 60, current_text_chars: 60, margin_chars: 0 },
      ],
      { dataDir: "./data", handoffsDir: "./data/handoffs", postgresAvailable: true }
    );
    expect(r.viability_counts).toEqual({ RECOVERABLE: 1, LOST: 1, NO_ROWS: 0, UNKNOWN: 0 });
  });

  it("formatSummary says viability is unknown when Postgres was unreachable", () => {
    const r = buildReport(files, [], { dataDir: "./data", handoffsDir: "./data/handoffs", postgresAvailable: false });
    const text = formatSummary(r);
    expect(text).toMatch(/Postgres unreachable/);
    expect(text).toMatch(/File-side stats above are still accurate/);
  });
});
