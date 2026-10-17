export { Counter } from "./counter";
export { DayAgenda } from "./agenda-actor";
import type { Counter } from "./counter";
import type { AgendaNamespace } from "./agenda-binding";

import {
  type ActorNamespace,
  type ActorStub,
  type IdFromNameOptions,
  type Secrets,
  type KvNamespace,
} from "@telnyx/edge-runtime";

import { loadConfig, type AppConfig } from "./config";
import { getAvailability, validateDateParam } from "./availability";
import { handleBookingRequest, readBoundedBody } from "./bookings";
import { handleMcpRequest } from "./mcp-server";
import { getLocalDateString, getLocalTimeParts } from "./scheduling";
import { logEvent, maskPhone } from "./logger";

type CounterStub = ActorStub & Pick<Counter, "increment" | "read">;
interface CounterNamespace extends ActorNamespace {
  idFromName(name: string, options?: IdFromNameOptions): CounterStub;
}

interface Env {
  COUNTER: CounterNamespace;
  AGENDA: AgendaNamespace;
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

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

// Telnyx calls this endpoint at assistant initialization to fetch runtime
// variables it can interpolate into the conversation. We must answer 200
// quickly regardless of internal state so the call continues; a degraded
// system_status signals the assistant to be cautious about taking bookings.
// NOTE: Telnyx request signature verification is a planned follow-up; the
// endpoint is currently unauthenticated because it returns only non-sensitive
// business info.
async function handleDynamicVariables(
  req: Request,
  env: Env,
): Promise<Response> {
  const start = Date.now();

  if (req.method !== "POST") {
    return new Response("method not allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  }

  // Same streaming byte limit as the booking adapter: a missing or false
  // Content-Length must not let an unbounded body into memory.
  const bodyResult = await readBoundedBody(req);
  if (!bodyResult.ok) {
    return bodyResult.status === 413
      ? Response.json({ error: "payload_too_large" }, { status: 413 })
      : Response.json({ error: "bad_request" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyResult.text);
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  // The docs describe the event's `payload` fields without being explicit
  // about a `data` envelope, so accept both {data:{payload}} and {payload}.
  const root =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)
      : {};
  const data =
    typeof root.data === "object" && root.data !== null ? root.data : root;
  const payload =
    typeof data === "object" && data !== null
      ? (data as Record<string, unknown>).payload
      : undefined;
  const payloadObj =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)
      : {};

  const callControlId =
    typeof payloadObj.call_control_id === "string"
      ? payloadObj.call_control_id
      : "";
  const callerRaw =
    typeof payloadObj.telnyx_end_user_target === "string"
      ? payloadObj.telnyx_end_user_target
      : "";
  const assistantId =
    typeof payloadObj.assistant_id === "string" ? payloadObj.assistant_id : "";

  let bookingEnabled = false;
  let serviceList = "";
  let systemStatus = "ok";
  if (env.CONFIG === undefined) {
    systemStatus = "degraded";
  } else {
    const cfgResult = await loadConfig(env.CONFIG);
    if (!cfgResult.ok) {
      systemStatus = "degraded";
    } else {
      bookingEnabled = cfgResult.config.business.booking_enabled;
      serviceList = cfgResult.config.services
        .map((s) => s.name)
        .join(", ");
    }
  }

  const now = Date.now();
  const todayLocal = getLocalDateString(now);
  const [yy, mm, dd] = todayLocal.split("-").map(Number);
  const weekday =
    WEEKDAY_NAMES[new Date(Date.UTC(yy, mm - 1, dd)).getUTCDay()];
  const timeParts = getLocalTimeParts(now);
  const hh = String(timeParts.hour).padStart(2, "0");
  const min = String(timeParts.minute).padStart(2, "0");

  logEvent("webhook.dynamic_variables", {
    call_control_id: callControlId,
    caller: maskPhone(callerRaw),
    assistant_id: assistantId,
    system_status: systemStatus,
    booking_enabled: bookingEnabled ? "true" : "false",
    latency_ms: Date.now() - start,
  });

  return Response.json({
    dynamic_variables: {
      booking_enabled: bookingEnabled ? "true" : "false",
      system_status: systemStatus,
      today_local: todayLocal,
      today_weekday: weekday,
      now_local_time: `${hh}:${min}`,
      business_hours:
        "Monday to Friday, 09:00-17:00, last appointment 16:00 (America/Mexico_City)",
      service_list: serviceList,
    },
  });
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
