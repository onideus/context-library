import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerPrompts(server: McpServer): void {
  server.prompt(
    "session_start",
    "Initialize a session by loading handoff state and checking for relevant prior decisions. Use this at the start of every conversation.",
    { topic: z.string().optional().describe("Primary topic for this session, if known") },
    async (args) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              "Starting a new session. Complete these steps before responding:",
              "",
              "1. Call get_latest_handoff to load current state. Read tone_notes before proceeding.",
              "2. Review task_summary for critical items and due dates.",
              args.topic
                ? `3. Call search_notes with query "${args.topic}" to load relevant prior decisions.`
                : "3. If a topic emerges, call search_notes before making recommendations.",
              "4. Note any open tasks related to the current topic.",
              "",
              "Do not skip these steps. Respond with a brief status summary after loading context.",
            ].join("\n"),
          },
        },
      ],
    })
  );

  server.prompt(
    "architect",
    "Load architectural context before discussing design decisions. Searches notes and artifacts for prior decisions on the given topic.",
    { topic: z.string().describe("Architecture topic to research (e.g., 'pipeline', 'embeddings', 'auth')") },
    async (args) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Architecture discussion: ${args.topic}`,
              "",
              "Before we discuss, complete these retrieval steps:",
              `1. Call search_notes with query "${args.topic}" to find documented decisions.`,
              `2. Call search_context with query "${args.topic}" and content_types ["note", "artifact"] for semantic matches.`,
              `3. Call search_tasks with query "${args.topic}" to find related open work.`,
              "",
              "Summarize what you found -- prior decisions, constraints, open work -- then we can discuss.",
            ].join("\n"),
          },
        },
      ],
    })
  );

  server.prompt(
    "plan",
    "Load task and artifact state before planning new work. Prevents duplicate task creation and contradictory decisions.",
    { area: z.string().describe("Work area to plan (e.g., 'context-library', 'pipeline', 'demo')") },
    async (args) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Planning session: ${args.area}`,
              "",
              "Before creating any tasks or artifacts:",
              "1. Call get_latest_handoff to load current session state.",
              `2. Call search_tasks with query "${args.area}" to see existing open/blocked work.`,
              `3. Call search_artifacts with query "${args.area}" to find queued or in-progress artifacts.`,
              `4. Call search_notes with query "${args.area}" to check for relevant decisions.`,
              "",
              "Present: open tasks, blocked items, queued artifacts, and relevant decisions. Then we can plan.",
            ].join("\n"),
          },
        },
      ],
    })
  );
}
