# Contributing to Context Library

Thank you for your interest in contributing. Context Library is a personal cognitive infrastructure tool — contributions that improve reliability, documentation, and deployment flexibility are especially welcome.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/context-library.git`
3. Install dependencies: `npm install`
4. Create a branch: `git checkout -b your-feature`

## Development

```bash
npm run dev          # Start with hot reload (tsx watch)
npm test             # Run full test suite
npm run build        # TypeScript compile
```

The server runs on port 3100 by default. For local development without Docker, you can run Postgres separately and configure connection details via environment variables (see `.env.example`).

## Testing

All pull requests must pass the existing test suite. If you're adding new functionality, include tests.

```bash
npm test             # Run once
npm run test:watch   # Watch mode
```

Tests use Vitest. The `dist/` directory is excluded from test discovery to prevent port conflicts.

### PostgreSQL Tests

Task-related tests (~29 tests) require a running PostgreSQL instance. Without Postgres, these tests are automatically skipped. To run the full suite:

```bash
docker run --rm -p 5432:5432 -e POSTGRES_DB=cl_test -e POSTGRES_USER=cl -e POSTGRES_PASSWORD=test pgvector/pgvector:pg16
```

## Pull Requests

1. Branch from `main`
2. Keep commits focused — one logical change per commit
3. Ensure `npm run build` and `npm test` pass
4. Verify all 4 Docker Compose combinations validate:
   ```bash
   docker compose config -q
   docker compose -f docker-compose.yml -f docker-compose.postgres.yml config -q
   docker compose -f docker-compose.yml -f docker-compose.postgres.yml -f docker-compose.embeddings.yml config -q
   docker compose -f docker-compose.yml -f docker-compose.postgres.yml -f docker-compose.auth.yml config -q
   ```
5. Open a PR against `main` with a clear description of what and why

## Architecture Decisions

Context Library is built around a few core principles:

- **Tiered deployment.** Every feature degrades gracefully. Core handoffs work without Postgres. Task search works without embeddings. Never add a hard dependency on an upper tier.
- **Append-only handoffs.** Handoff files are immutable once written. Edits create new files via `patch_handoff`, which merges with the latest state. Never mutate a stored handoff.
- **Auth at the boundary.** The server itself is unauthenticated. Auth is handled by an external proxy. Never add authentication logic to the server.
- **Single-user by design.** This is personal infrastructure. Multi-tenancy, user management, and access control are out of scope.

## What We're Looking For

- Bug fixes with test coverage
- Documentation improvements (especially deployment guides for new platforms)
- New storage backends or embedding providers
- Performance improvements to search and indexing
- LLM bootstrap files (see ROADMAP — per-environment config files for different AI assistants)

## What's Out of Scope

- Multi-user / multi-tenant features
- Authentication or authorization logic in the server
- UI or web interface (this is an MCP server, not a web app)
- Features that require upper-tier dependencies in lower tiers

## Code Style

- TypeScript strict mode
- ES modules (`"type": "module"` in package.json)
- Functional style where practical, classes where the SDK requires them
- No linter configured yet — match the style of surrounding code

## Guidelines

- Do not commit secrets, personal data, or environment-specific configuration

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
