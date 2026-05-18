import { describe, it, expect } from "vitest";
import { compactHandoff, COMPACTED_FLAG } from "../tools/compaction.js";
import type { Handoff } from "../storage/schemas.js";

// Compaction is exercised on historical handoff files that may still
// contain legacy task arrays (deprecated since schema 1.3). The fixture
// mimics that pre-1.3 shape so we can assert compaction's archival
// behavior on real on-disk content.
function makeHandoff(overrides: Partial<Handoff> = {}): Handoff {
  return {
    operational_state: {
      sleep_hours: "7",
      energy_level: "high",
      mood: "focused",
    },
    active_context: {
      session_meta: { label: "2026-04-17-v01", surface: "test", model: "haiku" },
      conversation_arc: "Exploring compaction design; settled on three-tier scheme.",
      key_decisions: ["Adopt three-tier schema", "Skip when pending embedding queued"],
      research_notes: "Lots of background reading on token budgets...",
    },
    tasks: {
      completed: ["old-a", "old-b", "old-c", "old-d", "recent-1", "recent-2", "recent-3"],
      open: ["next-up"],
      blocked: ["dep → waiting"],
    },
    tone_notes: "Be terse.",
    timezone: "America/New_York",
    stored_at: "2026-04-17T10:00:00.000-04:00",
    schema_version: "1.2",
    ...overrides,
  };
}

describe("compactHandoff", () => {
  it("trims tasks.completed to the last 3 items", () => {
    const { compacted, archived_keys } = compactHandoff(makeHandoff());
    expect(compacted.tasks?.completed).toEqual(["recent-1", "recent-2", "recent-3"]);
    expect(archived_keys).toContain("tasks.completed");
  });

  it("preserves tasks.completed when it already has 3 or fewer items", () => {
    const h = makeHandoff({
      tasks: { completed: ["a", "b"], open: [], blocked: [] },
    });
    const { compacted, archived_keys } = compactHandoff(h);
    expect(compacted.tasks?.completed).toEqual(["a", "b"]);
    expect(archived_keys).not.toContain("tasks.completed");
  });

  it("replaces active_context with compacted_summary and preserves session_meta", () => {
    const { compacted, archived_keys } = compactHandoff(makeHandoff());
    const ctx = compacted.active_context as Record<string, unknown>;
    expect(ctx).toBeDefined();
    expect(typeof ctx.compacted_summary).toBe("string");
    expect(ctx.compacted_summary).toMatch(/Session 2026-04-17-v01/);
    expect(ctx.session_meta).toEqual({
      label: "2026-04-17-v01",
      surface: "test",
      model: "haiku",
    });
    // Research notes and conversation arc detail gone from JSON (searchable via vector index).
    expect(ctx.conversation_arc).toBeUndefined();
    expect(ctx.research_notes).toBeUndefined();
    expect(ctx.key_decisions).toBeUndefined();
    expect(archived_keys).toContain("active_context");
  });

  it("falls back to a key_decision when conversation_arc is absent", () => {
    const h = makeHandoff({
      active_context: {
        key_decisions: ["Rolled back the migration", "Opened incident"],
      },
    });
    const { compacted } = compactHandoff(h);
    const ctx = compacted.active_context as Record<string, unknown>;
    expect(ctx.compacted_summary).toMatch(/Rolled back the migration/);
  });

  it("removes memory_deltas entirely on legacy historical handoffs", () => {
    const h = makeHandoff();
    (h as Record<string, unknown>).memory_deltas = [
      { slot: 1, action: "add", content: "delta-1" },
    ];
    const { compacted, archived_keys } = compactHandoff(h);
    expect((compacted as Record<string, unknown>).memory_deltas).toBeUndefined();
    expect(archived_keys).toContain("memory_deltas");
  });

  it("preserves operational_state, tone_notes, tasks.open, tasks.blocked, and metadata", () => {
    const h = makeHandoff();
    const { compacted } = compactHandoff(h);
    expect(compacted.operational_state).toEqual(h.operational_state);
    expect(compacted.tone_notes).toBe(h.tone_notes);
    expect(compacted.tasks?.open).toEqual(h.tasks?.open);
    expect(compacted.tasks?.blocked).toEqual(h.tasks?.blocked);
    expect(compacted.timezone).toBe(h.timezone);
    expect(compacted.stored_at).toBe(h.stored_at);
    expect(compacted.schema_version).toBe(h.schema_version);
  });

  it("sets the _compacted flag on the compacted result", () => {
    const { compacted } = compactHandoff(makeHandoff());
    expect((compacted as Record<string, unknown>)[COMPACTED_FLAG]).toBe(true);
  });

  it("is idempotent — already-compacted handoffs pass through unchanged", () => {
    const { compacted: once } = compactHandoff(makeHandoff());
    const { compacted: twice, archived_keys, original_size, compacted_size } =
      compactHandoff(once);
    expect(twice).toEqual(once);
    expect(archived_keys).toEqual([]);
    expect(original_size).toBe(compacted_size);
  });

  it("reports original_size and compacted_size accurately", () => {
    const h = makeHandoff();
    const { original_size, compacted_size } = compactHandoff(h);
    expect(original_size).toBe(JSON.stringify(h).length);
    // Compaction must reduce size for this fixture (lots of active_context content + long completed list).
    expect(compacted_size).toBeLessThan(original_size);
  });

  it("handles a minimal handoff with no active_context gracefully", () => {
    const minimal: Handoff = {
      tone_notes: "short",
      stored_at: "2026-04-17T10:00:00.000-04:00",
      schema_version: "1.3",
    };
    const { compacted, archived_keys } = compactHandoff(minimal);
    expect(compacted.tone_notes).toBe("short");
    expect(archived_keys).toEqual([]);
    expect((compacted as Record<string, unknown>)[COMPACTED_FLAG]).toBe(true);
  });
});
