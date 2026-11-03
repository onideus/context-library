import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScriptSync } from "../src/__tests__/helpers/spawn-server.js";

/**
 * Live smoke test for scripts/extract-entities.ts: one real Messages call.
 *
 * Skipped unless BOTH `EXTRACT_ENTITIES_LIVE=1` and `ANTHROPIC_API_KEY` are
 * set, so it never runs in CI or in an ordinary `npm test`. The repository
 * owner runs it by hand after an SDK or model change:
 *
 *   EXTRACT_ENTITIES_LIVE=1 npx vitest run scripts/extract-entities.live.test.ts
 *   EXTRACT_ENTITIES_LIVE=1 EXTRACT_MODEL=<model> npx vitest run scripts/extract-entities.live.test.ts
 *
 * The script is run as a subprocess against a synthetic DATA_DIR created in a
 * temp directory, and writes its seed file to a second temp directory, so it
 * can never read deployment data or overwrite a real `entities.seed.json`.
 * The fixtures are obviously fictional: this repository is public.
 *
 * The content assertions are loose on purpose. The model is nondeterministic
 * and sampling cannot be pinned on this API version, so the test checks that
 * the call succeeded end to end and that the one entity every fixture names
 * came back, not an exact entity list.
 */

const LIVE =
  process.env.EXTRACT_ENTITIES_LIVE === "1" && Boolean(process.env.ANTHROPIC_API_KEY);

const SCRIPT = join(process.cwd(), "scripts", "extract-entities.ts");
const SCRIPT_TIMEOUT_MS = 180_000;

/** Named in every fixture; must come back as a canonical name or alias. */
const RECURRING_PROJECT = "project-alpha";

const FIXTURES: Record<string, unknown> = {
  "2026-01-05T09-00-00.json": {
    stored_at: "2026-01-05T09:00:00.000Z",
    operational_state: { focus: "project-alpha ingest service" },
    active_context: {
      project_alpha:
        "Jane Developer finished the project-alpha ingest service. Acme Corp reviews it Thursday.",
      infra: "staging-server (the team calls it 'stage') was rebuilt on the new base image.",
    },
  },
  "2026-01-06T09-00-00.json": {
    stored_at: "2026-01-06T09:00:00.000Z",
    operational_state: { focus: "project-alpha review" },
    active_context: {
      project_alpha:
        "project-alpha (alpha for short) passed the Acme Corp review. Jane Developer owns the rollout.",
      personal: "Picked up Sam Example from practice; board game night Friday.",
    },
  },
  "2026-01-07T09-00-00.json": {
    stored_at: "2026-01-07T09:00:00.000Z",
    operational_state: { focus: "project-alpha rollout" },
    active_context: {
      project_alpha:
        "Alpha rolled out to staging-server. Jane Developer is drafting the project-alpha retro for Acme Corp.",
    },
  },
};

/** Lower-case, alphanumerics only, so "Project Alpha" and "project-alpha" compare equal. */
function normalize(s: unknown): string {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
}

interface SeedRow {
  canonical_name: string;
  aliases?: string[];
}

describe.skipIf(!LIVE)("extract-entities live smoke (EXTRACT_ENTITIES_LIVE=1)", () => {
  let dataDir: string;
  let outDir: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "extract-entities-data-"));
    outDir = await mkdtemp(join(tmpdir(), "extract-entities-out-"));
    const handoffsDir = join(dataDir, "handoffs");
    await mkdir(handoffsDir);
    for (const [filename, body] of Object.entries(FIXTURES)) {
      await writeFile(join(handoffsDir, filename), JSON.stringify(body, null, 2) + "\n", "utf8");
    }
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  });

  it(
    "extracts entities from synthetic handoffs through the real API",
    { timeout: 200_000 },
    async () => {
      const env: NodeJS.ProcessEnv = { ...process.env, DATA_DIR: dataDir };
      // Talk to the real endpoint with the key alone, whatever the shell has set.
      delete env.ANTHROPIC_BASE_URL;
      delete env.ANTHROPIC_AUTH_TOKEN;

      const output = join(outDir, "entities.seed.json");
      const result = runScriptSync(SCRIPT, ["--output", output], env, SCRIPT_TIMEOUT_MS);

      if (result.status !== 0) {
        // The script never prints its key; the SDK's error text carries the
        // HTTP status and error type needed to diagnose a rejected request.
        console.error(result.stdout);
        console.error(result.stderr);
      }
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/batches sent:\s+1\b/);
      expect(result.stdout).toMatch(/batch failures:\s+0\b/);

      const seed = JSON.parse(await readFile(output, "utf8")) as SeedRow[];
      expect(Array.isArray(seed)).toBe(true);
      expect(seed.length).toBeGreaterThan(0);

      const names = seed.flatMap((e) => [e.canonical_name, ...(e.aliases ?? [])]).map(normalize);
      expect(names).toContain(normalize(RECURRING_PROJECT));

      const model = result.stdout.match(/\[extract-entities\] model:\s+(\S+)/)?.[1] ?? "(not printed)";
      console.log(`[live] model:        ${model}`);
      console.log(`[live] entity count: ${seed.length}`);
      console.log(`[live] canonical:    ${seed.map((e) => e.canonical_name).join(", ")}`);
    }
  );
});
