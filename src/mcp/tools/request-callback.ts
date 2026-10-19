import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { DayCallbacksNamespace } from "../../actors/bindings";
import { callbacksActorName } from "../../domain/business-rules";
import { getLocalDateString } from "../../domain/scheduling";
import { logEvent, maskPhone } from "../../observability/logger";
import { recordMetric } from "../../observability/metrics";
import { startToolCall, toolError, toolJson, type ToolContext } from "../tool-result";

const INPUT = z
  .object({
    customer_name: z.string().trim().min(1).max(256),
    customer_phone: z.string().trim().min(1).max(64),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

// `request_callback` — write path. Records a callback request for the team,
// idempotent per conversation within the local day. Name and phone are
// stored inside the Actor but never echoed back in the response.
export function registerRequestCallback(
  server: McpServer,
  dayCallbacks: DayCallbacksNamespace | undefined,
  ctx: ToolContext,
): void {
  server.registerTool(
    "request_callback",
    {
      description:
        "Record a callback request for the team. Call once, after the caller gives their name and a short reason. Only tell the caller the request is recorded if status is recorded.",
      inputSchema: INPUT,
    },
    async (args: { customer_name: string; customer_phone: string; reason: string }, extra) => {
      const start = Date.now();
      const { conversationId, done } = startToolCall("request_callback", ctx, extra);
      if (conversationId === undefined) return done(toolError("conversation_id_required"));
      if (dayCallbacks === undefined) return done(toolError());

      let raw: { request_id?: unknown; created_at?: unknown };
      try {
        raw = await dayCallbacks
          .idFromName(callbacksActorName(getLocalDateString(Date.now())))
          .requestCallback({
            conversation_id: conversationId,
            customer_name: args.customer_name,
            customer_phone: args.customer_phone,
            reason: args.reason,
          });
      } catch {
        return done(toolError());
      }

      if (
        typeof raw?.request_id !== "string" ||
        raw.request_id.length === 0 ||
        typeof raw.created_at !== "string"
      ) {
        return done(toolError());
      }

      logEvent("callback.requested", {
        request_id: raw.request_id,
        telnyx_conversation_id: conversationId,
        phone_masked: maskPhone(args.customer_phone),
        latency_ms: Date.now() - start,
      });
      await recordMetric(ctx.metrics, {
        event: "callback",
        outcome: "requested",
        telnyx_conversation_id: conversationId,
      });

      return done(toolJson({ status: "recorded", request_id: raw.request_id }));
    },
  );
}
