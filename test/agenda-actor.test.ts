import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// MOCKED: verifies Actor read logic only. Never loads the real runtime.
// ActorStorage is mocked; no remote state is read or written.
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
import {
  DayAgenda,
  type DayAgendaState,
  type CreateBookingInput,
  computeFingerprint,
} from "../src/agenda-actor";
import type { AppConfig } from "../src/config";

// ---------------------------------------------------------------------------
// Fixtures — realistic dates, not placeholders.
// ---------------------------------------------------------------------------

const AGENDA_DATE = "2026-10-20"; // Tuesday

function booking(
  slot: string,
  id: string,
  date: string = AGENDA_DATE,
): Record<string, unknown> {
  return {
    id,
    service_id: "oil_change",
    date,
    time: slot,
    customer_name: "(test-name)",
    customer_phone: "(test-phone)",
    created_at: "2026-10-19T10:00:00Z",
    idempotency_key: `key-${id}`,
  };
}

function validState(
  bookings: Record<string, Record<string, unknown>> = {},
): DayAgendaState {
  return {
    date: AGENDA_DATE,
    bookings: bookings as Record<string, never>,
    idempotency: {},
  } as unknown as DayAgendaState;
}

function makeActor(storage: {
  get: ReturnType<typeof vi.fn>;
  put?: ReturnType<typeof vi.fn>;
  delete?: ReturnType<typeof vi.fn>;
}): DayAgenda {
  const actor = new DayAgenda(
    { storage } as never,
    {} as never,
  );
  return actor;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DayAgenda.getOccupiedSlots", () => {
  describe("missing state → empty occupancy", () => {
    it("returns [] when storage.get returns undefined (never written)", async () => {
      const storage = {
        get: vi.fn(async () => undefined),
        put: vi.fn(async () => {}),
        delete: vi.fn(async () => false),
      };
      const actor = makeActor(storage);
      const result = await actor.getOccupiedSlots();
      expect(result.occupied).toEqual([]);
      expect(storage.put).not.toHaveBeenCalled();
      expect(storage.delete).not.toHaveBeenCalled();
    });
  });

  describe("null stored state → throw (not empty agenda)", () => {
    it("null is NOT undefined — must throw, not return empty", async () => {
      const storage = {
        get: vi.fn(async () => null),
        put: vi.fn(async () => {}),
        delete: vi.fn(async () => false),
      };
      const actor = makeActor(storage);
      await expect(actor.getOccupiedSlots()).rejects.toThrow();
      // No writes performed.
      expect(storage.put).not.toHaveBeenCalled();
      expect(storage.delete).not.toHaveBeenCalled();
    });
  });

  describe("valid populated state → sorted occupied times", () => {
    it("returns occupied times sorted when multiple bookings exist", async () => {
      const state = validState({
        "13:00": booking("13:00", "b-001"),
        "09:00": booking("09:00", "b-002"),
        "16:00": booking("16:00", "b-003"),
      });
      const storage = {
        get: vi.fn(async () => state),
        put: vi.fn(async () => {}),
        delete: vi.fn(async () => false),
      };
      const actor = makeActor(storage);
      const result = await actor.getOccupiedSlots();
      expect(result.occupied).toEqual(["09:00", "13:00", "16:00"]);
      // No writes performed on read.
      expect(storage.put).not.toHaveBeenCalled();
      expect(storage.delete).not.toHaveBeenCalled();
    });

    it("returns single occupied time for one booking", async () => {
      const state = validState({
        "10:00": booking("10:00", "b-010"),
      });
      const actor = makeActor({ get: vi.fn(async () => state) });
      const result = await actor.getOccupiedSlots();
      expect(result.occupied).toEqual(["10:00"]);
    });

    it("returns [] when state has no bookings (valid empty record)", async () => {
      const state = validState({});
      const actor = makeActor({ get: vi.fn(async () => state) });
      const result = await actor.getOccupiedSlots();
      expect(result.occupied).toEqual([]);
    });
  });

  describe("storage errors → throw (caller maps to 503)", () => {
    it("rejected storage read throws", async () => {
      const storage = {
        get: vi.fn(async () => {
          throw new Error("network");
        }),
      };
      const actor = makeActor(storage);
      await expect(actor.getOccupiedSlots()).rejects.toThrow();
    });
  });

  describe("malformed aggregate → throw (not empty agenda)", () => {
    it("non-object state throws", async () => {
      const actor = makeActor({ get: vi.fn(async () => "not-an-object") });
      await expect(actor.getOccupiedSlots()).rejects.toThrow();
    });

    it("array state throws (state is an array, not a record)", async () => {
      const actor = makeActor({ get: vi.fn(async () => []) });
      await expect(actor.getOccupiedSlots()).rejects.toThrow();
    });

    it("missing date field throws", async () => {
      const bad = { bookings: {}, idempotency: {} };
      const actor = makeActor({ get: vi.fn(async () => bad) });
      await expect(actor.getOccupiedSlots()).rejects.toThrow();
    });

    it("invalid date format throws", async () => {
      const bad = { date: "2026-13-40", bookings: {}, idempotency: {} };
      const actor = makeActor({ get: vi.fn(async () => bad) });
      await expect(actor.getOccupiedSlots()).rejects.toThrow();
    });

    it("impossible calendar date throws", async () => {
      const bad = { date: "2026-02-30", bookings: {}, idempotency: {} };
      const actor = makeActor({ get: vi.fn(async () => bad) });
      await expect(actor.getOccupiedSlots()).rejects.toThrow();
    });

    it("bookings as array throws (not a record)", async () => {
      const bad = { date: AGENDA_DATE, bookings: [], idempotency: {} };
      const actor = makeActor({ get: vi.fn(async () => bad) });
      await expect(actor.getOccupiedSlots()).rejects.toThrow();
    });

    it("idempotency as array throws (not a record)", async () => {
      const bad = { date: AGENDA_DATE, bookings: {}, idempotency: [] };
      const actor = makeActor({ get: vi.fn(async () => bad) });
      await expect(actor.getOccupiedSlots()).rejects.toThrow();
    });
  });

  describe("invalid booking entries → throw", () => {
    it("invalid slot key in bookings record throws", async () => {
      const bad = validState({
        "09:30": booking("09:30", "b-0930"), // 09:30 not a whole-hour slot
      });
      const actor = makeActor({ get: vi.fn(async () => bad) });
      await expect(actor.getOccupiedSlots()).rejects.toThrow();
    });

    it("out-of-range slot key throws (08:00 is before opening)", async () => {
      const bad = validState({
        "08:00": booking("08:00", "b-0800"),
      });
      const actor = makeActor({ get: vi.fn(async () => bad) });
      await expect(actor.getOccupiedSlots()).rejects.toThrow();
    });

    it("17:00 slot throws (at end, not a valid start)", async () => {
      const bad = validState({
        "17:00": booking("17:00", "b-1700"),
      });
      const actor = makeActor({ get: vi.fn(async () => bad) });
      await expect(actor.getOccupiedSlots()).rejects.toThrow();
    });

    it("booking date inconsistent with aggregate date throws", async () => {
      const bad = validState({
        "10:00": booking("10:00", "b-001", "2026-10-21"), // different date
      });
      const actor = makeActor({ get: vi.fn(async () => bad) });
      await expect(actor.getOccupiedSlots()).rejects.toThrow();
    });

    it("booking missing customer_name throws", async () => {
      const bad = validState({
        "10:00": { ...booking("10:00", "b-001"), customer_name: "" },
      });
      const actor = makeActor({ get: vi.fn(async () => bad) });
      await expect(actor.getOccupiedSlots()).rejects.toThrow();
    });

    it("booking missing customer_phone throws", async () => {
      const bad = validState({
        "10:00": { ...booking("10:00", "b-001"), customer_phone: "" },
      });
      const actor = makeActor({ get: vi.fn(async () => bad) });
      await expect(actor.getOccupiedSlots()).rejects.toThrow();
    });

    it("booking with non-string idempotency_key throws", async () => {
      const bad = validState({
        "10:00": { ...booking("10:00", "b-001"), idempotency_key: 42 },
      });
      const actor = makeActor({ get: vi.fn(async () => bad) });
      await expect(actor.getOccupiedSlots()).rejects.toThrow();
    });
  });

  describe("no storage writes performed on read", () => {
    it("empty agenda path: no put or delete called", async () => {
      const storage = {
        get: vi.fn(async () => undefined),
        put: vi.fn(async () => {}),
        delete: vi.fn(async () => false),
        deleteAll: vi.fn(async () => {}),
      };
      const actor = makeActor(storage);
      await actor.getOccupiedSlots();
      expect(storage.put).not.toHaveBeenCalled();
      expect(storage.delete).not.toHaveBeenCalled();
      expect(storage.deleteAll).not.toHaveBeenCalled();
    });

    it("populated agenda path: no put or delete called", async () => {
      const state = validState({
        "09:00": booking("09:00", "b-001"),
        "14:00": booking("14:00", "b-002"),
      });
      const storage = {
        get: vi.fn(async () => state),
        put: vi.fn(async () => {}),
        delete: vi.fn(async () => false),
        deleteAll: vi.fn(async () => {}),
      };
      const actor = makeActor(storage);
      await actor.getOccupiedSlots();
      expect(storage.put).not.toHaveBeenCalled();
      expect(storage.delete).not.toHaveBeenCalled();
      expect(storage.deleteAll).not.toHaveBeenCalled();
    });
  });
});

// ===========================================================================
// createBooking tests (mocked storage)
// ===========================================================================

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

const DISABLED_CONFIG: AppConfig = {
  ...VALID_CONFIG,
  business: { ...VALID_CONFIG.business, booking_enabled: false },
};

// Calibrator for setting the fake clock — returns epoch ms for a given
// Mexico City local date/time. Used with vi.setSystemTime().
function localEpochMS(date: string, hour: number, minute: number): number {
  const [y, m, d] = date.split("-").map(Number);
  const candidate = Date.UTC(y, m - 1, d, hour, minute, 0);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(new Date(candidate));
  const ly = parts.find((p) => p.type === "year")!.value;
  const lm = parts.find((p) => p.type === "month")!.value;
  const ld = parts.find((p) => p.type === "day")!.value;
  const lh = Number(parts.find((p) => p.type === "hour")!.value);
  const lmin = Number(parts.find((p) => p.type === "minute")!.value);
  if (`${ly}-${lm}-${ld}` !== date) {
    throw new Error(`localEpochMS date mismatch for ${date}`);
  }
  const offsetMs = (hour * 60 + minute - lh * 60 - lmin) * 60000;
  return candidate + offsetMs;
}

// Fixed clock: Tuesday Oct 20, 2026 08:00 local MX (before opening, all slots future).
const CLOCK_TUE_OCT20_08 = localEpochMS("2026-10-20", 8, 0);

function makeBookingInput(
  overrides: Partial<CreateBookingInput> = {},
): CreateBookingInput {
  return {
    service_id: "oil_change",
    date: AGENDA_DATE,
    time: "10:00",
    customer_name: "  Maria Lopez  ",
    customer_phone: "  +52 55 1234 5678  ",
    idempotency_key: "attempt-001",
    confirmed: true,
    config: VALID_CONFIG,
    ...overrides,
  };
}

function makeActorWithPut(
  getState: () => unknown,
  putFn?: ReturnType<typeof vi.fn>,
): {
  actor: DayAgenda;
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
} {
  const get = vi.fn(async () => getState());
  const put = putFn ?? vi.fn(async () => {});
  const storage = { get, put };
  const actor = new DayAgenda({ storage } as never, {} as never);
  return { actor, get, put };
}

describe("DayAgenda.createBooking", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(CLOCK_TUE_OCT20_08);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("successful creation", () => {
    it("creates a booking on empty agenda and persists", async () => {
      const { actor, put } = makeActorWithPut(() => undefined);
      const result = await actor.createBooking(makeBookingInput());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.status).toBe("confirmed");
      expect(result.booking_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(result.service_id).toBe("oil_change");
      expect(result.date).toBe(AGENDA_DATE);
      expect(result.time).toBe("10:00");
      expect(put).toHaveBeenCalledTimes(1);
      expect(put).toHaveBeenCalledWith("agenda", expect.any(Object));
    });

    it("rejects occupied slot", async () => {
      const state = validState({
        "10:00": booking("10:00", "b-existing"),
      });
      const { actor, put } = makeActorWithPut(() => state);
      const result = await actor.createBooking(
        makeBookingInput({ time: "10:00" }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("slot_unavailable");
      expect(put).not.toHaveBeenCalled();
    });
  });

  describe("idempotent replay", () => {
    it("identical retry returns original booking_id, no write", async () => {
      let storedState: DayAgendaState | undefined;
      const put = vi.fn(async (_key: string, value: unknown) => {
        storedState = value as DayAgendaState;
      });
      const { actor: actor1 } = makeActorWithPut(() => undefined, put);
      const r1 = await actor1.createBooking(makeBookingInput());
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const originalId = r1.booking_id;

      const { actor: actor2, put: put2 } = makeActorWithPut(
        () => storedState,
      );
      const r2 = await actor2.createBooking(makeBookingInput());
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      expect(r2.booking_id).toBe(originalId);
      expect(put2).not.toHaveBeenCalled();
    });

    it("conflicting payload (different service_id) -> idempotency_key_conflict", async () => {
      let storedState: DayAgendaState | undefined;
      const put = vi.fn(async (_key: string, value: unknown) => {
        storedState = value as DayAgendaState;
      });
      const { actor: actor1 } = makeActorWithPut(() => undefined, put);
      await actor1.createBooking(makeBookingInput());

      const { actor: actor2, put: put2 } = makeActorWithPut(
        () => storedState,
      );
      const r2 = await actor2.createBooking(
        makeBookingInput({ service_id: "tire_rotation" }),
      );
      expect(r2.ok).toBe(false);
      if (r2.ok) return;
      expect(r2.code).toBe("idempotency_key_conflict");
      expect(put2).not.toHaveBeenCalled();
    });

    it("conflicting payload (different customer_name) -> conflict", async () => {
      let storedState: DayAgendaState | undefined;
      const put = vi.fn(async (_key: string, value: unknown) => {
        storedState = value as DayAgendaState;
      });
      const { actor: actor1 } = makeActorWithPut(() => undefined, put);
      await actor1.createBooking(makeBookingInput());

      const { actor: actor2 } = makeActorWithPut(
        () => storedState,
      );
      const r2 = await actor2.createBooking(
        makeBookingInput({ customer_name: "Different Person" }),
      );
      expect(r2.ok).toBe(false);
      if (r2.ok) return;
      expect(r2.code).toBe("idempotency_key_conflict");
    });

    it("conflicting payload (different confirmed value) -> conflict", async () => {
      let storedState: DayAgendaState | undefined;
      const put = vi.fn(async (_key: string, value: unknown) => {
        storedState = value as DayAgendaState;
      });
      const { actor: actor1 } = makeActorWithPut(() => undefined, put);
      await actor1.createBooking(makeBookingInput({ confirmed: true }));

      const { actor: actor2 } = makeActorWithPut(
        () => storedState,
      );
      const r2 = await actor2.createBooking(
        makeBookingInput({ confirmed: false }),
      );
      expect(r2.ok).toBe(false);
      if (r2.ok) return;
      expect(r2.code).toBe("idempotency_key_conflict");
    });

    it("replay after booking_enabled=false -> original success [C6]", async () => {
      let storedState: DayAgendaState | undefined;
      const put = vi.fn(async (_key: string, value: unknown) => {
        storedState = value as DayAgendaState;
      });
      const { actor: actor1 } = makeActorWithPut(() => undefined, put);
      const r1 = await actor1.createBooking(makeBookingInput());
      expect(r1.ok).toBe(true);

      const { actor: actor2, put: put2 } = makeActorWithPut(
        () => storedState,
      );
      const r2 = await actor2.createBooking(
        makeBookingInput({ config: DISABLED_CONFIG }),
      );
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      expect(r2.booking_id).toBe((r1 as { booking_id: string }).booking_id);
      expect(put2).not.toHaveBeenCalled();
    });

    it("replay after advancing clock past slot -> original success [C6]", async () => {
      let storedState: DayAgendaState | undefined;
      const put = vi.fn(async (_key: string, value: unknown) => {
        storedState = value as DayAgendaState;
      });
      const { actor: actor1 } = makeActorWithPut(() => undefined, put);
      const r1 = await actor1.createBooking(makeBookingInput());
      expect(r1.ok).toBe(true);

      // Advance clock to 2026-10-20 15:00 — slot 10:00 is now past.
      vi.setSystemTime(localEpochMS("2026-10-20", 15, 0));
      const { actor: actor2, put: put2 } = makeActorWithPut(
        () => storedState,
      );
      const r2 = await actor2.createBooking(makeBookingInput());
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      expect(r2.booking_id).toBe((r1 as { booking_id: string }).booking_id);
      expect(put2).not.toHaveBeenCalled();
    });

    it("replay after service removed from catalog -> original success [C6]", async () => {
      let storedState: DayAgendaState | undefined;
      const put = vi.fn(async (_key: string, value: unknown) => {
        storedState = value as DayAgendaState;
      });
      const { actor: actor1 } = makeActorWithPut(() => undefined, put);
      const r1 = await actor1.createBooking(
        makeBookingInput({ service_id: "general_maintenance" }),
      );
      expect(r1.ok).toBe(true);

      const revisedConfig: AppConfig = {
        ...VALID_CONFIG,
        services: VALID_CONFIG.services.filter(
          (s) => s.id !== "general_maintenance",
        ),
      };
      const { actor: actor2, put: put2 } = makeActorWithPut(
        () => storedState,
      );
      const r2 = await actor2.createBooking(
        makeBookingInput({
          service_id: "general_maintenance",
          config: revisedConfig,
        }),
      );
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      expect(r2.booking_id).toBe((r1 as { booking_id: string }).booking_id);
      expect(put2).not.toHaveBeenCalled();
    });
  });

  describe("new booking rejection — admission rules", () => {
    it("unknown_service when service_id not in catalog", async () => {
      const { actor, put } = makeActorWithPut(() => undefined);
      const result = await actor.createBooking(
        makeBookingInput({ service_id: "nonexistent" }),
      );
      expect(result).toEqual({ ok: false, code: "unknown_service" });
      expect(put).not.toHaveBeenCalled();
    });

    it("date_out_of_range when date is beyond window", async () => {
      const { actor } = makeActorWithPut(() => undefined);
      const result = await actor.createBooking(
        makeBookingInput({ date: "2026-11-15", time: "10:00" }),
      );
      expect(result).toEqual({ ok: false, code: "date_out_of_range" });
    });

    it("date_not_open for weekend", async () => {
      const { actor } = makeActorWithPut(() => undefined);
      const result = await actor.createBooking(
        makeBookingInput({ date: "2026-10-24" }),
      );
      expect(result).toEqual({ ok: false, code: "date_not_open" });
    });

    it("time_invalid for 09:30 (passes syntax, fails business hours)", async () => {
      const { actor } = makeActorWithPut(() => undefined);
      const result = await actor.createBooking(
        makeBookingInput({ time: "09:30" }),
      );
      expect(result).toEqual({ ok: false, code: "time_invalid" });
    });

    it("time_invalid for 17:00 (at end, not a valid start)", async () => {
      const { actor } = makeActorWithPut(() => undefined);
      const result = await actor.createBooking(
        makeBookingInput({ time: "17:00" }),
      );
      expect(result).toEqual({ ok: false, code: "time_invalid" });
    });

    it("time_invalid for 08:00 (before opening)", async () => {
      const { actor } = makeActorWithPut(() => undefined);
      const result = await actor.createBooking(
        makeBookingInput({ time: "08:00" }),
      );
      expect(result).toEqual({ ok: false, code: "time_invalid" });
    });

    it("confirmation_required when confirmed is false", async () => {
      const { actor } = makeActorWithPut(() => undefined);
      const result = await actor.createBooking(
        makeBookingInput({ confirmed: false }),
      );
      expect(result).toEqual({ ok: false, code: "confirmation_required" });
    });

    it("booking_disabled when booking_enabled is false", async () => {
      const { actor } = makeActorWithPut(() => undefined);
      const result = await actor.createBooking(
        makeBookingInput({ config: DISABLED_CONFIG }),
      );
      expect(result).toEqual({ ok: false, code: "booking_disabled" });
    });

    it("slot_in_past when clock is after the slot", async () => {
      vi.setSystemTime(localEpochMS("2026-10-20", 11, 0));
      const { actor } = makeActorWithPut(() => undefined);
      const result = await actor.createBooking(
        makeBookingInput({ time: "10:00" }),
      );
      expect(result).toEqual({ ok: false, code: "slot_in_past" });
    });
  });

  describe("clock advances during storage read (regression)", () => {
    it("slot that started by admission time is rejected", async () => {
      // Clock starts at 09:59 — slot 10:00 is still future at read time.
      vi.setSystemTime(localEpochMS("2026-10-20", 9, 59));
      const get = vi.fn(async () => {
        // Simulate delay: clock advances to 10:01 during storage read.
        vi.setSystemTime(localEpochMS("2026-10-20", 10, 1));
        return undefined;
      });
      const put = vi.fn(async () => {});
      const actor = new DayAgenda(
        { storage: { get, put } } as never,
        {} as never,
      );
      const result = await actor.createBooking(
        makeBookingInput({ time: "10:00" }),
      );
      // At admission time (10:01), slot 10:00 has started -> rejected.
      expect(result).toEqual({ ok: false, code: "slot_in_past" });
      expect(put).not.toHaveBeenCalled();
    });

    it("identical replay still succeeds despite clock advance", async () => {
      // First call at 08:00: create the booking.
      let storedState: DayAgendaState | undefined;
      const put = vi.fn(async (_key: string, value: unknown) => {
        storedState = value as DayAgendaState;
      });
      const { actor: actor1 } = makeActorWithPut(
        () => undefined,
        put,
      );
      const r1 = await actor1.createBooking(makeBookingInput({ time: "10:00" }));
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const originalId = r1.booking_id;

      // Replay at 15:00 (long past the slot): must return original.
      vi.setSystemTime(localEpochMS("2026-10-20", 15, 0));
      // Storage read also advances clock further — but replay bypasses admission.
      const getWithAdvance = vi.fn(async () => {
        vi.setSystemTime(localEpochMS("2026-10-20", 17, 0));
        return storedState;
      });
      const put2 = vi.fn(async () => {});
      const actor2 = new DayAgenda(
        { storage: { get: getWithAdvance, put: put2 } } as never,
        {} as never,
      );
      const r2 = await actor2.createBooking(makeBookingInput({ time: "10:00" }));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      expect(r2.booking_id).toBe(originalId);
      expect(put2).not.toHaveBeenCalled();
    });
  });

  describe("state validation during createBooking", () => {
    it("null stored state -> throws (not empty agenda)", async () => {
      const { actor } = makeActorWithPut(() => null);
      await expect(
        actor.createBooking(makeBookingInput()),
      ).rejects.toThrow();
    });

    it("malformed state (array) -> throws", async () => {
      const { actor } = makeActorWithPut(() => []);
      await expect(
        actor.createBooking(makeBookingInput()),
      ).rejects.toThrow();
    });

    it("agenda date mismatch with requested date -> throws", async () => {
      const wrongDateState = {
        date: "2026-10-21",
        bookings: {},
        idempotency: {},
      };
      const { actor } = makeActorWithPut(() => wrongDateState);
      await expect(
        actor.createBooking(makeBookingInput({ date: "2026-10-20" })),
      ).rejects.toThrow();
    });

    it("inconsistent idempotency entry (references non-existent booking) -> throws", async () => {
      const badState = {
        date: AGENDA_DATE,
        bookings: {},
        idempotency: {
          "attempt-001": {
            input_hash: "abc",
            booking_id: "b-001",
            booking_time: "10:00",
          },
        },
      };
      const { actor } = makeActorWithPut(() => badState);
      await expect(
        actor.createBooking(makeBookingInput()),
      ).rejects.toThrow();
    });

    it("inconsistent idempotency entry (booking_id mismatch) -> throws", async () => {
      const state = {
        date: AGENDA_DATE,
        bookings: {
          "10:00": booking("10:00", "b-actual"),
        },
        idempotency: {
          "attempt-001": {
            input_hash: "abc",
            booking_id: "b-wrong",
            booking_time: "10:00",
          },
        },
      };
      const { actor } = makeActorWithPut(() => state);
      await expect(
        actor.createBooking(makeBookingInput()),
      ).rejects.toThrow();
    });
  });

  describe("storage failures", () => {
    it("read failure -> throws (503)", async () => {
      const get = vi.fn(async () => {
        throw new Error("network");
      });
      const put = vi.fn(async () => {});
      const actor = new DayAgenda(
        { storage: { get, put } } as never,
        {} as never,
      );
      await expect(
        actor.createBooking(makeBookingInput()),
      ).rejects.toThrow();
    });

    it("write failure -> throws (503), loaded state untouched", async () => {
      const state = validState({ "10:00": booking("10:00", "b-001") });
      const get = vi.fn(async () => state);
      const put = vi.fn(async () => {
        throw new Error("write failed");
      });
      const actor = new DayAgenda(
        { storage: { get, put } } as never,
        {} as never,
      );
      await expect(
        actor.createBooking(makeBookingInput({ time: "11:00" })),
      ).rejects.toThrow();
      expect(state.bookings["10:00"]).toBeDefined();
      expect(state.bookings["11:00"]).toBeUndefined();
    });
  });

  describe("simulated write persisted but acknowledgement failed", () => {
    it("retry with same key returns original booking after partial write", async () => {
      let storedState: DayAgendaState | undefined;
      const putSucceeds = vi.fn(async (_key: string, value: unknown) => {
        storedState = value as DayAgendaState;
      });

      const { actor: actor1 } = makeActorWithPut(() => undefined, putSucceeds);
      const r1 = await actor1.createBooking(makeBookingInput());
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const originalId = r1.booking_id;

      const { actor: actor2, put: put2 } = makeActorWithPut(
        () => storedState,
      );
      const r2 = await actor2.createBooking(makeBookingInput());
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      expect(r2.booking_id).toBe(originalId);
      expect(put2).not.toHaveBeenCalled();
    });
  });

  describe("reserved-looking idempotency keys handled safely", () => {
    it("__proto__ as idempotency key does not access inherited properties", async () => {
      const { actor, put } = makeActorWithPut(() => undefined);
      const result = await actor.createBooking(
        makeBookingInput({ idempotency_key: "__proto__" }),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(put).toHaveBeenCalledTimes(1);
    });

    it("constructor as idempotency key is treated as a plain key", async () => {
      const { actor } = makeActorWithPut(() => undefined);
      const result = await actor.createBooking(
        makeBookingInput({ idempotency_key: "constructor" }),
      );
      expect(result.ok).toBe(true);
    });

    it("toString as idempotency key is treated as a plain key", async () => {
      const { actor } = makeActorWithPut(() => undefined);
      const result = await actor.createBooking(
        makeBookingInput({ idempotency_key: "toString" }),
      );
      expect(result.ok).toBe(true);
    });

    it("hasOwnProperty as idempotency key in stored state is safe", async () => {
      const fp = computeFingerprint({
        service_id: "oil_change",
        date: AGENDA_DATE,
        time: "10:00",
        customer_name: "test",
        customer_phone: "test",
        confirmed: true,
      });
      const state: DayAgendaState = {
        date: AGENDA_DATE,
        bookings: {
          "10:00": {
            id: "b-001",
            service_id: "oil_change",
            date: AGENDA_DATE,
            time: "10:00",
            customer_name: "test",
            customer_phone: "test",
            created_at: "2026-10-19T10:00:00Z",
            idempotency_key: "hasOwnProperty",
          },
        },
        idempotency: {
          hasOwnProperty: {
            input_hash: fp,
            booking_id: "b-001",
            booking_time: "10:00",
          },
        },
      };
      const { actor, put } = makeActorWithPut(() => state);
      const result = await actor.createBooking(
        makeBookingInput({
          idempotency_key: "hasOwnProperty",
          customer_name: "test",
          customer_phone: "test",
        }),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.booking_id).toBe("b-001");
      expect(put).not.toHaveBeenCalled();
    });
  });

  describe("no customer details in result", () => {
    it("success result does not contain customer_name or customer_phone", async () => {
      const { actor } = makeActorWithPut(() => undefined);
      const result = await actor.createBooking(makeBookingInput());
      expect(result.ok).toBe(true);
      const json = JSON.stringify(result);
      expect(json).not.toContain("Maria");
      expect(json).not.toContain("Lopez");
      expect(json).not.toContain("+52");
      expect(json).not.toContain("1234");
    });
  });
});
