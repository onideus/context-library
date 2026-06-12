import { describe, it, expect } from "vitest";
import { mergeHandoff } from "../tools/merge.js";
import type { Handoff } from "../storage/schemas.js";

function baseHandoff(overrides: Partial<Handoff> = {}): Handoff {
  return {
    operational_state: { sleep_hours: "7", mood: "focused", energy_level: "high" },
    active_context: { session: "morning", surface: "claude-code" },
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

  describe("deprecated tasks field (schema 1.3)", () => {
    // tasks operations are stripped by the patch_handoff handler before
    // reaching merge, so mergeHandoff itself no longer processes them.
    // These tests assert that nothing is mutated even if a stray tasks
    // field slips through.
    it("ignores a tasks field on the patch input", () => {
      const { merged, patchedFields } = mergeHandoff(baseHandoff(), {
        tasks: { open: { op: "append", items: ["x"] } },
      });
      expect(merged.tasks).toBeUndefined();
      expect(patchedFields).not.toContain("tasks");
    });
  });

  describe("patchedFields tracking", () => {
    it("tracks all patched fields correctly", () => {
      const { patchedFields } = mergeHandoff(baseHandoff(), {
        tone_notes: "new",
        timezone: "UTC",
        operational_state: { mood: "happy" },
        active_context: { key: "val" },
      });
      expect(patchedFields).toEqual(
        expect.arrayContaining([
          "tone_notes", "timezone", "operational_state", "active_context",
        ])
      );
    });

    it("returns empty patchedFields for no-op patch", () => {
      const { patchedFields } = mergeHandoff(baseHandoff(), {});
      expect(patchedFields).toEqual([]);
    });
  });
});
