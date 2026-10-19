import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KvNamespace } from "@telnyx/edge-runtime";
import { z } from "zod";

import { loadConfig } from "../../domain/config";
import { startToolCall, toolError, toolJson, type ToolContext } from "../tool-result";

// Strict empty object: the SDK rejects unexpected properties with a JSON-RPC
// Invalid params error.
const INPUT = z.object({}).strict();

// `get_service_catalog` — read-only: configured services and the admission
// flag, through loadConfig so the same validation and fail-closed semantics
// apply.
export function registerGetServiceCatalog(
  server: McpServer,
  kv: KvNamespace | undefined,
  ctx: ToolContext,
): void {
  server.registerTool(
    "get_service_catalog",
    {
      description:
        "Returns the service catalog (id, name, duration_minutes) and the booking_enabled admission flag.",
      inputSchema: INPUT,
    },
    async (_args, extra) => {
      const { done } = startToolCall("get_service_catalog", ctx, extra);
      if (kv === undefined) return done(toolError());

      const result = await loadConfig(kv);
      if (!result.ok) return done(toolError());

      return done(
        toolJson({
          services: result.config.services,
          booking_enabled: result.config.business.booking_enabled,
        }),
      );
    },
  );
}
