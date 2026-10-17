import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createHash } from "node:crypto";
import type { KvNamespace } from "@telnyx/edge-runtime";

import { loadConfig } from "./config";
import { getAvailability } from "./availability";
import { createBooking, type BookingServiceDeps } from "./booking-service";
import { isValidDate } from "./scheduling";
import type { AgendaNamespace } from "./agenda-binding";

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

const CREATE_BOOKING_INPUT = z
  .object({
    service_id: z.string().trim().min(1).max(128),
    date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
    time: z.string().trim().regex(/^\d{2}:\d{2}$/),
    customer_name: z.string().trim().min(1).max(256),
    customer_phone: z.string().trim().min(1).max(64),
    confirmed: z.boolean(),
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

// `create_booking` — write path. Derives a server-side idempotency_key from
// the normalized request fields so callers cannot poison replay protection
// and replays are deterministic. Routes through the existing createBooking
// application service, so admission rules, replay-first semantics, and the
// Actor's booking validation all apply unchanged. Tool-handler failures
// never throw out — missing bindings, infrastructure errors, and rejected
// domain codes all surface as MCP tool error results. Customer PII (name,
// phone) never leaves the boundary in any response.
function registerCreateBooking(
  server: McpServer,
  config: KvNamespace | undefined,
  agenda: AgendaNamespace | undefined,
): void {
  server.registerTool(
    "create_booking",
    {
      description:
        "Create the appointment. Call ONLY after the caller explicitly confirmed service, date and time; set confirmed=true only then. Use a time returned by get_availability. Retrying with identical arguments is safe and returns the same booking.",
      inputSchema: CREATE_BOOKING_INPUT,
    },
    async (args: {
      service_id: string;
      date: string;
      time: string;
      customer_name: string;
      customer_phone: string;
      confirmed: boolean;
    }) => {
      if (config === undefined || agenda === undefined) {
        return toolError();
      }

      // Deterministic, server-side idempotency key over the request fields
      // the user actually controls. The input schema is strict, so a
      // caller-supplied idempotency_key is rejected rather than trusted.
      const canonical =
        `${args.customer_phone}|${args.date}|${args.time}|${args.service_id}`;
      const idempotency_key = `mcp-${createHash("sha256")
        .update(canonical)
        .digest("hex")}`;

      const serviceDeps: BookingServiceDeps = {
        loadConfig: async () => {
          const r = await loadConfig(config);
          return r.ok ? r.config : null;
        },
        getAgenda: (name) => {
          const stub = agenda.idFromName(name);
          return {
            createBooking: (input) => stub.createBooking(input),
          };
        },
      };

      const result = await createBooking(
        {
          service_id: args.service_id,
          date: args.date,
          time: args.time,
          customer_name: args.customer_name,
          customer_phone: args.customer_phone,
          idempotency_key,
          confirmed: args.confirmed,
        },
        serviceDeps,
      );

      if (result.kind === "confirmed") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "confirmed",
                booking_id: result.booking_id,
                service_id: result.service_id,
                date: result.date,
                time: result.time,
              }),
            },
          ],
        };
      }
      if (result.kind === "rejected") {
        return toolError(result.code);
      }
      return toolError();
    },
  );
}

export interface McpDeps {
  config?: KvNamespace;
  agenda?: AgendaNamespace;
}

// One server + one transport per request. No shared session state across
// requests — each call is a fresh, fully isolated MCP interaction. Cleanup
// runs in `finally` so partial failures do not leak transport resources.
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
  registerCreateBooking(server, deps.config, deps.agenda);

  try {
    await server.connect(transport);
    return await transport.handleRequest(req);
  } finally {
    await transport.close();
    await server.close();
  }
}
