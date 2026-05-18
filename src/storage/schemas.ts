import { z } from "zod";

export const HandoffSchema = z
  .object({
    operational_state: z
      .object({
        sleep_hours: z.string().optional(),
        physical_state: z.string().optional(),
        energy_level: z.string().optional(),
        mood: z.string().optional(),
      })
      .optional(),
    active_context: z.record(z.string(), z.unknown()).optional(),
    /**
     * @deprecated Handoff task arrays are deprecated since schema 1.3. The
     * Postgres tasks table is authoritative; use create_task / update_task.
     * Accepted on input for backwards compatibility but stripped server-side
     * before storage. Historical handoffs on disk may still contain this
     * field — read it defensively, never write it.
     */
    tasks: z
      .object({
        completed: z.array(z.string()).optional(),
        open: z.array(z.string()).optional(),
        blocked: z.array(z.string()).optional(),
      })
      .optional(),
    tone_notes: z.string().optional(),
    timezone: z.string().optional(),
    stored_at: z.string().optional(),
    schema_version: z.string().optional(),
  })
  .passthrough();

export type Handoff = z.infer<typeof HandoffSchema>;
