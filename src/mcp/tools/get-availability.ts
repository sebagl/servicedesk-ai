import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KvNamespace } from "@telnyx/edge-runtime";
import { z } from "zod";

import type { AgendaNamespace } from "../../actors/bindings";
import { getAvailability } from "../../app/availability";
import { loadConfig } from "../../domain/config";
import { isValidDate } from "../../domain/scheduling";
import { startToolCall, toolError, toolJson, type ToolContext } from "../tool-result";

const INPUT = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();

// `get_availability` — read-only: open appointment times for one date.
// Reuses loadConfig + getAvailability so the same validation, fail-closed
// semantics and Actor occupancy check apply.
export function registerGetAvailability(
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
      inputSchema: INPUT,
    },
    async (args: { date: string }, extra) => {
      const { done } = startToolCall("get_availability", ctx, extra);
      if (!isValidDate(args.date)) return done(toolError("date_invalid"));
      if (config === undefined || agenda === undefined) return done(toolError());

      const cfgResult = await loadConfig(config);
      if (!cfgResult.ok) return done(toolError());

      const result = await getAvailability(args.date, Date.now(), cfgResult.config, agenda);
      if ("kind" in result) {
        const isDomainError = result.kind === "date_invalid" || result.kind === "date_out_of_range";
        return done(isDomainError ? toolError(result.kind) : toolError());
      }

      return done(
        toolJson({
          date: result.date,
          timezone: result.timezone,
          booking_enabled: result.booking_enabled,
          available_times: result.slots.filter((s) => s.available).map((s) => s.time),
        }),
      );
    },
  );
}
