# Design: Note lifecycle, provenance, version history, edit preconditions

> Status: **proposed, revised after adversarial review** (awaiting the
> maintainer decisions in §12). Target: migration `013`, two stacked PRs
> (§11). Scope is the `notes` primitive only — tasks, artifacts, handoffs,
> consolidation, recency decay, and the retrieval eval harness are out of
> scope.

## 1. Problem

Notes are the "permanent knowledge" primitive but have no lifecycle. A note
recorded in March ("Acme Corp deploys on Fridays") and its reversal in May
("Acme Corp froze Friday deploys") both match a search today, and nothing
tells the model which one is current. The ROADMAP v0.12 entry sketches
`status` / `superseded_by` / `valid_until`. This design builds the full
note-side foundation:

1. **Lifecycle** — which version of a fact is current.
2. **Provenance** — where a note's content came from.
3. **Version history** — the prior content of a note is kept when it changes.
4. **Edit precondition** — two writers cannot silently overwrite each other.

All examples in this document are fictional ("Acme Corp", "Jane Developer",
"project-alpha").

## 2. Ground truth that shaped the design

Verified against `main` at the time of writing:

- `notes` has exactly the ten columns from `005_notes.sql`; an
  `updated_at` trigger exists. Twelve migrations exist; the next is `013`.
  `src/db/migrate.ts` sends each file as **one simple-protocol query**, so a
  multi-statement file runs as one implicit transaction and rolls back
  entirely on failure; `DO $$ … $$` blocks are fine.
- Every search SQL statement in `search_context` reads `FROM embeddings`.
  Nothing joins `notes` at query time, and `embeddings.metadata` for a note
  holds only `{note_id, domain, tags, scope, created_at}`. `update_note`
  only re-indexes on title/content/domain/tags changes, and `/sync/push`
  never re-indexes at all — so **`embeddings.metadata` cannot be trusted
  for lifecycle state**.
- `search_context` relies on `ORDER BY embedding <=> $1 LIMIT n` being
  served by the HNSW index. Nothing sets `hnsw.ef_search`, so the index
  returns at most the default 40 candidates and post-filters them — the
  CTE's `LIMIT 100` is already nominal. Anything that makes the planner
  abandon the index-ordered path (a join it cannot keep ordered through)
  turns the scan into an exact full scan.
- `search_context` has a third candidate path — graph-only candidates are
  fetched by `(content_type, content_id)` straight from `embeddings` — and a
  dedup step that collapses rows whose first 500 characters match, keeping
  whichever came first when no `source_file` is present.
- The MCP tool and the `/sync/push` applier are two separate SQL paths with
  no shared helper. The sync note `base_updated_at` check compares
  `String(Date)` to an ISO string, so by code reading a *correct*
  precondition is rejected as `STALE_BASE` (the task path uses
  `toISOString`). Tests only exercise a deliberately stale value.
- `/sync/changes` snapshots are `SELECT *` — new columns flow to pullers
  with no route change. `/sync/push` uses a `.strict()` payload schema (new
  fields must be added) but a **non-strict** `precondition` schema (unknown
  keys are silently dropped). The `op` enum is shared across entity types
  and the task/artifact appliers treat "anything not insert/delete" as an
  update.
- `scripts/export.ts` runs each table's `SELECT` as its own autocommit
  query — tables are **not** exported from one snapshot. `import.ts#loadTable`
  binds `row[col] ?? null`, so an old tarball lacking a new NOT NULL column
  fails to import; `tables.ts` drives both SELECT and INSERT from an
  explicit column list, so an unregistered column is silently dropped.
- PR #280 (`str_replace_note` / `append_note`) is open against `main`; its
  `editNoteContent` runs a direct `UPDATE notes SET content = …`.

## 3. Schema — migration `013_note_lifecycle.sql`

### 3.1 New columns on `notes`

| Column | Type | Default | Notes |
|---|---|---|---|
| `status` | `TEXT NOT NULL` | `'active'` | `CHECK (status IN ('active','superseded'))`. **`expired` is not a stored value** — §3.3. |
| `superseded_by` | `UUID` | `NULL` | `REFERENCES notes(id) DEFERRABLE INITIALLY IMMEDIATE` (NO ACTION). A raw `DELETE` of a successor **fails loudly** instead of leaving a predecessor "superseded by nothing"; the tool path re-points predecessors before deleting (§7). `DEFERRABLE` lets import load self-referencing rows in `id` order after `SET CONSTRAINTS ALL DEFERRED` (§9.3); it is `INITIALLY IMMEDIATE` so ordinary writes get FK errors at statement time, not at `COMMIT` (where the helper cannot map them). |
| `superseded_at` | `TIMESTAMPTZ` | `NULL` | When the supersession was recorded. |
| `valid_until` | `TIMESTAMPTZ` | `NULL` | Author-declared expiry. `NULL` = none. |
| `provenance` | `TEXT` | `NULL` | `CHECK (provenance IN ('stated','decided','inferred','fetched','derived'))`. `NULL` = not recorded (every pre-migration row). |
| `version` | `INTEGER NOT NULL` | `1` | Monotonic per-note counter, bumped by the trigger in §3.5 on every effective `UPDATE`. The edit precondition compares against it. |

Existing rows backfill to `status='active', version=1`, everything else
`NULL`, through the column defaults — no `UPDATE` statement. On PG16 the
`ADD COLUMN … DEFAULT <constant>` is a catalog change; the CHECK and FK
additions scan the table under `ACCESS EXCLUSIVE`, which is negligible at
this scale and happens before the server starts listening.

### 3.2 Constraints

```sql
chk_notes_superseded_shape:  (status = 'superseded') = (superseded_by IS NOT NULL)
chk_notes_superseded_at:     (status = 'superseded') = (superseded_at IS NOT NULL)
chk_notes_no_self_supersede: superseded_by IS NULL OR superseded_by <> id
```

With the FK as `NO ACTION` these equivalences are safe (nothing can null
`superseded_by` behind the application's back), so the schema itself
guarantees a superseded note always names its successor. Constraints are
added by explicit name inside a `DO $$ … IF NOT EXISTS (SELECT 1 FROM
pg_constraint WHERE conrelid = 'notes'::regclass AND conname = …) …` block,
never inline on `ADD COLUMN IF NOT EXISTS`, so re-running the migration
neither errors nor duplicates them.

### 3.3 Expiry is computed, not stored

A note is **expired** when `status = 'active' AND valid_until IS NOT NULL
AND valid_until <= now()`. No cron, no stored flip, no drift between a flag
and the clock.

- Tool responses expose a computed `status` with three values
  (`active` | `superseded` | `expired`). Supersession wins when both apply
  — it carries more information (a successor).
- `/sync/changes` snapshots are raw rows: stored `status` plus
  `valid_until`. The client computes expiry with its own clock.
- Reviving an expired note is `update_note` with `valid_until: null` or a
  future date.

```sql
CASE
  WHEN status = 'superseded' THEN 'superseded'
  WHEN valid_until IS NOT NULL AND valid_until <= now() THEN 'expired'
  ELSE 'active'
END AS effective_status
```

### 3.4 Indexes

```sql
CREATE INDEX IF NOT EXISTS idx_notes_superseded_by ON notes (superseded_by)
    WHERE superseded_by IS NOT NULL;            -- reverse lookup, chain walk, delete splice
CREATE INDEX IF NOT EXISTS idx_notes_lifecycle ON notes (status, valid_until);
```

The lifecycle predicate is cheap at single-user scale (10³–10⁴ notes);
`idx_notes_superseded_by` is the one that matters (every `get_note`,
chain walk, and splice uses it).

### 3.5 `note_versions` and the versioning trigger

```sql
CREATE TABLE IF NOT EXISTS note_versions (
    note_id        UUID         NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    version        INTEGER      NOT NULL,
    snapshot       JSONB        NOT NULL,
    changed_fields TEXT[]       NOT NULL,
    changed_via    TEXT         NOT NULL,
    changed_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    PRIMARY KEY (note_id, version)
);
```

Row `(note_id, k)` is the note **as it was at version k**. History of a
note = its `note_versions` rows (v1…vN−1) plus the current row (vN).

**The invariant is enforced in the database**, not in application code. A
`BEFORE UPDATE` trigger `notes_version_history` on `notes`:

1. Computes `changed_fields` as the keys of `to_jsonb(OLD)` whose value
   differs in `to_jsonb(NEW)`, excluding `version` and `updated_at`.
2. If `changed_fields` is empty, restores `NEW.updated_at := OLD.updated_at`
   and returns — **a no-op `UPDATE` is a true no-op**: no version bump, no
   history row, no stale `expected_version` on other devices. (Trigger
   names sort so the existing `notes_updated_at` fires first; this trigger
   undoes its timestamp bump in the no-op case.)
3. Otherwise `INSERT INTO note_versions (note_id, version, snapshot,
   changed_fields, changed_via)` with `OLD.id`, `OLD.version`,
   `to_jsonb(OLD) - 'id' - 'version' - 'created_at'`, the diff, and
   `coalesce(nullif(current_setting('app.changed_via', true), ''), 'sql')`,
   then sets `NEW.version := OLD.version + 1`.

Consequences:

- Every writer is covered — MCP tools, `/sync/push`, PR #280's direct
  `UPDATE content`, an operator's `psql`. The merge order of #280 no longer
  opens a lost-update window (the follow-up for #280 is only to expose
  `expected_version`, §12 #6).
- `snapshot` is built server-side with `to_jsonb(OLD)` (microsecond
  timestamps, canonical key order), so a future `notes` column needs no
  `note_versions` migration. `snapshot.updated_at` is when version k began;
  the row's `changed_at` is when it ended.
- `changed_via` is whatever the write path put in the transaction-local GUC
  via `SET LOCAL app.changed_via = …` (`update_note`, `supersede_note`,
  `delete_note` for a splice, `sync_push`, `str_replace_note`,
  `append_note`); unknown writers record `'sql'`.
- No surrogate id: the composite PK round-trips through export/import and
  gives a deterministic `ORDER BY note_id, version`.
- `note_versions` is **not a sync entity** — never in `/sync/changes`, no
  push op — but is exported/imported (§9.3).

### 3.6 History retention

Unbounded history has two costs the review named: a secret pasted into a
note and then removed lives on in `note_versions` and in every nightly
export, and an `append_note`-style daily edit grows history quadratically.
Two controls, both decisions in §12 #12:

- `NOTE_HISTORY_MAX_VERSIONS` (env, default `0` = unlimited, matching the
  `RETENTION_COUNT` convention). When set, the shared helper deletes rows
  with `version <= current_version - 1 - N` after each successful write —
  history rows for a note at version v are v1…v−1, so this keeps exactly
  the newest N of them.
- `prune_note_history({ id, keep_last })` — a dedicated tool (not a mode on
  `update_note`) that deletes all but the newest `keep_last` history rows of
  one note; `keep_last: 0` purges history entirely. Writes a change-log row
  so pullers re-snapshot. Description says plainly that this is the only
  way to remove content that was edited out of a note.

## 4. Tool surface

Rule #1 of CLAUDE.md ("no polymorphic tools") is resolved in favor of a
**separate `supersede_note` tool**, overriding the ROADMAP sketch
("`update_note` gains a supersede action"). Supersession takes two ids,
validates both rows, and writes three columns atomically — a mode switch on
`update_note` would hide that.

### 4.1 `create_note` — new optional parameters

| Param | Type | Behaviour |
|---|---|---|
| `provenance` | enum | §4.6. Omitted → `NULL`. |
| `valid_until` | ISO-8601 **with offset** (`z.string().datetime({ offset: true })`) | Offset required on both MCP and sync paths — `Date.parse` treats an offset-less value as local time while Postgres uses the session zone; requiring the offset removes the ambiguity. Past dates are accepted (backfilling known-expired knowledge is legitimate). |

Response adds `version: 1`, `status: "active"`, `provenance`, and — when
`provenance` was omitted — a one-line `hint` to set it on the next write.

### 4.2 `update_note` — new optional parameters and history

| Param | Type | Behaviour |
|---|---|---|
| `provenance` | enum, nullable | `null` clears. |
| `valid_until` | ISO with offset, nullable | `null` clears (revives an expired note). |
| `expected_version` | integer | Precondition. **Enforced whenever present**, regardless of which fields the payload touches (the CLAUDE.md target semantic — never reintroduce "only enforce when X changes"). Mismatch → `VERSION_CONFLICT` with the current note. |

Order of checks: "at least one field provided" (`VALIDATION_ERROR`, no DB
round trip, as today) → row lock → `expected_version` → write. `update_note`
does **not** accept `status`, `superseded_by`, or `superseded_at`;
lifecycle moves only through `supersede_note` and the delete splice. Edits
to a superseded or expired note are allowed and versioned; status is
unaffected. A payload that changes nothing returns the unchanged row with
no version bump and no change-log row (§3.5 step 2).

### 4.3 `supersede_note` (new, write tool)

```
supersede_note({ id, superseded_by, expected_version? })
```

In one transaction (`supersedeNoteInTx`, §5):

1. `SELECT pg_advisory_xact_lock(<lifecycle-key>)` — §5 explains why.
2. `SELECT … FROM notes WHERE id IN ($1,$2) ORDER BY id FOR UPDATE`.
3. Validation, in order: either id missing → `NOT_FOUND` (response says
   which: `missing: "id" | "superseded_by"`); `id = superseded_by` →
   `INVALID_SUCCESSOR`; `expected_version` present and ≠ old `version` →
   `VERSION_CONFLICT`; old `status <> 'active'` → `STATUS_CONFLICT`
   (response carries the current row, so the caller sees by whom); the
   successor's effective status ≠ `active` → `INVALID_SUCCESSOR` (a
   superseded or expired note cannot be the current truth). Both rows being
   active makes cycles impossible by construction.
4. `SET LOCAL app.changed_via = 'supersede_note'`; `UPDATE notes SET
   status='superseded', superseded_by=$2, superseded_at=now() WHERE id=$1
   AND version=$v RETURNING *` (the trigger bumps `version` and writes the
   history row).
5. `appendChange('note', id, 'update')`. The successor row did not change,
   so no change-log row for it.

Returns `{ superseded: {id, title, version, superseded_by, superseded_at},
successor: {id, title} }`. No embedding re-index — search reads lifecycle
from `notes` (§6). Cross-scope supersession is allowed.

Description (cold-start): superseding is how a *replaced* decision is
retired without deleting it; the successor must already exist (create it
first); search redirects readers from the old note to the successor;
`delete_note` is for mistakes, `supersede_note` for changes of mind.

### 4.4 `get_note_history` (new, retrieval tool)

```
get_note_history({ id, limit?, offset? })
```

Newest-first; entry 0 is the current row (`is_current: true`), then
`note_versions` rows. `offset` counts from entry 0. Each entry: `version,
title, content, domain, tags, scope, source_url, related_task_ids,
provenance, valid_until, status, superseded_by, superseded_at,
changed_fields, changed_via, changed_at, is_current`. Default `limit` 10,
max 50. Content is included — "what did this say before" is the point.

Description follows CALL-THIS-WHEN / DO-NOT-CALL-WHEN /
CONSEQUENCE-OF-SKIPPING: call when a note reads differently than expected,
after a `VERSION_CONFLICT`, or when the user asks what a note used to say
or who changed it; do not call to browse (`list_notes`) or to find the
current fact (`search_notes`); consequence: overwriting another writer's
change or misattributing a revision.

### 4.5 Reads gain lifecycle fields

- `get_note` returns `status` (computed), `superseded_by`, `superseded_at`,
  `successor: {id, title} | null`, `supersedes: [id…]` (reverse lookup),
  `valid_until`, `provenance`, `version`.
- `list_notes` returns `status`, `valid_until`, `superseded_by`,
  `provenance`, `version` per item and gains a computed-`status` filter.
  **Default remains all statuses** — list is inventory, search is retrieval.
- `search_notes` — §6.

### 4.6 Provenance

| Value | Meaning | Example |
|---|---|---|
| `stated` | The user said it directly. | "Jane Developer said the Acme Corp cutover is 12 March." |
| `decided` | A decision reached in conversation and agreed by the user. | "We agreed project-alpha ships without the admin UI." |
| `inferred` | The assistant's own conclusion from evidence the user did not confirm. | "Build times suggest the CI runner is memory-bound." |
| `fetched` | Captured from external material; set `source_url`. | Takeaways from an article. |
| `derived` | Computed or aggregated from other notes/tasks/handoffs. | "Across six handoffs, deploys fail on Mondays." |

Steering in `create_note` / `update_note`: *"Set provenance on every note.
Be honest: `inferred` is correct whenever the user did not confirm the
claim — a wrong `stated` or `decided` will be treated as the user's own
words in future sessions and never challenged."* Existing rows stay `NULL`
("not recorded"); there is no default because a defaulted provenance is a
false one. `create_note` keeps it optional so existing clients and prompts
keep working.

### 4.7 Error codes

| Code | Where | Meaning |
|---|---|---|
| `VERSION_CONFLICT` | MCP `update_note`, `supersede_note`; sync `update`, `supersede` | `expected_version` ≠ current `version`; response carries the current note. Sibling of `STATUS_CONFLICT` / `HANDOFF_CONFLICT`. Checked **before** `base_updated_at` on sync, so it wins when both fail. |
| `STATUS_CONFLICT` | `supersede_note`; sync `supersede`, and sync `update` when `expected_status` is supplied | Stored status ≠ expected (`active` required for the note being superseded). |
| `INVALID_SUCCESSOR` | `supersede_note`; sync `supersede` | Self-supersede, or successor not effectively active. |
| `UNSUPPORTED_OP` | sync | `op: "supersede"` on a task or artifact — rejected per op, not per batch. |
| `STALE_BASE` | sync `update` | Existing; comparison fixed (§9.2). |
| `NOT_FOUND`, `VALIDATION_ERROR`, `DB_ERROR` | all | Existing. |

## 5. One write path, shared by MCP and sync — `src/notes/store.ts`

The trigger (§3.5) owns versioning and history. The shared module owns
everything else a write needs, so the MCP tool and `/sync/push` cannot
drift:

```ts
insertNoteInTx(client, fields, { id? })
updateNoteInTx(client, id, patch, { expectedVersion?, expectedStatus?, baseUpdatedAt?, via })
supersedeNoteInTx(client, id, successorId, { expectedVersion?, expectedStatus?, via })
deleteNoteInTx(client, id, { via })               → { deleted, relinked: NoteRow[] } | null
pruneNoteHistoryInTx(client, id, keepLast)
```

Each takes the caller's `PoolClient`, so the MCP `withTransaction` and the
sync dedupe-claim transaction both wrap it. Inside:

- **Row locks:** `SELECT … FOR UPDATE`, and when more than one row is
  involved, `ORDER BY id FOR UPDATE` so two transactions touching the same
  pair lock in the same order.
- **Lifecycle serialisation:** `supersedeNoteInTx` and `deleteNoteInTx`
  first take `pg_advisory_xact_lock(<constant key>)`. The review found a
  deadlock between a delete-splice (locks target, then predecessors) and a
  concurrent delete/supersede of an adjacent chain member (locks the other
  row, then waits on a predecessor). One advisory lock around *lifecycle*
  operations only — plain `update_note` does not take it — removes the
  cycle at a cost that is irrelevant at single-user scale.
- **Preconditions** against the locked row, in the order of §4.7.
- `SET LOCAL app.changed_via = $via` before the `UPDATE`, so the trigger
  records the writer.
- Conditional `UPDATE … WHERE id=$1 AND version=$v RETURNING *`. Zero rows
  after a successful lock means a concurrent `DELETE` — returned as
  not-found, matching today's `update_note` guard.
- `appendChange` only when `RETURNING version` advanced (a no-op update
  writes no change-log row).
- Retention trim (§3.6) when configured.

The last-writer-wins path (no `expected_version`) is preserved exactly —
now with a history row of what was overwritten.

Post-commit side effects (embedding re-index, entity extraction) stay in
the MCP handlers. The sync path gains the cheaper in-transaction equivalent
— §9.2.

## 6. Search behaviour

### 6.1 Redirect, do not hide

The first draft excluded superseded notes from default results. The review
showed that loses knowledge: a query that matches the *old* wording ("Friday
deploys") but not the successor's returns nothing, and `next_step` then
invites a duplicate note. So, by default, search **redirects**: a superseded
hit is replaced by the head of its chain, and the response says so.

Rules, shared by `search_notes` and `search_context`:

- Candidates are selected over **all statuses** except expired and orphaned
  (§6.3). Expired notes have no successor to redirect to, so they are
  dropped unless `include_expired: true`.
- Each superseded candidate is resolved to its chain head with a bounded
  recursive walk over `superseded_by` (depth ≤ 20; cycles are impossible by
  construction, the cap is belt-and-braces). If the head is expired, the
  candidate is dropped (unless `include_expired`). If the head is missing
  (should not happen under the NO ACTION FK) the candidate is dropped.
- The head replaces the candidate in the result list, carrying the
  candidate's rank/score and a `matched_via: [<old id>, …]` list. If the
  head was also matched directly, the two merge — best score wins,
  `matched_via` accumulates — so a chain never produces two rows.
- Every redirect emits a `lifecycle_notices` line: *"Note 2b7c… ('Acme Corp
  Friday deploys') matched but was superseded by 9e1a… ('Acme Corp deploy
  freeze') on 2026-05-02 — showing the successor."* Expired notes that are
  returned (opt-in) get *"Note 4f0d… expired on 2026-03-31."*
- `include_superseded: true` turns redirection off: superseded rows are
  returned as themselves with `superseded_by`, `superseded_at`,
  `successor_title`, and a notice. `include_expired: true` adds expired rows.
- `next_step` repeats the instruction to cite successors whenever notices
  are present.

### 6.2 `search_notes` (FTS over `notes`)

FTS match over all non-expired statuses; the chain walk, head fetch
(`LEFT JOIN notes succ` for `successor_title`, columns qualified), merge,
and notices happen in one follow-up query plus application code. Each
result carries `status` (computed), `superseded_by`, `superseded_at`,
`successor_title`, `valid_until`, `provenance`, `version`, `matched_via`.

### 6.3 `search_context` (hybrid over `embeddings`)

The embeddings table cannot answer lifecycle questions, and a join inside
the vector CTE can make the planner abandon the HNSW-ordered scan (§2). So
lifecycle enters as a **hashed subquery filter** that leaves the
index-ordered path intact, applied to both CTEs, the pure-vector branch,
and the graph-only candidate fetch:

```sql
AND (content_type <> 'note'
     OR content_id IN (SELECT id::text FROM notes WHERE <lifecycle predicate>))
```

- Default predicate: `valid_until IS NULL OR valid_until > now()` — i.e.
  drop expired notes and, because the subquery lists only rows that exist,
  drop orphaned embeddings for notes deleted via `/sync/push` (which never
  cleaned them up). With `include_expired` the predicate is `TRUE` (orphans
  still drop).
- The filter is added **only when notes are in scope** (`content_types`
  omitted or containing `note`). A handoff-only search never touches
  `notes`, so if migration 013 ever failed at startup (the runner logs and
  continues) only note-scoped searches degrade — not all search.
- `notes` are embedded unchunked with `content_id` = the note's uuid text,
  so `id::text` matches exactly.
- Redirection (§6.1) runs after candidate selection: one query fetches
  lifecycle for all note candidates and walks chains; heads not present in
  `embeddings` (e.g. a note inserted via sync before its queued embedding
  drained) are materialised from `notes.title`/`content` so the current
  fact is still shown.
- **Dedup rule change:** `deduplicateResults` collapses same-fingerprint
  rows keeping the first encountered; a copy-and-edit successor could be
  dropped in favour of the stale note. Note rows are **never collapsed
  across distinct `content_id`s** — two notes are two facts. Handoff chunk
  dedup is unchanged.
- `embeddings.metadata` is **not** extended with `status` (a copy the sync
  path can never refresh). `reindex` and `drainPendingEmbeddings` are
  unchanged and correctly include superseded notes.
- Regression guard: an `EXPLAIN` test (modelled on the content_hash index
  test in `sync.test.ts`, with `enable_seqscan = off`) asserts the semantic
  CTE still shows an index scan on the embeddings HNSW index with the
  lifecycle subquery present.
- Observed, not changed: `hnsw.ef_search` is at its default (40), so
  today's `LIMIT 100` candidate pool is nominal. Tuning it belongs to the
  v0.13 eval harness; listed as a follow-up in the PR.

### 6.4 `list_notes`

Default unchanged (all statuses, newest first); computed-`status` filter
added; status visible on every item.

### 6.5 Entity graph — non-goal

Triples extracted from a note stay in `entity_nodes` / `entity_relations`
after the note is superseded and keep contributing to graph-walk scores and
`browse_entities`. Filtering or down-weighting them is a follow-up under
the ROADMAP "graph-aware retrieval" item, not part of this change.

## 7. Delete semantics

`delete_note(id)` (MCP) and the sync `delete` op both route through
`deleteNoteInTx`:

1. Advisory lock (§5). `SELECT … FOR UPDATE` the target; absent →
   `NOT_FOUND` (MCP) / no-op tombstone (sync, today's replay-safe
   behaviour).
2. `SELECT … FROM notes WHERE superseded_by = $1 ORDER BY id FOR UPDATE` —
   the predecessors.
3. **Splice the chain** for each predecessor (`SET LOCAL app.changed_via =
   'delete_note'`):
   - if the deleted note was itself superseded, re-point the predecessor to
     that successor — A→B→C, delete B ⇒ A→C. `superseded_at` is **kept**
     (it records when the knowledge stopped being current; the re-point is
     bookkeeping);
   - if the deleted note was the end of the chain, **reactivate** the
     predecessor (`status='active'`, `superseded_by=NULL`,
     `superseded_at=NULL`) — nothing current says otherwise any more.
   The trigger versions each predecessor; the helper appends a change-log
   row for each so pullers re-snapshot.
4. `DELETE FROM notes WHERE id=$1` — now FK-clean; `note_versions` cascade.
5. `appendChange('note', id, 'delete')`.
6. After commit: best-effort `DELETE FROM embeddings` for the note (MCP does
   this today; the sync path gains it for parity).

Both the MCP response and the sync push result list `relinked: [{id,
status, superseded_by}]` (sync also returns their snapshots) so the caller
sees the side effect; `delete_note`'s description states it.

Why not the alternatives: *leave predecessors superseded with a null
successor* — silent knowledge loss and, under the new CHECK, impossible;
*refuse with `HAS_DEPENDENTS`* — no reactivate tool exists to make
progress; *keep history after delete* — `delete_note` promises permanent
deletion, and orphan history would make "delete" not delete content.

Deleting a **predecessor** has no cascade; the successor's `supersedes`
list shrinks.

## 8. Sync

### 8.1 `/sync/changes`

No route change: snapshots are `SELECT *`, so `status`, `superseded_by`,
`superseded_at`, `valid_until`, `provenance`, `version` appear
automatically. Clients compute expiry from `valid_until` (§3.3) and should
move to `version` as their edit precondition once they see it in
snapshots. `note_versions` never appears.

### 8.2 `/sync/push`

- `notePatchSchema` gains `provenance` (nullable enum) and `valid_until`
  (nullable ISO-with-offset). Not `status` / `superseded_by`.
- `precondition` becomes `.strict()` and gains `expected_version`
  (integer). Unknown keys are rejected rather than silently dropped — the
  review's scenario of a new client's `expected_version` being discarded
  by an older server (and the write applying unguarded) is the exact
  failure a strict schema makes visible.
- Note `update`: honours `expected_version` (`VERSION_CONFLICT`, checked
  first), `expected_status` against the stored status (`STATUS_CONFLICT` —
  today it is silently ignored for notes, which is the split CLAUDE.md
  forbids), and `base_updated_at` (`STALE_BASE`). **Bug fix:**
  `base_updated_at` is compared via `toISOString()` on the driver's `Date`
  with a string-equality fallback, as the task applier does, with a
  positive test.
- New op kind `supersede`, **notes only**: `{ op: "supersede", entity_id:
  <old>, payload: { superseded_by: <new> }, precondition: {
  expected_version?, expected_status? } }` → `supersedeNoteInTx`. Conflicts
  roll the transaction back so the `sync_op_log` claim disappears, as
  today. Change-log row is `update` on the old note. Task and artifact
  appliers gain an explicit `op === "update"` branch and return
  `UNSUPPORTED_OP` per op for anything else — the review showed
  `supersede` would otherwise be applied as a plain update and logged
  under the wrong op.
- Note `insert` and `update` **enqueue `pending_embeddings`** inside the
  push transaction (`INSERT … ON CONFLICT DO NOTHING`). No TEI call on the
  push path and nothing the client can observe; the existing drain (server
  startup, next `search_context`/`reindex`) embeds the note. Today a note
  inserted from mobile is never embedded, and after supersession that
  would make the current fact unreachable by semantic search.
- `delete` and `update` route through the shared helpers, so pushed edits
  are versioned and pushed deletes splice identically to MCP. Delete
  results include `relinked`.

Additive protocol change throughout — clients that never send `supersede`,
`expected_version`, or the new payload fields are unaffected.

## 9. Export / import

### 9.1 Export is one snapshot

`scripts/export.ts` currently reads each table in its own autocommit query.
With `note_versions` written in the same transaction as every note edit, a
nightly export racing an edit can capture `notes` at v3 and `note_versions`
holding `(Z,3)` — restore succeeds, and then every future `UPDATE` of Z
collides on the `(note_id, version)` primary key: **the note is
permanently uneditable**. Or `note_versions` references a note the earlier
`notes` read did not include and the restore fails half-way after a
`--force` truncate.

Fix: export runs every `SELECT` on **one client inside `BEGIN ISOLATION
LEVEL REPEATABLE READ READ ONLY`**. This also closes the pre-existing
latent skew between `entity_nodes` and `entity_relations`.

### 9.2 Import consistency pre-flight

Alongside the existing row-count pre-flight (before any DB write), import
checks that for every note in `notes.jsonl`, `max(note_versions.version)`
in `note_versions.jsonl` is `< notes.version`, and that every
`note_versions.note_id` exists in `notes.jsonl`. A violation fails fast as
"tarball inconsistent", the same class as today's "tarball corrupt".

### 9.3 Registry, FK deferral, old tarballs

- `notes.columns` += `status, superseded_by, superseded_at, valid_until,
  provenance, version` (after `related_task_ids`, before timestamps).
- New entry after `notes`: `note_versions` — `note_id, version, snapshot,
  changed_fields, changed_via, changed_at`; `orderBy: "note_id, version"`;
  `casts: { snapshot: "jsonb" }`.
- `loadTable` runs `SET CONSTRAINTS ALL DEFERRED` after `BEGIN`, so
  self-referencing `superseded_by` rows load in `id` order; the FK is
  checked at that table's `COMMIT`.
- **Absent column → `DEFAULT`:** a column missing from a JSONL row (as
  opposed to present with `null`) is emitted as SQL `DEFAULT`, with
  placeholders renumbered and no cast applied to the `DEFAULT` keyword.
  Without this every pre-013 tarball fails to restore (`status` NOT NULL).
  Neutral for current tarballs — the exporter always writes every column.
  The row→INSERT builder is extracted and unit-tested.
- A pre-013 tarball has no `note_versions.jsonl` and no manifest count for
  it → loads as zero rows. A 013 tarball into pre-013 code is refused by
  `verifyMigrations` before any truncation.
- `TRUNCATE … CASCADE` on `--force` is unaffected.
- `docs/backup-restore.md` spot-check adds `note_versions` to the psql
  count list.

## 10. Documentation updates

- **CLAUDE.md:** notes columns; `note_versions` table + trigger; migration
  count 13; tool lists (`supersede_note`, `get_note_history`,
  `prune_note_history`); a "Note lifecycle invariants" block (versioning
  and history are trigger-enforced; `expected_version` enforced whenever
  present on both paths; expiry computed; search redirects via `notes`,
  never via `embeddings.metadata`; lifecycle ops serialise on an advisory
  lock; export is one snapshot); sync section additions (`supersede` op,
  `VERSION_CONFLICT`, `UNSUPPORTED_OP`, strict precondition, snapshot
  fields, client-side expiry, pending-embeddings enqueue on push);
  "Last verified" header refreshed.
- **README.md:** tool rows + prose list; `include_superseded` /
  `include_expired`; `NOTE_HISTORY_MAX_VERSIONS`.
- **ROADMAP.md v0.12:** notes lifecycle + search awareness marked shipped
  with the "separate tool" correction; provenance + version history
  recorded; recency weighting and consolidation stay planned.
- **`.env.example`:** `NOTE_HISTORY_MAX_VERSIONS`.

## 11. PR plan — two stacked PRs

After the adversarial review the change is too large for one comfortable
review. Split along the one seam where the second half depends only on the
first half's *schema*:

**PR 1 — lifecycle foundation.** Migration 013 (columns, constraints,
`note_versions`, trigger); `src/notes/store.ts`; `create_note` /
`update_note` parameters; `supersede_note`, `get_note_history`,
`prune_note_history`; `get_note` / `list_notes` lifecycle fields; delete
splice; `/sync/push` changes (§8.2) and the `base_updated_at` fix;
export/import (§9); CLAUDE.md / README / ROADMAP / `.env.example`; all
tests except search. Search behaviour is untouched — superseded notes keep
appearing until PR 2 lands, which is today's behaviour, not a regression.

**PR 2 — search awareness.** `search_notes` and `search_context`
redirection, flags, annotations, notices; the dedup rule; the graph-only
fetch filter; the `EXPLAIN` guard; description updates; search tests.
Stacked on PR 1's branch; rebased onto `main` when PR 1 merges.

One commit per workstream inside each PR (migration · store · tools · sync
· portability · docs · tests) so review can proceed commit-by-commit.

## 12. Decisions for the maintainer

Recommendation first in each.

1. **Separate `supersede_note` tool vs an `update_note` status action.**
   Recommend the separate tool (CLAUDE.md rule #1; two ids, three-column
   atomic write, successor validation). The ROADMAP line is corrected.
2. **Expiry computed from `valid_until` vs a stored `expired` status.**
   Recommend computed (no cron, no drift, revivable); the `status` CHECK
   excludes `'expired'` so there is one source of truth.
3. **Provenance values and default.** Recommend the five values, nullable,
   no default (`NULL` = not recorded), optional on `create_note` with
   steering plus a response `hint`. Alternative: required on `create_note`
   (breaks existing prompts/clients).
4. **History mechanism and delete behaviour.** Recommend trigger-enforced
   versioning + history (covers every writer incl. PR #280 and raw SQL);
   no-op updates do not version; history cascades on delete; deleting a
   successor splices the chain (re-point, or reactivate at chain end).
   Alternative: app-code-only history (simpler SQL, weaker guarantee).
5. **Search default: redirect to successor vs hide.** Recommend redirect
   (§6.1) — hiding loses knowledge when the successor's wording differs or
   it is not yet embedded. Alternative: hide + notice only on opt-in.
6. **Build on PR #280 or on `main`.** Recommend `main`: #280 is open. New
   code lives in `src/notes/store.ts`; `notes.ts` edits are confined to
   imports, schemas, `formatNote`, the `update_note` / `delete_note`
   bodies, descriptions, and registrations appended at the end. Expected
   conflicts with #280 (all additive): `UPDATE_NOTE_DESC`, the tail of
   `registerNoteTools`, README line 50 + table rows, CLAUDE.md line 52,
   `notes.test.ts` appended blocks. Because the trigger versions #280's
   direct `UPDATE`, the only follow-up after #280 merges is exposing
   `expected_version` on `str_replace_note` / `append_note` via
   `updateNoteInTx` (folded in if #280 lands first).
7. **Sync `supersede` push op now vs later.** Recommend now (MCP/sync
   parity rule; small over the shared helper; additive).
8. **Precondition form.** Recommend `expected_version` (integer) on MCP;
   sync keeps `base_updated_at` (fixed) and adds `expected_version`, with
   `VERSION_CONFLICT` taking precedence.
9. **Fix the sync `base_updated_at` comparison and the missing
   `expected_status` enforcement for notes in PR 1.** Recommend yes — same
   code path, with the missing positive test.
10. **`list_notes` default.** Recommend all statuses + filter + visible
    status. Alternative: hide like search.
11. **A `reactivate_note` tool.** Recommend deferring; recovery for
    "superseded the wrong note" is deleting the successor (which splices or
    reactivates), and the NO ACTION FK means no unrecoverable state exists.
12. **History retention.** Recommend both `NOTE_HISTORY_MAX_VERSIONS`
    (default unlimited) and `prune_note_history` in PR 1 — the privacy case
    ("I edited a secret out of a note") has no other remedy. Alternative:
    defer both and document the limitation.
13. **Export under one `REPEATABLE READ` transaction.** Recommend yes in
    PR 1 — without it a restore can leave a note permanently uneditable.
14. **One PR vs two stacked.** Recommend two, split as §11.

Observed, out of scope, listed as follow-ups in the PR: `search_context`
returns `EMBEDDING_UNAVAILABLE` rather than falling back to FTS;
`hnsw.ef_search` is at the default 40; superseded notes' entity triples
stay live in graph retrieval; the `expected_status` MCP/sync asymmetry for
tasks and artifacts noted in CLAUDE.md is unchanged.

## Appendix — adversarial review, findings and resolutions

A cold reviewer attacked the first draft with only CLAUDE.md, the draft,
and the source. What changed:

| # | Finding | Resolution |
|---|---|---|
| 1 | Default hide drops superseded knowledge; sync-inserted notes never embedded, so the successor can be unreachable. | Redirect-to-head by default (§6.1); push path enqueues `pending_embeddings` (§8.2). |
| 2 | Export reads tables in separate snapshots → `notes`/`note_versions` skew → uneditable note or failed restore. | Single `REPEATABLE READ` export transaction; import pre-flight consistency check (§9.1–9.2). |
| 3 | `LEFT JOIN notes` inside the vector CTE can flip the HNSW plan. | Hashed `IN (subquery)` filter, applied only when notes are in scope; `EXPLAIN` guard (§6.3). |
| 4 | Delete-splice vs adjacent delete/supersede deadlocks; deferred FK errors surface at `COMMIT`. | Advisory lock around lifecycle ops; `ORDER BY id FOR UPDATE`; FK `INITIALLY IMMEDIATE`, deferred only inside import (§5, §3.1, §9.3). |
| 5 | Versioning in app code only; PR #280's direct `UPDATE` and raw SQL bypass it. | `BEFORE UPDATE` trigger owns version + history (§3.5). |
| 6 | `supersede` applied as update on tasks/artifacts; `expected_status` ignored for notes; non-strict precondition; splice side effects unreported. | `UNSUPPORTED_OP` per op; `expected_status` enforced; strict precondition; `relinked` in results (§8.2, §7). |
| 7 | History unprunable; privacy and growth. | `NOTE_HISTORY_MAX_VERSIONS` + `prune_note_history` as a decision (§3.6, §12 #12). |
| 8 | `ON DELETE SET NULL` leaves "superseded by nothing" with no recovery. | FK `NO ACTION`; stronger CHECKs now safe (§3.1–3.2). |
| — | Silent points: no-op updates, conflict precedence, splice timestamp, `valid_until` offsets, history paging, snapshot construction, dedup vs successors, join coupling all search to 013, entity graph. | Each decided explicitly in §3.5, §4.1–4.4, §4.7, §6.3, §6.5, §7. |
