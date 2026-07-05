# Example CC Prompt Artifact

This is a complete, fabricated CC-prompt artifact. It illustrates the shape the interceptor consumes as documented in [build-your-own-interceptor.md](../build-your-own-interceptor.md). Everything below the `---` divider is what would live in the artifact's `content` field. The block above is the metadata the interceptor reads directly.

The JSON block below shows the artifact's structured fields *as they exist in the row* — `title`, `status`, `tags`, `metadata`, etc. are stored as separate columns/JSONB, not parsed out of the artifact body. Only the prose after the divider is the `content` field the interceptor hands to the agent.

## Artifact metadata

```json
{
  "title": "Add /health/verbose endpoint to Project Alpha API",
  "artifact_type": "cc-prompt",
  "scope": "shared",
  "status": "ready",
  "tags": ["project-alpha", "health-check", "api"],
  "execution_order": 1,
  "dependencies": [],
  "metadata": {
    "target_repo": "project-alpha",
    "target_org": "acme-corp",
    "base_branch": "main",
    "working_branch": "pipeline/health-verbose-endpoint",
    "batch_label": "2026-03-15-health-expansion",
    "risk_hint": "low"
  }
}
```

Three fields carry the pipeline contract (see the table in [artifact-lifecycle.md](../artifact-lifecycle.md#pipeline-metadata-contract)):

- `target_repo` is **required**. An interceptor watching for `ready` cc-prompts will demote any artifact missing it back to `draft`, because it has no way to resolve where to execute. The prior `branch_target` key is deprecated in favor of this.
- `target_org` is optional and falls back to the interceptor's configured default org when absent.
- `content_hash` is **not shown here on purpose** — Context Library computes and stores it server-side on promotion to a locked status. Callers must not supply it; any caller-supplied value is stripped. The interceptor recomputes and verifies before executing (see the executor contract in [build-your-own-interceptor.md](../build-your-own-interceptor.md#3-the-executor-contract)).

---

## CC Prompt: Add /health/verbose endpoint to Project Alpha API

## Objective

Add a `GET /health/verbose` endpoint to the Project Alpha API that returns per-subsystem status objects. Existing `GET /health` continues to return the simple liveness shape; the verbose endpoint is additive and aimed at operator debugging rather than uptime monitoring.

## Context

Project Alpha's API currently exposes `GET /health` returning `{status, version, uptime}`. During recent incidents, the operator has needed to log into the host to check individual subsystem status (database connectivity, background worker queue depth, external cache reachability). The verbose endpoint surfaces the same information without a shell.

The endpoint remains unauthenticated to match `/health`, but it must be gated behind the same allowlist that protects the `/metrics` endpoint — deployment-local, IP-based, configured via `HEALTH_VERBOSE_ALLOWLIST` env var. If the allowlist is empty (default), the endpoint returns 404 rather than 403; the surface should not advertise its existence when disabled.

## Constraints

- Preserve the existing `GET /health` behavior exactly. No changes to its response shape, status codes, or performance characteristics.
- The verbose endpoint must respond in under 500ms in the happy path. Per-subsystem checks that would exceed this threshold must be bounded with a per-check timeout and reported as `timeout` rather than blocking the response.
- No new dependencies. Use the existing HTTP framework and the existing DB/cache clients.
- Follow the project's existing error-shape conventions — see the API's error middleware.
- Do not modify prohibited zones as listed in the repo's `CLAUDE.md`.

## File plan

Files this prompt is expected to touch (an agent that touches significantly more or fewer should treat that as a signal to stop and confirm):

- `src/api/routes/health.ts` — add the verbose route handler; keep the existing `/health` handler intact.
- `src/api/checks/` (new subdirectory) — one file per subsystem check, each exporting a `runCheck(): Promise<CheckResult>` function.
- `src/config.ts` — add `HEALTH_VERBOSE_ALLOWLIST` env var read.
- `src/__tests__/health-verbose.test.ts` — integration test coverage as described in acceptance criteria.
- `README.md` — document the new endpoint under Health Checks, matching the existing documentation style.
- `.env.example` — document `HEALTH_VERBOSE_ALLOWLIST`.

Files off limits: existing DB migrations (`src/db/migrations/*.sql`), the auth middleware (this endpoint is unauthenticated by design), any file mentioned in `CLAUDE.md`'s "do not touch" list.

## Acceptance criteria

Each criterion below is either runnable or observable in the diff. The adversarial reviewer will check all of them.

- `npm test` passes with no new failures.
- `npm run build` completes with zero TypeScript errors.
- `GET /health` returns `{status: "ok", version: <string>, uptime: <number>}` — response shape unchanged.
- `GET /health/verbose` returns a JSON object with per-subsystem keys, each carrying `{status: "ok"|"degraded"|"timeout"|"error", detail: <string>|null, latency_ms: <number>}`.
- With `HEALTH_VERBOSE_ALLOWLIST` unset, `GET /health/verbose` returns HTTP 404.
- With `HEALTH_VERBOSE_ALLOWLIST` set and the request source not in the list, the endpoint returns HTTP 404 (not 403).
- With the request source in the allowlist and every subsystem healthy, the endpoint returns HTTP 200 in under 500ms.
- The integration test `src/__tests__/health-verbose.test.ts` covers the happy path, the not-allowlisted path, the disabled path, and one subsystem-timeout path (using a mock or an intentionally slow check).
- No file outside the file plan is modified. No new runtime dependency is added.
- `CLAUDE.md`'s personal-data prohibition is respected — no real domains, IPs, or hostnames in committed files. The `.env.example` entry uses `127.0.0.1` or documented reserved ranges only.

## Notes for the reviewer

If you are the adversarial reviewer for this change:

- Verify that `GET /health` is byte-identical to its previous behavior.
- Verify that no path from unauthenticated requests to the verbose endpoint bypasses the allowlist.
- Verify that the per-check timeout is enforced — a slow subsystem must not stall the whole response.
- The generator's rationale is not provided by design. Judge the diff against the criteria above.
