import {
  spawn,
  spawnSync,
  type ChildProcess,
} from "node:child_process";
import { join } from "node:path";

/**
 * Shared child-process helpers for the integration suites.
 *
 * Every integration suite spawns the real server (`src/server.ts`) as a child
 * process in beforeAll and tears it down in afterAll. Spawning it as
 * `npx tsx src/server.ts` is a developer-experience trap on Windows:
 *
 *   - Without `shell: true`, `spawn("npx", ...)` fails with `spawn npx ENOENT`
 *     because npx is a `.cmd` shim there, not an executable.
 *   - With `shell: true`, the ChildProcess handle is the cmd.exe wrapper.
 *     SIGTERM kills the wrapper and the tsx server survives, still bound to
 *     its port — the NEXT run then talks to a stale server whose database was
 *     just wiped, and every suite on that port fails for a confusing reason.
 *
 * Running `node node_modules/tsx/dist/cli.mjs src/server.ts` directly avoids
 * both: the same argv works identically on Linux, macOS and Windows, and
 * `kill()` reaches the real process. CI (Linux) behaves exactly as before.
 *
 * Suites keep full control of the environment they pass in — ports, DATA_DIR,
 * PG*, feature flags, deleted keys — so what each test asserts is unchanged.
 */

/** Absolute path to the tsx CLI entry point inside this checkout. */
export const TSX_CLI = join(
  process.cwd(),
  "node_modules",
  "tsx",
  "dist",
  "cli.mjs"
);

/** Shape returned by `runScriptSync` — mirrors the subset of SpawnSyncReturns the suites read. */
export interface ScriptResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn `src/server.ts` under tsx with the given environment.
 *
 * The caller owns `env` entirely (spread `process.env` yourself and add or
 * delete whatever the suite needs). The child's stdout and stderr are drained
 * with no-op listeners so a full pipe buffer can never block the server when
 * many suites run in parallel; suites that want the output (e.g. the response
 * logging suite) attach their own additional listeners.
 */
export function spawnServer(env: NodeJS.ProcessEnv): ChildProcess {
  const proc = spawn(process.execPath, [TSX_CLI, "src/server.ts"], {
    cwd: process.cwd(),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.stdout?.on("data", () => {});
  proc.stderr?.on("data", () => {});
  return proc;
}

/**
 * Stop a server started by `spawnServer`: send SIGTERM, wait for the process
 * to exit, and escalate to SIGKILL if it is still alive after `deadlineMs`.
 *
 * Awaiting the `exit` event (rather than sleeping a fixed interval and
 * checking `proc.killed`, which is true as soon as a signal was SENT, not
 * when the process is gone) is what makes the escalation real and what
 * guarantees the port is free before the next suite reuses it.
 */
export async function stopServer(
  proc: ChildProcess | undefined,
  deadlineMs = 2_000
): Promise<void> {
  if (!proc || proc.pid === undefined) return;
  if (proc.exitCode !== null || proc.signalCode !== null) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(giveUpTimer);
      resolve();
    };
    proc.once("exit", finish);
    const killTimer = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill("SIGKILL");
      }
    }, deadlineMs);
    // Never hang afterAll if the exit event is somehow lost.
    const giveUpTimer = setTimeout(finish, deadlineMs + 2_000);
    proc.kill("SIGTERM");
  });
}

/**
 * Run a `scripts/*.ts` entry point under tsx synchronously and capture its
 * output. Used by suites that exercise the operational scripts (backfill,
 * export/import) rather than the server.
 */
export function runScriptSync(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 30_000
): ScriptResult {
  const result = spawnSync(process.execPath, [TSX_CLI, script, ...args], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    timeout: timeoutMs,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
