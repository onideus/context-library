# Lifecycle Walkthrough

This is a narrative end-to-end trace of one artifact through the pipeline loop, using [example-handoff.json](example-handoff.json) as the planning-session snapshot and [example-cc-prompt.md](example-cc-prompt.md) as the artifact. It walks the artifact from planning through completion, naming every tool call and pipeline action along the way. The walkthrough deliberately follows the **hold-for-human** merge path — the risk table (see [build-your-own-interceptor.md](../build-your-own-interceptor.md#5-the-merge-decision)) produces `hold for human` because the target repo isn't on the operator's auto-merge allowlist. This is the more common shape of the loop in practice, and it shows how the operator stays in control at the merge point.

## Step 1 — Planning session captures a draft

Session `2026-03-15-v02` runs. The operator is designing a small API expansion for Project Alpha. Toward the end of the session, the assistant drafts a CC-prompt artifact:

```
store_artifact({
  title: "Add /health/verbose endpoint to Project Alpha API",
  artifact_type: "cc-prompt",
  scope: "shared",
  status: "draft",
  content: <the full CC prompt from example-cc-prompt.md>,
  tags: ["project-alpha", "health-check", "api"],
  execution_order: 1,
  metadata: {
    target_repo: "project-alpha",
    base_branch: "main",
    working_branch: "pipeline/health-verbose-endpoint",
    batch_label: "2026-03-15-health-expansion",
    risk_hint: "low"
  }
})
```

The server stores the artifact, returns `{id, title, artifact_type, status: "draft", created_at}`, and fires background indexing. `content_hash` is not yet locked — the artifact is still `draft`.

Two sibling artifacts (execution_order 2 and 3) are stored the same way. A fourth artifact — the DB-backed session cache — is left `draft` because the operator hasn't resolved a schema question yet.

## Step 2 — Handoff written at session boundary

The assistant calls:

```
store_handoff({
  operational_state: {...},
  active_context: {
    session_meta: {label: "2026-03-15-v02", surface: "ide", model: "opus"},
    conversation_arc: "Planning session for Project Alpha...",
    decisions_made: [...],
    prompts_generated: [...],
    next_steps: [...],
    environment_context: {target_repo: "project-alpha", ...}
  },
  tone_notes: "Session was productive — operator prefers terse confirmations...",
  timezone: "America/Denver",
  final: true
})
```

The full payload is in [example-handoff.json](example-handoff.json). `final: true` sets `session_closed=true` on the stored handoff.

## Step 3 — Operator review, promotion to ready

The operator reads the drafted artifacts. Three look correct; the fourth (session cache) still has the open schema question, so it stays `draft`. For each of the three ready artifacts:

```
update_artifact({
  id: <artifact-id>,
  status: "ready"
})
```

The server enforces the `draft → ready` transition and computes `content_hash` (SHA-256 over the artifact's `content`) as part of the promotion. The hash is stored in `metadata` and cannot be overridden by future callers on locked statuses. Promotion to `ready` is the authorization act — from this point on, the interceptor's polling query will return the artifact.

## Step 4 — Interceptor claims the first artifact

Some time later, the interceptor runs its poll:

```
list_artifacts({
  artifact_type: "cc-prompt",
  status: "ready",
  order_by: "execution_order",
  order_dir: "asc"
})
```

Three artifacts come back in order (execution_order 1, 2, 3). The interceptor takes the first, checks its dependencies (empty — nothing to wait on), and claims it:

```
update_artifact({
  id: <artifact-1-id>,
  status: "executing",
  metadata: {claimed_by: "interceptor-a", claimed_at: "2026-03-15T14:22:07Z"}
})
```

A quick re-read confirms the claim. Status is now `executing`; no other interceptor will pick this artifact up.

## Step 5 — Executor runs the prompt

The interceptor:

1. Resolves target from `metadata.target_repo` and `metadata.base_branch`.
2. Fresh-clones the target repo into a working directory.
3. Creates the working branch (`pipeline/health-verbose-endpoint`) from `main`.
4. Recomputes SHA-256 over the artifact's `content` and compares to `metadata.content_hash` — they match.
5. Invokes the agentic coding CLI with the artifact's `content` as the prompt. **No wrapping, no paraphrasing.**
6. Waits for the CLI to exit. It produces a diff: new route handler, new checks subdirectory, config change, integration test, README and `.env.example` updates.
7. Commits as the pipeline identity, pushes the branch.

## Step 6 — PR opened, CI triggers, adversarial review runs

The interceptor opens a PR against `main`. The PR body includes the artifact's objective and acceptance criteria, plus a footer:

> Pipeline run: interceptor-a · Artifact: `<uuid>` · Commit: `<sha>`

CI runs automatically. In parallel, the interceptor invokes three reviewer models (per the reviewer_pool in the handoff's environment_context) against a zero-context payload: the diff, the acceptance criteria, and the target repo's `CLAUDE.md`. Each returns a structured verdict.

Results:

- CI: green. All tests pass, build clean.
- Reviewer A: `approve`, `risk: low`, no issues.
- Reviewer B: `approve`, `risk: low`, one `low`-severity note about docstring style.
- Reviewer C: `approve`, `risk: low`, no issues.

Consensus is unanimous approve at low risk. All verdicts are posted as PR comments.

## Step 7 — Merge gate: hold for human

The interceptor applies the merge decision table:

| Row | Value |
|---|---|
| Repo on allowlist? | **No** — `project-alpha` is not currently on the operator's auto-merge allowlist |
| Risk | low |
| Consensus | unanimous approve |
| High-severity findings | none |
| CI | green |

Because the repo is not allowlisted, the decision is **hold for human**. The interceptor:

- Posts a summary comment on the PR: `Adversarial review: 3/3 approve, low risk. CI green. Held for human review per repo policy.`
- Notifies the operator (however the deployment is configured — the operator's channel is out of scope here).
- Stops touching the PR.

Note the shape of the outcome: the change *could* merge on autopilot, and every automated signal says it's fine. The gate holds anyway because the operator hasn't yet added this repo to the allowlist — that trust is earned through operator watching, not asserted by the pipeline.

## Step 8 — Operator merges

Some time later, the operator reads the reviewer verdicts, spot-checks the diff, and merges the PR manually. The merge commit lands on `main`.

The completion step is triggered out of band — either via a webhook the interceptor subscribes to, a scheduled sweep looking for merged PRs referencing pipeline-run footers, or a manual `update_artifact` invocation by the operator. In this walkthrough, the interceptor has a webhook and detects the merge within seconds.

## Step 9 — update_artifact to completed

```
update_artifact({
  id: <artifact-1-id>,
  status: "completed",
  metadata: {
    pr_url: "https://<host>/<repo>/pull/<n>",
    merged: true,
    merge_sha: "<sha>",
    merge_type: "manual",
    ci_conclusion: "success",
    review_verdict: "unanimous_approve",
    review_risk: "low",
    completed_at: "2026-03-15T15:08:42Z"
  }
})
```

The server merges the metadata (existing `content_hash`, `claimed_by`, `claimed_at`, `target_repo` and so on are preserved).

## Step 10 — Digest note

The interceptor closes the loop with:

```
create_note({
  title: "Pipeline completion: Add /health/verbose endpoint to Project Alpha API",
  scope: "shared",
  domain: "pipeline",
  tags: ["pipeline-digest", "cc-prompt", "project-alpha"],
  content: "Added GET /health/verbose to Project Alpha's API. The endpoint returns per-subsystem status objects gated behind HEALTH_VERBOSE_ALLOWLIST — request sources not in the allowlist see 404, matching the existing metrics endpoint discipline. GET /health is unchanged.\n\nOperational implication: set HEALTH_VERBOSE_ALLOWLIST in the deployment env before this endpoint is useful. Recommended next: add an oncall runbook entry pointing to /health/verbose for incident triage.\n\nSource artifact: <uuid>. PR: <url>. Merge sha: <sha>. Reviewer verdict: unanimous approve, low risk. CI: green."
})
```

That note is what the operator reads a week from now when they need to remember why `/health/verbose` exists.

## Step 11 — The next artifacts

The interceptor returns to its poll loop. Execution_order 2 (`Extend Project Alpha CLAUDE.md with the verbose-health contract`) and 3 (`Add integration tests covering the new health shape`) are still `ready`. Both are picked up in order and follow the same path. The fourth artifact — the DB-backed session cache — stays `draft`; the interceptor never sees it.

## What the operator sees at session start

The next planning session begins. The assistant calls `get_latest_handoff`. The response includes:

- `session_continuity: "cold_start"` (previous session ended with `final: true` more than 15 minutes ago).
- `task_summary` from the authoritative Postgres tasks table.
- `artifact_summary`:
  - `recently_completed` — the three artifacts completed since the previous handoff's `stored_at`, with titles and execution_order.
  - `currently_executing` — empty.
  - `ready_queue` — empty.
  - `draft_count` — 1 (the deferred session cache artifact).
- `next_step` guidance reminding the assistant to search notes before responding on architecture topics.

The digest notes are indexable — a follow-up `search_notes({query: "health verbose"})` or a semantic `search_context` will surface them. The operator now has both the ephemeral session summary (from the handoff) and the durable record (from the notes) of what the pipeline built.

## Contract check

This walkthrough uses exactly these MCP tool calls:

- `store_artifact` (three drafts, plus the deferred fourth)
- `store_handoff` (session close)
- `update_artifact` (three promotions to `ready`, then per-artifact `executing` and `completed` transitions)
- `list_artifacts` (interceptor poll)
- `create_note` (digest per completed artifact)
- `get_latest_handoff` (next session start)

Everything else is either external (git host, CI, reviewer models) or a pure state transition. The Context Library surface stays the same whether the operator is running the pipeline against one repo or ten.
