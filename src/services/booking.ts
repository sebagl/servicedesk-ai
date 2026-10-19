import { agendaActorName } from "../domain/business-rules";
import type { AppConfig } from "../domain/config";
import type { CreateBookingInput, CreateBookingResult } from "../actors/day-agenda";

// ---------------------------------------------------------------------------
// Booking application service — transport-independent.
// Loads trusted config, routes to the per-day Actor, validates the Actor
// response shape, and returns a typed outcome. No Request, no Response, no
// HTTP status codes, no concrete Telnyx SDK types. Admission rules, replay-
// first logic, clock, and persistence remain in DayAgenda.
// ---------------------------------------------------------------------------

export interface BookingRequest {
  service_id: string;
  date: string;
  time: string;
  customer_name: string;
  customer_phone: string;
  idempotency_key: string;
  confirmed: boolean;
}

export interface BookingAgendaLike {
  createBooking(input: CreateBookingInput): Promise<CreateBookingResult>;
}

export interface BookingServiceDeps {
  // null = config load failed (KV missing, malformed, or read error).
  loadConfig(): Promise<AppConfig | null>;
  // Resolves an Actor by name. May throw — caller maps to infrastructure_error.
  getAgenda(name: string): BookingAgendaLike;
}

// Domain rejection codes emitted by DayAgenda.createBooking. Anything not in
// this set is treated as infrastructure corruption and surfaced as 503.
export type BookingDomainError =
  | "unknown_service"
  | "date_out_of_range"
  | "date_not_open"
  | "time_invalid"
  | "confirmation_required"
  | "booking_disabled"
  | "slot_in_past"
  | "slot_unavailable"
  | "idempotency_key_conflict";

const KNOWN_DOMAIN_ERRORS: ReadonlySet<string> = new Set<BookingDomainError>([
  "unknown_service",
  "date_out_of_range",
  "date_not_open",
  "time_invalid",
  "confirmation_required",
  "booking_disabled",
  "slot_in_past",
  "slot_unavailable",
  "idempotency_key_conflict",
]);

export type BookingServiceResult =
  | {
      kind: "confirmed";
      booking_id: string;
      service_id: string;
      date: string;
      time: string;
    }
  | { kind: "rejected"; code: BookingDomainError }
  | { kind: "infrastructure_error" };

export async function createBooking(
  req: BookingRequest,
  deps: BookingServiceDeps,
): Promise<BookingServiceResult> {
  let config: AppConfig | null;
  try {
    config = await deps.loadConfig();
  } catch {
    return { kind: "infrastructure_error" };
  }
  if (config === null) {
    return { kind: "infrastructure_error" };
  }

  const actorName = agendaActorName(config.business.location_id, req.date);
  let actorResult: CreateBookingResult;
  try {
    const stub = deps.getAgenda(actorName);
    actorResult = await stub.createBooking({
      service_id: req.service_id,
      date: req.date,
      time: req.time,
      customer_name: req.customer_name,
      customer_phone: req.customer_phone,
      idempotency_key: req.idempotency_key,
      confirmed: req.confirmed,
      config,
    });
  } catch {
    return { kind: "infrastructure_error" };
  }

  if (
    typeof actorResult !== "object" ||
    actorResult === null ||
    Array.isArray(actorResult) ||
    typeof actorResult.ok !== "boolean"
  ) {
    return { kind: "infrastructure_error" };
  }

  if (actorResult.ok) {
    const r = actorResult as {
      booking_id: unknown;
      service_id: unknown;
      date: unknown;
      time: unknown;
      status: unknown;
    };
    // Echoed fields must round-trip exactly with the request: a mismatch would
    // mean the Actor is acting on a different booking than we asked for, so we
    // fail closed rather than surface a fabricated success.
    if (
      typeof r.booking_id !== "string" ||
      r.booking_id.trim().length === 0 ||
      typeof r.service_id !== "string" ||
      r.service_id !== req.service_id ||
      typeof r.date !== "string" ||
      r.date !== req.date ||
      typeof r.time !== "string" ||
      r.time !== req.time ||
      r.status !== "confirmed"
    ) {
      return { kind: "infrastructure_error" };
    }
    return {
      kind: "confirmed",
      booking_id: r.booking_id,
      service_id: r.service_id,
      date: r.date,
      time: r.time,
    };
  }

  const code = (actorResult as { code?: unknown }).code;
  if (typeof code !== "string" || code.length === 0) {
    return { kind: "infrastructure_error" };
  }
  if (!KNOWN_DOMAIN_ERRORS.has(code)) {
    return { kind: "infrastructure_error" };
  }
  return { kind: "rejected", code: code as BookingDomainError };
}
