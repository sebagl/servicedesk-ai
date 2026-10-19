import { isValidAssistantId, renderCallPage } from "../../call/page";
import type { Env } from "../../env";
import { logEvent } from "../../observability/logger";
import { constantTimeEqual, extractBasicPassword, getAssistantId, getCallPagePassword } from "../auth";

// GET /call — password-protected page with the Telnyx web call widget. Every
// call started from it is billed to the account, so access uses HTTP Basic
// auth (the browser prompts; the username is ignored) with a password kept in
// Edge secrets. Rejections log the reason only, never the submitted password.
export async function handleCallPage(req: Request, env: Env): Promise<Response> {
  if (req.method !== "GET") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  const [password, assistantId] = await Promise.all([getCallPagePassword(env), getAssistantId(env)]);
  if (password === null || assistantId === null || !isValidAssistantId(assistantId)) {
    logEvent("call_page.rejected", { reason: "not_configured", http_status: 503 });
    return Response.json({ error: "service_unavailable" }, { status: 503 });
  }

  const submitted = extractBasicPassword(req);
  if (submitted === null || !constantTimeEqual(submitted, password)) {
    logEvent("call_page.rejected", {
      reason: submitted === null ? "missing_credentials" : "invalid_password",
      http_status: 401,
    });
    return new Response("Authentication required", {
      status: 401,
      headers: { "www-authenticate": 'Basic realm="ServiceDesk AI demo", charset="UTF-8"' },
    });
  }

  logEvent("call_page.served", {});
  return new Response(renderCallPage(assistantId), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
