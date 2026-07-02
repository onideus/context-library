# CLAUDE.md Conventions

`CLAUDE.md` is the per-repo contract between operator and coding agent. It's the file the agent reads before touching code, and it's how the operator's constraints become executable. In the pipeline pattern, `CLAUDE.md` is also part of the merge gate — the adversarial reviewers use it as ground truth when they check whether a diff violates project rules.

If the pipeline's job is to preserve operator intent across autonomous execution, `CLAUDE.md` is where that intent is written down. Treat it as production configuration, not documentation.

## What belongs in CLAUDE.md

A good `CLAUDE.md` is short enough to fit in context on every call and specific enough that a zero-context reviewer can use it as a rulebook. Sections that earn their place:

- **Project context.** One paragraph on what the repo is, what problem it solves, and who uses it. Enough that an agent making a change understands the stakes.
- **Build and test commands.** The exact commands (`npm test`, `cargo test`, whatever) that the agent should run to verify a change. Runnable acceptance criteria depend on these being current.
- **Architectural constraints.** The invariants the operator will not accept violations of. "Every external dependency must degrade gracefully" is an architectural constraint; "we like TypeScript" is not.
- **Prohibited zones.** Files, directories, or patterns the agent must not touch under normal circumstances (generated code, vendored dependencies, historical migrations, config with production secrets).
- **What NOT to do.** Explicit anti-patterns with reasons. This section pays for itself the first time an agent avoids a mistake a previous version made.
- **Personal data prohibition** (public repos only). See below.

## What does not belong

- API documentation that lives elsewhere. Reference it, don't duplicate it.
- Detailed architecture diagrams. Link to a dedicated file.
- Session-specific notes. Those go in handoffs.
- Anything that changes weekly.

The rule: if it's true across every session of every agent, it belongs in `CLAUDE.md`. Everything else belongs somewhere with a lifecycle.

## Runnable acceptance criteria

The pipeline pattern depends on acceptance criteria being **runnable**, not aspirational. The agent's success signal comes from executing the criteria, not from self-assessment.

Examples of runnable criteria that read well in a CC prompt:

- "`npm test` passes with no new failures."
- "`npm run build` succeeds with zero TypeScript errors."
- "A new integration test exercises the fix and passes when the fix is present, fails when it is absent."
- "The health endpoint returns HTTP 200 with a JSON body matching `{status: string, version: string, uptime: number}`."

Examples of criteria that don't work:

- "The code is clean." (unmeasurable)
- "The change is safe." (unmeasurable)
- "The user will find this intuitive." (needs a human)

The point of `CLAUDE.md`'s build/test command section is that CC prompts can reference these commands as acceptance criteria without restating them — "`npm test` passes, `npm run build` clean, adversarial review passes" is a valid full criteria block if the reader can look up what those commands mean.

## Explicit "do not touch" lists

Prohibited zones are non-negotiable. When you write "do not touch `src/db/migrations/`" in `CLAUDE.md`, you are saying: an agent that touches this directory has violated the contract, and the review gate should reject the PR regardless of whether the change is technically correct.

Common prohibited zones:

- **Applied migrations.** Once a migration file has been applied to a real database, editing it is a data integrity risk.
- **Generated code.** Regenerate, don't edit. If the generator is broken, fix the generator.
- **Vendored dependencies.** These come from upstream. Local edits get lost on the next update and confuse everyone.
- **Config with production secrets.** If secrets are in files, the agent has no business touching those files. If secrets aren't in files, this section can be shorter.
- **CI/CD pipeline files** on high-stakes repos. The agent probably shouldn't modify how it itself gets executed.

Each entry should say **what** is off limits, **why**, and **what to do instead**. "Do not edit `src/db/migrations/*.sql` — these are applied migrations. Add a new numbered migration file instead" is useful; "don't touch migrations" is not.

## Personal data prohibition (public repos)

If the repo is public, `CLAUDE.md` should carry an explicit "no personal data in committed files" section. The pattern this repo uses in its own [CLAUDE.md](../../CLAUDE.md) is a reasonable template — it enumerates categories (source, seed data, comments, docs, CI config, prompts, git history), explains the architectural separation (schema/generic examples committed; real data loads from `.gitignore`'d deployment-local files at runtime), and notes that this rule is enforced in multiple layers because no single layer fires reliably.

If you're operating a pipeline against public repos, this section becomes doubly important: the interceptor is generating code and prose that gets committed. It needs to know the rules before it writes anything.

The specifics of what counts as personal data are deployment-dependent — real names, employer names, private domains, device identifiers, project names that aren't yet public, relationship references. Write them down. The rule works when it's explicit; it fails when it's assumed.

## CLAUDE.md as part of the merge gate

Feed `CLAUDE.md` to the [adversarial reviewers](adversarial-review.md) as part of their zero-context input. The reviewer is then in a position to reject a diff that:

- Touches a prohibited zone.
- Violates an architectural constraint.
- Adds a pattern the "what NOT to do" section explicitly prohibits.
- Commits data the personal data prohibition prohibits.

This is why `CLAUDE.md` must be short and specific. A reviewer given ten pages of philosophy will miss violations. A reviewer given three pages of concrete rules will catch them.

## Keep it current

`CLAUDE.md` is production configuration. When the architecture changes, when a new prohibited zone shows up, when a build command changes — update the file. Stale `CLAUDE.md` files are worse than short ones: they get cited as authority long after they stopped being true, and the pipeline optimizes for the wrong constraints.

A per-release checklist item ("does `CLAUDE.md` still reflect reality?") is worth the minute it takes to check.
