import { describe, it, expect, vi } from "vitest";

import {
  createBooking,
  type BookingRequest,
  type BookingAgendaLike,
  type BookingServiceDeps,
  type BookingDomainError,
} from "../src/booking-service";
import type { AppConfig } from "../src/config";
import type { CreateBookingResult } from "../src/agenda-actor";

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

const VALID_REQUEST: BookingRequest = {
  service_id: "oil_change",
  date: "2026-10-20",
  time: "10:00",
  customer_name: "Maria Lopez",
  customer_phone: "+52 55 1234 5678",
  idempotency_key: "attempt-001",
  confirmed: true,
};

const CONFIRMED_RESULT: CreateBookingResult = {
  ok: true,
  booking_id: "b-0001-uuid",
  service_id: "oil_change",
  date: "2026-10-20",
  time: "10:00",
  status: "confirmed",
};

function makeDeps(overrides: Partial<BookingServiceDeps> = {}): {
  deps: BookingServiceDeps;
  loadConfig: ReturnType<typeof vi.fn>;
  getAgenda: ReturnType<typeof vi.fn>;
  stub: BookingAgendaLike;
} {
  const stub: BookingAgendaLike = {
    createBooking: vi.fn(async () => CONFIRMED_RESULT),
  };
  const loadConfig = vi.fn(async () => VALID_CONFIG);
  const getAgenda = vi.fn(() => stub);
  return {
    deps: {
      loadConfig: overrides.loadConfig ?? loadConfig,
      getAgenda: overrides.getAgenda ?? getAgenda,
    },
    loadConfig,
    getAgenda,
    stub,
  };
}

describe("createBooking service", () => {
  describe("config loading", () => {
    it("returns infrastructure_error when loadConfig returns null", async () => {
      const { deps } = makeDeps({ loadConfig: async () => null });
      const result = await createBooking(VALID_REQUEST, deps);
      expect(result).toEqual({ kind: "infrastructure_error" });
    });

    it("does not reach the agenda when config load fails", async () => {
      const { deps, getAgenda } = makeDeps({ loadConfig: async () => null });
      await createBooking(VALID_REQUEST, deps);
      expect(getAgenda).not.toHaveBeenCalled();
    });

    it("regression: rejecting config loader returns infrastructure_error without reaching agenda", async () => {
      const { deps, getAgenda } = makeDeps({
        loadConfig: async () => {
          throw new Error("kv read failed");
        },
      });
      const result = await createBooking(VALID_REQUEST, deps);
      expect(result).toEqual({ kind: "infrastructure_error" });
      expect(getAgenda).not.toHaveBeenCalled();
    });
  });

  describe("actor routing", () => {
    it("addresses the agenda using the configured location_id and request date", async () => {
      const { deps, getAgenda } = makeDeps();
      await createBooking(
        { ...VALID_REQUEST, date: "2026-10-21" },
        deps,
      );
      expect(getAgenda).toHaveBeenCalledWith("main-2026-10-21");
    });

    it("uses location_id from the loaded config, not a hardcoded one", async () => {
      const customConfig: AppConfig = {
        ...VALID_CONFIG,
        business: { ...VALID_CONFIG.business, location_id: "branch-east" },
      };
      const { deps, getAgenda } = makeDeps({ loadConfig: async () => customConfig });
      await createBooking(VALID_REQUEST, deps);
      expect(getAgenda).toHaveBeenCalledWith("branch-east-2026-10-20");
    });

    it("passes request fields plus trusted config to createBooking", async () => {
      // Trimming is the HTTP adapter's job; the service passes through what
      // the validated BookingRequest contains.
      const { deps, stub } = makeDeps();
      await createBooking(VALID_REQUEST, deps);
      expect(stub.createBooking).toHaveBeenCalledWith({
        service_id: "oil_change",
        date: "2026-10-20",
        time: "10:00",
        customer_name: "Maria Lopez",
        customer_phone: "+52 55 1234 5678",
        idempotency_key: "attempt-001",
        confirmed: true,
        config: VALID_CONFIG,
      });
    });

    it("does not inject a timestamp into the actor input", async () => {
      const { deps, stub } = makeDeps();
      await createBooking(VALID_REQUEST, deps);
      const input = (stub.createBooking as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as Record<string, unknown>;
      expect("now" in input).toBe(false);
    });
  });

  describe("confirmed outcomes", () => {
    it("maps actor success to kind 'confirmed' with the actor's booking fields", async () => {
      const { deps } = makeDeps({
        getAgenda: () => ({
          createBooking: async () => CONFIRMED_RESULT,
        }),
      });
      const result = await createBooking(VALID_REQUEST, deps);
      expect(result).toEqual({
        kind: "confirmed",
        booking_id: "b-0001-uuid",
        service_id: "oil_change",
        date: "2026-10-20",
        time: "10:00",
      });
    });
  });

  describe("rejected (domain) outcomes", () => {
    const domainCodes: BookingDomainError[] = [
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
      it(`maps known domain code "${code}" to kind 'rejected'`, async () => {
        const { deps } = makeDeps({
          getAgenda: () => ({
            createBooking: async () => ({ ok: false, code }),
          }),
        });
        const result = await createBooking(VALID_REQUEST, deps);
        expect(result).toEqual({ kind: "rejected", code });
      });
    }
  });

  describe("infrastructure_error mapping", () => {
    it("actor throws → infrastructure_error", async () => {
      const { deps } = makeDeps({
        getAgenda: () => ({
          createBooking: async () => {
            throw new Error("actor crashed");
          },
        }),
      });
      const result = await createBooking(VALID_REQUEST, deps);
      expect(result).toEqual({ kind: "infrastructure_error" });
    });

    it("actor response is not an object → infrastructure_error", async () => {
      const { deps } = makeDeps({
        getAgenda: () => ({
          createBooking: async () => "not-an-object" as unknown as CreateBookingResult,
        }),
      });
      const result = await createBooking(VALID_REQUEST, deps);
      expect(result).toEqual({ kind: "infrastructure_error" });
    });

    it("actor response missing 'ok' → infrastructure_error", async () => {
      const { deps } = makeDeps({
        getAgenda: () => ({
          createBooking: async () => ({}) as unknown as CreateBookingResult,
        }),
      });
      const result = await createBooking(VALID_REQUEST, deps);
      expect(result).toEqual({ kind: "infrastructure_error" });
    });

    it("success response with wrong status → infrastructure_error", async () => {
      const { deps } = makeDeps({
        getAgenda: () => ({
          createBooking: async () =>
            ({
              ok: true,
              booking_id: "b-1",
              service_id: "oil_change",
              date: "2026-10-20",
              time: "10:00",
              status: "pending",
            }) as unknown as CreateBookingResult,
        }),
      });
      const result = await createBooking(VALID_REQUEST, deps);
      expect(result).toEqual({ kind: "infrastructure_error" });
    });

    it("success response with non-string booking_id → infrastructure_error", async () => {
      const { deps } = makeDeps({
        getAgenda: () => ({
          createBooking: async () =>
            ({
              ok: true,
              booking_id: 42,
              service_id: "oil_change",
              date: "2026-10-20",
              time: "10:00",
              status: "confirmed",
            }) as unknown as CreateBookingResult,
        }),
      });
      const result = await createBooking(VALID_REQUEST, deps);
      expect(result).toEqual({ kind: "infrastructure_error" });
    });

    it("rejected response with unknown code → infrastructure_error", async () => {
      const { deps } = makeDeps({
        getAgenda: () => ({
          createBooking: async () => ({ ok: false, code: "mystery_failure" }),
        }),
      });
      const result = await createBooking(VALID_REQUEST, deps);
      expect(result).toEqual({ kind: "infrastructure_error" });
    });

    it("rejected response with empty code → infrastructure_error", async () => {
      const { deps } = makeDeps({
        getAgenda: () => ({
          createBooking: async () => ({ ok: false, code: "" }),
        }),
      });
      const result = await createBooking(VALID_REQUEST, deps);
      expect(result).toEqual({ kind: "infrastructure_error" });
    });
  });
});
