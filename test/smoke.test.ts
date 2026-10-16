import { describe, it, expect, vi, beforeEach } from "vitest";

// MOCKED: verifies routing + auth gate + health only.
// Never loads the real runtime, actor, or secret store.
vi.mock("@telnyx/edge-runtime", () => ({
  StatefulActor: class {
    ctx: unknown;
  },
}));

import handler from "../src/index";

const VALID_TOKEN = "test-smoke-token-value";

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

function makeEnv(
  stub: Stub,
  secrets?: Partial<{ get: ReturnType<typeof vi.fn> }>,
): unknown {
  return {
    COUNTER: { idFromName: () => stub },
    SECRETS: secrets,
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

function assertActorNotCalled(stub: Stub) {
  expect(stub.increment).not.toHaveBeenCalled();
  expect(stub.read).not.toHaveBeenCalled();
}

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
    env = makeEnv(stub, { get: vi.fn(async () => VALID_TOKEN) });
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
    env = makeEnv(stub, { get: vi.fn(async () => VALID_TOKEN) });
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

describe("route not found", () => {
  it("404 for unknown routes", async () => {
    const stub = makeStub();
    const env = makeEnv(stub, { get: vi.fn(async () => VALID_TOKEN) });
    const res = await handler.fetch(new Request("http://x/nope"), env as never);
    expect(res.status).toBe(404);
    assertActorNotCalled(stub);
  });
});
