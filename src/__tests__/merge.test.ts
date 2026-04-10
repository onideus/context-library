import { describe, it, expect } from "vitest";
import { mergeHandoff } from "../tools/merge.js";
import type { Handoff } from "../storage/schemas.js";

function baseHandoff(overrides: Partial<Handoff> = {}): Handoff {
  return {
    operational_state: { sleep_hours: "7", mood: "focused", energy_level: "high" },
    active_context: { session: "morning", surface: "claude-code" },
    tasks: { completed: ["done-1"], open: ["open-1", "open-2"], blocked: ["blocked-1"] },
    tone_notes: "Original tone",
    timezone: "America/New_York",
    stored_at: "2026-04-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("mergeHandoff", () => {
  describe("scalar overwrites", () => {
    it("overwrites tone_notes when provided", () => {
      const { merged, patchedFields } = mergeHandoff(baseHandoff(), { tone_notes: "New tone" });
      expect(merged.tone_notes).toBe("New tone");
      expect(patchedFields).toContain("tone_notes");
    });

    it("preserves tone_notes when null", () => {
      const { merged, patchedFields } = mergeHandoff(baseHandoff(), { tone_notes: null });
      expect(merged.tone_notes).toBe("Original tone");
      expect(patchedFields).not.toContain("tone_notes");
    });

    it("preserves tone_notes when undefined", () => {
      const { merged } = mergeHandoff(baseHandoff(), {});
      expect(merged.tone_notes).toBe("Original tone");
    });

    it("overwrites timezone when provided", () => {
      const { merged, patchedFields } = mergeHandoff(baseHandoff(), { timezone: "America/Chicago" });
      expect(merged.timezone).toBe("America/Chicago");
      expect(patchedFields).toContain("timezone");
    });
  });

  describe("object deep merge", () => {
    it("deep merges operational_state, preserving unpatched keys", () => {
      const { merged } = mergeHandoff(baseHandoff(), {
        operational_state: { mood: "relaxed" },
      });
      expect(merged.operational_state?.mood).toBe("relaxed");
      expect(merged.operational_state?.sleep_hours).toBe("7");
      expect(merged.operational_state?.energy_level).toBe("high");
    });

    it("deep merges active_context, preserving unpatched keys", () => {
      const { merged } = mergeHandoff(baseHandoff(), {
        active_context: { conversation_arc: "deploying" },
      });
      expect(merged.active_context?.session).toBe("morning");
      expect(merged.active_context?.surface).toBe("claude-code");
      expect(merged.active_context?.conversation_arc).toBe("deploying");
    });

    it("preserves operational_state when null", () => {
      const { merged, patchedFields } = mergeHandoff(baseHandoff(), { operational_state: null });
      expect(merged.operational_state?.mood).toBe("focused");
      expect(patchedFields).not.toContain("operational_state");
    });

    it("handles merging into empty original operational_state", () => {
      const { merged } = mergeHandoff(baseHandoff({ operational_state: undefined }), {
        operational_state: { mood: "happy" },
      });
      expect(merged.operational_state?.mood).toBe("happy");
    });
  });

  describe("array operations", () => {
    it("appends to tasks.open", () => {
      const { merged } = mergeHandoff(baseHandoff(), {
        tasks: { open: { op: "append", items: ["open-3"] } },
      });
      expect(merged.tasks?.open).toEqual(["open-1", "open-2", "open-3"]);
    });

    it("removes from tasks.open", () => {
      const { merged } = mergeHandoff(baseHandoff(), {
        tasks: { open: { op: "remove", items: ["open-1"] } },
      });
      expect(merged.tasks?.open).toEqual(["open-2"]);
    });

    it("replaces tasks.completed entirely", () => {
      const { merged } = mergeHandoff(baseHandoff(), {
        tasks: { completed: { op: "replace", items: ["new-done-1", "new-done-2"] } },
      });
      expect(merged.tasks?.completed).toEqual(["new-done-1", "new-done-2"]);
    });

    it("preserves tasks.open when null op", () => {
      const { merged } = mergeHandoff(baseHandoff(), {
        tasks: { open: null, completed: { op: "append", items: ["done-2"] } },
      });
      expect(merged.tasks?.open).toEqual(["open-1", "open-2"]);
      expect(merged.tasks?.completed).toEqual(["done-1", "done-2"]);
    });

    it("handles multiple array ops in one patch", () => {
      const { merged } = mergeHandoff(baseHandoff(), {
        tasks: {
          open: { op: "remove", items: ["open-1"] },
          completed: { op: "append", items: ["open-1"] },
          blocked: { op: "replace", items: [] },
        },
      });
      expect(merged.tasks?.open).toEqual(["open-2"]);
      expect(merged.tasks?.completed).toEqual(["done-1", "open-1"]);
      expect(merged.tasks?.blocked).toEqual([]);
    });

    it("preserves all tasks when tasks is null", () => {
      const { merged, patchedFields } = mergeHandoff(baseHandoff(), { tasks: null });
      expect(merged.tasks?.open).toEqual(["open-1", "open-2"]);
      expect(patchedFields).not.toContain("tasks");
    });
  });

  describe("memory_deltas", () => {
    it("replaces memory_deltas (not merged)", () => {
      const original = baseHandoff({
        memory_deltas: [{ slot: 1, action: "add" as const, content: "old" }],
      });
      const { merged } = mergeHandoff(original, {
        memory_deltas: [{ slot: 2, action: "replace", content: "new" }],
      });
      expect(merged.memory_deltas).toEqual([{ slot: 2, action: "replace", content: "new" }]);
    });

    it("preserves memory_deltas when null", () => {
      const original = baseHandoff({
        memory_deltas: [{ slot: 1, action: "add" as const, content: "keep" }],
      });
      const { merged, patchedFields } = mergeHandoff(original, { memory_deltas: null });
      expect(merged.memory_deltas).toEqual([{ slot: 1, action: "add", content: "keep" }]);
      expect(patchedFields).not.toContain("memory_deltas");
    });
  });

  describe("patchedFields tracking", () => {
    it("tracks all patched fields correctly", () => {
      const { patchedFields } = mergeHandoff(baseHandoff(), {
        tone_notes: "new",
        timezone: "UTC",
        operational_state: { mood: "happy" },
        active_context: { key: "val" },
        tasks: { open: { op: "append", items: ["x"] } },
        memory_deltas: [{ slot: 0, action: "add", content: "y" }],
      });
      expect(patchedFields).toEqual(
        expect.arrayContaining([
          "tone_notes", "timezone", "operational_state",
          "active_context", "tasks", "memory_deltas",
        ])
      );
    });

    it("returns empty patchedFields for no-op patch", () => {
      const { patchedFields } = mergeHandoff(baseHandoff(), {});
      expect(patchedFields).toEqual([]);
    });
  });
});
