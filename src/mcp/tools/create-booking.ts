import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHash } from "node:crypto";
import { z } from "zod";

import type { ConversationBookingNamespace } from "../../actors/bindings";
import type { ConversationBookingResult } from "../../domain/conversation-booking";
import { startToolCall, toolError, toolJson, type ToolContext } from "../tool-result";

const INPUT = z
  .object({
    service_id: z.string().trim().min(1).max(128),
    date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
    time: z.string().trim().regex(/^\d{2}:\d{2}$/),
    customer_name: z.string().trim().min(1).max(256),
    customer_phone: z.string().trim().min(1).max(64),
    confirmed: z.boolean(),
  })
  .strict();

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

function isNonEmptyString(v: unknown): v is string {
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
  if (r.kind !== "confirmed") return null;
  if (!isNonEmptyString(r.booking_id)) return null;
  if (!isNonEmptyString(r.service_id) || r.service_id !== expected.service_id) return null;
  if (!isNonEmptyString(r.date) || r.date !== expected.date) return null;
  if (!isNonEmptyString(r.time) || r.time !== expected.time) return null;
  return { booking_id: r.booking_id, service_id: r.service_id, date: r.date, time: r.time };
}

function rejectionCode(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as { kind?: unknown; code?: unknown };
  return r.kind === "rejected" && typeof r.code === "string" && REJECTION_CODES.has(r.code)
    ? r.code
    : null;
}

// Stable Actor name for a conversation: SHA-256 over the validated
// conversation id, so the same conversation always lands on the same Actor.
function conversationActorName(conversationId: string): string {
  return `conversation-${createHash("sha256").update(conversationId).digest("hex")}`;
}

// `create_booking` — write path through the conversation-scoped Actor, which
// owns one-booking-per-conversation and its own idempotency. Conversation
// identity comes from platform metadata only, never from tool arguments.
// Customer name and phone never appear in any response.
export function registerCreateBooking(
  server: McpServer,
  conversationBooking: ConversationBookingNamespace | undefined,
  ctx: ToolContext,
): void {
  server.registerTool(
    "create_booking",
    {
      description:
        "Create the appointment. Call ONLY after the caller explicitly confirmed service, date and time; set confirmed=true only then. Use a time returned by get_availability. Retrying with identical arguments is safe and returns the same booking.",
      inputSchema: INPUT,
    },
    async (
      args: {
        service_id: string;
        date: string;
        time: string;
        customer_name: string;
        customer_phone: string;
        confirmed: boolean;
      },
      extra,
    ) => {
      const { conversationId, done } = startToolCall("create_booking", ctx, extra);

      // Missing conversation identity blocks the write before any
      // infrastructure call. A missing binding is a configuration defect,
      // reported as the generic error rather than conversation_id_required.
      if (conversationId === undefined) return done(toolError("conversation_id_required"));
      if (conversationBooking === undefined) return done(toolError());

      let raw: ConversationBookingResult;
      try {
        raw = await conversationBooking.idFromName(conversationActorName(conversationId)).book({
          service_id: args.service_id,
          date: args.date,
          time: args.time,
          customer_name: args.customer_name,
          customer_phone: args.customer_phone,
          confirmed: args.confirmed,
        });
      } catch {
        return done(toolError());
      }

      const confirmed = validateConfirmedResult(raw, args);
      if (confirmed !== null) return done(toolJson({ status: "confirmed", ...confirmed }));

      const code = rejectionCode(raw);
      return done(code !== null ? toolError(code) : toolError());
    },
  );
}
