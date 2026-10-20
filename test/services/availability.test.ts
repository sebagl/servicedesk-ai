import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

import handler from "../../src/index";
import {
  getAvailability,
  validateDateParam,
  type AvailabilityResult,
} from "../../src/services/availability";
import type { AppConfig } from "../../src/domain/config";

const VALID_TOKEN = "test-smoke-token-value";
const TIMEZONE = "America/Mexico_City";

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

const MON_OCT19 = "2026-10-19"; // Monday
const TUE_OCT20 = "2026-10-20"; // Tuesday
const SAT_OCT24 = "2026-10-24"; // Saturday (out of window by the time we reach 6 days)
const SUN_OCT25 = "2026-10-25"; // Sunday

// Calibrator using the timezone-aware API (no hardcoded offset).
function localEpochMS(date: string, hour: number, minute: number): number {
  const [y, m, d] = date.split("-").map(Number);
  const candidate = Date.UTC(y, m - 1, d, hour, minute, 0);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
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

// 2026-10-19 08:00 MX — Monday morning, before opening (all 8 slots future).
const NOW_MON_08 = localEpochMS(MON_OCT19, 8, 0);

type AgendaStub = {
  getOccupiedSlots: ReturnType<typeof vi.fn>;
};

function makeEnv(
  agenda: { idFromName: (name: string) => AgendaStub },
  secrets: { get: ReturnType<typeof vi.fn> },
  config: { get: ReturnType<typeof vi.fn> },
): unknown {
  return {
    AGENDA: agenda,
    SECRETS: secrets,
    CONFIG: config,
  };
}

function validSecrets() {
  return { get: vi.fn(async () => VALID_TOKEN) };
}

function validKv(config: AppConfig) {
  return { get: vi.fn(async () => config) };
}

function getAvailabilityReq(date: string, token = VALID_TOKEN): Request {
  return new Request(`http://x/demo/availability?date=${date}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

// ---------------------------------------------------------------------------
// validateDateParam
// ---------------------------------------------------------------------------

describe("validateDateParam", () => {
  it("extracts a single date parameter", () => {
    const sp = new URLSearchParams("date=" + TUE_OCT20);
    expect(validateDateParam(sp)).toBe(TUE_OCT20);
  });
  it("rejects missing date parameter", () => {
    const sp = new URLSearchParams("");
    const res = validateDateParam(sp);
    expect(res).toEqual({ kind: "date_missing" });
  });
  it("rejects duplicate date parameters", () => {
    const sp = new URLSearchParams("date=" + TUE_OCT20 + "&date=" + MON_OCT19);
    const res = validateDateParam(sp);
    expect(res).toEqual({ kind: "date_duplicate" });
  });
  it("rejects invalid date format", () => {
    const sp = new URLSearchParams("date=2026-13-40");
    const res = validateDateParam(sp);
    expect(res).toEqual({ kind: "date_invalid" });
  });
});

// ---------------------------------------------------------------------------
// getAvailability — service-level tests (injected dependencies, no HTTP)
// ---------------------------------------------------------------------------

describe("getAvailability service", () => {
  describe("future weekday with empty agenda → eight available slots", () => {
    it("returns 8 available slots for a future weekday", async () => {
      const stub = {
        getOccupiedSlots: vi.fn(async () => ({ occupied: [] })),
      };
      const agenda = {
        idFromName: vi.fn(() => stub),
      };
      const result = await getAvailability(
        TUE_OCT20,
        NOW_MON_08,
        VALID_CONFIG,
        agenda as never,
      );
      expect("kind" in result).toBe(false);
      expect((result as AvailabilityResult).slots).toHaveLength(8);
      (result as AvailabilityResult).slots.forEach((s) => {
        expect(s.available).toBe(true);
      });
    });

    it("addresses Actor as main-{date}", async () => {
      const stub = {
        getOccupiedSlots: vi.fn(async () => ({ occupied: [] })),
      };
      const idFromName = vi.fn(() => stub);
      const agenda = { idFromName };
      await getAvailability(TUE_OCT20, NOW_MON_08, VALID_CONFIG, agenda as never);
      expect(idFromName).toHaveBeenCalledWith(`main-${TUE_OCT20}`);
    });
  });

  describe("occupied slot → unavailable, others unchanged", () => {
    it("marks one occupied slot as available:false, others true", async () => {
      const stub = {
        getOccupiedSlots: vi.fn(async () => ({ occupied: ["10:00"] })),
      };
      const agenda = { idFromName: vi.fn(() => stub) };
      const result = await getAvailability(
        TUE_OCT20,
        NOW_MON_08,
        VALID_CONFIG,
        agenda as never,
      );
      const slots = (result as AvailabilityResult).slots;
      expect(slots).toHaveLength(8);
      const ten = slots.find((s) => s.time === "10:00");
      expect(ten!.available).toBe(false);
      const nine = slots.find((s) => s.time === "09:00");
      expect(nine!.available).toBe(true);
      const eleven = slots.find((s) => s.time === "11:00");
      expect(eleven!.available).toBe(true);
    });
  });

  describe("past times excluded; weekends return no slots", () => {
    it("today's elapsed slots are excluded (at 10:30: 09:00/10:00 past)", async () => {
      const now10_30 = localEpochMS(MON_OCT19, 10, 30);
      const stub = {
        getOccupiedSlots: vi.fn(async () => ({ occupied: [] })),
      };
      const agenda = { idFromName: vi.fn(() => stub) };
      const result = await getAvailability(
        MON_OCT19,
        now10_30,
        VALID_CONFIG,
        agenda as never,
      );
      const slots = (result as AvailabilityResult).slots;
      expect(slots).toHaveLength(6); // 11:00–16:00
      expect(slots[0]!.time).toBe("11:00");
    });

    it("Saturday returns slots:[] (no candidate slots)", async () => {
      const stub = {
        getOccupiedSlots: vi.fn(async () => ({ occupied: [] })),
      };
      const agenda = { idFromName: vi.fn(() => stub) };
      const result = await getAvailability(
        SAT_OCT24,
        NOW_MON_08,
        VALID_CONFIG,
        agenda as never,
      );
      expect((result as AvailabilityResult).slots).toEqual([]);
      // Actor not called for weekends — no candidates to check occupancy.
      expect(stub.getOccupiedSlots).not.toHaveBeenCalled();
    });

    it("Sunday returns slots:[] (no candidate slots)", async () => {
      const stub = {
        getOccupiedSlots: vi.fn(async () => ({ occupied: [] })),
      };
      const agenda = { idFromName: vi.fn(() => stub) };
      const result = await getAvailability(
        SUN_OCT25,
        NOW_MON_08,
        VALID_CONFIG,
        agenda as never,
      );
      expect((result as AvailabilityResult).slots).toEqual([]);
    });
  });

  describe("date out of window → date_out_of_range", () => {
    it("rejects today+7 as out of window", async () => {
      const result = await getAvailability(
        "2026-10-26", // day 7 from Oct 19
        NOW_MON_08,
        VALID_CONFIG,
        { idFromName: vi.fn() } as never,
      );
      expect(result).toEqual({ kind: "date_out_of_range" });
    });
    it("rejects yesterday as out of window", async () => {
      const result = await getAvailability(
        "2026-10-18",
        NOW_MON_08,
        VALID_CONFIG,
        { idFromName: vi.fn() } as never,
      );
      expect(result).toEqual({ kind: "date_out_of_range" });
    });
  });

  describe("booking_enabled=false remains visible", () => {
    it("includes booking_enabled:false in response even when slots are available", async () => {
      const stub = {
        getOccupiedSlots: vi.fn(async () => ({ occupied: [] })),
      };
      const agenda = { idFromName: vi.fn(() => stub) };
      const result = await getAvailability(
        TUE_OCT20,
        NOW_MON_08,
        DISABLED_CONFIG,
        agenda as never,
      );
      expect((result as AvailabilityResult).booking_enabled).toBe(false);
      expect((result as AvailabilityResult).slots).toHaveLength(8);
    });
  });

  describe("Actor errors / malformed response → 503", () => {
    it("rejected Actor call returns service_unavailable", async () => {
      const stub = {
        getOccupiedSlots: vi.fn(async () => {
          throw new Error("actor error");
        }),
      };
      const agenda = { idFromName: vi.fn(() => stub) };
      const result = await getAvailability(
        TUE_OCT20,
        NOW_MON_08,
        VALID_CONFIG,
        agenda as never,
      );
      expect(result).toEqual({ kind: "service_unavailable" });
    });

    it("malformed Actor response (occupied not array) returns service_unavailable", async () => {
      const stub = {
        getOccupiedSlots: vi.fn(async () => ({ occupied: "not-an-array" })),
      };
      const agenda = { idFromName: vi.fn(() => stub) };
      const result = await getAvailability(
        TUE_OCT20,
        NOW_MON_08,
        VALID_CONFIG,
        agenda as never,
      );
      expect(result).toEqual({ kind: "service_unavailable" });
    });

    it("malformed Actor response (non-string entries) returns service_unavailable", async () => {
      const stub = {
        getOccupiedSlots: vi.fn(async () => ({ occupied: [42] })),
      };
      const agenda = { idFromName: vi.fn(() => stub) };
      const result = await getAvailability(
        TUE_OCT20,
        NOW_MON_08,
        VALID_CONFIG,
        agenda as never,
      );
      expect(result).toEqual({ kind: "service_unavailable" });
    });

    it("malformed Actor response (syntactic but non-canonical time '10:0') returns service_unavailable", async () => {
      const stub = {
        getOccupiedSlots: vi.fn(async () => ({ occupied: ["10:0"] })),
      };
      const agenda = { idFromName: vi.fn(() => stub) };
      const result = await getAvailability(
        TUE_OCT20,
        NOW_MON_08,
        VALID_CONFIG,
        agenda as never,
      );
      expect(result).toEqual({ kind: "service_unavailable" });
    });

    it("malformed Actor response (non-time string 'not-a-time') returns service_unavailable", async () => {
      const stub = {
        getOccupiedSlots: vi.fn(async () => ({ occupied: ["not-a-time"] })),
      };
      const agenda = { idFromName: vi.fn(() => stub) };
      const result = await getAvailability(
        TUE_OCT20,
        NOW_MON_08,
        VALID_CONFIG,
        agenda as never,
      );
      expect(result).toEqual({ kind: "service_unavailable" });
    });

    it("malformed Actor response (duplicate slot values) returns service_unavailable", async () => {
      const stub = {
        getOccupiedSlots: vi.fn(async () => ({ occupied: ["10:00", "10:00"] })),
      };
      const agenda = { idFromName: vi.fn(() => stub) };
      const result = await getAvailability(
        TUE_OCT20,
        NOW_MON_08,
        VALID_CONFIG,
        agenda as never,
      );
      expect(result).toEqual({ kind: "service_unavailable" });
    });

    it("valid empty Actor response still returns 8 available slots", async () => {
      const stub = {
        getOccupiedSlots: vi.fn(async () => ({ occupied: [] })),
      };
      const agenda = { idFromName: vi.fn(() => stub) };
      const result = await getAvailability(
        TUE_OCT20,
        NOW_MON_08,
        VALID_CONFIG,
        agenda as never,
      );
      const slots = (result as AvailabilityResult).slots;
      expect(slots).toHaveLength(8);
      slots.forEach((s) => expect(s.available).toBe(true));
    });

    it("valid populated Actor response still marks occupied slot unavailable", async () => {
      const stub = {
        getOccupiedSlots: vi.fn(async () => ({ occupied: ["09:00", "13:00", "16:00"] })),
      };
      const agenda = { idFromName: vi.fn(() => stub) };
      const result = await getAvailability(
        TUE_OCT20,
        NOW_MON_08,
        VALID_CONFIG,
        agenda as never,
      );
      const slots = (result as AvailabilityResult).slots;
      const nine = slots.find((s) => s.time === "09:00");
      const one = slots.find((s) => s.time === "13:00");
      const four = slots.find((s) => s.time === "16:00");
      expect(nine!.available).toBe(false);
      expect(one!.available).toBe(false);
      expect(four!.available).toBe(false);
    });
  });

  describe("timezone and location labels present", () => {
    it("returns location_id, timezone, date, booking_enabled in response", async () => {
      const stub = {
        getOccupiedSlots: vi.fn(async () => ({ occupied: [] })),
      };
      const agenda = { idFromName: vi.fn(() => stub) };
      const result = await getAvailability(
        TUE_OCT20,
        NOW_MON_08,
        VALID_CONFIG,
        agenda as never,
      );
      const r = result as AvailabilityResult;
      expect(r.location_id).toBe("main");
      expect(r.timezone).toBe("America/Mexico_City");
      expect(r.date).toBe(TUE_OCT20);
      expect(typeof r.booking_enabled).toBe("boolean");
    });
  });
});

// ---------------------------------------------------------------------------
// HTTP route: GET /demo/availability
// ---------------------------------------------------------------------------

describe("GET /demo/availability (HTTP route)", () => {
  // The route reads Date.now(); pin it to Monday 2026-10-19 08:00 local so the
  // expected slots do not depend on the day the suite runs.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_MON_08);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("unauthorized — no KV/Actor access", () => {
    it("401 without bearer, Actor not called", async () => {
      const agendaIdFromName = vi.fn(() => ({
        getOccupiedSlots: vi.fn(),
      }));
      const agenda = { idFromName: agendaIdFromName };
      const env = makeEnv(
        agenda,
        validSecrets(),
        validKv(VALID_CONFIG),
      );
      const res = await handler.fetch(
        new Request("http://x/demo/availability?date=" + TUE_OCT20),
        env as never,
      );
      expect(res.status).toBe(401);
      expect(agendaIdFromName).not.toHaveBeenCalled();
    });

    it("503 when secrets binding absent (before Actor/KV)", async () => {
      const agenda = { idFromName: vi.fn(() => ({ getOccupiedSlots: vi.fn() })) };
      const kv = validKv(VALID_CONFIG);
      const env = makeEnv(agenda, { get: vi.fn(async () => "") }, kv);
      const res = await handler.fetch(
        getAvailabilityReq(TUE_OCT20),
        env as never,
      );
      expect(res.status).toBe(503);
    });
  });

  describe("valid authenticated requests", () => {
    function makeFullEnv(
      occupied: string[],
      config: AppConfig = VALID_CONFIG,
    ): {
      env: unknown;
      agendaIdFromName: ReturnType<typeof vi.fn>;
    } {
      const agendaIdFromName = vi.fn(() => ({
        getOccupiedSlots: vi.fn(async () => ({ occupied })),
      }));
      const agenda = { idFromName: agendaIdFromName };
      const env = makeEnv(agenda, validSecrets(), validKv(config));
      return { env, agendaIdFromName };
    }

    it("future weekday, empty agenda → 200 with 8 available slots", async () => {
      const { env } = makeFullEnv([]);
      const res = await handler.fetch(
        getAvailabilityReq(TUE_OCT20),
        env as never,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.slots).toHaveLength(8);
      expect(body.slots[0]).toEqual({ time: "09:00", available: true });
      expect(body.slots[7]).toEqual({ time: "16:00", available: true });
      expect(body.location_id).toBe("main");
      expect(body.timezone).toBe("America/Mexico_City");
      expect(body.date).toBe(TUE_OCT20);
      expect(body.booking_enabled).toBe(true);
    });

    it("occupied slot → unavailable in response", async () => {
      const { env } = makeFullEnv(["13:00"]);
      const res = await handler.fetch(
        getAvailabilityReq(TUE_OCT20),
        env as never,
      );
      const body = await res.json();
      const onePm = body.slots.find((s: { time: string }) => s.time === "13:00");
      expect(onePm.available).toBe(false);
      const nineAm = body.slots.find((s: { time: string }) => s.time === "09:00");
      expect(nineAm.available).toBe(true);
    });

    it("booking_enabled=false visible even with available slots", async () => {
      const { env } = makeFullEnv([], DISABLED_CONFIG);
      const res = await handler.fetch(
        getAvailabilityReq(TUE_OCT20),
        env as never,
      );
      const body = await res.json();
      expect(body.booking_enabled).toBe(false);
      expect(body.slots).toHaveLength(8);
    });

    it("addresses Actor as main-{date}", async () => {
      const { env, agendaIdFromName } = makeFullEnv([]);
      await handler.fetch(
        getAvailabilityReq(TUE_OCT20),
        env as never,
      );
      expect(agendaIdFromName).toHaveBeenCalledWith(`main-${TUE_OCT20}`);
    });
  });

  describe("error responses", () => {
    it("400 for missing date parameter", async () => {
      const env = makeEnv(
        { idFromName: vi.fn(() => ({ getOccupiedSlots: vi.fn() })) },
        validSecrets(),
        validKv(VALID_CONFIG),
      );
      const res = await handler.fetch(
        new Request("http://x/demo/availability", {
          headers: { authorization: `Bearer ${VALID_TOKEN}` },
        }),
        env as never,
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "date_missing" });
    });

    it("400 for duplicate date parameter", async () => {
      const env = makeEnv(
        { idFromName: vi.fn(() => ({ getOccupiedSlots: vi.fn() })) },
        validSecrets(),
        validKv(VALID_CONFIG),
      );
      const res = await handler.fetch(
        new Request(
          `http://x/demo/availability?date=${TUE_OCT20}&date=${MON_OCT19}`,
          {
            headers: { authorization: `Bearer ${VALID_TOKEN}` },
          },
        ),
        env as never,
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "date_duplicate" });
    });

    it("400 for invalid date", async () => {
      const env = makeEnv(
        { idFromName: vi.fn(() => ({ getOccupiedSlots: vi.fn() })) },
        validSecrets(),
        validKv(VALID_CONFIG),
      );
      const res = await handler.fetch(
        getAvailabilityReq("2026-02-30"),
        env as never,
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "date_invalid" });
    });

    it("400 for out-of-window date", async () => {
      const env = makeEnv(
        { idFromName: vi.fn(() => ({ getOccupiedSlots: vi.fn() })) },
        validSecrets(),
        validKv(VALID_CONFIG),
      );
      // Use a far-future date that is always out of the 7-day window
      // regardless of real wall-clock time.
      const res = await handler.fetch(
        getAvailabilityReq("2030-01-01"),
        env as never,
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "date_out_of_range" });
    });

    it("503 for missing AGENDA binding", async () => {
      const env = {
        SECRETS: validSecrets(),
        CONFIG: validKv(VALID_CONFIG),
      };
      const res = await handler.fetch(
        getAvailabilityReq(TUE_OCT20),
        env as never,
      );
      expect(res.status).toBe(503);
    });

    it("503 for missing CONFIG binding", async () => {
      const env = {
        AGENDA: { idFromName: vi.fn(() => ({ getOccupiedSlots: vi.fn() })) },
        SECRETS: validSecrets(),
      };
      const res = await handler.fetch(
        getAvailabilityReq(TUE_OCT20),
        env as never,
      );
      expect(res.status).toBe(503);
    });

    it("503 for invalid config (KV returns null)", async () => {
      const env = makeEnv(
        { idFromName: vi.fn(() => ({ getOccupiedSlots: vi.fn() })) },
        validSecrets(),
        { get: vi.fn(async () => null) },
      );
      const res = await handler.fetch(
        getAvailabilityReq(TUE_OCT20),
        env as never,
      );
      expect(res.status).toBe(503);
    });

    it("503 for rejected Actor call", async () => {
      const stub = {
        getOccupiedSlots: vi.fn(async () => {
          throw new Error("oops");
        }),
      };
      const env = makeEnv(
        { idFromName: vi.fn(() => stub) },
        validSecrets(),
        validKv(VALID_CONFIG),
      );
      const res = await handler.fetch(
        getAvailabilityReq(TUE_OCT20),
        env as never,
      );
      expect(res.status).toBe(503);
    });

    it("503 for malformed Actor response", async () => {
      const stub = {
        getOccupiedSlots: vi.fn(async () => ({ occupied: "not-array" })),
      };
      const env = makeEnv(
        { idFromName: vi.fn(() => stub) },
        validSecrets(),
        validKv(VALID_CONFIG),
      );
      const res = await handler.fetch(
        getAvailabilityReq(TUE_OCT20),
        env as never,
      );
      expect(res.status).toBe(503);
    });
  });
});
