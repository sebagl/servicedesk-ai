import type { Env } from "../env";
import { handleCallPage } from "./routes/call";
import { handleDemo, isDemoPath } from "./routes/demo";
import { handleDynamicVariables } from "./routes/dynamic-variables";
import { handleMcp } from "./routes/mcp";
import { handlePortal, isPortalPath } from "./routes/portal";

export async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;

  if (pathname === "/health") {
    return Response.json({ status: "ok", service: "servicedesk-ai" });
  }
  if (pathname === "/health/liveness" || pathname === "/health/readiness") {
    return new Response("ok");
  }
  if (pathname === "/webhooks/dynamic-variables") return handleDynamicVariables(req, env);
  if (pathname === "/mcp") return handleMcp(req, env);
  if (pathname === "/call") return handleCallPage(req, env);
  if (isPortalPath(pathname)) return handlePortal(req, env, pathname);
  if (isDemoPath(pathname)) return handleDemo(req, env, url);

  return new Response("not found", { status: 404 });
}
