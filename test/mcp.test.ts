import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@telnyx/edge-runtime", () => ({
  StatefulActor: class {
    ctx: unknown;
  },
}));

import handler from "../src/index";
import { __resetMcpTokenCacheForTests } from "../src/index";
import type { AppConfig } from "../src/config";
import type {
  ConversationBookingInput,
  ConversationBookingResult,
} from "../src/conversation-booking";

const VALID_TOKEN = "mcp-test-token-value";

const VALID_CONFIG: AppConfig = {
  services: [
    { id: "oil_change", name: "Oil Change", duration_minutes: 60 },
    { id: "tire_rotation", name: "Tire Rotation", duration_minutes: 60 },
  ],
  business: {
    location_id: "main",
    timezone: "America/Mexico_City",
    open_days: ["mon", "tue", "wed", "thu", "fri"],
    slot_hours: { start: "09:00", end: "17:00", last_start: "16:00" },
    booking_window_days: 7,
    booking_enabled: true,
  },
};

type KvMock = { get: ReturnType<typeof vi.fn> };
type SecretsMock = { get: ReturnType<typeof vi.fn> };

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function mcpHeaders(
  token: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...bearer(token),
    ...extra,
  };
}

function jsonRpcBody(
  id: number,
  method: string,
  params: unknown = {},
): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

function mcpRequest(
  body: string,
  headers: Record<string, string>,
): Request {
  return new Request("http://x/mcp", { method: "POST", headers, body });
}

function validKv(config: unknown): KvMock {
  return { get: vi.fn(async () => config) };
}

function rejectingKv(): KvMock {
  return {
    get: vi.fn(async () => {
      throw new Error("network error");
    }),
  };
}

function validSecrets(): SecretsMock {
  return { get: vi.fn(async (binding: string) => {
    if (binding === "MCP_AUTH") return VALID_TOKEN;
    if (binding === "SMOKE_AUTH") return "smoke";
    throw new Error("unknown binding");
  }) };
}

function fullEnv(secrets?: SecretsMock, kv?: KvMock): unknown {
  return { SECRETS: secrets, CONFIG: kv };
}

// Reset the module-level MCP_AUTH cache so each test exercises the
// first-lookup semantics in isolation. Production code never calls the
// reset — the cache is invalidated by an instance restart, which is the
// right time to re-read a binding that may have rotated.
beforeEach(() => {
  __resetMcpTokenCacheForTests();
});

// ---------------------------------------------------------------------------
// Auth gate — runs before protocol processing and KV access
// ---------------------------------------------------------------------------

describe("/mcp — auth gate before protocol processing", () => {
  it("missing SECRETS binding → 503, KV never read", async () => {
    const kv = validKv(VALID_CONFIG);
    const env = { CONFIG: kv };
    const res = await handler.fetch(
      mcpRequest(jsonRpcBody(1, "initialize"), mcpHeaders(VALID_TOKEN)),
      env as never,
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "service_unavailable" });
    expect(kv.get).not.toHaveBeenCalled();
  });

  it("empty MCP_AUTH secret → 503, KV never read", async () => {
    const kv = validKv(VALID_CONFIG);
    const secrets = {
      get: vi.fn(async (binding: string) => {
        if (binding === "MCP_AUTH") return "";
        return "smoke";
      }),
    };
    const res = await handler.fetch(
      mcpRequest(jsonRpcBody(1, "initialize"), mcpHeaders(VALID_TOKEN)),
      fullEnv(secrets, kv) as never,
    );
    expect(res.status).toBe(503);
    expect(kv.get).not.toHaveBeenCalled();
  });

  it("MCP_AUTH retrieval rejects → 503, KV never read", async () => {
    const kv = validKv(VALID_CONFIG);
    const secrets = {
      get: vi.fn(async (binding: string) => {
        if (binding === "MCP_AUTH") throw new Error("retrieval failed");
        return "smoke";
      }),
    };
    const res = await handler.fetch(
      mcpRequest(jsonRpcBody(1, "initialize"), mcpHeaders(VALID_TOKEN)),
      fullEnv(secrets, kv) as never,
    );
    expect(res.status).toBe(503);
    expect(kv.get).not.toHaveBeenCalled();
  });

  it("wrong bearer → 401, KV never read", async () => {
    const kv = validKv(VALID_CONFIG);
    const res = await handler.fetch(
      mcpRequest(jsonRpcBody(1, "initialize"), mcpHeaders("wrong-token")),
      fullEnv(validSecrets(), kv) as never,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(kv.get).not.toHaveBeenCalled();
  });

  it("missing Authorization header → 401, KV never read", async () => {
    const kv = validKv(VALID_CONFIG);
    const res = await handler.fetch(
      new Request("http://x/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: jsonRpcBody(1, "initialize"),
      }),
      fullEnv(validSecrets(), kv) as never,
    );
    expect(res.status).toBe(401);
    expect(kv.get).not.toHaveBeenCalled();
  });

  it("malformed Authorization (no Bearer prefix) → 401", async () => {
    const kv = validKv(VALID_CONFIG);
    const res = await handler.fetch(
      mcpRequest(jsonRpcBody(1, "initialize"), {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Token ${VALID_TOKEN}`,
      }),
      fullEnv(validSecrets(), kv) as never,
    );
    expect(res.status).toBe(401);
    expect(kv.get).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Origin rejection — server-to-server MVP
// ---------------------------------------------------------------------------

describe("/mcp — Origin header rejected (server-to-server MVP)", () => {
  it("rejects browser-originated requests with 404, no auth, no KV", async () => {
    const kv = validKv(VALID_CONFIG);
    const res = await handler.fetch(
      mcpRequest(jsonRpcBody(1, "initialize"), {
        ...mcpHeaders(VALID_TOKEN),
        origin: "https://evil.example",
      }),
      fullEnv(validSecrets(), kv) as never,
    );
    expect(res.status).toBe(404);
    expect(kv.get).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Protocol — real SDK handles negotiation, methods, notifications
// ---------------------------------------------------------------------------

describe("/mcp — SDK protocol negotiation (initialize)", () => {
  it("returns protocolVersion, serverInfo, capabilities as JSON", async () => {
    const res = await handler.fetch(
      mcpRequest(
        jsonRpcBody(1, "initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test-client", version: "0.0.0" },
        }),
        mcpHeaders(VALID_TOKEN),
      ),
      fullEnv(validSecrets(), validKv(VALID_CONFIG)) as never,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = (await res.json()) as {
      jsonrpc: string;
      id: number;
      result: {
        protocolVersion: string;
        serverInfo: { name: string; version: string };
        capabilities: Record<string, unknown>;
      };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(body.result.serverInfo.name).toBe("servicedesk-ai");
    expect(body.result.capabilities).toBeDefined();
    expect(typeof body.result.protocolVersion).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// tools/list — only get_service_catalog is advertised
// ---------------------------------------------------------------------------

describe("/mcp — tools/list", () => {
  it("advertises exactly one tool: get_service_catalog", async () => {
    const res = await handler.fetch(
      mcpRequest(
        jsonRpcBody(1, "initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "0.0.0" },
        }),
        mcpHeaders(VALID_TOKEN),
      ),
      fullEnv(validSecrets(), validKv(VALID_CONFIG)) as never,
    );
    expect(res.status).toBe(200);

    const listRes = await handler.fetch(
      mcpRequest(jsonRpcBody(2, "tools/list"), mcpHeaders(VALID_TOKEN)),
      fullEnv(validSecrets(), validKv(VALID_CONFIG)) as never,
    );
    expect(listRes.status).toBe(200);
    const body = (await listRes.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(body.result.tools.map((t) => t.name)).toEqual([
      "get_service_catalog",
      "get_availability",
      "create_booking",
    ]);
  });
});

// ---------------------------------------------------------------------------
// tools/call — successful get_service_catalog
// ---------------------------------------------------------------------------

describe("/mcp — tools/call get_service_catalog (no args)", () => {
  it("returns services and booking_enabled, reads KV once", async () => {
    const kv = validKv(VALID_CONFIG);
    const res = await handler.fetch(
      mcpRequest(
        jsonRpcBody(1, "tools/call", {
          name: "get_service_catalog",
          arguments: {},
        }),
        mcpHeaders(VALID_TOKEN),
      ),
      fullEnv(validSecrets(), kv) as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
      };
    };
    expect(body.result.isError).toBeFalsy();
    expect(body.result.content).toHaveLength(1);
    const parsed = JSON.parse(body.result.content[0]!.text) as {
      services: Array<{ id: string; name: string; duration_minutes: number }>;
      booking_enabled: boolean;
    };
    expect(parsed.services).toHaveLength(2);
    expect(parsed.services[0]!.id).toBe("oil_change");
    expect(parsed.booking_enabled).toBe(true);
    expect(kv.get).toHaveBeenCalledTimes(1);
  });

  it("booking_enabled=false reflects config without error", async () => {
    const kv = validKv({
      ...VALID_CONFIG,
      business: { ...VALID_CONFIG.business, booking_enabled: false },
    });
    const res = await handler.fetch(
      mcpRequest(
        jsonRpcBody(1, "tools/call", {
          name: "get_service_catalog",
          arguments: {},
        }),
        mcpHeaders(VALID_TOKEN),
      ),
      fullEnv(validSecrets(), kv) as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { content: Array<{ text: string }> };
    };
    const parsed = JSON.parse(body.result.content[0]!.text) as {
      booking_enabled: boolean;
    };
    expect(parsed.booking_enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// tools/call — config failure surfaces as MCP tool error, no raw exception
// ---------------------------------------------------------------------------

describe("/mcp — tools/call get_service_catalog config failure", () => {
  it("missing CONFIG binding → tool error result, HTTP 200", async () => {
    const res = await handler.fetch(
      mcpRequest(
        jsonRpcBody(1, "tools/call", {
          name: "get_service_catalog",
          arguments: {},
        }),
        mcpHeaders(VALID_TOKEN),
      ),
      fullEnv(validSecrets(), undefined) as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {
        isError: boolean;
        content: Array<{ type: string; text: string }>;
      };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toBe("service_unavailable");
  });

  it("KV throws → tool error result, HTTP 200", async () => {
    const res = await handler.fetch(
      mcpRequest(
        jsonRpcBody(1, "tools/call", {
          name: "get_service_catalog",
          arguments: {},
        }),
        mcpHeaders(VALID_TOKEN),
      ),
      fullEnv(validSecrets(), rejectingKv()) as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {
        isError: boolean;
        content: Array<{ type: string; text: string }>;
      };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toBe("service_unavailable");
  });

  it("KV returns malformed config → tool error result, HTTP 200", async () => {
    const res = await handler.fetch(
      mcpRequest(
        jsonRpcBody(1, "tools/call", {
          name: "get_service_catalog",
          arguments: {},
        }),
        mcpHeaders(VALID_TOKEN),
      ),
      fullEnv(validSecrets(), validKv({ services: [] })) as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {
        isError: boolean;
        content: Array<{ type: string; text: string }>;
      };
    };
    expect(body.result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// tools/call — unexpected arguments rejected by the SDK
// ---------------------------------------------------------------------------

describe("/mcp — tools/call get_service_catalog with unexpected args", () => {
  it("rejects unrecognized keys via MCP tool error, KV not read", async () => {
    const kv = validKv(VALID_CONFIG);
    const res = await handler.fetch(
      mcpRequest(
        jsonRpcBody(1, "tools/call", {
          name: "get_service_catalog",
          arguments: { extra: "not-allowed" },
        }),
        mcpHeaders(VALID_TOKEN),
      ),
      fullEnv(validSecrets(), kv) as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {
        isError: boolean;
        content: Array<{ type: string; text: string }>;
      };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toMatch(/-32602/);
    expect(body.result.content[0]!.text).toMatch(/Unrecognized key/);
    expect(kv.get).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Two independent requests — fresh server/transport per request, no shared state
// ---------------------------------------------------------------------------

describe("/mcp — two independent requests have no shared transport state", () => {
  let kv: KvMock;
  beforeEach(() => {
    kv = validKv(VALID_CONFIG);
  });

  it("first request + second request are independent; no Mcp-Session-Id header", async () => {
    // Request 1 — initialize + tools/call
    const init1 = await handler.fetch(
      mcpRequest(
        jsonRpcBody(1, "initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "client-1", version: "0.0.0" },
        }),
        mcpHeaders(VALID_TOKEN),
      ),
      fullEnv(validSecrets(), kv) as never,
    );
    expect(init1.status).toBe(200);
    expect(init1.headers.get("mcp-session-id")).toBeNull();

    const call1 = await handler.fetch(
      mcpRequest(
        jsonRpcBody(2, "tools/call", {
          name: "get_service_catalog",
          arguments: {},
        }),
        mcpHeaders(VALID_TOKEN),
      ),
      fullEnv(validSecrets(), kv) as never,
    );
    expect(call1.status).toBe(200);
    const body1 = (await call1.json()) as {
      jsonrpc: string;
      id: number;
      result: { content: Array<{ text: string }> };
    };
    expect(body1.id).toBe(2);

    // Request 2 — fresh initialize, fresh transport; same jsonrpc id 1 is fine
    const init2 = await handler.fetch(
      mcpRequest(
        jsonRpcBody(1, "initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "client-2", version: "0.0.0" },
        }),
        mcpHeaders(VALID_TOKEN),
      ),
      fullEnv(validSecrets(), kv) as never,
    );
    expect(init2.status).toBe(200);
    expect(init2.headers.get("mcp-session-id")).toBeNull();

    const body2 = (await init2.json()) as {
      result: { serverInfo: { name: string } };
    };
    expect(body2.result.serverInfo.name).toBe("servicedesk-ai");

    // Both requests served; both transports stateless (no shared session id).
    expect(kv.get).toHaveBeenCalledTimes(1);
  });

  it("GET /health still 200 (no /mcp side effects on existing routes)", async () => {
    const env = { COUNTER: { idFromName: () => ({ increment: vi.fn(), read: vi.fn() }) } };
    const res = await handler.fetch(
      new Request("http://x/health"),
      env as never,
    );
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// tools/call — get_availability
// ---------------------------------------------------------------------------

describe("/mcp — tools/call get_availability", () => {
  // Pick a date within the 7-day booking window that lands on an open
  // weekday (Mon–Fri in America/Mexico_City), so generateDaySlots returns
  // the full 8-slot set deterministically.
  function futureOpenDate(): string {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Mexico_City",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
    });
    for (let i = 1; i <= 6; i++) {
      const parts = fmt.formatToParts(new Date(Date.now() + i * 86_400_000));
      const weekday = parts.find((p) => p.type === "weekday")!.value;
      if (["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday)) {
        const y = parts.find((p) => p.type === "year")!.value;
        const m = parts.find((p) => p.type === "month")!.value;
        const d = parts.find((p) => p.type === "day")!.value;
        return `${y}-${m}-${d}`;
      }
    }
    throw new Error("no open weekday within booking window");
  }

  function validAgenda(occupied: string[] = []) {
    return {
      idFromName: vi.fn(() => ({
        getOccupiedSlots: vi.fn(async () => ({ occupied })),
      })),
    };
  }

  function throwingAgenda() {
    return {
      idFromName: vi.fn(() => ({
        getOccupiedSlots: vi.fn(async () => {
          throw new Error("actor down");
        }),
      })),
    };
  }

  it("returns available_times for an open date with no occupancy", async () => {
    const kv = validKv(VALID_CONFIG);
    const agenda = validAgenda();
    const date = futureOpenDate();
    const res = await handler.fetch(
      mcpRequest(
        jsonRpcBody(1, "tools/call", {
          name: "get_availability",
          arguments: { date },
        }),
        mcpHeaders(VALID_TOKEN),
      ),
      { SECRETS: validSecrets(), CONFIG: kv, AGENDA: agenda } as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
      };
    };
    expect(body.result.isError).toBeFalsy();
    expect(body.result.content).toHaveLength(1);
    const parsed = JSON.parse(body.result.content[0]!.text) as {
      date: string;
      timezone: string;
      booking_enabled: boolean;
      available_times: string[];
    };
    expect(parsed.date).toBe(date);
    expect(parsed.timezone).toBe("America/Mexico_City");
    expect(parsed.booking_enabled).toBe(true);
    expect(parsed.available_times).toEqual([
      "09:00",
      "10:00",
      "11:00",
      "12:00",
      "13:00",
      "14:00",
      "15:00",
      "16:00",
    ]);
    expect(agenda.idFromName).toHaveBeenCalledTimes(1);
  });

  it("excludes occupied slots from available_times", async () => {
    const kv = validKv(VALID_CONFIG);
    const agenda = validAgenda(["10:00", "14:00"]);
    const date = futureOpenDate();
    const res = await handler.fetch(
      mcpRequest(
        jsonRpcBody(1, "tools/call", {
          name: "get_availability",
          arguments: { date },
        }),
        mcpHeaders(VALID_TOKEN),
      ),
      { SECRETS: validSecrets(), CONFIG: kv, AGENDA: agenda } as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
      };
    };
    expect(body.result.isError).toBeFalsy();
    const parsed = JSON.parse(body.result.content[0]!.text) as {
      available_times: string[];
    };
    expect(parsed.available_times).not.toContain("10:00");
    expect(parsed.available_times).not.toContain("14:00");
    expect(parsed.available_times).toContain("09:00");
    expect(parsed.available_times).toContain("16:00");
  });

  it("out-of-range date → date_out_of_range isError", async () => {
    const kv = validKv(VALID_CONFIG);
    const agenda = validAgenda();
    const res = await handler.fetch(
      mcpRequest(
        jsonRpcBody(1, "tools/call", {
          name: "get_availability",
          arguments: { date: "2099-01-01" },
        }),
        mcpHeaders(VALID_TOKEN),
      ),
      { SECRETS: validSecrets(), CONFIG: kv, AGENDA: agenda } as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {
        isError: boolean;
        content: Array<{ type: string; text: string }>;
      };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toBe(
      JSON.stringify({ error: "date_out_of_range" }),
    );
  });

  it("calendar-invalid date → date_invalid isError", async () => {
    const kv = validKv(VALID_CONFIG);
    const agenda = validAgenda();
    const res = await handler.fetch(
      mcpRequest(
        jsonRpcBody(1, "tools/call", {
          name: "get_availability",
          arguments: { date: "2026-02-30" },
        }),
        mcpHeaders(VALID_TOKEN),
      ),
      { SECRETS: validSecrets(), CONFIG: kv, AGENDA: agenda } as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {
        isError: boolean;
        content: Array<{ type: string; text: string }>;
      };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toBe(
      JSON.stringify({ error: "date_invalid" }),
    );
  });

  it("rejects unexpected arguments via SDK invalid params", async () => {
    const kv = validKv(VALID_CONFIG);
    const agenda = validAgenda();
    const date = futureOpenDate();
    const res = await handler.fetch(
      mcpRequest(
        jsonRpcBody(1, "tools/call", {
          name: "get_availability",
          arguments: { date, extra: "not-allowed" },
        }),
        mcpHeaders(VALID_TOKEN),
      ),
      { SECRETS: validSecrets(), CONFIG: kv, AGENDA: agenda } as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {
        isError: boolean;
        content: Array<{ type: string; text: string }>;
      };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toMatch(/-32602/);
    expect(kv.get).not.toHaveBeenCalled();
  });

  it("Actor throws → service_unavailable isError", async () => {
    const kv = validKv(VALID_CONFIG);
    const agenda = throwingAgenda();
    const date = futureOpenDate();
    const res = await handler.fetch(
      mcpRequest(
        jsonRpcBody(1, "tools/call", {
          name: "get_availability",
          arguments: { date },
        }),
        mcpHeaders(VALID_TOKEN),
      ),
      { SECRETS: validSecrets(), CONFIG: kv, AGENDA: agenda } as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {
        isError: boolean;
        content: Array<{ type: string; text: string }>;
      };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toBe("service_unavailable");
  });
});

// ---------------------------------------------------------------------------
// tools/call — create_booking (conversation-scoped StatefulActor)
// ---------------------------------------------------------------------------

describe("/mcp — tools/call create_booking", () => {
  type ActorHandler = (
    input: ConversationBookingInput,
  ) =>
    | ConversationBookingResult
    | Error
    | Promise<ConversationBookingResult | Error>;

  function conversationBookingActor(handler: ActorHandler) {
    const stub = {
      book: vi.fn(async (input: ConversationBookingInput) => {
        const result = await handler(input);
        if (result instanceof Error) throw result;
        return result;
      }),
    };
    return {
      stub,
      idFromName: vi.fn(() => stub),
    };
  }

  function futureOpenDate(): string {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Mexico_City",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
    });
    for (let i = 1; i <= 6; i++) {
      const parts = fmt.formatToParts(new Date(Date.now() + i * 86_400_000));
      const weekday = parts.find((p) => p.type === "weekday")!.value;
      if (["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday)) {
        const y = parts.find((p) => p.type === "year")!.value;
        const m = parts.find((p) => p.type === "month")!.value;
        const d = parts.find((p) => p.type === "day")!.value;
        return `${y}-${m}-${d}`;
      }
    }
    throw new Error("no open weekday within booking window");
  }

  const BASE_ARGS = () => {
    const date = futureOpenDate();
    return {
      service_id: "oil_change",
      date,
      time: "10:00",
      customer_name: "Alice",
      customer_phone: "+5215512345678",
      confirmed: true,
    };
  };

  function callBooking(
    env: unknown,
    id: number,
    arguments_: unknown,
    meta: unknown = undefined,
  ): Promise<Response> {
    const params: Record<string, unknown> = {
      name: "create_booking",
      arguments: arguments_,
    };
    if (meta !== undefined) params._meta = meta;
    return handler.fetch(
      mcpRequest(jsonRpcBody(id, "tools/call", params), mcpHeaders(VALID_TOKEN)),
      env as never,
    );
  }

  // The same conversation id always resolves to the same SHA-256-derived
  // actor name, regardless of the booking date — that is the entire point
  // of routing through the conversation-scoped StatefulActor.
  const ACTOR_NAME_FOR = (conversationId: string): string => {
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    return `conversation-${createHash("sha256")
      .update(conversationId)
      .digest("hex")}`;
  };

  it("valid metadata → routes to actor and forwards only normalized booking args", async () => {
    const captured: ConversationBookingInput[] = [];
    const { stub, idFromName } = conversationBookingActor((input) => {
      captured.push(input);
      return {
        kind: "confirmed",
        booking_id: "bid-1",
        service_id: input.service_id,
        date: input.date,
        time: input.time,
      };
    });
    const args = BASE_ARGS();
    const conversationId = "conv-AZ_09";

    const res = await callBooking(
      { SECRETS: validSecrets(), CONVERSATION_BOOKING: { idFromName } },
      1,
      args,
      { telnyx_conversation_id: conversationId },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
      };
    };
    expect(body.result.isError).toBeFalsy();
    const parsed = JSON.parse(body.result.content[0]!.text) as {
      status: string;
      booking_id: string;
      service_id: string;
      date: string;
      time: string;
    };
    expect(parsed).toEqual({
      status: "confirmed",
      booking_id: "bid-1",
      service_id: "oil_change",
      date: args.date,
      time: "10:00",
    });

    expect(idFromName).toHaveBeenCalledTimes(1);
    expect(idFromName).toHaveBeenCalledWith(ACTOR_NAME_FOR(conversationId));

    expect(captured).toHaveLength(1);
    const sent = captured[0]!;
    expect(sent.service_id).toBe("oil_change");
    expect(sent.date).toBe(args.date);
    expect(sent.time).toBe("10:00");
    expect(sent.customer_name).toBe("Alice");
    expect(sent.customer_phone).toBe("+5215512345678");
    expect(sent.confirmed).toBe(true);
    // No idempotency_key or other transport-layer fields forwarded.
    expect((sent as unknown as Record<string, unknown>).idempotency_key).toBeUndefined();
    expect((sent as unknown as Record<string, unknown>).telnyx_conversation_id).toBeUndefined();
    expect(stub.book).toHaveBeenCalledTimes(1);
  });

  it("same conversation with changed date still routes to the same actor", async () => {
    const calls: string[] = [];
    const stub = {
      book: vi.fn(async (input: ConversationBookingInput) => {
        calls.push(input.date);
        return {
          kind: "confirmed",
          booking_id: "bid-x",
          service_id: input.service_id,
          date: input.date,
          time: input.time,
        };
      }),
    };
    const idFromName = vi.fn(() => stub);
    const conversationId = "conv-stable-1";
    const baseArgs = BASE_ARGS();

    const env = { SECRETS: validSecrets(), CONVERSATION_BOOKING: { idFromName } };

    await callBooking(
      env,
      1,
      baseArgs,
      { telnyx_conversation_id: conversationId },
    );
    await callBooking(
      env,
      2,
      { ...baseArgs, date: "2099-02-10", time: "11:00" },
      { telnyx_conversation_id: conversationId },
    );

    expect(idFromName).toHaveBeenCalledTimes(2);
    expect((idFromName.mock.calls[0] as unknown as [string])[0]).toBe(
      ACTOR_NAME_FOR(conversationId),
    );
    expect((idFromName.mock.calls[1] as unknown as [string])[0]).toBe(
      ACTOR_NAME_FOR(conversationId),
    );
    expect((idFromName.mock.calls[0] as unknown as [string])[0]).toBe(
      (idFromName.mock.calls[1] as unknown as [string])[0],
    );
  });

  it("different conversations use different actors", async () => {
    const stubA = {
      book: vi.fn(async (input: ConversationBookingInput) => ({
        kind: "confirmed" as const,
        booking_id: "bid-a",
        service_id: input.service_id,
        date: input.date,
        time: input.time,
      })),
    };
    const stubB = {
      book: vi.fn(async (input: ConversationBookingInput) => ({
        kind: "confirmed" as const,
        booking_id: "bid-b",
        service_id: input.service_id,
        date: input.date,
        time: input.time,
      })),
    };
    const idFromName = vi
      .fn<(name: string) => typeof stubA>()
      .mockImplementationOnce(() => stubA)
      .mockImplementationOnce(() => stubB);
    const args = BASE_ARGS();

    await callBooking(
      { SECRETS: validSecrets(), CONVERSATION_BOOKING: { idFromName } },
      1,
      args,
      { telnyx_conversation_id: "conv-alpha" },
    );
    await callBooking(
      { SECRETS: validSecrets(), CONVERSATION_BOOKING: { idFromName } },
      2,
      args,
      { telnyx_conversation_id: "conv-beta" },
    );

    expect(idFromName).toHaveBeenCalledTimes(2);
    expect((idFromName.mock.calls[0] as unknown as [string])[0]).toBe(
      ACTOR_NAME_FOR("conv-alpha"),
    );
    expect((idFromName.mock.calls[1] as unknown as [string])[0]).toBe(
      ACTOR_NAME_FOR("conv-beta"),
    );
    expect((idFromName.mock.calls[0] as unknown as [string])[0]).not.toBe(
      (idFromName.mock.calls[1] as unknown as [string])[0],
    );
    expect(stubA.book).toHaveBeenCalledTimes(1);
    expect(stubB.book).toHaveBeenCalledTimes(1);
  });

  it("missing conversation metadata → conversation_id_required, no actor call", async () => {
    const { stub, idFromName } = conversationBookingActor(() => ({
      kind: "confirmed",
      booking_id: "bid-1",
      service_id: "oil_change",
      date: "2099-01-15",
      time: "10:00",
    }));

    const res = await callBooking(
      { SECRETS: validSecrets(), CONVERSATION_BOOKING: { idFromName } },
      1,
      BASE_ARGS(),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {
        isError: boolean;
        content: Array<{ type: string; text: string }>;
      };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toBe(
      JSON.stringify({ error: "conversation_id_required" }),
    );
    expect(idFromName).not.toHaveBeenCalled();
    expect(stub.book).not.toHaveBeenCalled();
  });

  it("missing _meta entirely → conversation_id_required, no actor call", async () => {
    const { stub, idFromName } = conversationBookingActor(() => ({
      kind: "confirmed",
      booking_id: "bid-1",
      service_id: "oil_change",
      date: "2099-01-15",
      time: "10:00",
    }));

    const res = await callBooking(
      { SECRETS: validSecrets(), CONVERSATION_BOOKING: { idFromName } },
      1,
      BASE_ARGS(),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toBe(
      JSON.stringify({ error: "conversation_id_required" }),
    );
    expect(idFromName).not.toHaveBeenCalled();
    expect(stub.book).not.toHaveBeenCalled();
  });

  it("invalid conversation metadata (bad charset) → conversation_id_required", async () => {
    const { stub, idFromName } = conversationBookingActor(() => ({
      kind: "confirmed",
      booking_id: "bid-1",
      service_id: "oil_change",
      date: "2099-01-15",
      time: "10:00",
    }));

    const res = await callBooking(
      { SECRETS: validSecrets(), CONVERSATION_BOOKING: { idFromName } },
      1,
      BASE_ARGS(),
      { telnyx_conversation_id: "has space and !chars" },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toBe(
      JSON.stringify({ error: "conversation_id_required" }),
    );
    expect(idFromName).not.toHaveBeenCalled();
    expect(stub.book).not.toHaveBeenCalled();
  });

  it("valid metadata + absent CONVERSATION_BOOKING binding → service_unavailable, no infra call", async () => {
    const kv = validKv(VALID_CONFIG);
    const agenda = {
      idFromName: vi.fn(() => ({
        book: vi.fn(async () => ({ kind: "confirmed" })),
        getOccupiedSlots: vi.fn(async () => ({ occupied: [] })),
        createBooking: vi.fn(async () => ({ ok: true })),
      })),
    };

    const res = await callBooking(
      { SECRETS: validSecrets(), CONFIG: kv, AGENDA: agenda },
      1,
      BASE_ARGS(),
      { telnyx_conversation_id: "conv-AZ_09" },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toBe("service_unavailable");
    expect(kv.get).not.toHaveBeenCalled();
    expect(agenda.idFromName).not.toHaveBeenCalled();
  });

  it("confirmed replay works without CONFIG or AGENDA bindings", async () => {
    const { stub, idFromName } = conversationBookingActor((input) => ({
      kind: "confirmed",
      booking_id: "bid-replay",
      service_id: input.service_id,
      date: input.date,
      time: input.time,
    }));
    const args = BASE_ARGS();

    const env = { SECRETS: validSecrets(), CONVERSATION_BOOKING: { idFromName } };

    const r1 = await callBooking(
      env,
      1,
      args,
      { telnyx_conversation_id: "conv-replay-1" },
    );
    const r2 = await callBooking(
      env,
      2,
      args,
      { telnyx_conversation_id: "conv-replay-1" },
    );

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const body1 = (await r1.json()) as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
    const body2 = (await r2.json()) as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
    expect(body1.result.isError).toBeFalsy();
    expect(body2.result.isError).toBeFalsy();
    expect(JSON.parse(body2.result.content[0]!.text)).toEqual(
      JSON.parse(body1.result.content[0]!.text),
    );
    expect(stub.book).toHaveBeenCalledTimes(2);
  });

  it("conversation_already_booked → isError with the domain code", async () => {
    const { idFromName } = conversationBookingActor(() => ({
      kind: "rejected",
      code: "conversation_already_booked",
    }));

    const res = await callBooking(
      { SECRETS: validSecrets(), CONVERSATION_BOOKING: { idFromName } },
      1,
      BASE_ARGS(),
      { telnyx_conversation_id: "conv-already-1" },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toBe(
      JSON.stringify({ error: "conversation_already_booked" }),
    );
  });

  it("slot_unavailable → isError with the domain code", async () => {
    const { idFromName } = conversationBookingActor(() => ({
      kind: "rejected",
      code: "slot_unavailable",
    }));

    const res = await callBooking(
      { SECRETS: validSecrets(), CONVERSATION_BOOKING: { idFromName } },
      1,
      BASE_ARGS(),
      { telnyx_conversation_id: "conv-slot-1" },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toBe(
      JSON.stringify({ error: "slot_unavailable" }),
    );
  });

  it("actor throws → service_unavailable isError (no raw error leaked)", async () => {
    const { idFromName } = conversationBookingActor(() => {
      throw new Error("rpc failure: actor crashed");
    });

    const res = await callBooking(
      { SECRETS: validSecrets(), CONVERSATION_BOOKING: { idFromName } },
      1,
      BASE_ARGS(),
      { telnyx_conversation_id: "conv-rpc-1" },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toBe("service_unavailable");
    expect(body.result.content[0]!.text).not.toContain("rpc failure");
  });

  it("idFromName throws with sensitive sentinel → generic tool error, one log, no leak", async () => {
    const SENTINEL = `__sentinel_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
    const idFromName = vi.fn(() => {
      throw new Error(
        `internal namespace lookup failed: secret=${SENTINEL}`,
      );
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const res = await callBooking(
        { SECRETS: validSecrets(), CONVERSATION_BOOKING: { idFromName } },
        1,
        BASE_ARGS(),
        { telnyx_conversation_id: "conv-lookup-fail-1" },
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result: {
          isError: boolean;
          content: Array<{ type: string; text: string }>;
        };
      };
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0]!.text).toBe("service_unavailable");
      // The raw exception must never appear in the response — including
      // the sentinel that uniquely identifies this failure path.
      expect(JSON.stringify(body.result)).not.toContain(SENTINEL);

      // Exactly one tool-result log line must be emitted, and it must not
      // contain the sentinel.
      const toolCallLogs = logSpy.mock.calls
        .map((call) => call[0])
        .filter((s): s is string => typeof s === "string")
        .map((s) => JSON.parse(s) as Record<string, unknown>)
        .filter(
          (e) => e.event === "mcp.tool_call" && e.tool === "create_booking",
        );
      expect(toolCallLogs).toHaveLength(1);
      expect(toolCallLogs[0]!.outcome).toBe("service_unavailable");
      for (const line of logSpy.mock.calls) {
        expect(JSON.stringify(line)).not.toContain(SENTINEL);
      }
    } finally {
      logSpy.mockRestore();
    }
  });

  it("malformed actor result (non-object) → service_unavailable", async () => {
    const stub = { book: vi.fn(async () => "not-an-object" as unknown as ConversationBookingResult) };
    const idFromName = vi.fn(() => stub);

    const res = await callBooking(
      { SECRETS: validSecrets(), CONVERSATION_BOOKING: { idFromName } },
      1,
      BASE_ARGS(),
      { telnyx_conversation_id: "conv-malformed-1" },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toBe("service_unavailable");
  });

  it("confirmed result with mismatched service/date/time → service_unavailable", async () => {
    const stub = {
      book: vi.fn(
        async (input: ConversationBookingInput) =>
          ({
            kind: "confirmed",
            booking_id: "bid-bad",
            service_id: "wrong_service",
            date: input.date,
            time: input.time,
          }) as ConversationBookingResult,
      ),
    };
    const idFromName = vi.fn(() => stub);

    const res = await callBooking(
      { SECRETS: validSecrets(), CONVERSATION_BOOKING: { idFromName } },
      1,
      BASE_ARGS(),
      { telnyx_conversation_id: "conv-mismatch-1" },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toBe("service_unavailable");
  });

  it("unknown rejection code → service_unavailable", async () => {
    const { idFromName } = conversationBookingActor(
      () =>
        ({
          kind: "rejected",
          code: "totally_unknown_code",
        }) as unknown as ConversationBookingResult,
    );

    const res = await callBooking(
      { SECRETS: validSecrets(), CONVERSATION_BOOKING: { idFromName } },
      1,
      BASE_ARGS(),
      { telnyx_conversation_id: "conv-unknown-1" },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toBe("service_unavailable");
  });

  it("infrastructure_error from actor → service_unavailable", async () => {
    const { idFromName } = conversationBookingActor(() => ({
      kind: "infrastructure_error",
    }));

    const res = await callBooking(
      { SECRETS: validSecrets(), CONVERSATION_BOOKING: { idFromName } },
      1,
      BASE_ARGS(),
      { telnyx_conversation_id: "conv-infra-1" },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toBe("service_unavailable");
  });

  it("rejects unexpected arguments (e.g. idempotency_key) via SDK invalid params", async () => {
    const { stub, idFromName } = conversationBookingActor((input) => ({
      kind: "confirmed",
      booking_id: "bid-1",
      service_id: input.service_id,
      date: input.date,
      time: input.time,
    }));

    const res = await callBooking(
      { SECRETS: validSecrets(), CONVERSATION_BOOKING: { idFromName } },
      1,
      { ...BASE_ARGS(), idempotency_key: "caller-supplied-key" },
      { telnyx_conversation_id: "conv-strict-1" },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toMatch(/-32602/);
    expect(stub.book).not.toHaveBeenCalled();
  });

  it("success response never contains customer name or phone", async () => {
    const { idFromName } = conversationBookingActor((input) => ({
      kind: "confirmed",
      booking_id: "bid-1",
      service_id: input.service_id,
      date: input.date,
      time: input.time,
    }));

    const res = await callBooking(
      { SECRETS: validSecrets(), CONVERSATION_BOOKING: { idFromName } },
      1,
      {
        ...BASE_ARGS(),
        customer_name: "Alice Smith",
        customer_phone: "+5215512345678",
      },
      { telnyx_conversation_id: "conv-pii-1" },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
    expect(body.result.isError).toBeFalsy();
    const text = body.result.content[0]!.text;
    expect(text).not.toContain("Alice");
    expect(text).not.toContain("Smith");
    expect(text).not.toContain("+5215512345678");
    expect(text).not.toContain("customer_name");
    expect(text).not.toContain("customer_phone");
  });

  // --- mcp.tool_call log never contains customer data -------------------
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("mcp.tool_call log line carries no customer name, phone, or args", async () => {
    const { idFromName } = conversationBookingActor((input) => ({
      kind: "confirmed",
      booking_id: "bid-1",
      service_id: input.service_id,
      date: input.date,
      time: input.time,
    }));

    await callBooking(
      { SECRETS: validSecrets(), CONVERSATION_BOOKING: { idFromName } },
      1,
      {
        ...BASE_ARGS(),
        customer_name: "Alice Smith",
        customer_phone: "+5215512345678",
      },
      { telnyx_conversation_id: "conv-log-1" },
    );

    const ev = logSpy.mock.calls
      .map((call) => call[0])
      .filter((s): s is string => typeof s === "string")
      .map((s) => JSON.parse(s) as Record<string, unknown>)
      .find((e) => e.event === "mcp.tool_call");
    expect(ev).toBeDefined();
    expect(ev!.tool).toBe("create_booking");
    expect(ev!.outcome).toBe("ok");
    expect(typeof ev!.latency_ms).toBe("number");
    const serialized = JSON.stringify(ev);
    expect(serialized).not.toContain("Alice");
    expect(serialized).not.toContain("Smith");
    expect(serialized).not.toContain("+5215512345678");
    expect(serialized).not.toContain("customer_name");
    expect(serialized).not.toContain("customer_phone");
  });
});

describe("/mcp — correlation id and rejection logging", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  function events(name: string): Array<Record<string, unknown>> {
    return logSpy.mock.calls
      .map((call) => call[0])
      .filter((s): s is string => typeof s === "string")
      .map((s) => JSON.parse(s) as Record<string, unknown>)
      .filter((e) => e.event === name);
  }

  function catalogCall(extra: Record<string, string>): Request {
    return mcpRequest(
      jsonRpcBody(1, "tools/call", { name: "get_service_catalog", arguments: {} }),
      mcpHeaders(VALID_TOKEN, extra),
    );
  }

  it("logs a valid x-call-control-id on the tool-call line", async () => {
    await handler.fetch(
      catalogCall({ "x-call-control-id": "v3:abc_DEF-123" }),
      fullEnv(validSecrets(), validKv(VALID_CONFIG)) as never,
    );
    const [ev] = events("mcp.tool_call");
    expect(ev?.call_control_id).toBe("v3:abc_DEF-123");
  });

  it("ignores a malformed correlation header instead of logging it", async () => {
    await handler.fetch(
      catalogCall({ "x-call-control-id": "bad value {\"event\":\"forged\"}" }),
      fullEnv(validSecrets(), validKv(VALID_CONFIG)) as never,
    );
    const [ev] = events("mcp.tool_call");
    expect(ev?.call_control_id).toBe("");
  });

  it("logs the rejection reason without the credential", async () => {
    await handler.fetch(
      mcpRequest(jsonRpcBody(1, "tools/list"), mcpHeaders("wrong-token")),
      fullEnv(validSecrets(), validKv(VALID_CONFIG)) as never,
    );
    const [ev] = events("mcp.rejected");
    expect(ev?.reason).toBe("invalid_bearer");
    expect(JSON.stringify(ev)).not.toContain("wrong-token");
  });

  it("logs origin_header when a browser Origin is present", async () => {
    await handler.fetch(
      mcpRequest(
        jsonRpcBody(1, "tools/list"),
        mcpHeaders(VALID_TOKEN, { origin: "https://example.com" }),
      ),
      fullEnv(validSecrets(), validKv(VALID_CONFIG)) as never,
    );
    expect(events("mcp.rejected")[0]?.reason).toBe("origin_header");
  });
});

// ---------------------------------------------------------------------------
// params._meta.telnyx_conversation_id — correlation only
// ---------------------------------------------------------------------------

describe("/mcp — telnyx_conversation_id correlation (params._meta)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  function toolCalls(name: string): Array<Record<string, unknown>> {
    return logSpy.mock.calls
      .map((call) => call[0])
      .filter((s): s is string => typeof s === "string")
      .map((s) => JSON.parse(s) as Record<string, unknown>)
      .filter((e) => e.event === "mcp.tool_call" && e.tool === name);
  }

  function futureOpenDate(): string {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Mexico_City",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
    });
    for (let i = 1; i <= 6; i++) {
      const parts = fmt.formatToParts(new Date(Date.now() + i * 86_400_000));
      const weekday = parts.find((p) => p.type === "weekday")!.value;
      if (["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday)) {
        const y = parts.find((p) => p.type === "year")!.value;
        const m = parts.find((p) => p.type === "month")!.value;
        const d = parts.find((p) => p.type === "day")!.value;
        return `${y}-${m}-${d}`;
      }
    }
    throw new Error("no open weekday within booking window");
  }

  function catalogCallWithMeta(meta: unknown): Request {
    return mcpRequest(
      jsonRpcBody(1, "tools/call", {
        name: "get_service_catalog",
        arguments: {},
        _meta: meta,
      }),
      mcpHeaders(VALID_TOKEN),
    );
  }

  function availabilityCallWithMeta(date: string, meta: unknown): Request {
    return mcpRequest(
      jsonRpcBody(1, "tools/call", {
        name: "get_availability",
        arguments: { date },
        _meta: meta,
      }),
      mcpHeaders(VALID_TOKEN),
    );
  }

  function bookingCallWithMeta(args: unknown, meta: unknown): Request {
    return mcpRequest(
      jsonRpcBody(1, "tools/call", {
        name: "create_booking",
        arguments: args,
        _meta: meta,
      }),
      mcpHeaders(VALID_TOKEN),
    );
  }

  it("logs a valid telnyx_conversation_id for get_service_catalog", async () => {
    await handler.fetch(
      catalogCallWithMeta({ telnyx_conversation_id: "conv:v3:abc_DEF-123" }),
      fullEnv(validSecrets(), validKv(VALID_CONFIG)) as never,
    );
    const [ev] = toolCalls("get_service_catalog");
    expect(ev?.telnyx_conversation_id).toBe("conv:v3:abc_DEF-123");
    expect(ev?.call_control_id).toBe("");
  });

  it("logs a valid telnyx_conversation_id for get_availability", async () => {
    const kv = validKv(VALID_CONFIG);
    const agenda = {
      idFromName: vi.fn(() => ({
        getOccupiedSlots: vi.fn(async () => ({ occupied: [] })),
      })),
    };
    await handler.fetch(
      availabilityCallWithMeta(futureOpenDate(), {
        telnyx_conversation_id: "conv-AZ_09",
      }),
      { SECRETS: validSecrets(), CONFIG: kv, AGENDA: agenda } as never,
    );
    const [ev] = toolCalls("get_availability");
    expect(ev?.telnyx_conversation_id).toBe("conv-AZ_09");
  });

  it("logs a valid telnyx_conversation_id for create_booking without altering input", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const stub = {
      book: vi.fn(async (input: ConversationBookingInput) => {
        captured.push({ ...input });
        return {
          kind: "confirmed" as const,
          booking_id: "bid-meta",
          service_id: input.service_id,
          date: input.date,
          time: input.time,
        };
      }),
    };
    const idFromName = vi.fn(() => stub);
    const args = {
      service_id: "oil_change",
      date: futureOpenDate(),
      time: "10:00",
      customer_name: "Alice",
      customer_phone: "+5215512345678",
      confirmed: true,
    };

    const res = await handler.fetch(
      bookingCallWithMeta(args, {
        telnyx_conversation_id: "conv-1234:abc",
      }),
      { SECRETS: validSecrets(), CONVERSATION_BOOKING: { idFromName } } as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
    expect(body.result.isError).toBeFalsy();
    const parsed = JSON.parse(body.result.content[0]!.text) as {
      booking_id: string;
    };
    expect(parsed.booking_id).toBe("bid-meta");

    const [ev] = toolCalls("create_booking");
    expect(ev?.telnyx_conversation_id).toBe("conv-1234:abc");

    // Metadata must not change what reaches the Actor — and the MCP layer
    // must not derive an idempotency_key from request fields anymore.
    expect(captured).toHaveLength(1);
    expect(captured[0]!.service_id).toBe("oil_change");
    expect(captured[0]!.date).toBe(args.date);
    expect(captured[0]!.time).toBe("10:00");
    expect(captured[0]!.customer_name).toBe("Alice");
    expect(captured[0]!.customer_phone).toBe("+5215512345678");
    expect(captured[0]!.confirmed).toBe(true);
    expect((captured[0] as Record<string, unknown>).telnyx_conversation_id).toBeUndefined();
    expect((captured[0] as Record<string, unknown>).idempotency_key).toBeUndefined();
  });

  it("omits the field when _meta is missing entirely", async () => {
    await handler.fetch(
      catalogCallWithMeta(undefined),
      fullEnv(validSecrets(), validKv(VALID_CONFIG)) as never,
    );
    const [ev] = toolCalls("get_service_catalog");
    expect(ev).toBeDefined();
    expect("telnyx_conversation_id" in (ev as object)).toBe(false);
  });

  it("omits the field when the value is not a string", async () => {
    await handler.fetch(
      catalogCallWithMeta({ telnyx_conversation_id: 12345 }),
      fullEnv(validSecrets(), validKv(VALID_CONFIG)) as never,
    );
    const [ev1] = toolCalls("get_service_catalog");
    expect("telnyx_conversation_id" in (ev1 as object)).toBe(false);

    await handler.fetch(
      catalogCallWithMeta({ telnyx_conversation_id: { nested: "x" } }),
      fullEnv(validSecrets(), validKv(VALID_CONFIG)) as never,
    );
    const calls = toolCalls("get_service_catalog");
    const ev2 = calls[calls.length - 1];
    expect("telnyx_conversation_id" in (ev2 as object)).toBe(false);

    await handler.fetch(
      catalogCallWithMeta({ telnyx_conversation_id: null }),
      fullEnv(validSecrets(), validKv(VALID_CONFIG)) as never,
    );
    const calls2 = toolCalls("get_service_catalog");
    const ev3 = calls2[calls2.length - 1];
    expect("telnyx_conversation_id" in (ev3 as object)).toBe(false);
  });

  it("omits the field when the value exceeds 128 characters", async () => {
    const tooLong = "a".repeat(129);
    await handler.fetch(
      catalogCallWithMeta({ telnyx_conversation_id: tooLong }),
      fullEnv(validSecrets(), validKv(VALID_CONFIG)) as never,
    );
    const [ev] = toolCalls("get_service_catalog");
    expect("telnyx_conversation_id" in (ev as object)).toBe(false);
  });

  it("omits the field when the value contains disallowed characters", async () => {
    const cases = [
      "has space",
      "has/slash",
      'has"quote',
      "has{brace}",
      "has\nnewline",
      "",
    ];
    for (const value of cases) {
      await handler.fetch(
        catalogCallWithMeta({ telnyx_conversation_id: value }),
        fullEnv(validSecrets(), validKv(VALID_CONFIG)) as never,
      );
    }
    const calls = toolCalls("get_service_catalog");
    expect(calls).toHaveLength(cases.length);
    for (const ev of calls) {
      expect("telnyx_conversation_id" in (ev as object)).toBe(false);
    }
  });

  it("does not alter tool results when metadata is invalid", async () => {
    const kv = validKv(VALID_CONFIG);
    const res1 = await handler.fetch(
      catalogCallWithMeta({ telnyx_conversation_id: "valid-id_42" }),
      fullEnv(validSecrets(), kv) as never,
    );
    const res2 = await handler.fetch(
      catalogCallWithMeta({ telnyx_conversation_id: "bad value" }),
      fullEnv(validSecrets(), kv) as never,
    );
    expect(res1.status).toBe(res2.status);
    const body1 = (await res1.json()) as {
      result: { content: Array<{ text: string }> };
    };
    const body2 = (await res2.json()) as {
      result: { content: Array<{ text: string }> };
    };
    expect(body1.result.content[0]!.text).toBe(body2.result.content[0]!.text);
  });

  it("keeps call_control_id separate from telnyx_conversation_id", async () => {
    await handler.fetch(
      mcpRequest(
        jsonRpcBody(1, "tools/call", {
          name: "get_service_catalog",
          arguments: {},
          _meta: { telnyx_conversation_id: "conv-XYZ" },
        }),
        mcpHeaders(VALID_TOKEN, { "x-call-control-id": "call-999" }),
      ),
      fullEnv(validSecrets(), validKv(VALID_CONFIG)) as never,
    );
    const [ev] = toolCalls("get_service_catalog");
    expect(ev?.call_control_id).toBe("call-999");
    expect(ev?.telnyx_conversation_id).toBe("conv-XYZ");
  });
});

// ---------------------------------------------------------------------------
// MCP_AUTH cache — the /mcp hot path authenticates every request against
// the bearer token, and reading the token from SECRETS on every request
// is wasted work: the binding is immutable for the lifetime of the
// instance. We cache a successful read module-level and short-circuit
// subsequent requests. Failures (empty value, rejected promise, missing
// binding) are never cached so the next request can retry the lookup.
// ---------------------------------------------------------------------------

describe("/mcp — MCP_AUTH cache", () => {
  it("second request serves from cache; SECRETS.get is not called again", async () => {
    const kv = validKv(VALID_CONFIG);
    const secrets = validSecrets();
    const env = fullEnv(secrets, kv);

    const res1 = await handler.fetch(
      mcpRequest(jsonRpcBody(1, "initialize"), mcpHeaders(VALID_TOKEN)),
      env as never,
    );
    expect(res1.status).toBe(200);
    expect(secrets.get).toHaveBeenCalledTimes(1);

    const res2 = await handler.fetch(
      mcpRequest(jsonRpcBody(2, "initialize"), mcpHeaders(VALID_TOKEN)),
      env as never,
    );
    expect(res2.status).toBe(200);
    // The warm path short-circuits the lookup, so SECRETS.get is not
    // called a second time on the same env.
    expect(secrets.get).toHaveBeenCalledTimes(1);
  });

  it("empty MCP_AUTH is not cached; a subsequent valid lookup retries SECRETS.get", async () => {
    const kv = validKv(VALID_CONFIG);
    const emptySecrets: SecretsMock = {
      get: vi.fn(async (binding: string) => {
        if (binding === "MCP_AUTH") return "";
        if (binding === "SMOKE_AUTH") return "smoke";
        throw new Error("unknown binding");
      }),
    };
    const env1 = fullEnv(emptySecrets, kv);

    const res1 = await handler.fetch(
      mcpRequest(jsonRpcBody(1, "initialize"), mcpHeaders(VALID_TOKEN)),
      env1 as never,
    );
    expect(res1.status).toBe(503);
    expect(emptySecrets.get).toHaveBeenCalledTimes(1);

    // Second request on a different env whose secrets return the valid
    // token. Because the empty read did not populate the cache, the
    // handler must call SECRETS.get on the new env and succeed.
    const validSecrets2 = validSecrets();
    const env2 = fullEnv(validSecrets2, kv);
    const res2 = await handler.fetch(
      mcpRequest(jsonRpcBody(1, "initialize"), mcpHeaders(VALID_TOKEN)),
      env2 as never,
    );
    expect(res2.status).toBe(200);
    expect(validSecrets2.get).toHaveBeenCalledTimes(1);
  });

  it("MCP_AUTH rejection is not cached; a subsequent valid lookup retries SECRETS.get", async () => {
    const kv = validKv(VALID_CONFIG);
    const rejectingSecrets2: SecretsMock = {
      get: vi.fn(async (binding: string) => {
        if (binding === "MCP_AUTH") throw new Error("retrieval failed");
        if (binding === "SMOKE_AUTH") return "smoke";
        throw new Error("unknown binding");
      }),
    };
    const env1 = fullEnv(rejectingSecrets2, kv);

    const res1 = await handler.fetch(
      mcpRequest(jsonRpcBody(1, "initialize"), mcpHeaders(VALID_TOKEN)),
      env1 as never,
    );
    expect(res1.status).toBe(503);
    expect(rejectingSecrets2.get).toHaveBeenCalledTimes(1);

    const validSecrets2 = validSecrets();
    const env2 = fullEnv(validSecrets2, kv);
    const res2 = await handler.fetch(
      mcpRequest(jsonRpcBody(1, "initialize"), mcpHeaders(VALID_TOKEN)),
      env2 as never,
    );
    expect(res2.status).toBe(200);
    expect(validSecrets2.get).toHaveBeenCalledTimes(1);
  });
});
