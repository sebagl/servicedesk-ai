import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";
import type {
  ActorNamespace,
  ActorStub,
  IdFromNameOptions,
  KvNamespace,
} from "@telnyx/edge-runtime";

import { loadConfig } from "./config";
import { getAvailability } from "./availability";
import { isValidDate } from "./scheduling";
import type { AgendaNamespace } from "./agenda-binding";
import type { ConversationBooking as ConversationBookingActor } from "./conversation-actor";
import type { ConversationBookingResult } from "./conversation-booking";
import type { CallbackQueueNamespace } from "./callback-binding";
import { logEvent, maskPhone } from "./logger";
import { recordMetric, type MetricsNamespace } from "./metrics";

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

const REQUEST_CALLBACK_INPUT = z
  .object({
    customer_name: z.string().trim().min(1).max(256),
    customer_phone: z.string().trim().min(1).max(64),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

const TOOL_ERROR_TEXT = "service_unavailable";

// Correlation-only id forwarded by the Assistant as JSON-RPC params._meta.
// Bounded charset so the value can never inject into a log line. Never
// consulted for authorization, idempotency, or any booking decision.
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;
type CallbackExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

function readConversationId(extra: CallbackExtra): string | undefined {
  const meta = extra._meta as Record<string, unknown> | undefined;
  const raw = meta?.["telnyx_conversation_id"];
  return typeof raw === "string" && CONVERSATION_ID_PATTERN.test(raw)
    ? raw
    : undefined;
}

// `get_service_catalog` — read-only, returns the configured services and the
// admission flag. Reads through the existing loadConfig so the same validation
// and fail-closed semantics apply. Tool-handler failures never throw out —
// config failures surface as a generic MCP tool error result.
function registerGetServiceCatalog(
  server: McpServer,
  kv: KvNamespace | undefined,
  ctx: ToolContext,
): void {
  server.registerTool(
    "get_service_catalog",
    {
      description:
        "Returns the service catalog (id, name, duration_minutes) and the booking_enabled admission flag.",
      inputSchema: GET_SERVICE_CATALOG_INPUT,
    },
    async (_args, extra) => {
      const start = Date.now();
      const conversationId = readConversationId(extra);
      if (kv === undefined) {
        return logToolResult(
          "get_service_catalog",
          ctx,
          start,
          toolError(),
          conversationId,
        );
      }
      const result = await loadConfig(kv);
      if (!result.ok) {
        return logToolResult(
          "get_service_catalog",
          ctx,
          start,
          toolError(),
          conversationId,
        );
      }
      return logToolResult(
        "get_service_catalog",
        ctx,
        start,
        {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                services: result.config.services,
                booking_enabled: result.config.business.booking_enabled,
              }),
            },
          ],
        },
        conversationId,
      );
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

// Classify a tool result into the outcome label emitted to the structured
// log. Success → "ok"; domain errors carry the error code; missing bindings
// and infra failures collapse to "service_unavailable". Never derives the
// outcome from anything that could include tool arguments or PII.
function classifyToolOutcome(result: unknown): string {
  if (typeof result !== "object" || result === null) return "ok";
  const r = result as { isError?: unknown; content?: unknown };
  if (r.isError !== true) return "ok";
  const content = Array.isArray(r.content) ? r.content : [];
  const text =
    typeof content[0] === "object" &&
    content[0] !== null &&
    typeof (content[0] as { text?: unknown }).text === "string"
      ? ((content[0] as { text: string }).text)
      : "";
  if (text === TOOL_ERROR_TEXT) return "service_unavailable";
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    return typeof parsed.error === "string"
      ? parsed.error
      : "service_unavailable";
  } catch {
    return "service_unavailable";
  }
}

interface ToolContext {
  callId: string;
  metrics?: MetricsNamespace;
}

async function logToolResult<T>(
  tool: string,
  ctx: ToolContext,
  start: number,
  result: T,
  conversationId?: string,
): Promise<T> {
  const outcome = classifyToolOutcome(result);
  const latencyMs = Date.now() - start;
  const fields: Record<string, string | number | boolean> = {
    tool,
    call_control_id: ctx.callId,
    outcome,
    latency_ms: latencyMs,
  };
  if (conversationId !== undefined) {
    fields.telnyx_conversation_id = conversationId;
  }
  logEvent("mcp.tool_call", fields);
  await recordMetric(ctx.metrics, {
    event: `mcp.${tool}`,
    outcome,
    latency_ms: latencyMs,
    ...(conversationId !== undefined ? { telnyx_conversation_id: conversationId } : {}),
  });
  return result;
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
  ctx: ToolContext,
): void {
  server.registerTool(
    "get_availability",
    {
      description:
        "Open appointment times for one date (YYYY-MM-DD, workshop local time America/Mexico_City). Only offer times returned here.",
      inputSchema: GET_AVAILABILITY_INPUT,
    },
    async (args: { date: string }, extra) => {
      const start = Date.now();
      const conversationId = readConversationId(extra);
      if (!isValidDate(args.date)) {
        return logToolResult(
          "get_availability",
          ctx,
          start,
          toolError("date_invalid"),
          conversationId,
        );
      }
      if (config === undefined || agenda === undefined) {
        return logToolResult(
          "get_availability",
          ctx,
          start,
          toolError(),
          conversationId,
        );
      }
      const cfgResult = await loadConfig(config);
      if (!cfgResult.ok) {
        return logToolResult(
          "get_availability",
          ctx,
          start,
          toolError(),
          conversationId,
        );
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
          return logToolResult(
            "get_availability",
            ctx,
            start,
            toolError(result.kind),
            conversationId,
          );
        }
        return logToolResult(
          "get_availability",
          ctx,
          start,
          toolError(),
          conversationId,
        );
      }
      return logToolResult(
        "get_availability",
        ctx,
        start,
        {
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
        },
        conversationId,
      );
    },
  );
}

// `create_booking` — write path. Routes through the conversation-scoped
// StatefulActor (booking-domain.md §10): the Actor owns one-booking-per-
// conversation and its own idempotency. Conversation identity is read from
// SDK metadata only — never from tool arguments or correlation headers —
// and resolved to a stable Actor name via SHA-256, so the same conversation
// always lands on the same Actor regardless of date or time. The MCP layer
// does not consult KV/AGENDA before calling: the Actor handles execution
// and confirmed replays, and is the only place those bindings are touched.
// Tool-handler failures never throw out — invalid metadata, missing
// CONVERSATION_BOOKING binding, RPC lookup failures, and malformed Actor
// results all collapse to a generic MCP tool error without exposing the
// underlying exception. Customer PII (name, phone) never leaves the
// boundary in any response.
type ConversationBookingStub = ActorStub & Pick<ConversationBookingActor, "book">;
interface ConversationBookingNamespace extends ActorNamespace {
  idFromName(name: string, options?: IdFromNameOptions): ConversationBookingStub;
}

// Allowlisted rejection codes the MCP layer can echo back. Anything outside
// this set — including unknown codes from a malformed Actor — collapses to
// service_unavailable. conversation_already_booked is enforced by the
// Actor; other codes propagate verbatim from the booking domain.
const REJECTION_CODES: ReadonlySet<string> = new Set([
  "unknown_service",
  "date_out_of_range",
  "date_not_open",
  "time_invalid",
  "confirmation_required",
  "booking_disabled",
  "slot_in_past",
  "slot_unavailable",
  "idempotency_key_conflict",
  "conversation_already_booked",
]);

function isString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

// Strict validation of the Actor's confirmed result, with cross-field
// correspondence to the request. A mismatch indicates the Actor returned
// a record for a different booking attempt — collapse to malformed.
function validateConfirmedResult(
  raw: unknown,
  expected: { service_id: string; date: string; time: string },
): { booking_id: string; service_id: string; date: string; time: string } | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.kind !== "string" || r.kind !== "confirmed") return null;
  if (!isString(r.booking_id)) return null;
  if (!isString(r.service_id) || r.service_id !== expected.service_id) return null;
  if (!isString(r.date) || r.date !== expected.date) return null;
  if (!isString(r.time) || r.time !== expected.time) return null;
  return {
    booking_id: r.booking_id,
    service_id: r.service_id,
    date: r.date,
    time: r.time,
  };
}

// Stable Actor name for a conversation: SHA-256 over the validated
// conversation id, prefixed with "conversation-". The same id always maps
// to the same Actor instance for the lifetime of the deployment.
function conversationActorName(conversationId: string): string {
  return `conversation-${createHash("sha256")
    .update(conversationId)
    .digest("hex")}`;
}

function registerCreateBooking(
  server: McpServer,
  conversationBooking: ConversationBookingNamespace | undefined,
  ctx: ToolContext,
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
    }, extra) => {
      const start = Date.now();
      const conversationId = readConversationId(extra);

      // Missing or invalid conversation identity blocks the write path
      // before any infrastructure call — the request can never reach an
      // Actor that would know what to do with it.
      if (conversationId === undefined) {
        return logToolResult(
          "create_booking",
          ctx,
          start,
          toolError("conversation_id_required"),
          conversationId,
        );
      }

      // Valid metadata but no binding at all: this is a configuration
      // defect, surfaced as generic service_unavailable. We never fall
      // back to `conversation_id_required` here — that code is reserved
      // for missing/invalid metadata and would mislead the caller about
      // what to fix.
      if (conversationBooking === undefined) {
        return logToolResult(
          "create_booking",
          ctx,
          start,
          toolError(),
          conversationId,
        );
      }

      // The Actor lookup and the RPC are both wrapped in one try/catch:
      // any exception from idFromName() or from the book() call itself
      // (binding missing at runtime, network failure, actor crash, etc.)
      // is collapsed to a generic tool error. The raw exception never
      // reaches the response or any log line.
      let raw: ConversationBookingResult;
      try {
        const actorName = conversationActorName(conversationId);
        const stub = conversationBooking.idFromName(actorName);
        raw = await stub.book({
          service_id: args.service_id,
          date: args.date,
          time: args.time,
          customer_name: args.customer_name,
          customer_phone: args.customer_phone,
          confirmed: args.confirmed,
        });
      } catch {
        return logToolResult(
          "create_booking",
          ctx,
          start,
          toolError(),
          conversationId,
        );
      }

      const validated = validateConfirmedResult(raw, {
        service_id: args.service_id,
        date: args.date,
        time: args.time,
      });
      if (validated !== null) {
        return logToolResult(
          "create_booking",
          ctx,
          start,
          {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "confirmed",
                  booking_id: validated.booking_id,
                  service_id: validated.service_id,
                  date: validated.date,
                  time: validated.time,
                }),
              },
            ],
          },
          conversationId,
        );
      }

      // Not confirmed — try to classify as a domain rejection. Anything
      // malformed (unknown shape, unknown code) collapses to
      // service_unavailable.
      if (
        typeof raw === "object" &&
        raw !== null &&
        !Array.isArray(raw) &&
        (raw as { kind?: unknown }).kind === "rejected" &&
        typeof (raw as { code?: unknown }).code === "string" &&
        REJECTION_CODES.has((raw as { code: string }).code)
      ) {
        return logToolResult(
          "create_booking",
          ctx,
          start,
          toolError((raw as { code: string }).code),
          conversationId,
        );
      }

      return logToolResult(
        "create_booking",
        ctx,
        start,
        toolError(),
        conversationId,
      );
    },
  );
}

// Single shared instance — there is only one callback queue across all
// conversations. Routing all callers to the same Actor name guarantees a
// single coherent read-modify-write of the "queue" key.
const CALLBACK_QUEUE_ACTOR_NAME = "main";

// `request_callback` — write path. Records a callback request for the team
// against the trusted Telnyx conversation id. Conversation identity is
// required (read from SDK metadata only) and routes the call to a single
// shared CallbackQueue StatefulActor that owns the persisted queue and
// per-conversation idempotency. The Actor returns only an opaque
// request_id and the originating created_at — customer name and phone
// are accepted on the wire, persisted inside the Actor, but never echoed
// back in the MCP response. Tool-handler failures never throw out —
// missing metadata, absent binding, RPC failures, and malformed Actor
// results all collapse to a generic MCP tool error.
function registerRequestCallback(
  server: McpServer,
  callbackQueue: CallbackQueueNamespace | undefined,
  ctx: ToolContext,
): void {
  server.registerTool(
    "request_callback",
    {
      description:
        "Record a callback request for the team. Call once, after the caller gives their name and a short reason. Only tell the caller the request is recorded if status is recorded.",
      inputSchema: REQUEST_CALLBACK_INPUT,
    },
    async (
      args: { customer_name: string; customer_phone: string; reason: string },
      extra,
    ) => {
      const start = Date.now();
      const conversationId = readConversationId(extra);

      if (conversationId === undefined) {
        return logToolResult(
          "request_callback",
          ctx,
          start,
          toolError("conversation_id_required"),
          conversationId,
        );
      }

      if (callbackQueue === undefined) {
        return logToolResult(
          "request_callback",
          ctx,
          start,
          toolError(),
          conversationId,
        );
      }

      let raw: { request_id?: unknown; created_at?: unknown };
      try {
        const stub = callbackQueue.idFromName(CALLBACK_QUEUE_ACTOR_NAME);
        raw = await stub.requestCallback({
          conversation_id: conversationId,
          customer_name: args.customer_name,
          customer_phone: args.customer_phone,
          reason: args.reason,
        });
      } catch {
        return logToolResult(
          "request_callback",
          ctx,
          start,
          toolError(),
          conversationId,
        );
      }

      if (
        typeof raw?.request_id !== "string" ||
        raw.request_id.length === 0 ||
        typeof raw.created_at !== "string"
      ) {
        return logToolResult(
          "request_callback",
          ctx,
          start,
          toolError(),
          conversationId,
        );
      }

      const requestId = raw.request_id;
      const latencyMs = Date.now() - start;

      logEvent("callback.requested", {
        request_id: requestId,
        telnyx_conversation_id: conversationId,
        phone_masked: maskPhone(args.customer_phone),
        latency_ms: latencyMs,
      });
      await recordMetric(ctx.metrics, {
        event: "callback",
        outcome: "requested",
        telnyx_conversation_id: conversationId,
      });

      return logToolResult(
        "request_callback",
        ctx,
        start,
        {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ status: "recorded", request_id: requestId }),
            },
          ],
        },
        conversationId,
      );
    },
  );
}

export interface McpDeps {
  config?: KvNamespace;
  agenda?: AgendaNamespace;
  conversationBooking?: ConversationBookingNamespace;
  callbackQueue?: CallbackQueueNamespace;
  // Optional caller-supplied correlation id (e.g. the Telnyx call_control_id
  // forwarded as a header), logged so a call can be traced across webhook
  // and tool calls. Never used for authorization or business logic.
  callId?: string;
  metrics?: MetricsNamespace;
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

  const ctx: ToolContext = { callId: deps.callId ?? "", metrics: deps.metrics };
  registerGetServiceCatalog(server, deps.config, ctx);
  registerGetAvailability(server, deps.config, deps.agenda, ctx);
  registerCreateBooking(server, deps.conversationBooking, ctx);
  registerRequestCallback(server, deps.callbackQueue, ctx);

  try {
    await server.connect(transport);
    return await transport.handleRequest(req);
  } finally {
    await transport.close();
    await server.close();
  }
}
