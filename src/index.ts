export { Counter } from "./counter";
export { DayAgenda } from "./agenda-actor";
export { ConversationBooking } from "./conversation-actor";
import type { Counter } from "./counter";
import type { AgendaNamespace } from "./agenda-binding";
import type { ConversationBooking as ConversationBookingActor } from "./conversation-actor";

import {
  type ActorNamespace,
  type ActorStub,
  type IdFromNameOptions,
  type Secrets,
  type KvNamespace,
} from "@telnyx/edge-runtime";

import { loadConfig, type AppConfig } from "./config";
import { getAvailability, validateDateParam } from "./availability";
import { handleBookingRequest } from "./bookings";
import { handleMcpRequest } from "./mcp-server";
import { handleDynamicVariables } from "./dynamic-variables";
import { logEvent } from "./logger";

type CounterStub = ActorStub & Pick<Counter, "increment" | "read">;
interface CounterNamespace extends ActorNamespace {
  idFromName(name: string, options?: IdFromNameOptions): CounterStub;
}

type ConversationBookingStub = ActorStub & Pick<ConversationBookingActor, "book">;
interface ConversationBookingNamespace extends ActorNamespace {
  idFromName(name: string, options?: IdFromNameOptions): ConversationBookingStub;
}

interface Env {
  COUNTER: CounterNamespace;
  AGENDA: AgendaNamespace;
  CONVERSATION_BOOKING: ConversationBookingNamespace;
  SECRETS?: Secrets;
  CONFIG?: KvNamespace;
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

async function getMcpToken(env: Env): Promise<string | null> {
  if (!env.SECRETS) return null;
  try {
    const token = await env.SECRETS.get("MCP_AUTH");
    return token || null;
  } catch {
    return null;
  }
}

// Optional correlation header for /mcp. If the Assistant forwards the call's
// call_control_id here, webhook and tool-call log lines share one id. Only a
// bounded, safe charset is accepted so the header cannot inject into logs.
const CALL_ID_HEADER = "x-call-control-id";
const CALL_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;

function readCallId(req: Request): string {
  const value = req.headers.get(CALL_ID_HEADER);
  return value !== null && CALL_ID_PATTERN.test(value) ? value : "";
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok", service: "servicedesk-ai" });
    }
    if (url.pathname === "/health/liveness") return new Response("ok");
    if (url.pathname === "/health/readiness") return new Response("ok");

    // --- /webhooks/dynamic-variables — Telnyx assistant initialization ---
    if (url.pathname === "/webhooks/dynamic-variables") {
      return handleDynamicVariables(req, env);
    }

    // --- /mcp — server-to-server, auth-gated, browser Origin rejected ---
    if (url.pathname === "/mcp") {
      // Server-to-server MVP — refuse browser-originated traffic before any
      // secret read or protocol handling.
      // Rejections are logged (reason only, never the credential) so a
      // misconfigured Assistant connection is visible in the runtime logs.
      if (req.headers.get("origin") !== null) {
        logEvent("mcp.rejected", { reason: "origin_header" });
        return new Response("not found", { status: 404 });
      }

      const token = await getMcpToken(env);
      if (token === null) {
        logEvent("mcp.rejected", { reason: "secret_unavailable" });
        return Response.json({ error: "service_unavailable" }, { status: 503 });
      }

      const credential = extractBearer(req);
      if (credential === null || !constantTimeEqual(credential, token)) {
        logEvent("mcp.rejected", {
          reason: credential === null ? "missing_bearer" : "invalid_bearer",
        });
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }

      return handleMcpRequest(req, {
        config: env.CONFIG,
        agenda: env.AGENDA,
        conversationBooking: env.CONVERSATION_BOOKING,
        callId: readCallId(req),
      });
    }

    // --- Demo routes (smoke-test only, auth-gated) ---
    const isDemoConfig = url.pathname === "/demo/config";
    const isDemoAvailability = url.pathname === "/demo/availability";
    const isDemoBookings = url.pathname === "/demo/bookings";
    const counterMatch = url.pathname.match(
      /^\/demo\/counter\/([^/]+)\/(increment|read)$/,
    );

    if (!isDemoConfig && !isDemoAvailability && !isDemoBookings && !counterMatch) {
      return new Response("not found", { status: 404 });
    }

    // Authenticate before reading KV or reaching the Actor.
    const token = await getSmokeToken(env);
    if (token === null) {
      return Response.json({ error: "service_unavailable" }, { status: 503 });
    }

    const credential = extractBearer(req);
    if (credential === null || !constantTimeEqual(credential, token)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    // --- GET /demo/config ---
    if (isDemoConfig) {
      if (req.method !== "GET") {
        return new Response("not found", { status: 404 });
      }
      if (!env.CONFIG) {
        return Response.json({ error: "service_unavailable" }, { status: 503 });
      }
      const result = await loadConfig(env.CONFIG);
      if (!result.ok) {
        return Response.json({ error: "service_unavailable" }, { status: 503 });
      }
      return Response.json(result.config satisfies AppConfig);
    }

    // --- GET /demo/availability?date=YYYY-MM-DD ---
    if (isDemoAvailability) {
      if (req.method !== "GET") {
        return new Response("not found", { status: 404 });
      }
      if (!env.CONFIG || !env.AGENDA) {
        return Response.json({ error: "service_unavailable" }, { status: 503 });
      }
      const dateOrError = validateDateParam(url.searchParams);
      if (typeof dateOrError !== "string") {
        const status = dateOrError.kind === "date_out_of_range" ? 400 : 400;
        return Response.json(
          { error: dateOrError.kind },
          { status },
        );
      }

      const cfgResult = await loadConfig(env.CONFIG);
      if (!cfgResult.ok) {
        return Response.json({ error: "service_unavailable" }, { status: 503 });
      }

      const result = await getAvailability(
        dateOrError,
        Date.now(),
        cfgResult.config,
        env.AGENDA,
      );

      if ("kind" in result) {
        if (result.kind === "date_out_of_range") {
          return Response.json({ error: "date_out_of_range" }, { status: 400 });
        }
        return Response.json({ error: "service_unavailable" }, { status: 503 });
      }

      return Response.json(result);
    }

    // --- POST /demo/bookings ---
    if (isDemoBookings) {
      if (req.method !== "POST") {
        return new Response("not found", { status: 404 });
      }
      const result = await handleBookingRequest(req, env);
      return Response.json(result.body, { status: result.status });
    }

    // --- /demo/counter/:id/{increment,read} ---
    const id = counterMatch![1]!;
    const action = counterMatch![2]!;
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
