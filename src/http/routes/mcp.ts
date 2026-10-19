import type { Env } from "../../env";
import { handleMcpRequest } from "../../mcp/server";
import { logEvent } from "../../observability/logger";
import { getMcpToken, hasValidBearer } from "../auth";

// Optional correlation header for /mcp. If the Assistant forwards the call's
// call_control_id here, webhook and tool-call log lines share one id. Only a
// bounded, safe charset is accepted so the header cannot inject into logs.
const CALL_ID_HEADER = "x-call-control-id";
const CALL_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;

function readCallId(req: Request): string {
  const value = req.headers.get(CALL_ID_HEADER);
  return value !== null && CALL_ID_PATTERN.test(value) ? value : "";
}

// /mcp — server-to-server, auth-gated. Browser-originated traffic is refused
// before any secret read or protocol handling. Rejections are logged (reason
// only, never the credential) so a misconfigured Assistant connection is
// visible in the runtime logs.
export async function handleMcp(req: Request, env: Env): Promise<Response> {
  if (req.headers.get("origin") !== null) {
    logEvent("mcp.rejected", { reason: "origin_header" });
    return new Response("not found", { status: 404 });
  }

  const token = await getMcpToken(env);
  if (token === null) {
    logEvent("mcp.rejected", { reason: "secret_unavailable" });
    return Response.json({ error: "service_unavailable" }, { status: 503 });
  }

  if (!hasValidBearer(req, token)) {
    logEvent("mcp.rejected", {
      reason: req.headers.get("authorization")?.startsWith("Bearer ")
        ? "invalid_bearer"
        : "missing_bearer",
    });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  return handleMcpRequest(req, {
    config: env.CONFIG,
    agenda: env.AGENDA,
    conversationBooking: env.CONVERSATION_BOOKING,
    dayCallbacks: env.DAY_CALLBACKS,
    callId: readCallId(req),
    metrics: env.METRICS,
  });
}
