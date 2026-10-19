import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";

import type { MetricsNamespace } from "../actors/bindings";
import { logEvent } from "../observability/logger";
import { recordMetric } from "../observability/metrics";

export const TOOL_ERROR_TEXT = "service_unavailable";

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface ToolContext {
  callId: string;
  metrics?: MetricsNamespace;
}

// Matches the SDK's CallToolResult shape (it requires an index signature).
export type ToolResult = {
  [key: string]: unknown;
  isError?: true;
  content: Array<{ type: "text"; text: string }>;
};

// Conversation id set by the Telnyx platform in JSON-RPC params._meta (not
// by the model). Bounded charset so the value can never inject into a log
// line. Write tools require it and use it to route to per-conversation state.
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;

export function readConversationId(extra: ToolExtra): string | undefined {
  const meta = extra._meta as Record<string, unknown> | undefined;
  const raw = meta?.["telnyx_conversation_id"];
  return typeof raw === "string" && CONVERSATION_ID_PATTERN.test(raw)
    ? raw
    : undefined;
}

export function toolJson(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

// A domain code becomes {"error":"<code>"}; no code means a generic
// infrastructure failure that never leaks the underlying exception.
export function toolError(code?: string): ToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: code === undefined ? TOOL_ERROR_TEXT : JSON.stringify({ error: code }),
      },
    ],
  };
}

// Classify a tool result into the outcome label emitted to the structured
// log. Success → "ok"; domain errors carry the error code; missing bindings
// and infra failures collapse to "service_unavailable". Never derives the
// outcome from anything that could include tool arguments or PII.
function classifyToolOutcome(result: ToolResult): string {
  if (result.isError !== true) return "ok";
  const text = result.content[0]?.text ?? "";
  if (text === TOOL_ERROR_TEXT) return "service_unavailable";
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : "service_unavailable";
  } catch {
    return "service_unavailable";
  }
}

// Logs one "mcp.tool_call" line and records the metric for every tool
// result, success or failure, then returns the result unchanged.
export async function logToolResult(
  tool: string,
  ctx: ToolContext,
  start: number,
  result: ToolResult,
  conversationId?: string,
): Promise<ToolResult> {
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

// Starts the clock for one tool call and returns a finisher bound to it.
export function startToolCall(tool: string, ctx: ToolContext, extra: ToolExtra) {
  const start = Date.now();
  const conversationId = readConversationId(extra);
  const done = (result: ToolResult) => logToolResult(tool, ctx, start, result, conversationId);
  return { conversationId, done };
}
