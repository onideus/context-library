import type { Handoff } from "../storage/schemas.js";

/**
 * Compacted flag marker. Present on handoffs that have already been compacted
 * so repeated compaction passes are idempotent no-ops.
 */
export const COMPACTED_FLAG = "_compacted" as const;

export interface CompactionResult {
  compacted: Handoff;
  archived_keys: string[];
  original_size: number;
  compacted_size: number;
}

/** Keep the N most recent completed task entries; older items rely on the vector index. */
const COMPLETED_TASKS_KEEP = 3;

/**
 * Produce a compacted version of a stored handoff.
 *
 * Rules (see batch 5 prompt for full rationale):
 * - operational_state, tone_notes, tasks.open, tasks.blocked, metadata — preserved.
 * - tasks.completed — truncated to the last COMPLETED_TASKS_KEEP items.
 * - active_context — collapsed to {session_meta?, compacted_summary}. Full text
 *   was embedded during the original store, so it remains searchable.
 * - memory_deltas — removed (already applied at store time).
 * - Idempotent: a handoff with _compacted=true passes through unchanged.
 */
export function compactHandoff(handoff: Handoff): CompactionResult {
  const original_size = JSON.stringify(handoff).length;
  const alreadyCompacted = (handoff as Record<string, unknown>)[COMPACTED_FLAG] === true;

  if (alreadyCompacted) {
    return {
      compacted: handoff,
      archived_keys: [],
      original_size,
      compacted_size: original_size,
    };
  }

  const archived_keys: string[] = [];
  const compacted: Handoff = { ...handoff };

  if (compacted.tasks?.completed && compacted.tasks.completed.length > COMPLETED_TASKS_KEEP) {
    const keep = compacted.tasks.completed.slice(-COMPLETED_TASKS_KEEP);
    compacted.tasks = { ...compacted.tasks, completed: keep };
    archived_keys.push("tasks.completed");
  }

  if (compacted.active_context && Object.keys(compacted.active_context).length > 0) {
    const ctx = compacted.active_context;
    const sessionMeta = ctx.session_meta as Record<string, unknown> | undefined;
    const summary = buildContextSummary(ctx);
    const next: Record<string, unknown> = { compacted_summary: summary };
    if (sessionMeta) next.session_meta = sessionMeta;
    compacted.active_context = next;
    archived_keys.push("active_context");
  }

  if (compacted.memory_deltas !== undefined) {
    delete compacted.memory_deltas;
    archived_keys.push("memory_deltas");
  }

  (compacted as Record<string, unknown>)[COMPACTED_FLAG] = true;

  const compacted_size = JSON.stringify(compacted).length;

  return { compacted, archived_keys, original_size, compacted_size };
}

/** Derive a one-line summary from active_context for the compacted placeholder. */
function buildContextSummary(ctx: Record<string, unknown>): string {
  const meta = ctx.session_meta as Record<string, unknown> | undefined;
  const label = typeof meta?.label === "string" ? meta.label : undefined;
  const brief = firstBrief(ctx);
  const prefix = label ? `Session ${label}` : "Session";
  return brief ? `${prefix}: ${brief}` : prefix;
}

/** Pull a short descriptor from conversation_arc or the first key_decision. */
function firstBrief(ctx: Record<string, unknown>): string | null {
  const arc = ctx.conversation_arc;
  if (typeof arc === "string" && arc.trim()) return truncate(arc.trim(), 200);
  if (Array.isArray(arc) && arc.length > 0) {
    const first = arc[0];
    if (typeof first === "string" && first.trim()) return truncate(first.trim(), 200);
  }

  const decisions = ctx.key_decisions;
  if (Array.isArray(decisions) && decisions.length > 0) {
    const first = decisions[0];
    if (typeof first === "string" && first.trim()) return truncate(first.trim(), 200);
    if (first && typeof first === "object") {
      const text = (first as Record<string, unknown>).decision ?? (first as Record<string, unknown>).summary;
      if (typeof text === "string" && text.trim()) return truncate(text.trim(), 200);
    }
  }

  return null;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";
}
