import type { Handoff } from "../storage/schemas.js";

interface ArrayOp {
  op: "append" | "remove" | "replace";
  items: string[];
}

interface PatchInput {
  operational_state?: Record<string, string | undefined> | null;
  active_context?: Record<string, unknown> | null;
  tasks?: {
    completed?: ArrayOp | null;
    open?: ArrayOp | null;
    blocked?: ArrayOp | null;
  } | null;
  memory_deltas?: Array<{ slot: number; action: string; content?: string }> | null;
  tone_notes?: string | null;
  timezone?: string | null;
}

function applyArrayOp(original: string[], op: ArrayOp): string[] {
  switch (op.op) {
    case "append":
      return [...original, ...op.items];
    case "remove":
      return original.filter((item) => !op.items.includes(item));
    case "replace":
      return [...op.items];
    default:
      return original;
  }
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

  // Tasks — explicit array operations
  if (patch.tasks !== undefined && patch.tasks !== null) {
    const origTasks = original.tasks || { completed: [], open: [], blocked: [] };
    const mergedTasks = { ...origTasks };

    for (const key of ["completed", "open", "blocked"] as const) {
      const op = patch.tasks[key];
      if (op !== undefined && op !== null) {
        mergedTasks[key] = applyArrayOp(origTasks[key] || [], op);
      }
    }

    merged.tasks = mergedTasks;
    patchedFields.push("tasks");
  }

  // memory_deltas — new deltas for this patch, not merged with original
  if (patch.memory_deltas !== undefined && patch.memory_deltas !== null) {
    merged.memory_deltas = patch.memory_deltas as Handoff["memory_deltas"];
    patchedFields.push("memory_deltas");
  }

  return { merged, patchedFields };
}

export type { PatchInput, ArrayOp };
