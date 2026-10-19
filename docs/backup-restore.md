# Backup, Export & Restore

Context Library ships two scripts — `npm run export` and `npm run import` —
that together provide a supported way to back up a deployment, move it to
new hardware, and migrate embedding models. The mechanism is intentionally
boring: one tarball per export, JSONL per table, a `manifest.json` that
declares what's inside, and a system `tar` on both ends.

**The data is the product. The code is replaceable.** These scripts exist
so that stays true.

## What an export contains

A single gzipped tarball named
`context-library-<app_version>-<YYYYMMDDTHHmmssZ>.tar.gz` with:

- `manifest.json` — app version, applied migrations, embedding model +
  dimensions at export time, per-table row counts, distinct handoff schema
  versions observed, `includes_embeddings` flag
- `tables/*.jsonl` — one JSON line per row per Postgres table, sorted by a
  stable key so consecutive exports of an unchanged database diff cleanly
- `handoffs/*.json` — verbatim copy of the handoff file tree
- `handoffs/archive/` — verbatim copy of the compaction archive: the
  byte-exact original of every handoff compacted under
  `COMPACTION_MODE=archive`, plus any `rehydrate-handoffs` sidecars. For a
  compacted handoff this is the only full copy, so it is always exported.
  `manifest.json` records its size as `handoff_archive_file_count`.

Embeddings are **excluded by default**. They are recomputable, they inflate
the tarball substantially (~2 KiB per chunk), and re-embedding at import
time via the existing `pending_embeddings` queue is the standard path.
`--include-embeddings` opts back in when you specifically want an
exact-restore that skips the re-embed step.

## `npm run export`

```bash
# Default: writes to <DATA_DIR>/exports/
npm run export

# Write elsewhere
npm run export -- --out /mnt/backups/

# Include the embeddings table
npm run export -- --include-embeddings
```

Under the hood it opens a normal `pg.Pool` connection, `SELECT`s each
managed table in a deterministic order, streams the rows into JSONL, copies
`DATA_DIR/handoffs/` into the tarball, writes the manifest, and shells out
to `tar -czf` to produce the archive. There is no server dependency — you
can run the script against a running deployment (the `SELECT`s are
short-lived and read-only) or against an offline database.

**The table export is one consistent snapshot.** Every table's `SELECT`
(and the row counts the manifest declares) runs on a single connection inside
one `REPEATABLE READ` read-only transaction, so the JSONL files describe the
database as of one instant even when you export a live deployment. This
matters because a note's edit history (`note_versions`) is written in the
same transaction as the edit itself: read from separate snapshots, an export
could capture a note at version 3 alongside a history row for version 3 — a
restore of which would leave that note permanently uneditable — or a history
row for a note the earlier read missed. The snapshot is held only while the
tables are read, not while handoffs are copied or the tarball is built, so it
does not block writers. (Handoff files are copied separately and are not part
of the database snapshot.)

**The database schema must be at least as new as the checkout running the
export.** The export `SELECT`s the columns the checkout's table registry
lists, so running it from a checkout newer than the database's schema (for
example right after upgrading the code, before the server has started and
applied its migrations) fails fast with `column "..." does not exist`
(SQLSTATE 42703). That is deliberate: a tarball silently missing the new
columns would be a lossy backup. The fix is to bring the schema current first —
start the server once (it migrates at startup) or run the migration runner —
and then export. A *table* the database lacks entirely is different: it is
exported as an empty file with a warning.

**Nothing is uploaded anywhere.** The output lives on your local
filesystem, full stop. Ship it to backup storage yourself.

## `npm run import <tarball>`

```bash
# Restore into a fresh, empty deployment
npm run import /mnt/backups/context-library-0.11.0-20260706T140312Z.tar.gz

# Preview what would happen without touching the database or filesystem
npm run import <tarball> -- --dry-run

# Restore into a non-empty deployment (destroys existing content first)
npm run import <tarball> -- --force
```

### What import does

1. Extract the tarball into a temp directory (cleaned up on exit).
2. Read `manifest.json`.
3. Check the tarball itself, before any database access:
   - each `tables/<name>.jsonl` row count matches the manifest — a corrupt
     tarball fails fast;
   - a cross-table **consistency pre-flight** on the notes files: every
     `note_versions` row must belong to a note in `notes.jsonl` and carry a
     version strictly below that note's current `version`, and every
     `superseded_by` must name a note in `notes.jsonl`. A tarball that
     violates this (for example one exported before the single-snapshot fix,
     or edited by hand) is refused with `Tarball inconsistent: ...` — the
     first defect would leave the note permanently uneditable, the other two
     would fail the load after a `--force` truncate. A missing
     `notes.jsonl` counts as an empty note set, so history rows with no notes
     are refused; a tarball with no `note_versions.jsonl` (pre-013) simply has
     no history to check.
4. Check that every managed table is empty and `DATA_DIR/handoffs/` has no
   files. If either check fails and `--force` is not set, refuse.
   **A refused import never touches the destination — not its rows, not its
   handoff files, and not its schema:** this check runs before any migration
   is applied, so pointing `PG*` at a live deployment by mistake and
   forgetting `--force` changes nothing. (Tables the destination's schema
   lacks are counted as empty, so this check is safe on an older schema.)
5. Now that the import will proceed (empty destination, or `--force`), bring
   the schema current. Verify the destination `_migrations` table is at or
   beyond every migration named in the manifest, **and** that it has applied
   every migration this checkout ships; if either check finds a gap, run
   `runMigrations()` from the local codebase (idempotent). The second check
   matters because the server normally migrates at startup, but a restore can
   run on a freshly upgraded checkout before the server has started: an older
   tarball names nothing the destination lacks, yet the load writes the
   current schema's columns — and with `--force` the truncate would already
   have run when a missing column made the load fail. If migrations named in
   the manifest still aren't present after running, refuse to continue and
   tell the operator to upgrade the codebase first. `--dry-run` lists the
   pending migrations without applying them.
6. If `--force` is set and the destination is non-empty, `TRUNCATE ...
   RESTART IDENTITY CASCADE` every managed table and clear
   `DATA_DIR/handoffs/` — **except `handoffs/archive/`, which is never
   cleared.** It is append-only and may hold originals the tarball does not
   (for example, a tarball exported before archives were exported).
7. Load each JSONL file in its own transaction, INSERT with the table
   registry's column order, and verify the loaded count against the manifest
   before committing. Deferrable constraints are deferred to each table's
   `COMMIT` (`SET CONSTRAINTS ALL DEFERRED`), which lets notes that point at a
   successor via `superseded_by` load in `id` order regardless of which comes
   first.
8. Copy handoff files into `DATA_DIR/handoffs/`, then merge the tarball's
   `handoffs/archive/` in without overwriting any archive file already
   present (archived originals are byte-exact, so an existing one is kept).
9. Queue re-embed through `pending_embeddings` — see below.

**Older tarballs still restore.** A column that is *absent* from a JSONL row
(as opposed to present with `null`) is loaded as the column's `DEFAULT`, and a
table with no JSONL file loads as zero rows. So a tarball exported before
migration 013 — no note lifecycle columns, no `note_versions.jsonl` — restores
with every note `status = 'active'`, `version = 1`, and `provenance`,
`valid_until`, `superseded_by` and `superseded_at` all `NULL`, and an empty
history. The reverse is refused: a tarball whose manifest lists a migration
the destination does not have, even after the local runner has applied
everything this checkout ships, is rejected before any truncation, so a 013
tarball cannot be loaded by pre-013 code.

### Re-embed policy

The import queues rows into `pending_embeddings` when either:

- the manifest declared `includes_embeddings: false` (default case), or
- the manifest's `embedding_model` / `embedding_dimensions` disagree with
  the destination's current config (`EMBEDDING_MODEL` /
  `EMBEDDING_DIMENSIONS`).

When neither condition is true, no re-embed is queued.

Once queued, the standard `drainPendingEmbeddings()` path — invoked by
`search_context` and `reindex` and by the server on startup — will
re-embed each entry against the current model in FIFO order. If TEI is
unavailable at import time, the queue simply waits. This is the same
resilience path used everywhere else in the server, not a special case.

### Sync client invalidation — read this if you have paired clients

A restore rebuilds `changes` and `sync_op_log` with fresh BIGSERIAL values.
Any sync client that had recorded a cursor from the *pre-restore* server
is holding a cursor that no longer maps to what the server thinks it
means. The safe recovery for those clients is:

1. Delete the local database on the client (mobile app, sync agent, etc).
2. Re-pair or perform a full initial sync from `cursor=0`.

The server does not attempt to hide this from clients. It cannot — there
is no invariant it could preserve. An epoch or instance-id on the sync
wire is a candidate for a future PR (see the `--force` code path for
context on why nothing prevents it from happening implicitly today), but
it is out of scope for this milestone; **plan the re-pair.**

## Recommended: nightly export

Deployment-side scheduling is the intended model — the app itself does
not run cron. A minimal example (put this in your operator's crontab, not
inside the container):

```
# Every night at 03:15, run an export into a private backup dir.
15 3 * * *   cd /opt/context-library && npm run export -- --out /var/backups/context-library/
```

For a versioned backup, point `--out` at a directory that's a git working
tree of a **private repository** and commit the produced tarball (or a
diff-friendly extracted form of it — the JSONL files AND `manifest.json`
are deterministic across exports of an unchanged database, so a diff
between consecutive nights is only the rows that actually changed. The
tarball itself is not byte-identical because `tar -czf` bakes in mtimes
and a gzip header; commit the extracted tree, not the tarball, if you
want clean diffs).

> **Never commit an export tarball to the public repo.** The tarball
> contains the entire personal dataset — every note, task, artifact, and
> handoff verbatim. `data/` is `.gitignore`d and `data/exports/` inherits
> that; the nightly-commit pattern above applies to a *private* or
> *local* backup repository only. If in doubt, don't commit — write to
> object storage or a local disk instead.

## Restore drill (do this quarterly)

You do not have a backup until you have restored from it. The recommended
drill:

1. `npm run export -- --out ./drill/` on the live deployment.
2. Bring up a scratch Postgres and set `PGDATABASE=cl_drill` (or any
   throwaway db).
3. Set `DATA_DIR=./drill/data-fresh` and create the directory.
4. `npm run import ./drill/context-library-*.tar.gz -- --dry-run` and eyeball
   the plan — every table's post-import count should equal the manifest.
5. `npm run import ./drill/context-library-*.tar.gz`.
6. Spot-verify:
   - `psql $PG* -c 'select count(*) from tasks; select count(*) from notes; select count(*) from note_versions; select count(*) from artifacts;'`
     match the manifest.
   - Start the server against the drill database and call
     `get_latest_handoff` — the response should carry the same filename
     as the newest file in `./drill/data-fresh/handoffs/`.
   - Wait for the pending-embeddings queue to drain (or force a
     `reindex`) and run an FTS query against `search_context` for a term
     you know is in a known-restored note or artifact.
7. Tear down the drill environment.

## Embedding-model migration

The intended flow when you want to change the embedding model:

1. `npm run export` (default excludes embeddings, so the tarball is small).
2. Bring up a new deployment with `EMBEDDING_MODEL` / `EMBEDDING_DIMENSIONS`
   set to the new values.
3. `npm run import <tarball>` — every indexable row lands in
   `pending_embeddings` automatically because the manifest's model
   disagrees with the destination.
4. Let the drain path re-embed at its own pace against the new TEI.

You do not need to run any special "reindex" step. The pending queue is
the reindex.

## What the scripts do NOT do

- No scheduling. `npm run export` is a single-shot command; put it in
  cron / systemd timers / your CI runner at the deployment site.
- No network upload. If you want the export in S3, pipe it there yourself.
- No incremental / differential exports — every run is a full snapshot.
- No modification of `/sync/*` routes or the changes-log semantics.
- No re-encryption or key management — this is a filesystem tarball. If
  you need at-rest encryption, wrap the tarball with your own tooling
  (`age`, `gpg`, encrypted volume, whatever) before you commit or upload
  it.
