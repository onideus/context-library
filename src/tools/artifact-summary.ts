import { query } from "../db/client.js";

export interface ArtifactSummaryItem {
  id: string;
  title: string;
  artifact_type: string;
  execution_order: number | null;
}

export interface ArtifactSummaryCompletedItem extends ArtifactSummaryItem {
  completed_at: string;
}

export interface DynamicArtifactSummary {
  ready_count: number;
  executing_count: number;
  draft_count: number;
  completed_count: number;
  recently_completed: ArtifactSummaryCompletedItem[];
  currently_executing: ArtifactSummaryItem[];
  ready_queue: ArtifactSummaryItem[];
}

interface CountRow {
  status: string;
  count: string;
}

interface ItemRow {
  id: string;
  title: string;
  artifact_type: string;
  execution_order: number | null;
}

interface CompletedRow extends ItemRow {
  completed_at: string;
}

/**
 * Compute an enriched artifact_summary from Postgres. Returns null if
 * Postgres is unavailable or any query fails, allowing callers to omit the
 * field entirely under graceful degradation.
 *
 * recently_completed is scoped to artifacts whose `completed` state was
 * reached after the handoff was stored. We approximate "transitioned to
 * completed" using `updated_at` because the artifacts table does not carry
 * a dedicated completed_at column — status changes trigger updated_at via
 * the shared updated_at trigger, so this is the closest available signal.
 * Pass null/undefined for `handoffStoredAt` to disable the time filter.
 */
export async function computeDynamicArtifactSummary(
  handoffStoredAt?: string | null
): Promise<DynamicArtifactSummary | null> {
  try {
    const sinceMs = handoffStoredAt ? Date.parse(handoffStoredAt) : NaN;
    const since = !isNaN(sinceMs) ? new Date(sinceMs).toISOString() : null;

    const recentlyCompletedQuery = since
      ? query<CompletedRow>(
          `SELECT id, title, artifact_type, execution_order, updated_at AS completed_at
             FROM artifacts
             WHERE status = 'completed' AND updated_at > $1
             ORDER BY updated_at DESC
             LIMIT 10`,
          [since]
        )
      : query<CompletedRow>(
          `SELECT id, title, artifact_type, execution_order, updated_at AS completed_at
             FROM artifacts
             WHERE status = 'completed'
             ORDER BY updated_at DESC
             LIMIT 10`
        );

    const [counts, recentlyCompleted, currentlyExecuting, readyQueue] = await Promise.all([
      query<CountRow>(
        `SELECT status::text AS status, count(*)::text AS count
           FROM artifacts
           WHERE status IN ('draft', 'ready', 'executing', 'completed')
           GROUP BY status`
      ),
      recentlyCompletedQuery,
      query<ItemRow>(
        `SELECT id, title, artifact_type, execution_order
           FROM artifacts
           WHERE status = 'executing'
           ORDER BY execution_order ASC NULLS LAST, updated_at DESC`
      ),
      query<ItemRow>(
        `SELECT id, title, artifact_type, execution_order
           FROM artifacts
           WHERE status = 'ready'
           ORDER BY execution_order ASC NULLS LAST, created_at ASC
           LIMIT 10`
      ),
    ]);

    let draftCount = 0;
    let readyCount = 0;
    let executingCount = 0;
    let completedCount = 0;
    for (const row of counts.rows) {
      const n = parseInt(row.count, 10);
      if (row.status === "draft") draftCount = n;
      else if (row.status === "ready") readyCount = n;
      else if (row.status === "executing") executingCount = n;
      else if (row.status === "completed") completedCount = n;
    }

    return {
      ready_count: readyCount,
      executing_count: executingCount,
      draft_count: draftCount,
      completed_count: completedCount,
      recently_completed: recentlyCompleted.rows.map((r) => ({
        id: r.id,
        title: r.title,
        artifact_type: r.artifact_type,
        execution_order: r.execution_order,
        completed_at: r.completed_at,
      })),
      currently_executing: currentlyExecuting.rows.map((r) => ({
        id: r.id,
        title: r.title,
        artifact_type: r.artifact_type,
        execution_order: r.execution_order,
      })),
      ready_queue: readyQueue.rows.map((r) => ({
        id: r.id,
        title: r.title,
        artifact_type: r.artifact_type,
        execution_order: r.execution_order,
      })),
    };
  } catch {
    return null;
  }
}
