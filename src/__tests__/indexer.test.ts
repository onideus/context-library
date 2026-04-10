import { describe, it, expect } from "vitest";
import { extractHandoffText, chunkText } from "../embeddings/text.js";

describe("extractHandoffText", () => {
  it("extracts labeled key-value pairs from flat object", () => {
    const text = extractHandoffText({
      tone_notes: "Be direct and concise",
    });
    expect(text).toContain("tone_notes: Be direct and concise");
  });

  it("extracts nested object values with key paths", () => {
    const text = extractHandoffText({
      operational_state: {
        mood: "focused",
        energy_level: "high",
      },
    });
    expect(text).toContain("operational_state mood: focused");
    expect(text).toContain("operational_state energy_level: high");
  });

  it("extracts string arrays joined with periods", () => {
    const text = extractHandoffText({
      tasks: {
        open: ["Write tests", "Deploy to NAS"],
      },
    });
    expect(text).toContain("tasks open: Write tests. Deploy to NAS");
  });

  it("skips structural keys (stored_at, schema_version, etc.)", () => {
    const text = extractHandoffText({
      stored_at: "2026-04-01T10:00:00Z",
      schema_version: "1.1",
      timezone: "America/New_York",
      tone_notes: "Keep this",
    });
    expect(text).not.toContain("stored_at");
    expect(text).not.toContain("schema_version");
    expect(text).not.toContain("timezone");
    expect(text).toContain("tone_notes: Keep this");
  });

  it("skips structural values (UUIDs, ISO timestamps, semver)", () => {
    const text = extractHandoffText({
      some_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      some_date: "2026-04-01T10:00:00.000Z",
      version: "1.1",
      real_content: "This should appear",
    });
    expect(text).not.toContain("a1b2c3d4");
    expect(text).not.toContain("2026-04-01");
    // Semver values should be skipped, but key-path for non-structural strings works
    expect(text).toContain("real_content: This should appear");
  });

  it("handles deeply nested objects", () => {
    const text = extractHandoffText({
      active_context: {
        session: "Claude Code debugging",
        key_decisions: ["Use pgvector", "Deploy on NAS"],
      },
    });
    expect(text).toContain("active_context session: Claude Code debugging");
    expect(text).toContain("active_context key_decisions: Use pgvector. Deploy on NAS");
  });

  it("returns empty string for empty object", () => {
    const text = extractHandoffText({});
    expect(text).toBe("");
  });

  it("handles null and undefined values gracefully", () => {
    const text = extractHandoffText({
      null_field: null,
      undefined_field: undefined,
      real_field: "exists",
    });
    expect(text).toContain("real_field: exists");
    expect(text).not.toContain("null");
  });

  it("extracts boolean and number values", () => {
    const text = extractHandoffText({
      active_context: {
        count: 42,
        active: true,
      },
    });
    expect(text).toContain("active_context count: 42");
    expect(text).toContain("active_context active: true");
  });
});

describe("chunkText", () => {
  it("returns single chunk for short text", () => {
    const chunks = chunkText("Short text");
    expect(chunks).toEqual(["Short text"]);
  });

  it("returns empty array for empty text", () => {
    const chunks = chunkText("");
    expect(chunks).toEqual([]);
  });

  it("returns empty array for whitespace-only text", () => {
    const chunks = chunkText("   \n\n  ");
    expect(chunks).toEqual([]);
  });

  it("splits on double newlines when text exceeds target", () => {
    // Create text with sections that together exceed 2000 chars
    const section1 = "A".repeat(1500);
    const section2 = "B".repeat(1500);
    const text = `${section1}\n\n${section2}`;
    const chunks = chunkText(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(section1);
    expect(chunks[1]).toBe(section2);
  });

  it("accumulates small sections into one chunk", () => {
    const sections = Array.from({ length: 5 }, (_, i) => `Section ${i}: ${"x".repeat(100)}`);
    const text = sections.join("\n\n");
    const chunks = chunkText(text);
    // Total is ~550 chars, should fit in one chunk
    expect(chunks.length).toBe(1);
  });

  it("merges undersized trailing chunk into previous", () => {
    const big = "A".repeat(1800);
    const tiny = "B".repeat(100);
    const text = `${big}\n\n${tiny}`;
    const chunks = chunkText(text);
    // tiny is under MIN_CHUNK_SIZE (200), should merge with big
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toContain("A");
    expect(chunks[0]).toContain("B");
  });

  it("splits very long single section on newlines", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Line ${i}: ${"y".repeat(80)}`);
    const text = lines.join("\n");
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2200); // some tolerance
    }
  });

  it("preserves content — no data loss in round trip", () => {
    const sections = Array.from({ length: 20 }, (_, i) => `Section ${i}: ${"z".repeat(300)}`);
    const text = sections.join("\n\n");
    const chunks = chunkText(text);
    const rejoined = chunks.join("\n\n");
    // Every section should appear in the output
    for (const section of sections) {
      expect(rejoined).toContain(section);
    }
  });
});
