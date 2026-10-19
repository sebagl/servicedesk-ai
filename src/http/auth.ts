import type { Env } from "../env";

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
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

async function readSecret(
  env: Env,
  binding: "SMOKE_AUTH" | "PORTAL_AUTH" | "MCP_AUTH",
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
