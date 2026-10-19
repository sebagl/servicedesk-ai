import { getAvailability, validateDateParam } from "../../services/availability";
import { loadCallbacks } from "../../services/portal-reports";
import { loadConfig, type AppConfig } from "../../domain/config";
import type { Env } from "../../env";
import { logEvent } from "../../observability/logger";
import { getSmokeToken, hasValidBearer } from "../auth";
import { handleBookingRequest } from "./bookings";

// Smoke-test routes, all behind the SMOKE_AUTH bearer. Authentication runs
// before reading KV or reaching any Actor.

const DEMO_PATHS = new Set(["/demo/config", "/demo/availability", "/demo/bookings", "/demo/callbacks"]);

const unavailable = () => Response.json({ error: "service_unavailable" }, { status: 503 });
const notFound = () => new Response("not found", { status: 404 });

export function isDemoPath(pathname: string): boolean {
  return DEMO_PATHS.has(pathname);
}

export async function handleDemo(req: Request, env: Env, url: URL): Promise<Response> {
  const token = await getSmokeToken(env);
  if (token === null) return unavailable();
  if (!hasValidBearer(req, token)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  switch (url.pathname) {
    case "/demo/config":
      return req.method === "GET" ? demoConfig(env) : notFound();
    case "/demo/availability":
      return req.method === "GET" ? demoAvailability(env, url) : notFound();
    case "/demo/bookings": {
      if (req.method !== "POST") return notFound();
      const result = await handleBookingRequest(req, env);
      return Response.json(result.body, { status: result.status });
    }
    case "/demo/callbacks":
      return req.method === "GET"
        ? demoCallbacks(env)
        : Response.json({ error: "method_not_allowed" }, { status: 405 });
    default:
      return notFound();
  }
}

async function demoConfig(env: Env): Promise<Response> {
  if (!env.CONFIG) return unavailable();
  const result = await loadConfig(env.CONFIG);
  if (!result.ok) return unavailable();
  return Response.json(result.config satisfies AppConfig);
}

// GET /demo/availability?date=YYYY-MM-DD
async function demoAvailability(env: Env, url: URL): Promise<Response> {
  if (!env.CONFIG || !env.AGENDA) return unavailable();
  const dateOrError = validateDateParam(url.searchParams);
  if (typeof dateOrError !== "string") {
    return Response.json({ error: dateOrError.kind }, { status: 400 });
  }

  const cfgResult = await loadConfig(env.CONFIG);
  if (!cfgResult.ok) return unavailable();

  const result = await getAvailability(dateOrError, Date.now(), cfgResult.config, env.AGENDA);
  if ("kind" in result) {
    return result.kind === "date_out_of_range"
      ? Response.json({ error: "date_out_of_range" }, { status: 400 })
      : unavailable();
  }
  return Response.json(result);
}

// GET /demo/callbacks — operator view of pending callback requests across the
// last 7 local days (today and the 6 previous). Fixed actor names, no scans;
// the per-day merge returns entries newest first. Never logs entry contents,
// only count and latency.
async function demoCallbacks(env: Env): Promise<Response> {
  const start = Date.now();
  if (!env.DAY_CALLBACKS) return unavailable();

  // Same 7-day merge as the portal; a failed day is logged there and the
  // demo route fails closed rather than returning a silently partial list.
  const { entries, ok } = await loadCallbacks(env.DAY_CALLBACKS, Date.now(), "/demo/callbacks");
  if (!ok) return unavailable();

  logEvent("callback.listed", { count: entries.length, latency_ms: Date.now() - start });
  return Response.json({
    callbacks: entries.map((e) => ({
      id: e.id,
      created_at: e.created_at,
      customer_name: e.customer_name,
      customer_phone: e.customer_phone,
      reason: e.reason,
    })),
  });
}
