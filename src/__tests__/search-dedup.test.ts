import { describe, it, expect } from "vitest";
import { deduplicateResults } from "../tools/search.js";

/**
 * Helper: create a mock search result row.
 */
function makeRow(
  contentText: string,
  sourceFile: string,
  extra?: { similarity?: number; rrf_score?: number }
) {
  return {
    content_type: "handoff",
    content_id: `${sourceFile}#chunk_1`,
    content_text: contentText,
    metadata: { source_file: sourceFile, chunk_index: 0 },
    similarity: extra?.similarity ?? 0.8,
    rrf_score: extra?.rrf_score ?? 0.03,
  };
}

describe("search_context source deduplication", () => {
  it("collapses identical content to the oldest source_file", () => {
    const sharedText =
      "The database failover incident occurred on March 21 when the primary replica lost connectivity. " +
      "This was detected by automated monitoring and escalated to the on-call engineer. The backup was promoted immediately.";

    const rows = [
      makeRow(sharedText, "2026-04-04T10-00-00-000Z-aaaa1111.json", { rrf_score: 0.035 }),
      makeRow(sharedText, "2026-04-03T08-00-00-000Z-bbbb2222.json", { rrf_score: 0.033 }),
      makeRow(sharedText, "2026-03-25T14-00-00-000Z-cccc3333.json", { rrf_score: 0.031 }),
      makeRow(sharedText, "2026-03-22T09-00-00-000Z-dddd4444.json", { rrf_score: 0.029 }),
      makeRow(sharedText, "2026-03-21T23-12-37-052Z-eeee5555.json", { rrf_score: 0.027 }),
    ];

    const { deduped, preDedupCount } = deduplicateResults(rows);

    expect(preDedupCount).toBe(5);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].metadata.source_file).toBe("2026-03-21T23-12-37-052Z-eeee5555.json");
  });

  it("preserves diverse content (no false dedup)", () => {
    const rows = [
      makeRow("Alpha content about project planning and quarterly goals", "2026-03-21T01-00-00-000Z-a.json"),
      makeRow("Beta content discussing database migration strategy", "2026-03-22T02-00-00-000Z-b.json"),
      makeRow("Gamma content reviewing authentication middleware", "2026-03-23T03-00-00-000Z-c.json"),
      makeRow("Delta content about deployment pipeline improvements", "2026-03-24T04-00-00-000Z-d.json"),
      makeRow("Epsilon content covering test coverage analysis", "2026-03-25T05-00-00-000Z-e.json"),
    ];

    const { deduped, preDedupCount } = deduplicateResults(rows);

    expect(preDedupCount).toBe(5);
    expect(deduped).toHaveLength(5);
  });

  it("keeps the oldest source when multiple rows share a fingerprint", () => {
    const sharedText = "Decision to migrate from Express to Hono was made during the architecture review session.";

    const rows = [
      makeRow(sharedText, "2026-04-01T12-00-00-000Z-new111.json"),
      makeRow(sharedText, "2026-03-15T08-30-00-000Z-old222.json"),
      makeRow(sharedText, "2026-03-28T16-00-00-000Z-mid333.json"),
    ];

    const { deduped } = deduplicateResults(rows);

    expect(deduped).toHaveLength(1);
    expect(deduped[0].metadata.source_file).toBe("2026-03-15T08-30-00-000Z-old222.json");
  });

  it("over-fetch scenario: 15 duplicates + 5 unique collapses to 6", () => {
    const duplicateText =
      "The database failover incident was documented in the March 21 handoff. " +
      "This event was significant because it required immediate intervention.";

    const rows: any[] = [];

    // 15 duplicates across different dates
    for (let i = 0; i < 15; i++) {
      const day = String(i + 1).padStart(2, "0");
      rows.push(
        makeRow(duplicateText, `2026-03-${day}T10-00-00-000Z-dup${String(i).padStart(5, "0")}.json`, {
          rrf_score: 0.04 - i * 0.001,
        })
      );
    }

    // 5 unique rows
    rows.push(makeRow("Unique content about sleep tracking improvements", "2026-03-20T11-00-00-000Z-uniq1.json", { rrf_score: 0.025 }));
    rows.push(makeRow("Unique content about task management workflow", "2026-03-21T12-00-00-000Z-uniq2.json", { rrf_score: 0.024 }));
    rows.push(makeRow("Unique content about embedding pipeline tuning", "2026-03-22T13-00-00-000Z-uniq3.json", { rrf_score: 0.023 }));
    rows.push(makeRow("Unique content about authentication audit results", "2026-03-23T14-00-00-000Z-uniq4.json", { rrf_score: 0.022 }));
    rows.push(makeRow("Unique content about deployment automation scripts", "2026-03-24T15-00-00-000Z-uniq5.json", { rrf_score: 0.021 }));

    const { deduped, preDedupCount } = deduplicateResults(rows);

    expect(preDedupCount).toBe(20);
    // 1 surviving duplicate + 5 unique = 6
    expect(deduped).toHaveLength(6);

    // The surviving duplicate should be from March 01 (oldest)
    const dupSurvivor = deduped.find((r) =>
      r.content_text.includes("database failover incident was documented")
    );
    expect(dupSurvivor).toBeDefined();
    expect(dupSurvivor!.metadata.source_file).toBe("2026-03-01T10-00-00-000Z-dup00000.json");
  });

  it("handles rows without source_file in metadata", () => {
    const sharedText = "Content without source file metadata for edge case testing purposes.";

    const rows = [
      { content_type: "task", content_id: "task-1", content_text: sharedText, metadata: {}, similarity: 0.9 },
      { content_type: "task", content_id: "task-2", content_text: sharedText, metadata: {}, similarity: 0.85 },
      makeRow("Different content entirely about something else", "2026-03-21T10-00-00-000Z-other.json"),
    ];

    const { deduped } = deduplicateResults(rows);

    // 1 collapsed from the two no-source rows + 1 unique = 2
    expect(deduped).toHaveLength(2);
  });

  it("does not collapse operational_state headers that start similarly", () => {
    // These start similarly but diverge quickly — different sleep hours, dates, etc.
    const row1Text =
      "operational_state: sleep_hours: 7.5, physical_state: rested, energy_level: high, mood: focused. " +
      "Session on 2026-03-21 covered deployment automation and CI pipeline improvements.";
    const row2Text =
      "operational_state: sleep_hours: 6.0, physical_state: tired, energy_level: low, mood: stressed. " +
      "Session on 2026-04-01 focused on debugging authentication failures in production.";

    const rows = [
      makeRow(row1Text, "2026-03-21T10-00-00-000Z-aaa.json"),
      makeRow(row2Text, "2026-04-01T10-00-00-000Z-bbb.json"),
    ];

    const { deduped } = deduplicateResults(rows);

    // Should NOT collapse — these are genuinely different despite similar prefix
    expect(deduped).toHaveLength(2);
  });
});
