import type { Handoff } from "../storage/schemas.js";

interface ArrayOp {
  op: "append" | "remove" | "replace";
  items: string[];
}

/**
 * Patch input accepted by mergeHandoff.
 *
 * Note: the `tasks` field is no longer processed by merge (deprecated since
 * schema 1.3). The patch_handoff handler strips `tasks` from both the patch
 * and the source handoff before calling merge, so the legacy task arrays
 * never propagate into new files. The field stays in the type for callers
 * that still type-check against the old shape.
 */
interface PatchInput {
  operational_state?: Record<string, string | undefined> | null;
  active_context?: Record<string, unknown> | null;
  tasks?: {
    completed?: ArrayOp | null;
    open?: ArrayOp | null;
    blocked?: ArrayOp | null;
  } | null;
  tone_notes?: string | null;
  timezone?: string | null;
}

export function mergeHandoff(
  original: Handoff,
  patch: PatchInput
): { merged: Handoff; patchedFields: string[] } {
  const merged: Handoff = { ...original };
  const patchedFields: string[] = [];

  // Scalars — direct overwrite (null means "no change")
  if (patch.tone_notes !== undefined && patch.tone_notes !== null) {
    merged.tone_notes = patch.tone_notes;
    patchedFields.push("tone_notes");
  }
  if (patch.timezone !== undefined && patch.timezone !== null) {
    merged.timezone = patch.timezone;
    patchedFields.push("timezone");
  }

  // Objects — deep merge
  if (patch.operational_state !== undefined && patch.operational_state !== null) {
    merged.operational_state = {
      ...(original.operational_state || {}),
      ...patch.operational_state,
    };
    patchedFields.push("operational_state");
  }
  if (patch.active_context !== undefined && patch.active_context !== null) {
    merged.active_context = {
      ...(original.active_context || {}),
      ...patch.active_context,
    };
    patchedFields.push("active_context");
  }

  return { merged, patchedFields };
}

export type { PatchInput, ArrayOp };
