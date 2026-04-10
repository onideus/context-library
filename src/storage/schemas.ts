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
    active_context: z.record(z.string(), z.any()).optional(),
    tasks: z
      .object({
        completed: z.array(z.string()).optional(),
        open: z.array(z.string()).optional(),
        blocked: z.array(z.string()).optional(),
      })
      .optional(),
    memory_deltas: z
      .array(
        z.object({
          slot: z.number(),
          action: z.enum(["add", "replace", "remove"]),
          content: z.string().optional(),
        })
      )
      .optional(),
    tone_notes: z.string().optional(),
    timezone: z.string().optional(),
    stored_at: z.string().optional(),
  })
  .passthrough();

export type Handoff = z.infer<typeof HandoffSchema>;
