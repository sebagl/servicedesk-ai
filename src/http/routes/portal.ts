import {
  getAppointmentsReport,
  getKpisReport,
  getObservabilityReport,
  type PortalDeps,
} from "../../services/portal-reports";
import type { Env } from "../../env";
import { logEvent } from "../../observability/logger";
import { PORTAL_HTML } from "../../portal/page";
import { getPortalToken, hasValidBearer } from "../auth";

const unavailable = () => Response.json({ error: "service_unavailable" }, { status: 503 });

type Report = (deps: PortalDeps, now: number) => Promise<object | null>;

const API_ROUTES: Record<string, Report> = {
  "/api/appointments": getAppointmentsReport,
  "/api/kpis": getKpisReport,
  "/api/observability": getObservabilityReport,
};

export function isPortalPath(pathname: string): boolean {
  return pathname === "/portal" || Object.hasOwn(API_ROUTES, pathname);
}

// GET /portal serves the static operator page (holds no data, so no auth).
// /api/* returns operator data behind the PORTAL_AUTH bearer, checked before
// reading KV or reaching any Actor.
export async function handlePortal(req: Request, env: Env, pathname: string): Promise<Response> {
  if (pathname === "/portal") {
    if (req.method !== "GET") {
      return Response.json({ error: "method_not_allowed" }, { status: 405 });
    }
    return new Response(PORTAL_HTML, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  const token = await getPortalToken(env);
  if (token === null) return unavailable();
  if (!hasValidBearer(req, token)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (req.method !== "GET") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  const report = API_ROUTES[pathname]!;
  try {
    const body = await report(
      {
        config: env.CONFIG,
        agenda: env.AGENDA,
        dayCallbacks: env.DAY_CALLBACKS,
        metrics: env.METRICS,
      },
      Date.now(),
    );
    if (body === null) {
      logEvent("portal.report_failed", { route: pathname, reason: "binding_missing" });
      return unavailable();
    }
    return Response.json(body);
  } catch (err) {
    // Error messages from the Actors carry no customer data; truncated anyway.
    const reason = err instanceof Error ? `${err.name}: ${err.message}` : "unknown";
    logEvent("portal.report_failed", { route: pathname, reason: reason.slice(0, 160) });
    return unavailable();
  }
}
