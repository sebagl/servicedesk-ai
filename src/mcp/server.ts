import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { KvNamespace } from "@telnyx/edge-runtime";

import type {
  AgendaNamespace,
  CallbackQueueNamespace,
  ConversationBookingNamespace,
  MetricsNamespace,
} from "../actors/bindings";
import type { ToolContext } from "./tool-result";
import { registerCreateBooking } from "./tools/create-booking";
import { registerGetAvailability } from "./tools/get-availability";
import { registerGetServiceCatalog } from "./tools/get-service-catalog";
import { registerRequestCallback } from "./tools/request-callback";

const SERVICE_INFO = { name: "servicedesk-ai", version: "0.0.0" } as const;

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
export async function handleMcpRequest(req: Request, deps: McpDeps): Promise<Response> {
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
