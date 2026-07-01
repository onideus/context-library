# Handoff Lifecycle

Handoffs answer *Where am I?* They are the ephemeral session-boundary primitive: a snapshot of operational state, active work, and tone, written when a session ends and read when the next one begins. Everything durable — decisions, tasks, generated outputs — belongs in [notes](../../ROADMAP.md#design-philosophy-four-primitives), [tasks](../../ROADMAP.md#design-philosophy-four-primitives), or [artifacts](artifact-lifecycle.md). Handoffs are the *thin* layer.

The pipeline pattern depends on this discipline. If handoffs bloat into task databases or architecture snapshots, the interceptor cannot cleanly separate ephemeral state from the durable artifacts it is meant to execute.

## Store vs patch vs get

Three tools cover the whole lifecycle. Their descriptions are the contract of record — if this page and the tool descriptions disagree, the tool descriptions win.

| Tool | Purpose | When |
|---|---|---|
| `store_handoff` | Full-state capture | At session boundaries (start/end), before heavy context operations that risk compression, or when significant context has accumulated |
| `patch_handoff` | Partial update, merged onto the latest handoff | Mid-session updates (mood, tone_notes, appending to active_context) — cheaper than a full re-store |
| `get_latest_handoff` | Read most recent handoff | At session start, before any store/patch (to load current state), before evaluative or judgment-class responses |

Both `store_handoff` and `patch_handoff` are **append-only**: they always create a new timestamped file. `patch_handoff` merges the patch onto the previous file and writes the result; the previous file is not mutated. This is a deliberate design choice — see below.

## Merge semantics

`patch_handoff` combines a partial payload with the latest stored handoff:

- **Scalars** (`tone_notes`, `timezone`) — direct overwrite when provided, preserved when null or absent.
- **Objects** (`operational_state`, `active_context`) — deep merge at the top level. Provided keys overwrite, omitted keys are preserved.
- **Task arrays** — deprecated since schema 1.3, stripped server-side, logged as a structured warning. Tasks live in the tasks table; handoff array operations are no-ops.

The `final: true` flag on either tool closes the session: the stored handoff carries `session_closed=true` and a `session_closed_at` timestamp, and the next `get_latest_handoff` returns `session_continuity: "cold_start"` (after a threshold — reopening within ~15 minutes still reports `resume`).

## Session boundary discipline

The pipeline pattern assumes the operator can tell, from a single `get_latest_handoff` call, whether the previous session ended cleanly or was interrupted. That signal only exists if handoffs are actually written at session boundaries.

Recommended cadence:

- **Session start** — call `get_latest_handoff` first. Read `session_continuity`, `elapsed_seconds`, and `same_calendar_day` before doing anything else. `same_calendar_day=false` means operational state is stale and should be confirmed with the user.
- **Mid-session** — use `patch_handoff` for small updates (mood shift, tone note revision, appending a decision to `active_context.conversation_arc`). Avoid re-stating the entire handoff every few turns.
- **Session end** — `store_handoff` with `final: true`. Include the session label in `active_context.session_meta.label`.
- **Never on an empty payload** — the server rejects `EMPTY_HANDOFF` / `EMPTY_PATCH`. That is the correct behavior; don't work around it.

## Session labeling convention

Session labels go in `active_context.session_meta.label` using the format `YYYY-MM-DD-vNN`:

- `YYYY-MM-DD` — the date the session started.
- `vNN` — the nth session on that date, zero-padded (`v01`, `v02`, …).

Example: `2026-03-15-v02` is the second session on March 15, 2026. Reset the counter each day. This convention makes handoff files and their embeddings cheap to correlate with a specific conversation in an operator's own log.

`session_meta` also carries optional `surface` (e.g., `"ide"`, `"terminal"`, `"desktop"`) and `model` (e.g., `"opus"`, `"sonnet"`, `"haiku"`) fields so a handoff can be attributed to the interface and model that produced it. These are advisory; the server doesn't parse them.

## Why append-only matters

The store is append-only for three reasons that matter to the pipeline:

1. **Audit trail.** Every handoff file is a checkpoint. If a session goes wrong and a bad handoff gets written, the previous good one is still on disk. Recovery is `get_handoff` on the older filename, not a database restore.
2. **Recoverability from bad writes.** A model that hallucinates a handoff, or a client that sends a truncated payload, cannot destroy prior state. It can only append a new file that the operator can then reject or overwrite with a corrected `store_handoff`.
3. **Embedding lineage.** Each handoff file is indexed separately. The semantic search index can be replayed against the history without reconstructing a mutation log.

The trade-off is disk cost. That is what `RETENTION_COUNT` and handoff compaction (`npm run compact-history`) address.

## Anti-patterns to avoid

Three specific failure modes recur when handoffs are misused. Each one degrades the pipeline's ability to trust the session signal.

### Temporal urgency claims propagating as fact

A handoff that says `"blocked on legal review, decision needed by Friday"` becomes canonical if it is not corrected on the next session. The next handoff will inherit the framing (via deep merge on `active_context`), and by the third session "needed by Friday" is being cited as background. If the deadline was speculative when written, mark it that way (`"blocked on legal review, tentative Friday target — confirm"`) or omit it entirely and put it in a task with a `due_date`. Tasks have a lifecycle; handoff prose does not.

### Handoffs as task database

The `tasks` field is deprecated. Task arrays inside handoffs are stripped server-side. This is not a compatibility bug — it is the design. Tasks belong in the tasks table where they have a status lifecycle, FTS, and a scope filter. A handoff that lists "todo: fix the migration" is a handoff that will still list "todo: fix the migration" three sessions after the migration was fixed, because there is no lifecycle to move it out.

If you find yourself writing tasks into `active_context`, stop and call `create_task` instead. The `task_summary` returned by `get_latest_handoff` is computed live from Postgres — the authoritative view — and will show them.

### Architecture snapshots that rot

`active_context` is for *what is happening right now*. It is not the place for "here's how the auth system works" or "the ingest pipeline uses Kafka." Those are notes. If an architectural description ends up in a handoff, it will be deep-merged into every subsequent handoff by the next `patch_handoff` — and it will be wrong the moment the architecture changes, because nothing forces a refresh. Notes have no lifecycle expectation, are searchable by meaning, and are the correct home for durable interpretation.

## What a healthy handoff looks like

- `operational_state` reflects the operator's current state at the moment of storage, not a running summary.
- `active_context` captures the conversation arc, key decisions made *this session*, and immediate next steps.
- `active_context.session_meta` carries the label, surface, and model.
- `tone_notes` is short and actionable, not a personality profile.
- `timezone` is set — many derived fields (`same_calendar_day`, `stored_at_local`) depend on it.
- No `tasks` field; no architecture prose; no dates asserted as urgent without a task backing them.

See [examples/example-handoff.json](examples/example-handoff.json) for a complete valid handoff following these conventions.
