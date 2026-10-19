import type { AppConfig, BusinessConfig } from "../domain/config";
import type { DayAgenda } from "../actors/day-agenda";
import type { ActorNamespace, ActorStub } from "@telnyx/edge-runtime";
import { generateDaySlots, isValidDate, isDateInWindow } from "../domain/scheduling";
import { agendaActorName, SLOT_START_TIMES } from "../domain/business-rules";

// Canonical, supported slot start times — shared with the Actor's persisted
// state validator. Any value outside this set (or any duplicate) is rejected
// as a malformed occupancy response, not silently dropped.
const VALID_SLOT_STARTS: ReadonlySet<string> = new Set(SLOT_START_TIMES);

export interface AvailabilitySlot {
  time: string;
  available: boolean;
}

export interface AvailabilityResult {
  location_id: string;
  date: string;
  timezone: string;
  booking_enabled: boolean;
  slots: AvailabilitySlot[];
}

export type AvailabilityError =
  | { kind: "date_missing" }
  | { kind: "date_duplicate" }
  | { kind: "date_invalid" }
  | { kind: "date_out_of_range" }
  | { kind: "service_unavailable" };

type AgendaStub = ActorStub & Pick<DayAgenda, "getOccupiedSlots">;
export interface AgendaNamespace extends ActorNamespace {
  idFromName(name: string): AgendaStub;
}

// Extracts and validates exactly one `date` query parameter.
export function validateDateParam(
  searchParams: URLSearchParams,
): string | AvailabilityError {
  const dates = searchParams.getAll("date");
  if (dates.length === 0) return { kind: "date_missing" };
  if (dates.length > 1) return { kind: "date_duplicate" };
  const date = dates[0]!;
  if (!isValidDate(date)) return { kind: "date_invalid" };
  return date;
}

// Computes availability for one date by combining scheduling candidates
// with Actor-read occupied slots. All dependencies are injected.
export async function getAvailability(
  date: string,
  now: number,
  config: AppConfig,
  agenda: AgendaNamespace,
): Promise<AvailabilityResult | AvailabilityError> {
  const business: BusinessConfig = config.business;

  if (!isDateInWindow(date, now, business))
    return { kind: "date_out_of_range" };

  // Generate candidate slots using existing scheduling rules.
  const candidateTimes = generateDaySlots(date, now, business);

  // If no candidates (weekend, past day, all past times), return empty slots.
  if (candidateTimes.length === 0) {
    return {
      location_id: business.location_id,
      date,
      timezone: business.timezone,
      booking_enabled: business.booking_enabled,
      slots: [],
    };
  }

  // Address the Actor via the shared naming convention.
  const actorName = agendaActorName(business.location_id, date);
  let occupied: string[];
  try {
    const stub = agenda.idFromName(actorName);
    const result = await stub.getOccupiedSlots();
    occupied = result.occupied;
  } catch {
    return { kind: "service_unavailable" };
  }

  // Validate Actor response shape at runtime. Each entry must be a string,
  // a canonical slot start time (per the shared business-rules), and there
  // must be no duplicates. Invalid values indicate a corrupted Actor
  // response — fail closed as service_unavailable rather than silently
  // discarding entries (which would over-report availability).
  if (!Array.isArray(occupied)) {
    return { kind: "service_unavailable" };
  }
  const occupiedSet = new Set<string>();
  for (const t of occupied) {
    if (typeof t !== "string" || !VALID_SLOT_STARTS.has(t)) {
      return { kind: "service_unavailable" };
    }
    if (occupiedSet.has(t)) {
      return { kind: "service_unavailable" };
    }
    occupiedSet.add(t);
  }

  const slots: AvailabilitySlot[] = candidateTimes.map((time) => ({
    time,
    available: !occupiedSet.has(time),
  }));

  return {
    location_id: business.location_id,
    date,
    timezone: business.timezone,
    booking_enabled: business.booking_enabled,
    slots,
  };
}
