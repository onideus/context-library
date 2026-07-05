import type { Context, Next } from "hono";
import { timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

/**
 * Pluggable bearer-token authenticator interface for sync routes.
 *
 * The repo commits the auth *boundary* — an interface plus a static-token
 * reference implementation. Deployments are expected to swap in whatever they
 * need (JWT verification, HMAC, mTLS lookup, etc.) by registering their own
 * SyncAuthenticator. The MCP endpoint delegates auth entirely to the upstream
 * mcp-auth-proxy; the sync endpoints are a separate surface because a mobile
 * client can't participate in the interactive OAuth 2.1 flow.
 *
 * See design-doc §7.
 */
export interface SyncAuthenticator {
  /**
   * Human-readable name used in log lines. Deployments swapping in a JWT or
   * HMAC authenticator should override this so operators can see which
   * implementation is in effect at startup.
   */
  readonly name: string;

  /**
   * Called with the raw bearer token from the `Authorization` header (without
   * the `Bearer ` prefix). Return true to allow the request. Any thrown error
   * is treated as a rejection.
   */
  authenticate(token: string): Promise<boolean> | boolean;
}

/**
 * Reference implementation: a single static bearer token sourced from the
 * `SYNC_BEARER_TOKEN` env var. Constant-time comparison so an attacker
 * measuring response latency can't leak byte-by-byte match progress.
 *
 * When the env var is unset OR empty, no request can be authenticated —
 * deployments must opt in to enable /sync/*.
 */
export class StaticTokenAuthenticator implements SyncAuthenticator {
  readonly name = "static-token";
  private readonly expected: string | null;

  constructor(expected: string | null) {
    this.expected = expected && expected.length > 0 ? expected : null;
  }

  authenticate(token: string): boolean {
    if (this.expected === null) return false;
    return constantTimeEqual(token, this.expected);
  }
}

/**
 * Constant-time comparison via Node's crypto.timingSafeEqual. Encoding both
 * strings as UTF-8 buffers first is important — a hand-rolled charCodeAt loop
 * only compares UTF-16 code units, which is safe for ASCII bearers but
 * brittle if a deployment ever picks a multi-byte token.
 *
 * Returns false as soon as byte lengths differ. Leaking length is safe: the
 * transport packet length already reveals it, so a timing side channel here
 * gives an attacker nothing they didn't already have.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf-8");
  const bb = Buffer.from(b, "utf-8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

let activeAuthenticator: SyncAuthenticator = new StaticTokenAuthenticator(
  config.syncBearerToken
);

/**
 * Swap in a different authenticator implementation. Tests use this to inject
 * an "allow all" authenticator; deployments that want JWT or HMAC install
 * their own here at startup.
 */
export function setSyncAuthenticator(auth: SyncAuthenticator): void {
  activeAuthenticator = auth;
}

/**
 * Read the currently-installed authenticator (mainly for tests / diagnostics).
 */
export function getSyncAuthenticator(): SyncAuthenticator {
  return activeAuthenticator;
}

/**
 * Hono middleware that enforces the sync auth boundary. Rejects requests
 * without an `Authorization: Bearer <token>` header or whose token the
 * active authenticator declines. Returns 401 with a minimal body — no
 * hints about *why* the token was rejected.
 */
export async function syncAuthMiddleware(c: Context, next: Next): Promise<Response | void> {
  const header = c.req.header("Authorization") ?? c.req.header("authorization");
  if (!header || !header.startsWith("Bearer ")) {
    return c.json({ error: "unauthorized", code: "UNAUTHORIZED" }, 401);
  }
  const token = header.slice("Bearer ".length).trim();
  if (token.length === 0) {
    return c.json({ error: "unauthorized", code: "UNAUTHORIZED" }, 401);
  }
  let ok = false;
  try {
    ok = await activeAuthenticator.authenticate(token);
  } catch {
    ok = false;
  }
  if (!ok) {
    return c.json({ error: "unauthorized", code: "UNAUTHORIZED" }, 401);
  }
  await next();
}
