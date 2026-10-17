import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { KvNamespace } from "@telnyx/edge-runtime";

import { loadConfig } from "./config";

const SERVICE_INFO = { name: "servicedesk-ai", version: "0.0.0" } as const;

// Argument schema is a strict empty object so the SDK rejects any call that
// supplies unexpected properties with a JSON-RPC Invalid params error.
const GET_SERVICE_CATALOG_INPUT = z
  .object({})
  .strict();

const TOOL_ERROR_TEXT = "service_unavailable";

// `get_service_catalog` — read-only, returns the configured services and the
// admission flag. Reads through the existing loadConfig so the same validation
// and fail-closed semantics apply. Tool-handler failures never throw out —
// config failures surface as a generic MCP tool error result.
function registerGetServiceCatalog(
  server: McpServer,
  kv: KvNamespace | undefined,
): void {
  server.registerTool(
    "get_service_catalog",
    {
      description:
        "Returns the service catalog (id, name, duration_minutes) and the booking_enabled admission flag.",
      inputSchema: GET_SERVICE_CATALOG_INPUT,
    },
    async () => {
      if (kv === undefined) {
        return toolError();
      }
      const result = await loadConfig(kv);
      if (!result.ok) {
        return toolError();
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              services: result.config.services,
              booking_enabled: result.config.business.booking_enabled,
            }),
          },
        ],
      };
    },
  );
}

function toolError(): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    isError: true,
    content: [{ type: "text", text: TOOL_ERROR_TEXT }],
  };
}

// One server + one transport per request. No shared session state across
// requests — each call is a fresh, fully isolated MCP interaction. Cleanup
// runs in `finally` so partial failures do not leak transport resources.
export async function handleMcpRequest(
  req: Request,
  kv: KvNamespace | undefined,
): Promise<Response> {
  const server = new McpServer(SERVICE_INFO);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  registerGetServiceCatalog(server, kv);

  try {
    await server.connect(transport);
    return await transport.handleRequest(req);
  } finally {
    await transport.close();
    await server.close();
  }
}
