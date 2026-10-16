export { Counter } from "./counter";
import type { Counter } from "./counter";

import {
  type ActorNamespace,
  type ActorStub,
  type IdFromNameOptions,
  type Secrets,
} from "@telnyx/edge-runtime";

type CounterStub = ActorStub & Pick<Counter, "increment" | "read">;
interface CounterNamespace extends ActorNamespace {
  idFromName(name: string, options?: IdFromNameOptions): CounterStub;
}
interface Env {
  COUNTER: CounterNamespace;
  SECRETS?: Secrets;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function extractBearer(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice(7).trim();
}

async function getSmokeToken(env: Env): Promise<string | null> {
  if (!env.SECRETS) return null;
  try {
    const token = await env.SECRETS.get("SMOKE_AUTH");
    return token || null;
  } catch {
    return null;
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok", service: "servicedesk-ai" });
    }
    if (url.pathname === "/health/liveness") return new Response("ok");
    if (url.pathname === "/health/readiness") return new Response("ok");

    // SMOKE-TEST ONLY — protected by SMOKE_TEST_TOKEN secret.
    // Remove before public deployment.
    const m = url.pathname.match(/^\/demo\/counter\/([^/]+)\/(increment|read)$/);
    if (!m) return new Response("not found", { status: 404 });

    const token = await getSmokeToken(env);
    if (token === null) {
      return Response.json({ error: "service_unavailable" }, { status: 503 });
    }

    const credential = extractBearer(req);
    if (credential === null || !constantTimeEqual(credential, token)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const id = m[1]!;
    const action = m[2]!;
    const stub = env.COUNTER.idFromName(id);

    if (action === "increment" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { amount?: number };
      const amount = typeof body.amount === "number" ? body.amount : 1;
      const result = await stub.increment(amount);
      return Response.json({ counter: id, ...result });
    }

    if (action === "read" && req.method === "GET") {
      const result = await stub.read();
      return Response.json({ counter: id, ...result });
    }

    return new Response("not found", { status: 404 });
  },
};
