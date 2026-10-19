import { describe, it, expect, vi } from "vitest";

// MOCKED: verifies routing + auth gate + health + config loader only.
// Never loads the real runtime, actor, secret store, or KV.
vi.mock("@telnyx/edge-runtime", () => ({
  StatefulActor: class {
    ctx: unknown;
  },
}));

import handler from "../../src/index";
import { loadConfig, type AppConfig } from "../../src/domain/config";

const VALID_TOKEN = "test-smoke-token-value";

const VALID_CONFIG: AppConfig = {
  services: [
    { id: "oil_change", name: "Oil Change", duration_minutes: 60 },
    { id: "tire_rotation", name: "Tire Rotation", duration_minutes: 60 },
    {
      id: "general_maintenance",
      name: "General Maintenance Service",
      duration_minutes: 60,
    },
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

type SecretsMock = { get: ReturnType<typeof vi.fn> };
type KvMock = { get: ReturnType<typeof vi.fn> };

function makeEnv(secrets?: SecretsMock, config?: KvMock): unknown {
  return {
    SECRETS: secrets,
    CONFIG: config,
  };
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function getConfig(headers: Record<string, string> = {}): Request {
  return new Request("http://x/demo/config", { headers });
}

function validSecrets(): SecretsMock {
  return { get: vi.fn(async () => VALID_TOKEN) };
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

// ---------------------------------------------------------------------------
// Health — public, no secrets required
// ---------------------------------------------------------------------------

describe("health — public, no secrets required", () => {
  it("GET /health returns service payload without SECRETS", async () => {
    const res = await handler.fetch(new Request("http://x/health"), makeEnv() as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "servicedesk-ai" });
  });

  it("GET /health/liveness without SECRETS", async () => {
    const res = await handler.fetch(
      new Request("http://x/health/liveness"),
      makeEnv() as never,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("GET /health/readiness without SECRETS", async () => {
    const res = await handler.fetch(
      new Request("http://x/health/readiness"),
      makeEnv() as never,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// GET /demo/config — auth gate
// ---------------------------------------------------------------------------

describe("config route — auth gate", () => {
  it("unauthorized request does not read KV", async () => {
    const kv = validKv(VALID_CONFIG);
    const env = makeEnv(validSecrets(), kv);
    const res = await handler.fetch(getConfig(), env as never);
    expect(res.status).toBe(401);
    expect(kv.get).not.toHaveBeenCalled();
  });

  it("absent SECRETS binding → 503, KV not read", async () => {
    const kv = validKv(VALID_CONFIG);
    const env = makeEnv({ get: vi.fn(async () => "") }, kv);
    const res = await handler.fetch(getConfig(bearer(VALID_TOKEN)), env as never);
    expect(res.status).toBe(503);
    expect(kv.get).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /demo/config — valid configuration
// ---------------------------------------------------------------------------

describe("config route — valid configuration", () => {
  it("returns config with booking_enabled true", async () => {
    const kv = validKv(VALID_CONFIG);
    const env = makeEnv(validSecrets(), kv);
    const res = await handler.fetch(getConfig(bearer(VALID_TOKEN)), env as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.services).toHaveLength(3);
    expect(body.business.booking_enabled).toBe(true);
  });

  it("returns config with booking_enabled false (valid config, not error)", async () => {
    const disabledConfig = {
      ...VALID_CONFIG,
      business: { ...VALID_CONFIG.business, booking_enabled: false },
    };
    const kv = validKv(disabledConfig);
    const env = makeEnv(validSecrets(), kv);
    const res = await handler.fetch(getConfig(bearer(VALID_TOKEN)), env as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.business.booking_enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /demo/config — unavailable configuration → 503
// ---------------------------------------------------------------------------

describe("config route — unavailable configuration → 503", () => {
  it("missing CONFIG binding → 503", async () => {
    const env = makeEnv(validSecrets(), undefined);
    const res = await handler.fetch(getConfig(bearer(VALID_TOKEN)), env as never);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ error: "service_unavailable" });
  });

  it("KV key returns null → 503", async () => {
    const kv = { get: vi.fn(async () => null) };
    const env = makeEnv(validSecrets(), kv);
    const res = await handler.fetch(getConfig(bearer(VALID_TOKEN)), env as never);
    expect(res.status).toBe(503);
  });

  it("KV read rejects → 503", async () => {
    const env = makeEnv(validSecrets(), rejectingKv());
    const res = await handler.fetch(getConfig(bearer(VALID_TOKEN)), env as never);
    expect(res.status).toBe(503);
  });

  it("malformed JSON (get throws SyntaxError) → 503", async () => {
    const kv = {
      get: vi.fn(async () => {
        throw new SyntaxError("Unexpected token");
      }),
    };
    const env = makeEnv(validSecrets(), kv);
    const res = await handler.fetch(getConfig(bearer(VALID_TOKEN)), env as never);
    expect(res.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// GET /demo/config — invalid schema → 503
// ---------------------------------------------------------------------------

describe("config route — invalid schema → 503", () => {
  async function getWithConfig(config: unknown) {
    const env = makeEnv(validSecrets(), validKv(config));
    return handler.fetch(getConfig(bearer(VALID_TOKEN)), env as never);
  }

  it("empty object → 503", async () => {
    const res = await getWithConfig({});
    expect(res.status).toBe(503);
  });

  it("booking_enabled as string 'false' rejected → 503", async () => {
    const bad = {
      ...VALID_CONFIG,
      business: { ...VALID_CONFIG.business, booking_enabled: "false" },
    };
    const res = await getWithConfig(bad);
    expect(res.status).toBe(503);
  });

  it("duplicate service IDs rejected → 503", async () => {
    const dup = {
      ...VALID_CONFIG,
      services: [
        ...VALID_CONFIG.services,
        { id: "oil_change", name: "Duplicate", duration_minutes: 60 },
      ],
    };
    const res = await getWithConfig(dup);
    expect(res.status).toBe(503);
  });

  it("duration_minutes not 60 rejected → 503", async () => {
    const bad = {
      ...VALID_CONFIG,
      services: [
        { id: "oil_change", name: "Oil Change", duration_minutes: 30 },
      ],
    };
    const res = await getWithConfig(bad);
    expect(res.status).toBe(503);
  });

  it("empty service name rejected → 503", async () => {
    const bad = {
      ...VALID_CONFIG,
      services: [{ id: "oil_change", name: "", duration_minutes: 60 }],
    };
    const res = await getWithConfig(bad);
    expect(res.status).toBe(503);
  });

  it("wrong timezone rejected → 503", async () => {
    const bad = {
      ...VALID_CONFIG,
      business: { ...VALID_CONFIG.business, timezone: "UTC" },
    };
    const res = await getWithConfig(bad);
    expect(res.status).toBe(503);
  });

  it("wrong location_id rejected → 503", async () => {
    const bad = {
      ...VALID_CONFIG,
      business: { ...VALID_CONFIG.business, location_id: "downtown" },
    };
    const res = await getWithConfig(bad);
    expect(res.status).toBe(503);
  });

  it("unknown weekday rejected → 503", async () => {
    const bad = {
      ...VALID_CONFIG,
      business: { ...VALID_CONFIG.business, open_days: ["mon", "funday"] },
    };
    const res = await getWithConfig(bad);
    expect(res.status).toBe(503);
  });

  it("duplicate weekday rejected → 503", async () => {
    const bad = {
      ...VALID_CONFIG,
      business: {
        ...VALID_CONFIG.business,
        open_days: ["mon", "tue", "mon"],
      },
    };
    const res = await getWithConfig(bad);
    expect(res.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// loadConfig unit tests (direct, without HTTP layer)
// ---------------------------------------------------------------------------

describe("loadConfig — direct unit tests", () => {
  it("valid config returns ok", async () => {
    const kv = validKv(VALID_CONFIG);
    const result = await loadConfig(kv as never);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.services).toHaveLength(3);
      expect(result.config.business.booking_enabled).toBe(true);
    }
  });

  it("booking_enabled=false is valid config", async () => {
    const disabled = {
      ...VALID_CONFIG,
      business: { ...VALID_CONFIG.business, booking_enabled: false },
    };
    const kv = validKv(disabled);
    const result = await loadConfig(kv as never);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.business.booking_enabled).toBe(false);
    }
  });

  it("missing key (null) → not ok", async () => {
    const kv = { get: vi.fn(async () => null) };
    const result = await loadConfig(kv as never);
    expect(result.ok).toBe(false);
  });

  it("rejected read → not ok", async () => {
    const result = await loadConfig(rejectingKv() as never);
    expect(result.ok).toBe(false);
  });

  it("string 'false' for booking_enabled → not ok", async () => {
    const bad = {
      ...VALID_CONFIG,
      business: { ...VALID_CONFIG.business, booking_enabled: "false" },
    };
    const result = await loadConfig(validKv(bad) as never);
    expect(result.ok).toBe(false);
  });

  it("duplicate service IDs → not ok", async () => {
    const dup = {
      ...VALID_CONFIG,
      services: [
        ...VALID_CONFIG.services,
        { id: "oil_change", name: "Dup", duration_minutes: 60 },
      ],
    };
    const result = await loadConfig(validKv(dup) as never);
    expect(result.ok).toBe(false);
  });

  it("wrong location_id → not ok", async () => {
    const bad = {
      ...VALID_CONFIG,
      business: { ...VALID_CONFIG.business, location_id: "downtown" },
    };
    const result = await loadConfig(validKv(bad) as never);
    expect(result.ok).toBe(false);
  });

  it("empty location_id rejected → not ok", async () => {
    const bad = {
      ...VALID_CONFIG,
      business: { ...VALID_CONFIG.business, location_id: "" },
    };
    const result = await loadConfig(validKv(bad) as never);
    expect(result.ok).toBe(false);
  });

  it("unknown weekday in open_days → not ok", async () => {
    const bad = {
      ...VALID_CONFIG,
      business: { ...VALID_CONFIG.business, open_days: ["mon", "funday"] },
    };
    const result = await loadConfig(validKv(bad) as never);
    expect(result.ok).toBe(false);
  });

  it("weekday with wrong casing → not ok", async () => {
    const bad = {
      ...VALID_CONFIG,
      business: { ...VALID_CONFIG.business, open_days: ["Mon", "Tue"] },
    };
    const result = await loadConfig(validKv(bad) as never);
    expect(result.ok).toBe(false);
  });

  it("duplicate weekday in open_days → not ok", async () => {
    const bad = {
      ...VALID_CONFIG,
      business: {
        ...VALID_CONFIG.business,
        open_days: ["mon", "tue", "mon"],
      },
    };
    const result = await loadConfig(validKv(bad) as never);
    expect(result.ok).toBe(false);
  });

  it("empty open_days → not ok", async () => {
    const bad = {
      ...VALID_CONFIG,
      business: { ...VALID_CONFIG.business, open_days: [] },
    };
    const result = await loadConfig(validKv(bad) as never);
    expect(result.ok).toBe(false);
  });

  it("single weekday subset is accepted", async () => {
    const ok = {
      ...VALID_CONFIG,
      business: { ...VALID_CONFIG.business, open_days: ["mon"] },
    };
    const result = await loadConfig(validKv(ok) as never);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.business.open_days).toEqual(["mon"]);
    }
  });

  it("weekend-only subset is accepted", async () => {
    const ok = {
      ...VALID_CONFIG,
      business: { ...VALID_CONFIG.business, open_days: ["sat", "sun"] },
    };
    const result = await loadConfig(validKv(ok) as never);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.business.open_days).toEqual(["sat", "sun"]);
    }
  });

  it("non-contiguous weekday subset is accepted", async () => {
    const ok = {
      ...VALID_CONFIG,
      business: {
        ...VALID_CONFIG.business,
        open_days: ["mon", "wed", "fri"],
      },
    };
    const result = await loadConfig(validKv(ok) as never);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.business.open_days).toEqual(["mon", "wed", "fri"]);
    }
  });
});

// ---------------------------------------------------------------------------
// Route not found
// ---------------------------------------------------------------------------

describe("route not found", () => {
  it("404 for unknown routes", async () => {
    const env = makeEnv(validSecrets());
    const res = await handler.fetch(new Request("http://x/nope"), env as never);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /demo/callbacks — operator view of pending callback requests across
// the last 7 local days (today and the 6 previous). Per-day actors, merged
// newest first.
// ---------------------------------------------------------------------------

import { callbacksActorName } from "../../src/domain/business-rules";
import { addDays, getLocalDateString } from "../../src/domain/scheduling";

describe("/demo/callbacks — auth gate", () => {
  type CallbackStub = {
    listCallbacks: ReturnType<typeof vi.fn>;
    requestCallback: ReturnType<typeof vi.fn>;
  };

  function makeCallbackStub(entries: unknown[]): CallbackStub {
    return {
      listCallbacks: vi.fn(async () => entries),
      requestCallback: vi.fn(),
    };
  }

  function callbacksEnv(
    stub: CallbackStub,
    secrets: SecretsMock = validSecrets(),
  ): unknown {
    return {
      DAY_CALLBACKS: { idFromName: () => stub },
      SECRETS: secrets,
    };
  }

  it("missing Authorization header → 401, Actor never reached", async () => {
    const stub = makeCallbackStub([]);
    const env = callbacksEnv(stub);
    const res = await handler.fetch(
      new Request("http://x/demo/callbacks"),
      env as never,
    );
    expect(res.status).toBe(401);
    expect(stub.listCallbacks).not.toHaveBeenCalled();
  });

  it("wrong bearer → 401, Actor never reached", async () => {
    const stub = makeCallbackStub([]);
    const env = callbacksEnv(stub);
    const res = await handler.fetch(
      new Request("http://x/demo/callbacks", { headers: bearer("wrong-token") }),
      env as never,
    );
    expect(res.status).toBe(401);
    expect(stub.listCallbacks).not.toHaveBeenCalled();
  });

  it("absent SECRETS binding → 503, Actor never reached", async () => {
    const stub = makeCallbackStub([]);
    const env = { DAY_CALLBACKS: { idFromName: () => stub } };
    const res = await handler.fetch(
      new Request("http://x/demo/callbacks", { headers: bearer(VALID_TOKEN) }),
      env as never,
    );
    expect(res.status).toBe(503);
    expect(stub.listCallbacks).not.toHaveBeenCalled();
  });

  it("empty SMOKE_AUTH secret → 503, Actor never reached", async () => {
    const stub = makeCallbackStub([]);
    const env = callbacksEnv(stub, { get: vi.fn(async () => "") });
    const res = await handler.fetch(
      new Request("http://x/demo/callbacks", { headers: bearer(VALID_TOKEN) }),
      env as never,
    );
    expect(res.status).toBe(503);
    expect(stub.listCallbacks).not.toHaveBeenCalled();
  });

  it("absent DAY_CALLBACKS binding → 503 after auth", async () => {
    const env = { SECRETS: validSecrets() };
    const res = await handler.fetch(
      new Request("http://x/demo/callbacks", { headers: bearer(VALID_TOKEN) }),
      env as never,
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "service_unavailable" });
  });
});

describe("/demo/callbacks — success and failure", () => {
  type CallbackStub = {
    listCallbacks: ReturnType<typeof vi.fn>;
    requestCallback: ReturnType<typeof vi.fn>;
  };

  function makeCallbackStub(entries: unknown[]): CallbackStub {
    return {
      listCallbacks: vi.fn(async () => entries),
      requestCallback: vi.fn(),
    };
  }

  it("queries 7 fixed per-day actor names (today + 6 previous)", async () => {
    const stub = makeCallbackStub([]);
    const idFromName = vi.fn((_name: string) => stub);
    const env = {
      DAY_CALLBACKS: { idFromName },
      SECRETS: validSecrets(),
    };
    const res = await handler.fetch(
      new Request("http://x/demo/callbacks", { headers: bearer(VALID_TOKEN) }),
      env as never,
    );
    expect(res.status).toBe(200);
    const today = getLocalDateString(Date.now());
    expect(idFromName.mock.calls.map((c: [string]) => c[0])).toEqual(
      Array.from({ length: 7 }, (_, i) => callbacksActorName(addDays(today, -i))),
    );
  });

  it("returns entries with full operator fields (including full phone)", async () => {
    const today = getLocalDateString(Date.now());
    const yesterday = addDays(today, -1);
    const stubByName: Record<string, unknown[]> = {
      [callbacksActorName(today)]: [
        {
          id: "req-1",
          conversation_id: "conv-1",
          customer_name: "Alice Smith",
          customer_phone: "+5215512345678",
          reason: "oil change question",
          created_at: "2026-10-18T10:00:00.000Z",
        },
      ],
      [callbacksActorName(yesterday)]: [
        {
          id: "req-2",
          conversation_id: "conv-2",
          customer_name: "Bob",
          customer_phone: "+5215599998888",
          reason: "tire rotation",
          created_at: "2026-10-17T09:30:00.000Z",
        },
      ],
    };
    const stub = {
      listCallbacks: vi.fn(),
      requestCallback: vi.fn(),
    };
    stub.listCallbacks.mockImplementation(async function (this: unknown) {
      // Inspect the actor name from the call context (idFromName stores it).
      return [];
    });
    const idFromName = vi.fn((name: string) => {
      stub.listCallbacks.mockImplementation(async () => stubByName[name] ?? []);
      return stub;
    });
    const env = {
      DAY_CALLBACKS: { idFromName },
      SECRETS: validSecrets(),
    };
    const res = await handler.fetch(
      new Request("http://x/demo/callbacks", { headers: bearer(VALID_TOKEN) }),
      env as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      callbacks: Array<{
        id: string;
        created_at: string;
        customer_name: string;
        customer_phone: string;
        reason: string;
      }>;
    };
    expect(body.callbacks).toHaveLength(2);
    // Newest first across days.
    expect(body.callbacks[0]).toEqual({
      id: "req-1",
      created_at: "2026-10-18T10:00:00.000Z",
      customer_name: "Alice Smith",
      customer_phone: "+5215512345678",
      reason: "oil change question",
    });
    expect(body.callbacks[1]).toEqual({
      id: "req-2",
      created_at: "2026-10-17T09:30:00.000Z",
      customer_name: "Bob",
      customer_phone: "+5215599998888",
      reason: "tire rotation",
    });
    // Operator view intentionally exposes the conversation_id-bearing
    // entries; the wire shape never carries a "conversation_id" field.
    expect(
      (body.callbacks[0] as unknown as Record<string, unknown>).conversation_id,
    ).toBeUndefined();
  });

  it("returns { callbacks: [] } when every day is empty", async () => {
    const stub = makeCallbackStub([]);
    const env = {
      DAY_CALLBACKS: { idFromName: () => stub },
      SECRETS: validSecrets(),
    };
    const res = await handler.fetch(
      new Request("http://x/demo/callbacks", { headers: bearer(VALID_TOKEN) }),
      env as never,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ callbacks: [] });
  });

  it("one day's actor throws → fails closed with 503, no entry contents leaked", async () => {
    const today = getLocalDateString(Date.now());
    const yesterday = addDays(today, -1);
    const SENTINEL = `__cb_list_sentinel_${Date.now()}__`;
    const stubByName: Record<string, () => Promise<unknown[]>> = {
      [callbacksActorName(today)]: () => {
        throw new Error(`rpc failure: ${SENTINEL}`);
      },
      [callbacksActorName(yesterday)]: async () => [
        {
          id: "req-prev",
          conversation_id: "conv-prev",
          customer_name: "Old",
          customer_phone: "+5215500000000",
          reason: "from yesterday",
          created_at: "2026-10-17T08:00:00.000Z",
        },
      ],
    };
    const idFromName = vi.fn((name: string) => ({
      listCallbacks: vi.fn(() => stubByName[name]!()),
      requestCallback: vi.fn(),
    }));
    const env = {
      DAY_CALLBACKS: { idFromName },
      SECRETS: validSecrets(),
    };
    const res = await handler.fetch(
      new Request("http://x/demo/callbacks", { headers: bearer(VALID_TOKEN) }),
      env as never,
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ error: "service_unavailable" });
    expect(JSON.stringify(body)).not.toContain(SENTINEL);
    expect(JSON.stringify(body)).not.toContain("+5215500000000");
  });

  it("wrong method (POST) → 405, Actor never reached", async () => {
    const stub = makeCallbackStub([]);
    const env = {
      DAY_CALLBACKS: { idFromName: () => stub },
      SECRETS: validSecrets(),
    };
    const res = await handler.fetch(
      new Request("http://x/demo/callbacks", {
        method: "POST",
        headers: bearer(VALID_TOKEN),
      }),
      env as never,
    );
    expect(res.status).toBe(405);
    expect(stub.listCallbacks).not.toHaveBeenCalled();
  });

  it("emits callback.listed with count and latency_ms only (no entry fields)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const today = getLocalDateString(Date.now());
      const stub = {
        listCallbacks: vi.fn(async () => [
          {
            id: "req-1",
            conversation_id: "conv-1",
            customer_name: "Alice Smith",
            customer_phone: "+5215512345678",
            reason: "leak canary 9f2a",
            created_at: "2026-10-18T10:00:00.000Z",
          },
        ]),
        requestCallback: vi.fn(),
      };
      const idFromName = vi.fn((name: string) => {
        if (name !== callbacksActorName(today)) {
          return { listCallbacks: vi.fn(async () => []), requestCallback: vi.fn() };
        }
        return stub;
      });
      const env = {
        DAY_CALLBACKS: { idFromName },
        SECRETS: validSecrets(),
      };
      const res = await handler.fetch(
        new Request("http://x/demo/callbacks", { headers: bearer(VALID_TOKEN) }),
        env as never,
      );
      expect(res.status).toBe(200);

      const events = logSpy.mock.calls
        .map((call) => call[0])
        .filter((s): s is string => typeof s === "string")
        .map((s) => JSON.parse(s) as Record<string, unknown>)
        .filter((e) => e.event === "callback.listed");
      expect(events).toHaveLength(1);
      expect(events[0]!.count).toBe(1);
      expect(typeof events[0]!.latency_ms).toBe("number");

      const allSerialized = logSpy.mock.calls
        .map((call) => JSON.stringify(call))
        .join("\n");
      expect(allSerialized).not.toContain("Alice");
      expect(allSerialized).not.toContain("Smith");
      expect(allSerialized).not.toContain("+5215512345678");
      expect(allSerialized).not.toContain("leak canary");
      expect(allSerialized).not.toContain("req-1");
      expect(allSerialized).not.toContain("customer_name");
      expect(allSerialized).not.toContain("customer_phone");
      expect(allSerialized).not.toContain("reason");
    } finally {
      logSpy.mockRestore();
    }
  });
});
