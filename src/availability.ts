import type { AppConfig, BusinessConfig } from "./config";
import type { DayAgenda } from "./agenda-actor";
import type { ActorNamespace, ActorStub } from "@telnyx/edge-runtime";
import { generateDaySlots, isValidDate, isDateInWindow } from "./scheduling";

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
interface AgendaNamespace extends ActorNamespace {
  idFromName(name: string): AgendaStub;
}

const LOCATION_ID = "main";
const TIMEZONE = "America/Mexico_City";

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
      location_id: LOCATION_ID,
      date,
      timezone: TIMEZONE,
      booking_enabled: business.booking_enabled,
      slots: [],
    };
  }

  // Address the Actor as main-{YYYY-MM-DD}.
  const actorName = `${LOCATION_ID}-${date}`;
  let occupied: string[];
  try {
    const stub = agenda.idFromName(actorName);
    const result = await stub.getOccupiedSlots();
    occupied = result.occupied;
  } catch {
    return { kind: "service_unavailable" };
  }

  // Validate Actor response shape at runtime.
  if (
    !Array.isArray(occupied) ||
    !occupied.every((t) => typeof t === "string")
  ) {
    return { kind: "service_unavailable" };
  }

  const occupiedSet = new Set(occupied);

  const slots: AvailabilitySlot[] = candidateTimes.map((time) => ({
    time,
    available: !occupiedSet.has(time),
  }));

  return {
    location_id: LOCATION_ID,
    date,
    timezone: TIMEZONE,
    booking_enabled: business.booking_enabled,
    slots,
  };
}
