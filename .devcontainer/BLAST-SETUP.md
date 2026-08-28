# The blast container

A development container for this repo with a hard containment boundary: egress
is default-deny, the only thing mounted from the host is this checkout, no
credentials live in any file, and there is no Docker socket inside. It exists so
an agentic session can be given broad permissions inside a box whose blast
radius is known.

The boundary itself is not defined here. It comes from the
[`blast-base`](https://github.com/onideus/blast-base) image, pinned to
`ghcr.io/onideus/blast-base:0.1.0`. That repo's `BLAST-CONTRACT.md` is
authoritative for how the firewall is configured and what a consumer owes it.
This directory supplies only the context-library-specific parts: a
`postgresql-client` layer, an allowlist of one extra name, and a test database.

## The full test suite runs inside

Postgres is a compose sidecar brought up as part of container initialisation,
not something you start on the host first. `docker compose` waits for its
healthcheck before the blast service starts, so by the time you have a shell,
`npm test` — the whole suite, including every Postgres-gated file — is expected
to pass. There are no host-side setup steps.

The sidecar publishes **no** host port. It is reachable only from inside the
compose network, by the service name `postgres`, and only because that name is
listed in `BLAST_REQUIRED_DOMAINS`. Its data directory is a `tmpfs`, so every
`docker compose down` wipes it; the test suites create their own per-suite
databases on each run, so an empty server is the expected starting state.

There is no embedding server in here, so `EMBEDDING_URL` points at a closed
loopback port. That is deliberate: at its default the server probes the host
`embeddings`, and behind the firewall a DNS miss takes about twenty seconds
instead of returning immediately — long enough to blow the suite's five-second
per-test timeout on every code path that reports embedding status. A closed port
gives the same "unavailable" answer instantly, and the graceful-degradation
paths are still the ones being exercised. Semantic search is a native task
against the deployment stack.

## Opening it

In VS Code: **Reopen in Container**.

From a terminal:

```
npx @devcontainers/cli up --workspace-folder .
```

Either path builds the consumer image from `Dockerfile`, pulls the pinned base,
brings up `postgres`, runs `npm ci`, and then runs the firewall as the last step
before the container is considered ready (`waitFor: postStartCommand`). Read the
`postStart` output: it opens with the effective firewall configuration and ends
with three self-checks. If it did not print "Firewall configuration complete"
followed by passing verifications, the boundary is not up and nothing else in
here should be trusted.

### Building against a local base

If the pinned tag is unavailable — not yet published, or you are offline — build
the base yourself and point the consumer at it:

```
docker build -t blast-base:local <path-to-a-blast-base-checkout>
```

Then set `BLAST_BASE=blast-base:local` in your environment before opening the
container. It is a compose build arg with a default; nothing else changes.

## What is and is not reachable

Allowed out: `api.anthropic.com` and `registry.npmjs.org` (the base always
allows these and a consumer cannot remove them), the published GitHub IP
ranges, Claude Code's telemetry endpoints, and the `postgres` sidecar.

Everything else is rejected immediately — not dropped, so it fails fast rather
than hanging. Two consequences worth stating plainly:

- `BLAST_ALLOW_HOST_NETWORK` is `false` here. Nothing on the host is needed, so
  the Docker gateway rule is closed. Your deployment host and anything it runs
  are unreachable from inside, by construction.
- There is no Docker inside, and no socket mounted. Anything that builds or runs
  containers is a native task.

A quick way to convince yourself, from a shell inside:

```
curl --connect-timeout 5 https://example.com        # must be rejected
pg_isready -h postgres -U cl -d cl_test             # must be accepting
which docker                                        # must print nothing
```

## What must run natively instead

Work that needs any of the following belongs in a normal session on the host,
not in here:

- Docker itself — building images, `docker compose` against the deployment
  stack, `scripts/test-compose.sh`.
- The live handoff data directory. The container sees this checkout and nothing
  else; `DATA_DIR` on the deployment host is not mounted.
- The deployment database. The sidecar is a throwaway test instance; the
  deployment Postgres is behind the closed host-network rule.

The canonical example is handoff compaction: developing and testing
`scripts/compact-history.ts` against fixtures is container work, but running
`npm run compact-history` over real handoff files, or any recovery step that
touches the deployment database, is a native task on the host.

## Credentials and first run

No key is baked into any file, and none should ever be added to one. On first
run, export it in the shell inside the container and accept the trust dialog:

```
export ANTHROPIC_API_KEY=...
claude
```

Claude Code's configuration lands at `~/.claude/.claude.json`, which is inside
the `context-library-claude-config` named volume — the root-level `~/.claude.json`
is ignored. The volume survives rebuilds, which is the point: you authenticate
once, not every time the image changes.

Two named volumes exist:

| Volume | Mounted at | Holds |
|---|---|---|
| `context-library-claude-config` | `/home/node/.claude` | Claude Code config and credentials |
| `context-library-bashhistory` | `/commandhistory` | shell history across rebuilds |

To revoke everything the container knows:

```
docker compose -f .devcontainer/docker-compose.yml down
docker volume rm context-library-claude-config
```

## Windows notes

Line endings matter: `*.sh text eol=lf` in the repo's `.gitattributes` is
mandatory, because a CRLF shell script inside a Linux container fails with
`bad interpreter: /bin/bash^M`. Verify with `git ls-files --eol`.

Bind-mount I/O from the Windows filesystem is slow under WSL2. If builds or
`npm ci` crawl, move the checkout into the WSL2 filesystem and open it from
there.

Note also that `npm ci` runs inside the container against the bind-mounted
checkout, so `node_modules/` ends up holding Linux binaries. If you also run the
suite natively on Windows, re-run `npm ci` on the host afterwards.

## This directory is not editable by agents

`.devcontainer/` is human-review-only. An auto-mode session running inside the
container does not modify the files that define its own boundary. The base image
moves only by publishing a new tag in `blast-base` and bumping the pin in
`Dockerfile` through a reviewed PR — which is why the pin is a literal version
and never `latest`.
