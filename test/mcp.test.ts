import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@telnyx/edge-runtime", () => ({
  StatefulActor: class {
    ctx: unknown;
  },
}));

import handler from "../src/index";
import type { AppConfig } from "../src/config";

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
