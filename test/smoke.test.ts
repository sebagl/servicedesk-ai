import { describe, it, expect, vi, beforeEach } from "vitest";

// MOCKED: verifies routing + auth gate + health + config loader only.
// Never loads the real runtime, actor, secret store, or KV.
vi.mock("@telnyx/edge-runtime", () => ({
  StatefulActor: class {
    ctx: unknown;
  },
}));

import handler from "../src/index";
import { loadConfig, type AppConfig } from "../src/config";

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

type Stub = {
  increment: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
};

function makeStub(): Stub {
  return {
    increment: vi.fn(async (amount = 1) => ({ count: amount })),
    read: vi.fn(async () => ({ count: 7 })),
  };
}

type SecretsMock = { get: ReturnType<typeof vi.fn> };
type KvMock = { get: ReturnType<typeof vi.fn> };

function makeEnv(
  stub: Stub,
  secrets?: SecretsMock,
  config?: KvMock,
): unknown {
  return {
    COUNTER: { idFromName: () => stub },
    SECRETS: secrets,
    CONFIG: config,
  };
}

function makeFullEnv(secrets: SecretsMock, config?: KvMock): unknown {
  return {
    COUNTER: { idFromName: () => makeStub() },
    SECRETS: secrets,
    CONFIG: config,
  };
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function postInc(
  id: string,
  amount: number,
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://x/demo/counter/${id}/increment`, {
    method: "POST",
    body: JSON.stringify({ amount }),
    headers: { "content-type": "application/json", ...headers },
  });
}

function getRead(id: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://x/demo/counter/${id}/read`, { headers });
}

function getConfig(headers: Record<string, string> = {}): Request {
  return new Request("http://x/demo/config", { headers });
}

function assertActorNotCalled(stub: Stub) {
  expect(stub.increment).not.toHaveBeenCalled();
  expect(stub.read).not.toHaveBeenCalled();
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
    const env = { COUNTER: { idFromName: () => makeStub() } };
    const res = await handler.fetch(new Request("http://x/health"), env as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "servicedesk-ai" });
  });

  it("GET /health/liveness without SECRETS", async () => {
    const env = { COUNTER: { idFromName: () => makeStub() } };
    const res = await handler.fetch(
      new Request("http://x/health/liveness"),
      env as never,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("GET /health/readiness without SECRETS", async () => {
    const env = { COUNTER: { idFromName: () => makeStub() } };
    const res = await handler.fetch(
      new Request("http://x/health/readiness"),
      env as never,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Counter auth gate (existing tests, unchanged)
// ---------------------------------------------------------------------------

describe("1. absent secret binding → 503", () => {
  it("increment route returns 503 when SECRETS is undefined", async () => {
    const stub = makeStub();
    const env = makeEnv(stub, undefined);
    const res = await handler.fetch(postInc("a", 1), env as never);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ error: "service_unavailable" });
    assertActorNotCalled(stub);
  });
});

describe("2. empty/missing secret → 503", () => {
  it("increment returns 503 when get returns empty string", async () => {
    const stub = makeStub();
    const env = makeEnv(stub, { get: vi.fn(async () => "") });
    const res = await handler.fetch(postInc("a", 1), env as never);
    expect(res.status).toBe(503);
    assertActorNotCalled(stub);
  });
});

describe("3. secret retrieval rejects → 503", () => {
  it("read route returns 503 when get throws", async () => {
    const stub = makeStub();
    const env = makeEnv(stub, {
      get: vi.fn(async () => {
        throw new Error("retrieval failed");
      }),
    });
    const res = await handler.fetch(getRead("a"), env as never);
    expect(res.status).toBe(503);
    assertActorNotCalled(stub);
  });
});

describe("4. authorization failures → 401", () => {
  let stub: Stub;
  let env: unknown;

  beforeEach(() => {
    stub = makeStub();
    env = makeEnv(stub, validSecrets());
  });

  it("missing Authorization header on read", async () => {
    const res = await handler.fetch(getRead("a"), env as never);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "unauthorized" });
    assertActorNotCalled(stub);
  });

  it("malformed Authorization (no Bearer prefix) on increment", async () => {
    const res = await handler.fetch(
      postInc("a", 1, { authorization: "Token " + VALID_TOKEN }),
      env as never,
    );
    expect(res.status).toBe(401);
    assertActorNotCalled(stub);
  });

  it("incorrect token on read", async () => {
    const res = await handler.fetch(
      getRead("a", bearer("wrong-token")),
      env as never,
    );
    expect(res.status).toBe(401);
    assertActorNotCalled(stub);
  });
});

describe("5. valid credentials → reach Actor", () => {
  let stub: Stub;
  let env: unknown;

  beforeEach(() => {
    stub = makeStub();
    env = makeEnv(stub, validSecrets());
  });

  it("POST increment with valid bearer reaches Actor", async () => {
    const res = await handler.fetch(
      postInc("a", 5, bearer(VALID_TOKEN)),
      env as never,
    );
    expect(res.status).toBe(200);
    expect(stub.increment).toHaveBeenCalledWith(5);
    expect(await res.json()).toEqual({ counter: "a", count: 5 });
  });

  it("GET read with valid bearer reaches Actor", async () => {
    const res = await handler.fetch(
      getRead("a", bearer(VALID_TOKEN)),
      env as never,
    );
    expect(res.status).toBe(200);
    expect(stub.read).toHaveBeenCalled();
    expect(await res.json()).toEqual({ counter: "a", count: 7 });
  });

  it("defaults increment amount to 1 when body has no amount", async () => {
    const res = await handler.fetch(
      new Request("http://x/demo/counter/a/increment", {
        method: "POST",
        body: JSON.stringify({}),
        headers: {
          "content-type": "application/json",
          ...bearer(VALID_TOKEN),
        },
      }),
      env as never,
    );
    expect(stub.increment).toHaveBeenCalledWith(1);
    expect(await res.json()).toEqual({ counter: "a", count: 1 });
  });
});

// ---------------------------------------------------------------------------
// GET /demo/config — auth gate
// ---------------------------------------------------------------------------

describe("config route — auth gate", () => {
  it("unauthorized request does not read KV", async () => {
    const kv = validKv(VALID_CONFIG);
    const env = makeFullEnv(validSecrets(), kv);
    const res = await handler.fetch(getConfig(), env as never);
    expect(res.status).toBe(401);
    expect(kv.get).not.toHaveBeenCalled();
  });

  it("absent SECRETS binding → 503, KV not read", async () => {
    const kv = validKv(VALID_CONFIG);
    const env = makeFullEnv({ get: vi.fn(async () => "") }, kv);
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
    const env = makeFullEnv(validSecrets(), kv);
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
    const env = makeFullEnv(validSecrets(), kv);
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
    const env = makeFullEnv(validSecrets(), undefined);
    const res = await handler.fetch(getConfig(bearer(VALID_TOKEN)), env as never);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ error: "service_unavailable" });
  });

  it("KV key returns null → 503", async () => {
    const kv = { get: vi.fn(async () => null) };
    const env = makeFullEnv(validSecrets(), kv);
    const res = await handler.fetch(getConfig(bearer(VALID_TOKEN)), env as never);
    expect(res.status).toBe(503);
  });

  it("KV read rejects → 503", async () => {
    const env = makeFullEnv(validSecrets(), rejectingKv());
    const res = await handler.fetch(getConfig(bearer(VALID_TOKEN)), env as never);
    expect(res.status).toBe(503);
  });

  it("malformed JSON (get throws SyntaxError) → 503", async () => {
    const kv = {
      get: vi.fn(async () => {
        throw new SyntaxError("Unexpected token");
      }),
    };
    const env = makeFullEnv(validSecrets(), kv);
    const res = await handler.fetch(getConfig(bearer(VALID_TOKEN)), env as never);
    expect(res.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// GET /demo/config — invalid schema → 503
// ---------------------------------------------------------------------------

describe("config route — invalid schema → 503", () => {
  async function getWithConfig(config: unknown) {
    const env = makeFullEnv(validSecrets(), validKv(config));
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
});

// ---------------------------------------------------------------------------
// Route not found
// ---------------------------------------------------------------------------

describe("route not found", () => {
  it("404 for unknown routes", async () => {
    const stub = makeStub();
    const env = makeEnv(stub, validSecrets());
    const res = await handler.fetch(new Request("http://x/nope"), env as never);
    expect(res.status).toBe(404);
    assertActorNotCalled(stub);
  });
});
