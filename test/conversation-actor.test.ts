import { describe, it, expect, vi } from "vitest";

// MOCKED: the runtime StatefulActor is replaced with a minimal stand-in so
// we can construct ConversationBooking without the platform. Storage is the
// serialized fake from ./support; KV and AGENDA are vi.fn doubles.
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

// Import AFTER the mock so `StatefulActor` is the mock class.
import { ConversationBooking } from "../src/conversation-actor";
import { createFakeStorage } from "./support/fake-actor-storage";
import type { AppConfig } from "../src/config";
import type {
  CreateBookingInput,
  CreateBookingResult,
} from "../src/agenda-actor";
import type { ActorStorageLike } from "../src/conversation-booking";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_INPUT = {
  service_id: "oil_change",
  date: "2026-10-20",
  time: "10:00",
  customer_name: "Maria Lopez",
  customer_phone: "+52 55 1234 5678",
  confirmed: true,
};

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

const SUCCESS_RESULT: CreateBookingResult = {
  ok: true,
  booking_id: "b-001",
  service_id: "oil_change",
  date: "2026-10-20",
  time: "10:00",
  status: "confirmed",
};

interface AgendaStubLike {
  createBooking: ReturnType<typeof vi.fn>;
  getOccupiedSlots: ReturnType<typeof vi.fn>;
}

function makeBindings(
  overrides: {
    config?: unknown;
    createBooking?: (input: CreateBookingInput) => Promise<CreateBookingResult>;
  } = {},
) {
  const config = overrides.config === undefined ? VALID_CONFIG : overrides.config;
  const kvGet = vi.fn(async () => config);
  const agendaCreate =
    overrides.createBooking ?? (async () => SUCCESS_RESULT);
  const stub: AgendaStubLike = {
    createBooking: vi.fn(agendaCreate),
    getOccupiedSlots: vi.fn(async () => ({ occupied: [] })),
  };
  const idFromName = vi.fn(() => stub);
  return {
    env: {
      CONFIG: { get: kvGet, put: vi.fn(), delete: vi.fn() },
      AGENDA: { idFromName },
    } as never,
    kvGet,
    idFromName,
    stub,
  };
}

function makeActor(
  overrides: Parameters<typeof makeBindings>[0] = {},
) {
  const bindings = makeBindings(overrides);
  const storage = createFakeStorage();
  const actor = new ConversationBooking(
    { storage } as never,
    bindings.env,
  );
  return {
    actor,
    storage: storage as unknown as ActorStorageLike,
    ...bindings,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConversationBooking adapter", () => {
  it("successful delegation: routes to AGENDA and returns the confirmed result", async () => {
    const { actor, stub, idFromName } = makeActor();

    const r = await actor.book(VALID_INPUT);

    expect(r).toEqual({
      kind: "confirmed",
      booking_id: "b-001",
      service_id: "oil_change",
      date: "2026-10-20",
      time: "10:00",
    });
    expect(idFromName).toHaveBeenCalledWith("main-2026-10-20");
    expect(stub.createBooking).toHaveBeenCalledTimes(1);

    const executorInput = stub.createBooking.mock.calls[0]![0] as CreateBookingInput;
    expect(executorInput.idempotency_key).toMatch(/^[0-9a-f-]{36}$/i);
    expect(executorInput.config.business.location_id).toBe("main");
    expect(executorInput.service_id).toBe("oil_change");
    expect(executorInput.date).toBe("2026-10-20");
    expect(executorInput.time).toBe("10:00");
  });

  it("confirmed replay: returns stored result without loading KV or contacting AGENDA", async () => {
    const { actor, kvGet, idFromName, stub } = makeActor();

    const r1 = await actor.book(VALID_INPUT);
    expect(r1.kind).toBe("confirmed");
    expect(stub.createBooking).toHaveBeenCalledTimes(1);
    expect(kvGet).toHaveBeenCalledTimes(1);

    kvGet.mockClear();
    idFromName.mockClear();
    stub.createBooking.mockClear();

    const r2 = await actor.book(VALID_INPUT);
    expect(r2).toEqual(r1);
    expect(kvGet).not.toHaveBeenCalled();
    expect(idFromName).not.toHaveBeenCalled();
    expect(stub.createBooking).not.toHaveBeenCalled();
  });

  it("changed input after confirmation is rejected without contacting AGENDA", async () => {
    const { actor, stub, idFromName } = makeActor();
    await actor.book(VALID_INPUT);

    stub.createBooking.mockClear();
    idFromName.mockClear();

    const changed = { ...VALID_INPUT, date: "2026-10-21", time: "11:00" };
    const r = await actor.book(changed);
    expect(r).toEqual({
      kind: "rejected",
      code: "conversation_already_booked",
    });
    expect(stub.createBooking).not.toHaveBeenCalled();
    expect(idFromName).not.toHaveBeenCalled();
  });

  it("ambiguous failure then recovery reuses the same idempotency key", async () => {
    let callCount = 0;
    const { actor, stub } = makeActor({
      createBooking: async () => {
        callCount++;
        if (callCount === 1) throw new Error("agenda timeout");
        return SUCCESS_RESULT;
      },
    });

    // First call: executor throws → coordinator preserves pending.
    const r1 = await actor.book(VALID_INPUT);
    expect(r1).toEqual({ kind: "infrastructure_error" });
    expect(stub.createBooking).toHaveBeenCalledTimes(1);

    // Second call with identical input: retry the same attempt_key.
    const r2 = await actor.book(VALID_INPUT);
    expect(r2).toEqual({
      kind: "confirmed",
      booking_id: "b-001",
      service_id: "oil_change",
      date: "2026-10-20",
      time: "10:00",
    });
    expect(stub.createBooking).toHaveBeenCalledTimes(2);

    const firstCall = stub.createBooking.mock.calls[0]![0] as CreateBookingInput;
    const secondCall = stub.createBooking.mock.calls[1]![0] as CreateBookingInput;
    // Same key on retry because pending state preserves the original attempt_key.
    expect(secondCall.idempotency_key).toBe(firstCall.idempotency_key);
    expect(secondCall.service_id).toBe(firstCall.service_id);
    expect(secondCall.date).toBe(firstCall.date);
    expect(secondCall.time).toBe(firstCall.time);
  });

  it("config location mismatch: never calls DayAgenda; returns infrastructure_error", async () => {
    const wrongConfig: AppConfig = {
      ...VALID_CONFIG,
      business: { ...VALID_CONFIG.business, location_id: "branch-east" },
    };
    const { actor, stub, idFromName } = makeActor({ config: wrongConfig });

    const r = await actor.book(VALID_INPUT);
    expect(r).toEqual({ kind: "infrastructure_error" });
    expect(stub.createBooking).not.toHaveBeenCalled();
    expect(idFromName).not.toHaveBeenCalled();
  });

  it("missing CONFIG binding: fails closed; AGENDA never called", async () => {
    const { stub, idFromName } = makeActor();
    // Re-construct with CONFIG removed.
    const env = { AGENDA: { idFromName } } as never;
    const storage = createFakeStorage();
    const a = new ConversationBooking({ storage } as never, env);

    const r = await a.book(VALID_INPUT);
    expect(r).toEqual({ kind: "infrastructure_error" });
    expect(idFromName).not.toHaveBeenCalled();
    expect(stub.createBooking).not.toHaveBeenCalled();
  });

  it("missing AGENDA binding: fails closed; KV never read", async () => {
    const { kvGet, stub } = makeActor();
    // Re-construct with AGENDA removed.
    const env = { CONFIG: { get: kvGet, put: vi.fn(), delete: vi.fn() } } as never;
    const storage = createFakeStorage();
    const a = new ConversationBooking({ storage } as never, env);

    const r = await a.book(VALID_INPUT);
    expect(r).toEqual({ kind: "infrastructure_error" });
    expect(kvGet).not.toHaveBeenCalled();
    expect(stub.createBooking).not.toHaveBeenCalled();
  });

  it("unexpected adapter errors are caught and surfaced as infrastructure_error", async () => {
    // Inject a storage whose .get throws synchronously to simulate an
    // adapter-level crash. coordinateBooking's own try/catch should not see
    // this — but the actor's outer try/catch must.
    const brokenStorage = {
      get: vi.fn(async () => {
        throw new Error("storage exploded");
      }),
      put: vi.fn(async () => {}),
    };
    const bindings = makeBindings();
    const a = new ConversationBooking(
      { storage: brokenStorage } as never,
      bindings.env,
    );

    const r = await a.book(VALID_INPUT);
    expect(r).toEqual({ kind: "infrastructure_error" });
  });
});
