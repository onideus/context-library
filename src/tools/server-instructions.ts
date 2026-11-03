/**
 * MCP server `instructions`: shared background sent once in the initialize
 * response instead of being repeated across tool descriptions.
 *
 * Some clients never show instructions to the model, so nothing a model needs
 * to call a tool correctly may live only here: each tool's description and
 * parameter descriptions must stand on their own. Name only tools that are
 * always registered (no deprecated aliases, no entity-graph tools);
 * tool-budget.test.ts checks this and the length cap.
 */
export const SERVER_INSTRUCTIONS = `Context Library is persistent memory shared across conversations and clients. It holds four kinds of content; put each piece of information in the right one.

- Handoffs: session state: where work stopped, what is in progress, how to approach the user next time. Short-lived; older handoffs are compacted. create_handoff saves the full state, update_handoff changes part of it.
- Tasks: action items with a lifecycle (open, completed, deferred, cancelled). The tasks table is the authoritative task store: do not keep task lists in handoffs or anywhere else.
- Notes: permanent knowledge: decisions and why, constraints, patterns, lessons, takeaways from sources. Every edit is versioned; a note replaced by a newer one is superseded, not deleted.
- Artifacts: generated outputs used later (prompts for coding agents, research reports, templates), with a status lifecycle from draft through ready, executing and completed, or superseded.

Rule of thumb: "research X" is a task; "we researched X and chose Y because Z" is a note; the report itself is an artifact. If a future session would have to dig through old handoffs to recover something, it belongs in a note.

Scope (tasks, notes, artifacts):
- work: job and project work.
- personal: health, family, finance, life admin.
- shared: reusable across both (architecture decisions, open-source work, general patterns).
Choose from the content; when it is unclear, ask. On list and search tools, omitting scope covers all three. get_latest_handoff and get_handoff have a different scope parameter (full, work, personal) that hides fields of a handoff.

Note provenance (where a note's content came from):
- stated: the user said it directly.
- decided: a decision reached in the conversation and agreed by the user.
- inferred: your own conclusion that the user did not confirm.
- fetched: taken from external material (also set source_url).
- derived: computed or aggregated from other notes, tasks or handoffs.
Use inferred whenever the user did not confirm the claim: a wrong stated or decided is later read as the user's own words and never questioned.

Session start:
1. Call get_latest_handoff before anything else. Read tone_notes and apply them. session_continuity tells you whether the loaded state is live (resume) or history (cold_start).
2. Before answering about prior work, decisions, people, projects or systems, search. search_context is the primary search (semantic, across all four kinds); search_notes, search_tasks and search_artifacts are keyword searches within one kind and keep working when semantic search is offline. Do not contradict a current note without the user's say-so.
3. task_summary and artifact_summary are computed live from the database; trust them over task or artifact text inside a handoff.

Read before write:
- Read the current record before changing it, and pass the precondition the tool offers: expected_version (notes), expected_content_hash (edit_artifact), expected_status (update_task, update_artifact), expected_source (update_handoff).
- On VERSION_CONFLICT, STATUS_CONFLICT or HANDOFF_CONFLICT nothing was written. Re-read, reconcile with what changed, and retry; do not re-send blindly or overwrite the other change.
- Search before creating a task, note or artifact, to avoid duplicates.

Session labels: set active_context.session_meta.label to YYYY-MM-DD-vNN, the date plus a two-digit counter for that day (for example 2026-04-10-v01), with surface and model when known. On the last write of a session, pass final=true.

Errors come back as JSON {error: true, code, message}; branch on code.`;
