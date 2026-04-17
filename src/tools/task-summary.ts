import { query } from "../db/client.js";

export interface DynamicTaskSummary {
  open_count: number;
  blocked_count: number;
  completed_count: number;
  critical_items: Array<{ id: string; title: string; due_date: string | null }>;
  due_this_week: Array<{ id: string; title: string; due_date: string }>;
  recently_completed: Array<{ id: string; title: string; completed_at: string }>;
  blocked_items: Array<{ id: string; title: string; blocked_reason: string }>;
}

interface CountRow {
  status: string;
  count: string;
}

interface BlockedCountRow {
  count: string;
}

interface CriticalRow {
  id: string;
  title: string;
  due_date: string | null;
}

interface DueRow {
  id: string;
  title: string;
  due_date: string;
}

interface CompletedRow {
  id: string;
  title: string;
  completed_at: string;
}

interface BlockedItemRow {
  id: string;
  title: string;
  blocked_reason: string;
}

/**
 * Compute the enriched task_summary from Postgres. Returns null if Postgres is
 * unavailable or any query fails, allowing callers to fall back to the
 * handoff-based count summary.
 */
export async function computeDynamicTaskSummary(): Promise<DynamicTaskSummary | null> {
  try {
    const [counts, blockedCount, critical, dueThisWeek, recentlyCompleted, blockedItems] =
      await Promise.all([
        query<CountRow>(
          `SELECT status::text AS status, count(*)::text AS count
           FROM tasks
           WHERE status IN ('open', 'completed')
           GROUP BY status`
        ),
        query<BlockedCountRow>(
          `SELECT count(*)::text AS count
           FROM tasks
           WHERE blocked_reason IS NOT NULL AND status = 'open'`
        ),
        query<CriticalRow>(
          `SELECT id, title, due_date
           FROM tasks
           WHERE status = 'open' AND priority = 'critical'
           ORDER BY due_date ASC NULLS LAST
           LIMIT 5`
        ),
        query<DueRow>(
          `SELECT id, title, due_date
           FROM tasks
           WHERE status = 'open'
             AND due_date BETWEEN NOW() AND NOW() + INTERVAL '7 days'
           ORDER BY due_date ASC`
        ),
        query<CompletedRow>(
          `SELECT id, title, completed_at
           FROM tasks
           WHERE status = 'completed'
           ORDER BY completed_at DESC NULLS LAST
           LIMIT 5`
        ),
        query<BlockedItemRow>(
          `SELECT id, title, blocked_reason
           FROM tasks
           WHERE status = 'open' AND blocked_reason IS NOT NULL
           ORDER BY created_at DESC`
        ),
      ]);

    let openCount = 0;
    let completedCount = 0;
    for (const row of counts.rows) {
      const n = parseInt(row.count, 10);
      if (row.status === "open") openCount = n;
      else if (row.status === "completed") completedCount = n;
    }

    return {
      open_count: openCount,
      blocked_count: parseInt(blockedCount.rows[0]?.count ?? "0", 10),
      completed_count: completedCount,
      critical_items: critical.rows.map((r) => ({
        id: r.id,
        title: r.title,
        due_date: r.due_date,
      })),
      due_this_week: dueThisWeek.rows.map((r) => ({
        id: r.id,
        title: r.title,
        due_date: r.due_date,
      })),
      recently_completed: recentlyCompleted.rows.map((r) => ({
        id: r.id,
        title: r.title,
        completed_at: r.completed_at,
      })),
      blocked_items: blockedItems.rows.map((r) => ({
        id: r.id,
        title: r.title,
        blocked_reason: r.blocked_reason,
      })),
    };
  } catch {
    return null;
  }
}
