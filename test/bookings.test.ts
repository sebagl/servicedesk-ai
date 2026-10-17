import { describe, it, expect, vi } from "vitest";

vi.mock("@telnyx/edge-runtime", () => ({
  StatefulActor: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import handler from "../src/index";
import type { AppConfig } from "../src/config";
import type { CreateBookingResult } from "../src/agenda-actor";

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

function validSecrets() {
  return { get: vi.fn(async () => VALID_TOKEN) };
}

function validKv(config: unknown = VALID_CONFIG) {
  return { get: vi.fn(async () => config) };
}

type AgendaStub = {
  getOccupiedSlots: ReturnType<typeof vi.fn>;
  createBooking: ReturnType<typeof vi.fn>;
};

function makeEnv(
  agendaStub: AgendaStub,
  secrets = validSecrets(),
  config = validKv(),
): {
  env: unknown;
  idFromName: ReturnType<typeof vi.fn>;
} {
  const idFromName = vi.fn(() => agendaStub);
  const env = {
    COUNTER: { idFromName: () => ({}) },
    AGENDA: { idFromName },
    SECRETS: secrets,
    CONFIG: config,
  };
  return { env, idFromName };
}

function bookingReq(
  body: unknown,
  token = VALID_TOKEN,
): Request {
  const json = typeof body === "string" ? body : JSON.stringify(body);
  return new Request("http://x/demo/bookings", {
    method: "POST",
    body: json,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
  });
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    service_id: "oil_change",
    date: "2026-10-20",
    time: "10:00",
    customer_name: "Maria Lopez",
    customer_phone: "+52 55 1234 5678",
    idempotency_key: "attempt-001",
    confirmed: true,
    ...overrides,
  };
}

const SUCCESS_RESULT: CreateBookingResult = {
  ok: true,
  booking_id: "b-0001-uuid",
  service_id: "oil_change",
  date: "2026-10-20",
  time: "10:00",
  status: "confirmed",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /demo/bookings", () => {
  describe("valid request and correct actor routing", () => {
    it("returns 200 with booking response on success", async () => {
      const stub: AgendaStub = {
        getOccupiedSlots: vi.fn(),
        createBooking: vi.fn(async () => SUCCESS_RESULT),
      };
      const { env } = makeEnv(stub);
      const res = await handler.fetch(bookingReq(validBody()), env as never);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        booking_id: "b-0001-uuid",
        service_id: "oil_change",
        date: "2026-10-20",
        time: "10:00",
        status: "confirmed",
      });
    });

    it("addresses actor as main-{date}", async () => {
      const stub: AgendaStub = {
        getOccupiedSlots: vi.fn(),
        createBooking: vi.fn(async () => SUCCESS_RESULT),
      };
      const { env, idFromName } = makeEnv(stub);
      await handler.fetch(bookingReq(validBody({ date: "2026-10-21" })), env as never);
      expect(idFromName).toHaveBeenCalledWith("main-2026-10-21");
    });

    it("passes trimmed fields to actor", async () => {
      const stub: AgendaStub = {
        getOccupiedSlots: vi.fn(),
        createBooking: vi.fn(async () => SUCCESS_RESULT),
      };
      const { env } = makeEnv(stub);
      await handler.fetch(
        bookingReq(validBody({ customer_name: "  Jordan  ", customer_phone: "  +52  " })),
        env as never,
      );
      expect(stub.createBooking).toHaveBeenCalledWith(
        expect.objectContaining({
          customer_name: "Jordan",
          customer_phone: "+52",
        }),
      );
    });

    it("does not pass a timestamp to actor", async () => {
      const stub: AgendaStub = {
        getOccupiedSlots: vi.fn(),
        createBooking: vi.fn(async () => SUCCESS_RESULT),
      };
      const { env } = makeEnv(stub);
      await handler.fetch(bookingReq(validBody()), env as never);
      const input = stub.createBooking.mock.calls[0]![0] as Record<string, unknown>;
      expect("now" in input).toBe(false);
    });
  });

  describe("unauthorized requests never access KV or Actor", () => {
    it("401 without bearer — Actor not called, KV not called", async () => {
      const stub: AgendaStub = {
        getOccupiedSlots: vi.fn(),
        createBooking: vi.fn(),
      };
      const kv = validKv();
      const { env } = makeEnv(stub, validSecrets(), kv);
      const res = await handler.fetch(
        bookingReq(validBody(), "wrong-token"),
        env as never,
      );
      expect(res.status).toBe(401);
      expect(stub.createBooking).not.toHaveBeenCalled();
      expect(kv.get).not.toHaveBeenCalled();
    });

    it("401 with no auth header", async () => {
      const stub: AgendaStub = {
        getOccupiedSlots: vi.fn(),
        createBooking: vi.fn(),
      };
      const { env } = makeEnv(stub);
      const res = await handler.fetch(
        new Request("http://x/demo/bookings", {
          method: "POST",
          body: JSON.stringify(validBody()),
          headers: { "content-type": "application/json" },
        }),
        env as never,
      );
      expect(res.status).toBe(401);
      expect(stub.createBooking).not.toHaveBeenCalled();
    });
  });

  describe("malformed JSON", () => {
    it("400 for invalid JSON", async () => {
      const stub: AgendaStub = {
        getOccupiedSlots: vi.fn(),
        createBooking: vi.fn(),
      };
      const { env } = makeEnv(stub);
      const res = await handler.fetch(bookingReq("{not json"), env as never);
      expect(res.status).toBe(400);
      expect(stub.createBooking).not.toHaveBeenCalled();
    });
  });

  describe("invalid types and dates/times", () => {
    it("400 for bad date format", async () => {
      const stub: AgendaStub = { getOccupiedSlots: vi.fn(), createBooking: vi.fn() };
      const { env } = makeEnv(stub);
      const res = await handler.fetch(
        bookingReq(validBody({ date: "2026-13-01" })),
        env as never,
      );
      expect(res.status).toBe(400);
      expect(stub.createBooking).not.toHaveBeenCalled();
    });

    it("400 for impossible calendar date", async () => {
      const stub: AgendaStub = { getOccupiedSlots: vi.fn(), createBooking: vi.fn() };
      const { env } = makeEnv(stub);
      const res = await handler.fetch(
        bookingReq(validBody({ date: "2026-02-30" })),
        env as never,
      );
      expect(res.status).toBe(400);
    });

    it("400 for invalid time syntax (not HH:mm)", async () => {
      const stub: AgendaStub = { getOccupiedSlots: vi.fn(), createBooking: vi.fn() };
      const { env } = makeEnv(stub);
      const res = await handler.fetch(
        bookingReq(validBody({ time: "10" })),
        env as never,
      );
      expect(res.status).toBe(400);
      expect(stub.createBooking).not.toHaveBeenCalled();
    });

    it("400 for confirmed as string instead of boolean", async () => {
      const stub: AgendaStub = { getOccupiedSlots: vi.fn(), createBooking: vi.fn() };
      const { env } = makeEnv(stub);
      const res = await handler.fetch(
        bookingReq(validBody({ confirmed: "true" })),
        env as never,
      );
      expect(res.status).toBe(400);
      expect(stub.createBooking).not.toHaveBeenCalled();
    });

    it("400 for empty customer_name", async () => {
      const stub: AgendaStub = { getOccupiedSlots: vi.fn(), createBooking: vi.fn() };
      const { env } = makeEnv(stub);
      const res = await handler.fetch(
        bookingReq(validBody({ customer_name: "  " })),
        env as never,
      );
      expect(res.status).toBe(400);
    });

    it("400 for empty customer_phone", async () => {
      const stub: AgendaStub = { getOccupiedSlots: vi.fn(), createBooking: vi.fn() };
      const { env } = makeEnv(stub);
      const res = await handler.fetch(
        bookingReq(validBody({ customer_phone: "" })),
        env as never,
      );
      expect(res.status).toBe(400);
    });

    it("400 for empty idempotency_key", async () => {
      const stub: AgendaStub = { getOccupiedSlots: vi.fn(), createBooking: vi.fn() };
      const { env } = makeEnv(stub);
      const res = await handler.fetch(
        bookingReq(validBody({ idempotency_key: "  " })),
        env as never,
      );
      expect(res.status).toBe(400);
    });
  });

  describe("unexpected fields rejected", () => {
    it("400 for config field in body", async () => {
      const stub: AgendaStub = { getOccupiedSlots: vi.fn(), createBooking: vi.fn() };
      const { env } = makeEnv(stub);
      const res = await handler.fetch(
        bookingReq(validBody({ config: { something: true } })),
        env as never,
      );
      expect(res.status).toBe(400);
      expect(stub.createBooking).not.toHaveBeenCalled();
    });

    it("400 for now field in body", async () => {
      const stub: AgendaStub = { getOccupiedSlots: vi.fn(), createBooking: vi.fn() };
      const { env } = makeEnv(stub);
      const res = await handler.fetch(
        bookingReq(validBody({ now: 1234567890 })),
        env as never,
      );
      expect(res.status).toBe(400);
    });

    it("400 for is_retry field in body", async () => {
      const stub: AgendaStub = { getOccupiedSlots: vi.fn(), createBooking: vi.fn() };
      const { env } = makeEnv(stub);
      const res = await handler.fetch(
        bookingReq(validBody({ is_retry: true })),
        env as never,
      );
      expect(res.status).toBe(400);
    });
  });

  describe("oversized bodies", () => {
    it("413 for body over 10 KiB with absent Content-Length", async () => {
      const stub: AgendaStub = { getOccupiedSlots: vi.fn(), createBooking: vi.fn() };
      const { env } = makeEnv(stub);
      const big = "x".repeat(10 * 1024 + 1);
      const res = await handler.fetch(
        new Request("http://x/demo/bookings", {
          method: "POST",
          body: big,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${VALID_TOKEN}`,
          },
        }),
        env as never,
      );
      expect(res.status).toBe(413);
      expect(stub.createBooking).not.toHaveBeenCalled();
    });

    it("413 for body over 10 KiB with misleading small Content-Length", async () => {
      const stub: AgendaStub = { getOccupiedSlots: vi.fn(), createBooking: vi.fn() };
      const { env } = makeEnv(stub);
      const big = "x".repeat(10 * 1024 + 100);
      const res = await handler.fetch(
        new Request("http://x/demo/bookings", {
          method: "POST",
          body: big,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${VALID_TOKEN}`,
            "content-length": "100",
          },
        }),
        env as never,
      );
      expect(res.status).toBe(413);
    });
  });

  describe("body reader lock release", () => {
    // cancel() and read() returning done do NOT release the reader lock.
    // readBoundedBody() must call reader.releaseLock() explicitly so the
    // request body can be consumed elsewhere (or GC'd) after the handler
    // completes. These tests assert req.body.locked === false on success,
    // oversized body, failed read, and a never-settling cancel.

    it("success path: 200, body.locked is false, Actor reached", async () => {
      const stub: AgendaStub = {
        getOccupiedSlots: vi.fn(),
        createBooking: vi.fn(async () => SUCCESS_RESULT),
      };
      const kv = validKv();
      const { env } = makeEnv(stub, validSecrets(), kv);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify(validBody())));
          controller.close();
        },
      });
      const req = new Request("http://x/demo/bookings", {
        method: "POST",
        body: stream,
        ...({ duplex: "half" } as Record<string, unknown>),
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${VALID_TOKEN}`,
        },
      });
      const res = await handler.fetch(req, env as never);
      expect(res.status).toBe(200);
      expect(stub.createBooking).toHaveBeenCalled();
      expect(req.body).not.toBeNull();
      expect(req.body!.locked).toBe(false);
    });

    it("oversized body: 413, body.locked is false, Actor not reached", async () => {
      const stub: AgendaStub = { getOccupiedSlots: vi.fn(), createBooking: vi.fn() };
      const kv = validKv();
      const { env } = makeEnv(stub, validSecrets(), kv);
      const big = new Uint8Array(10 * 1024 + 100);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(big);
        },
        cancel() {
          // Rejection is absorbed by .catch() in readBoundedBody. releaseLock()
          // must run independently and synchronously.
          throw new Error("cancel failed");
        },
      });
      const req = new Request("http://x/demo/bookings", {
        method: "POST",
        body: stream,
        ...({ duplex: "half" } as Record<string, unknown>),
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${VALID_TOKEN}`,
        },
      });
      const res = await handler.fetch(req, env as never);
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: "payload_too_large" });
      expect(kv.get).not.toHaveBeenCalled();
      expect(stub.createBooking).not.toHaveBeenCalled();
      expect(req.body!.locked).toBe(false);
    });

    it("failed read: 400, body.locked is false, Actor not reached", async () => {
      const stub: AgendaStub = { getOccupiedSlots: vi.fn(), createBooking: vi.fn() };
      const kv = validKv();
      const { env } = makeEnv(stub, validSecrets(), kv);
      const stream = new ReadableStream({
        start(controller) {
          controller.error(new Error("connection reset"));
        },
      });
      const req = new Request("http://x/demo/bookings", {
        method: "POST",
        body: stream,
        ...({ duplex: "half" } as Record<string, unknown>),
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${VALID_TOKEN}`,
        },
      });
      const res = await handler.fetch(req, env as never);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_request" });
      expect(kv.get).not.toHaveBeenCalled();
      expect(stub.createBooking).not.toHaveBeenCalled();
      expect(req.body!.locked).toBe(false);
    });

    it("413 returned even when cancel() never settles (non-hanging regression)", async () => {
      // cancel() returns a promise that never resolves. The finally block
      // must NOT await cancel() — otherwise the function would hang. releaseLock()
      // runs synchronously after the fire-and-forget cancel(), so the body
      // lock is freed even when the underlying source is wedged.
      const stub: AgendaStub = { getOccupiedSlots: vi.fn(), createBooking: vi.fn() };
      const kv = validKv();
      const { env } = makeEnv(stub, validSecrets(), kv);
      const big = new Uint8Array(10 * 1024 + 100);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(big);
        },
        cancel() {
          return new Promise<void>(() => {});
        },
      });
      const req = new Request("http://x/demo/bookings", {
        method: "POST",
        body: stream,
        ...({ duplex: "half" } as Record<string, unknown>),
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${VALID_TOKEN}`,
        },
      });
      const res = await handler.fetch(req, env as never);
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: "payload_too_large" });
      expect(kv.get).not.toHaveBeenCalled();
      expect(stub.createBooking).not.toHaveBeenCalled();
      // releaseLock() ran synchronously even though cancel() is still pending.
      expect(req.body!.locked).toBe(false);
    });
  });

  describe("configuration failure and missing bindings", () => {
    it("503 when CONFIG binding is missing", async () => {
      const stub: AgendaStub = { getOccupiedSlots: vi.fn(), createBooking: vi.fn() };
      const env = {
        COUNTER: { idFromName: () => ({}) },
        AGENDA: { idFromName: vi.fn(() => stub) },
        SECRETS: validSecrets(),
      };
      const res = await handler.fetch(bookingReq(validBody()), env as never);
      expect(res.status).toBe(503);
      expect(stub.createBooking).not.toHaveBeenCalled();
    });

    it("503 when AGENDA binding is missing", async () => {
      const env = {
        COUNTER: { idFromName: () => ({}) },
        SECRETS: validSecrets(),
        CONFIG: validKv(),
      };
      const res = await handler.fetch(bookingReq(validBody()), env as never);
      expect(res.status).toBe(503);
    });

    it("503 when KV returns null (config failure), including retries", async () => {
      const stub: AgendaStub = { getOccupiedSlots: vi.fn(), createBooking: vi.fn() };
      const kv = { get: vi.fn(async () => null) };
      const { env } = makeEnv(stub, validSecrets(), kv);
      // First attempt
      const res1 = await handler.fetch(bookingReq(validBody()), env as never);
      expect(res1.status).toBe(503);
      // Retry (same idempotency key) — also 503 because KV infra failure
      const res2 = await handler.fetch(bookingReq(validBody()), env as never);
      expect(res2.status).toBe(503);
      expect(stub.createBooking).not.toHaveBeenCalled();
    });
  });

  describe("structurally valid requests reach Actor regardless of admission rules", () => {
    it("confirmed:false still reaches Actor (handler does not check)", async () => {
      const stub: AgendaStub = {
        getOccupiedSlots: vi.fn(),
        createBooking: vi.fn(async () => ({ ok: false, code: "confirmation_required" })),
      };
      const { env } = makeEnv(stub);
      const res = await handler.fetch(
        bookingReq(validBody({ confirmed: false })),
        env as never,
      );
      expect(stub.createBooking).toHaveBeenCalled();
      expect(res.status).toBe(400);
    });

    it("unknown service_id still reaches Actor", async () => {
      const stub: AgendaStub = {
        getOccupiedSlots: vi.fn(),
        createBooking: vi.fn(async () => ({ ok: false, code: "unknown_service" })),
      };
      const { env } = makeEnv(stub);
      const res = await handler.fetch(
        bookingReq(validBody({ service_id: "nonexistent" })),
        env as never,
      );
      expect(stub.createBooking).toHaveBeenCalled();
      expect(res.status).toBe(400);
    });

    it("09:30 time still reaches Actor (handler does syntax only)", async () => {
      const stub: AgendaStub = {
        getOccupiedSlots: vi.fn(),
        createBooking: vi.fn(async () => ({ ok: false, code: "time_invalid" })),
      };
      const { env } = makeEnv(stub);
      const res = await handler.fetch(
        bookingReq(validBody({ time: "09:30" })),
        env as never,
      );
      expect(stub.createBooking).toHaveBeenCalled();
      expect(res.status).toBe(400);
    });

    it("replay (identical retry) reaches Actor and succeeds", async () => {
      const stub: AgendaStub = {
        getOccupiedSlots: vi.fn(),
        createBooking: vi.fn(async () => SUCCESS_RESULT),
      };
      const { env } = makeEnv(stub);
      const res = await handler.fetch(bookingReq(validBody()), env as never);
      expect(stub.createBooking).toHaveBeenCalled();
      expect(res.status).toBe(200);
    });
  });

  describe("known domain errors mapped to 400", () => {
    const domainCodes = [
      "unknown_service",
      "date_out_of_range",
      "date_not_open",
      "time_invalid",
      "confirmation_required",
      "booking_disabled",
      "slot_in_past",
      "slot_unavailable",
      "idempotency_key_conflict",
    ];
    for (const code of domainCodes) {
      it(`400 for ${code}`, async () => {
        const stub: AgendaStub = {
          getOccupiedSlots: vi.fn(),
          createBooking: vi.fn(async () => ({ ok: false, code })),
        };
        const { env } = makeEnv(stub);
        const res = await handler.fetch(bookingReq(validBody()), env as never);
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body).toEqual({ error: code });
      });
    }
  });

  describe("infrastructure errors mapped to 503", () => {
    it("503 when Actor throws", async () => {
      const stub: AgendaStub = {
        getOccupiedSlots: vi.fn(),
        createBooking: vi.fn(async () => {
          throw new Error("actor crashed");
        }),
      };
      const { env } = makeEnv(stub);
      const res = await handler.fetch(bookingReq(validBody()), env as never);
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toEqual({ error: "service_unavailable" });
    });

    it("503 for malformed Actor response (not an object)", async () => {
      const stub: AgendaStub = {
        getOccupiedSlots: vi.fn(),
        createBooking: vi.fn(async () => "not-an-object" as never),
      };
      const { env } = makeEnv(stub);
      const res = await handler.fetch(bookingReq(validBody()), env as never);
      expect(res.status).toBe(503);
    });

    it("503 for malformed Actor response (ok not boolean)", async () => {
      const stub: AgendaStub = {
        getOccupiedSlots: vi.fn(),
        createBooking: vi.fn(async () => ({ ok: "yes" }) as never),
      };
      const { env } = makeEnv(stub);
      const res = await handler.fetch(bookingReq(validBody()), env as never);
      expect(res.status).toBe(503);
    });

    it("503 for unknown error code from Actor", async () => {
      const stub: AgendaStub = {
        getOccupiedSlots: vi.fn(),
        createBooking: vi.fn(async () => ({ ok: false, code: "unknown_rejection" })),
      };
      const { env } = makeEnv(stub);
      const res = await handler.fetch(bookingReq(validBody()), env as never);
      expect(res.status).toBe(503);
    });
  });

  describe("success responses exclude customer details", () => {
    it("response body does not contain customer_name or customer_phone", async () => {
      const stub: AgendaStub = {
        getOccupiedSlots: vi.fn(),
        createBooking: vi.fn(async () => SUCCESS_RESULT),
      };
      const { env } = makeEnv(stub);
      const res = await handler.fetch(
        bookingReq(validBody({ customer_name: "Secret Person", customer_phone: "secret-phone" })),
        env as never,
      );
      const json = JSON.stringify(await res.json());
      expect(json).not.toContain("Secret");
      expect(json).not.toContain("Person");
      expect(json).not.toContain("secret-phone");
    });
  });

  describe("GET /demo/bookings returns 404", () => {
    it("GET method rejected", async () => {
      const stub: AgendaStub = { getOccupiedSlots: vi.fn(), createBooking: vi.fn() };
      const { env } = makeEnv(stub);
      const res = await handler.fetch(
        new Request("http://x/demo/bookings", {
          headers: { authorization: `Bearer ${VALID_TOKEN}` },
        }),
        env as never,
      );
      expect(res.status).toBe(404);
    });
  });
});
