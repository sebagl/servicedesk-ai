import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { KvNamespace } from "@telnyx/edge-runtime";

import { loadConfig } from "./config";
import { getAvailability, type AgendaNamespace } from "./availability";
import { isValidDate } from "./scheduling";

const SERVICE_INFO = { name: "servicedesk-ai", version: "0.0.0" } as const;

// Argument schema is a strict empty object so the SDK rejects any call that
// supplies unexpected properties with a JSON-RPC Invalid params error.
const GET_SERVICE_CATALOG_INPUT = z
  .object({})
  .strict();

const GET_AVAILABILITY_INPUT = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
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

function toolError(code?: string): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text:
          code === undefined ? TOOL_ERROR_TEXT : JSON.stringify({ error: code }),
      },
    ],
  };
}

// `get_availability` — read-only, returns open appointment times for one date.
// Reuses loadConfig + getAvailability so the same validation, fail-closed
// semantics, and Actor occupancy check apply. Tool-handler failures never
// throw out — missing bindings, config failures, and Actor failures all
// surface as a generic MCP tool error result.
function registerGetAvailability(
  server: McpServer,
  config: KvNamespace | undefined,
  agenda: AgendaNamespace | undefined,
): void {
  server.registerTool(
    "get_availability",
    {
      description:
        "Open appointment times for one date (YYYY-MM-DD, workshop local time America/Mexico_City). Only offer times returned here.",
      inputSchema: GET_AVAILABILITY_INPUT,
    },
    async (args: { date: string }) => {
      if (!isValidDate(args.date)) {
        return toolError("date_invalid");
      }
      if (config === undefined || agenda === undefined) {
        return toolError();
      }
      const cfgResult = await loadConfig(config);
      if (!cfgResult.ok) {
        return toolError();
      }
      const result = await getAvailability(
        args.date,
        Date.now(),
        cfgResult.config,
        agenda,
      );
      if ("kind" in result) {
        if (
          result.kind === "date_invalid" ||
          result.kind === "date_out_of_range"
        ) {
          return toolError(result.kind);
        }
        return toolError();
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              date: result.date,
              timezone: result.timezone,
              booking_enabled: result.booking_enabled,
              available_times: result.slots
                .filter((s) => s.available)
                .map((s) => s.time),
            }),
          },
        ],
      };
    },
  );
}

// One server + one transport per request. No shared session state across
// requests — each call is a fresh, fully isolated MCP interaction. Cleanup
// runs in `finally` so partial failures do not leak transport resources.
export interface McpDeps {
  config?: KvNamespace;
  agenda?: AgendaNamespace;
}

export async function handleMcpRequest(
  req: Request,
  deps: McpDeps,
): Promise<Response> {
  const server = new McpServer(SERVICE_INFO);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  registerGetServiceCatalog(server, deps.config);
  registerGetAvailability(server, deps.config, deps.agenda);

  try {
    await server.connect(transport);
    return await transport.handleRequest(req);
  } finally {
    await transport.close();
    await server.close();
  }
}
