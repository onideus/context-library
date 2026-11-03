import { z } from "zod";
import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { config } from "../config.js";
import { applyEdits, type ContentEdit } from "./note-edits.js";

/**
 * Deprecated tool names, kept for ONE release as aliases of their renamed
 * tools (old name → new name). Registered only while LEGACY_TOOL_NAMES is on
 * (the default). Removing the aliases next release means deleting these
 * entries, the str_replace_note adapter below, and the config flag.
 */
export const TOOL_ALIASES: Readonly<Record<string, string>> = {
  store_handoff: "create_handoff",
  patch_handoff: "update_handoff",
  store_artifact: "create_artifact",
  patch_artifact: "edit_artifact",
  str_replace_note: "edit_note",
  browse_entities: "list_entities",
  entity_relations: "get_entity_relations",
  run_extraction: "create_extraction_run",
  compare_extractions: "compare_extraction_runs",
};

/** The deprecated names that point at `newName`. */
export function legacyNamesFor(newName: string): string[] {
  return Object.entries(TOOL_ALIASES)
    .filter(([, target]) => target === newName)
    .map(([old]) => old);
}

export function aliasDescription(newName: string): string {
  return `Deprecated alias of ${newName}. Use ${newName}; this name is removed in the next release.`;
}

/**
 * A legacy alias that does NOT share the new tool's schema and handler.
 * Only str_replace_note needs one (edit_note changed the input shape).
 */
export interface LegacyAdapter {
  schema: z.ZodRawShape;
  handler: (args: never) => Promise<CallToolResult>;
}

/**
 * Register a tool under `name` and, while LEGACY_TOOL_NAMES is on, under each
 * deprecated name from TOOL_ALIASES. An alias gets the same schema and
 * handler (unless `adapters` supplies one for that old name), the
 * deprecation description, and logs one line per call so remaining callers
 * show up in the server log.
 */
export function registerTool<Args extends z.ZodRawShape>(
  mcpServer: McpServer,
  name: string,
  description: string,
  schema: Args,
  handler: ToolCallback<Args>,
  adapters: Record<string, LegacyAdapter> = {}
): void {
  mcpServer.tool(name, description, schema, handler);
  if (!config.legacyToolNames) return;

  for (const oldName of legacyNamesFor(name)) {
    const adapter = adapters[oldName];
    const aliasSchema = (adapter?.schema ?? schema) as Args;
    const target = (adapter?.handler ?? handler) as ToolCallback<Args>;
    const aliasHandler = ((args, extra) => {
      console.log(`[deprecated-tool] ${oldName} called; use ${name}`);
      return target(args, extra);
    }) as ToolCallback<Args>;
    mcpServer.tool(oldName, aliasDescription(name), aliasSchema, aliasHandler);
  }
}

// ── str_replace_note adapter ─────────────────────────────────────

/**
 * Runs one content edit against a note under its row lock and writes it as
 * edit_note would (see editNoteContent in notes.ts). Injected so this module
 * does not import the notes tool module.
 */
export type NoteContentEditor = (
  id: string,
  expectedVersion: number | undefined,
  edit: (content: string) => ContentEdit
) => Promise<CallToolResult>;

function legacyJsonResponse(data: unknown): CallToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

/**
 * The deprecated str_replace_note keeps its OLD contract exactly: single
 * old_str/new_str input, `replacements` as a number, handler-level
 * VALIDATION_ERROR for an empty old_str, and the old NO_MATCH /
 * AMBIGUOUS_MATCH messages without edit_index. Matching goes through the
 * shared applyEdits; the write is edit_note's (changed_via 'edit_note').
 */
export function strReplaceNoteAdapter(editNote: NoteContentEditor): LegacyAdapter {
  const schema = {
    id: z.string().describe("UUID of the note to edit"),
    old_str: z
      .string()
      .describe("Exact text to find (literal, case- and whitespace-sensitive, not a regex)"),
    new_str: z
      .string()
      .describe("Replacement text, inserted verbatim. Empty string deletes old_str"),
    replace_all: z
      .boolean()
      .optional()
      .describe("Replace every occurrence instead of requiring exactly one (default false)"),
    expected_version: z.number().int().min(1).optional().describe(
      "Optimistic-concurrency precondition: the note's 'version' as you last saw it (from get_note or a previous response). Enforced whenever present; on mismatch nothing is written and VERSION_CONFLICT returns the current note. Omit for last-writer-wins."
    ),
  };
  type LegacyArgs = {
    id: string;
    old_str: string;
    new_str: string;
    replace_all?: boolean;
    expected_version?: number;
  };

  const handler = async (args: LegacyArgs): Promise<CallToolResult> => {
    if (!args.old_str) {
      return legacyJsonResponse({
        error: true,
        message: "old_str must be a non-empty string",
        code: "VALIDATION_ERROR",
      });
    }
    try {
      return await editNote(args.id, args.expected_version, (content): ContentEdit => {
        const result = applyEdits(content, [
          { old_str: args.old_str, new_str: args.new_str, replace_all: args.replace_all },
        ]);
        if (!result.ok) {
          return result.code === "NO_MATCH"
            ? {
                ok: false,
                message: "old_str was not found in the note content. Call get_note and copy the text exactly.",
                code: "NO_MATCH",
                match_count: 0,
              }
            : {
                ok: false,
                message: `old_str matches ${result.match_count} times. Widen old_str with surrounding text to make it unique, or pass replace_all: true.`,
                code: "AMBIGUOUS_MATCH",
                match_count: result.match_count,
              };
        }
        return { ok: true, content: result.content, replacements: result.replacements[0] };
      });
    } catch (err) {
      return legacyJsonResponse({ error: true, message: (err as Error).message, code: "DB_ERROR" });
    }
  };

  return { schema, handler: handler as LegacyAdapter["handler"] };
}
