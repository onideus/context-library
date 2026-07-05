# Build Your Own Interceptor

This page is the replication spec. Someone with a Tier 2+ Context Library deployment and an agentic coding CLI should be able to build a working interceptor from this document. It is pattern-level, not code — the reference implementation is private. What is shipped here are the contracts.

If the pattern here works for you and the guardrails feel load-bearing, that is intentional. Shipping this loop **without** the gates is a decision you own — the pattern assumes them.

## 1. Prerequisites

- **Context Library at Tier 2 or higher.** The interceptor's whole state machine lives in the `artifacts` table, which requires Postgres. Tier 3 (embeddings) is not required for the interceptor itself, but you'll want it for the planning-side search that produces good artifacts.
- **An agentic coding CLI.** Anything that can run non-interactively against a working directory and take a prompt as input works. The interceptor drives the CLI; the CLI drives the repo.
- **A git host with API access.** For opening PRs, posting review comments, checking CI status, and merging. GitHub, GitLab, and Gitea all fit.
- **CI on target repos.** The merge gate assumes CI is a first-class signal. If a repo has no CI, either add some or take that repo off the auto-merge allowlist.
- **A separate identity for the pipeline.** Distinct git author, distinct API tokens, distinct signing key. The audit trail depends on it.

## 2. The polling loop

The interceptor's outer loop is simple:

```
loop:
  artifacts = list_artifacts({
    artifact_type: "cc-prompt",
    status: "ready",
    order_by: "execution_order",
    order_dir: "asc"
  })

  for artifact in artifacts:
    if not all_dependencies_completed(artifact.dependencies):
      continue  # try again next poll

    claimed = try_claim(artifact.id)
    if not claimed:
      continue  # another interceptor beat us to it

    run_pipeline_stages(artifact)

  sleep(poll_interval)
```

Two contracts matter here.

**Claiming is a status transition, not a lock table.** `update_artifact(id, status: "executing")` is the claim. The tool layer runs the write as a conditional UPDATE: it lands only if the row is still in the caller's expected status (defaulting to the status read at the top of the `update_artifact` call, overridable via `expected_status`). If two interceptors both read the artifact while it is `ready` and race to claim, the first UPDATE lands and returns the row; the second gets `STATUS_CONFLICT` with the current server state and re-polls. Optionally include a `metadata.claimed_by` identifier on the claim update as an audit-trail record of which interceptor holds the claim — it is a supplement to `STATUS_CONFLICT`, not the primary race signal. Existing interceptors that detect races by reading back `metadata.claimed_by` remain correct; the server-side conditional UPDATE is a strict superset of that check, so no migration is required. This matches the executing-state description in [artifact-lifecycle.md](artifact-lifecycle.md).

**Dependencies are your responsibility to honor.** `list_artifacts` does not filter by dependency status. Read the artifact, look up each dependency's status, skip if any are not `completed`, `superseded`, or explicitly waived. Re-poll — an artifact that isn't ready this cycle might be ready next cycle.

Sensible poll intervals sit around 30-60 seconds. Tighter is wasteful; looser makes the pipeline feel unresponsive.

## 3. The executor contract

Once claimed, the interceptor invokes the coding agent. The agent runs against a fresh clone or worktree of the target repo.

The critical contract: **the artifact's `content` is the entire prompt.** The interceptor does not paraphrase it, extend it, or wrap it in extra system-prompt scaffolding beyond what the coding CLI itself requires. The artifact is self-contained by design — objective, context, constraints, file plan, acceptance criteria, target metadata — and stays self-contained in execution.

Why: if the interceptor decorates the prompt, then the behavior in production drifts from what the planning session captured. The artifact stops being a reproducible input.

Steps the interceptor performs (not the agent):

1. **Resolve the target repo.** The interceptor reads `metadata.target_repo` (required), optional `metadata.target_org` (defaults per your interceptor config when absent), `metadata.base_branch` (defaults to `main` or your convention — this is an interceptor-side convention, not a server contract), and `metadata.working_branch` (defaults to a derived name if absent). If `metadata.target_repo` is missing on a `ready` cc-prompt, demote it back to `draft` with a note in metadata explaining why — do not silently guess a target. `metadata.branch_target` is a deprecated legacy alias for `target_repo`; interceptors may fall back to it during the deprecation window, but new artifacts should not use it.
2. **Clone or worktree.** Fresh working directory per run. Never reuse.
3. **Create the working branch** from the base branch.
4. **Verify `content_hash`.** Recompute SHA-256 over the artifact's `content` and compare to `metadata.content_hash`. Context Library computes and locks this hash server-side on promotion to a locked status — the interceptor's job is only to verify. If they differ, abort and flag the artifact; it was mutated between poll and execution.
5. **Hand the artifact content to the agent** as its prompt.
6. **Wait for the agent to exit.** If it produces no changes, treat that as an execution failure — see failure handling below.
7. **Commit the changes** as the pipeline identity, push the branch to the remote.

The agent is trusted to follow the prompt. The interceptor is trusted to set up a clean environment, not to interpret the change.

The full metadata contract — which fields are required, which are auto-computed, which are deprecated — lives in [artifact-lifecycle.md](artifact-lifecycle.md#pipeline-metadata-contract). Authoring agents should read that table before producing cc-prompts.

## 4. PR and gate stage

After the branch is pushed:

1. **Open a PR.** Title from the artifact's `title`; body assembled from the artifact's objective and acceptance criteria plus a footer identifying the pipeline run (artifact UUID, pipeline commit SHA, timestamp). The footer is what an operator uses to trace a merged commit back to its source artifact.
2. **Trigger CI.** Usually automatic on PR open; wait for completion.
3. **Run adversarial review.** See [adversarial-review.md](adversarial-review.md). The interceptor invokes N reviewer models in parallel, each with the same zero-context inputs (diff, acceptance criteria, `CLAUDE.md`). Reviewer verdicts are posted to the PR as structured comments.
4. **Aggregate.** Wait until CI finishes and all reviewers have returned. Compute the consensus verdict and the highest reported risk level.

At the end of this stage the interceptor has: CI status, N reviewer verdicts, aggregate consensus, and highest severity flagged.

## 5. The merge decision

Governance table. This is the pattern's load-bearing artifact — everything else in the loop is machinery that makes this table reliable.

| Repo | Risk | Consensus | High-severity finding | CI | Decision |
|---|---|---|---|---|---|
| Allowlisted | low | unanimous approve | none | green | **auto-merge** |
| Allowlisted | low | unanimous approve | none | red | hold for human |
| Allowlisted | low | split / changes_requested | any | any | hold for human |
| Allowlisted | medium or high | any | any | any | hold for human |
| Allowlisted | any | any | any high | any | hold for human |
| Not allowlisted | any | any | any | any | hold for human |

"Hold for human" means: leave the PR open with the reviewer comments posted, notify the operator (however you notify — email, chat, dashboard), and stop touching the PR. The operator merges, closes, or requests changes.

**On the auto-merge path:** the interceptor merges the PR (squash or merge, your call), waits for the merge to complete, then proceeds to completion.

**On the hold path:** the interceptor's job is done. It does not poll the PR waiting for a human. Instead, the operator's manual merge is what triggers the completion step — implemented via a webhook, a scheduled sweep that looks for merged PRs referencing pipeline-run footers, or manual `update_artifact` invocation. Choose whichever fits your ops style.

Repo allowlist: keep it short. Start with docs-only repos. Add code repos only after you've watched the loop run for a while and the gate has actually rejected some merges — a gate that has never rejected anything is a gate you don't yet trust.

## 6. Completion and digest

After the PR merges (auto or manual):

1. **`update_artifact`** to `completed`. Set `metadata.pr_url`, `metadata.merged` (`true`/`false`), `metadata.merge_sha`, `metadata.merge_type` (`auto` or `manual`), `metadata.completed_at`. Preserve prior metadata via merge semantics.
2. **Write a digest note.** `create_note` with a title like `Pipeline completion: {artifact.title}`, scope inherited from the artifact, and content that summarizes:
   - What actually changed (one paragraph, plain prose — not a copy of the diff).
   - Why (the objective from the artifact, restated).
   - Any operational implication: config changes, deploy steps, monitoring to watch, follow-up tasks.
   - A link back to the PR and to the source artifact's UUID.

The digest note is the antidote to the [operator internalization gap](adversarial-review.md#honest-limits). It is the record the operator reads a week later when they need to remember why the pipeline made a change. Don't skip it.

## 7. Failure handling

Real failure modes and how the pattern handles them.

### Executor crash

The interceptor process dies mid-execution. Artifacts stuck in `executing` don't self-heal.

**Recovery:** on interceptor startup, query for `executing` artifacts whose `updated_at` is older than a threshold (say, twice the maximum expected execution time). Log them, notify the operator, and either revert them to `ready` (safe if you're confident the executor didn't push a branch) or leave them for manual inspection. The default is to leave them — silent auto-revert can lose evidence of what went wrong.

### CI failure

The agent produced code, the PR opened, CI is red.

**Two options; pick one and be consistent.** Either (a) revert the artifact to `ready` so the next poll re-runs it — appropriate if CI failures on this repo are usually flakes — or (b) transition to `completed` with `metadata.outcome: "ci_failed"` and rely on the operator to open a follow-up. Option (b) is the safer default: if CI failed for a real reason, re-running the artifact unchanged won't help.

### Adversarial review disagreement or reject

Any reject, or split verdicts — see the merge decision table. Hold for human. Post all verdicts to the PR. This is working as intended; disagreement is the signal.

### Embedding server outage

Irrelevant to the interceptor. Artifacts are stored in Postgres; `list_artifacts` is a plain SQL query with FTS available as a fallback for `search_artifacts`. Semantic search degrades on the planning side, not the execution side.

### PR host outage

Retry with backoff on the API calls that talk to the git host. If the outage exceeds a reasonable window (an hour), transition the artifact back to `ready` and let the next poll re-attempt. Do not leave it `executing` indefinitely.

### Two interceptors racing

Detected via the claim step. Loser backs off. If you find yourself hitting races often, you have too many interceptors — one is usually enough.

## 8. Pseudocode

Language-neutral, TypeScript-flavored. This is illustrative, not a copy of the reference implementation.

```typescript
// Outer loop
while (running) {
  const artifacts = await mcp.callTool("list_artifacts", {
    artifact_type: "cc-prompt",
    status: "ready",
    order_by: "execution_order",
    order_dir: "asc",
  });

  for (const artifact of artifacts) {
    if (!(await dependenciesSatisfied(artifact.dependencies))) continue;

    const claimed = await claim(artifact.id);
    if (!claimed) continue;

    try {
      // artifact carries the fields we need for execution (metadata, content,
      // etc.) — it was read at the top of the loop from list_artifacts and
      // the claim above did not need to hand it back.
      await runPipeline(artifact);
    } catch (err) {
      await handleFailure(artifact, err);
    }
  }

  await sleep(pollInterval);
}

async function claim(id: string): Promise<boolean> {
  // The conditional-UPDATE guard in update_artifact does the mutex work:
  // pass expected_status: "ready" and the write only lands if the row is
  // still ready. A racing interceptor gets STATUS_CONFLICT and re-polls.
  //
  // We treat "the row is now executing" as the claim signal — checking
  // only for `code !== "STATUS_CONFLICT"` would silently classify unrelated
  // errors (validation, transport, unknown codes) as a successful claim.
  const result = await mcp.callTool("update_artifact", {
    id,
    status: "executing",
    expected_status: "ready",
    metadata: { claimed_by: interceptorId, claimed_at: nowIso() },
  });
  return result.status === "executing";
}

async function runPipeline(artifact: Artifact) {
  // target_repo is required on the artifact; if missing, the artifact
  // should have been demoted back to draft before we ever claimed it.
  const target = artifact.metadata.target_repo;
  const targetOrg = artifact.metadata.target_org ?? defaultOrg;
  const baseBranch = artifact.metadata.base_branch ?? "main";
  const workingBranch = artifact.metadata.working_branch ?? deriveBranchName(artifact);

  verifyContentHash(artifact);

  const workdir = await cloneFresh(target, baseBranch, workingBranch);
  await runAgent(workdir, artifact.content);           // executor contract
  const changes = await gitStatus(workdir);
  if (changes.empty) throw new NoOpExecution();

  await commitAndPush(workdir, artifact);
  const pr = await openPr(target, workingBranch, baseBranch, artifact);

  const ci = await awaitCi(pr);
  const review = await runAdversarialReview(pr, artifact);
  const decision = mergeDecision({ target, ci, review });

  if (decision === "auto-merge") {
    await mergePr(pr);
    await complete(artifact, { pr, ci, review, mergeType: "auto" });
  } else {
    await postHoldNotice(pr, decision);
    await notifyOperator(artifact, pr, decision);
    // completion is triggered by the operator's manual merge, out of band
  }
}

async function complete(
  artifact: Artifact,
  outcome: { pr: Pr; ci: CiResult; review: ReviewResult; mergeType: string }
) {
  await mcp.callTool("update_artifact", {
    id: artifact.id,
    status: "completed",
    metadata: {
      pr_url: outcome.pr.url,
      merged: true,
      merge_sha: outcome.pr.mergeSha,
      merge_type: outcome.mergeType,
      ci_conclusion: outcome.ci.conclusion,
      review_verdict: outcome.review.consensus,
      review_risk: outcome.review.highestRisk,
      completed_at: nowIso(),
    },
  });

  await mcp.callTool("create_note", {
    title: `Pipeline completion: ${artifact.title}`,
    scope: artifact.scope,
    domain: "pipeline",
    tags: ["pipeline-digest", artifact.artifact_type],
    content: buildDigest(artifact, outcome),
  });
}
```

The specifics — how you shell out to your coding CLI, how you talk to your git host, how you wire adversarial review — are yours to fill in. The contract with Context Library is exactly the tool calls above: `list_artifacts`, `get_artifact`, `update_artifact`, `create_note`.

See [examples/example-cc-prompt.md](examples/example-cc-prompt.md) for the artifact shape this loop consumes, and [examples/lifecycle-walkthrough.md](examples/lifecycle-walkthrough.md) for an end-to-end trace of one artifact through the whole loop.
