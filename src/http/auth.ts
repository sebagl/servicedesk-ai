import { createHash, timingSafeEqual } from "node:crypto";

import type { Env } from "../env";

// Compares fixed-length SHA-256 digests so neither the content nor the length
// of the secret leaks through timing.
export function constantTimeEqual(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

export function extractBearer(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice(7).trim();
}

export function hasValidBearer(req: Request, token: string): boolean {
  const credential = extractBearer(req);
  return credential !== null && constantTimeEqual(credential, token);
}

// Password from an HTTP Basic `Authorization` header; the username is ignored.
export function extractBasicPassword(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header || !header.startsWith("Basic ")) return null;
  try {
    const decoded = atob(header.slice(6).trim());
    const separator = decoded.indexOf(":");
    return separator === -1 ? null : decoded.slice(separator + 1);
  } catch {
    return null;
  }
}

async function readSecret(
  env: Env,
  binding: "SMOKE_AUTH" | "PORTAL_AUTH" | "MCP_AUTH" | "CALL_PAGE_AUTH" | "ASSISTANT_ID",
): Promise<string | null> {
  if (!env.SECRETS) return null;
  try {
    const token = await env.SECRETS.get(binding);
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

export function getSmokeToken(env: Env): Promise<string | null> {
  return readSecret(env, "SMOKE_AUTH");
}

export function getCallPagePassword(env: Env): Promise<string | null> {
  return readSecret(env, "CALL_PAGE_AUTH");
}

// Kept in Edge secrets rather than the repo: anyone who knows the assistant id
// can start a web call, which is billed to the account.
export function getAssistantId(env: Env): Promise<string | null> {
  return readSecret(env, "ASSISTANT_ID");
}

export function getPortalToken(env: Env): Promise<string | null> {
  return readSecret(env, "PORTAL_AUTH");
}

// Module-level cache for a successfully read MCP_AUTH token. The secret
// is bound at deploy time and never rotates within an instance, so the
// first read is the only read we need to pay for on the /mcp hot path.
// Failures (empty value, rejected promise, missing binding) are not cached:
// the next request must be allowed to retry the lookup.
let cachedMcpToken: string | null = null;

// Test-only escape hatch so suites that drive the handler directly can
// observe the first-lookup semantics in isolation. Production code never
// calls this — the cache is invalidated by an instance restart.
export function __resetMcpTokenCacheForTests(): void {
  cachedMcpToken = null;
}

export async function getMcpToken(env: Env): Promise<string | null> {
  if (!env.SECRETS) return null;
  if (cachedMcpToken !== null) return cachedMcpToken;
  const token = await readSecret(env, "MCP_AUTH");
  if (token !== null) cachedMcpToken = token;
  return token;
}
