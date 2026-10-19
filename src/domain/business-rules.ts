// Single source of truth for the demo business rules and actor naming.
// All other modules import from here; no inline literals elsewhere.

export const LOCATION_ID = "main";
export const TIMEZONE = "America/Mexico_City";
export const SLOT_HOURS = {
  start: "09:00",
  end: "17:00",
  last_start: "16:00",
} as const;
export const SLOT_DURATION_MINUTES = 60;
export const BOOKING_WINDOW_DAYS = 7;

const START_HOUR = Number(SLOT_HOURS.start.split(":")[0]);
const LAST_START_HOUR = Number(SLOT_HOURS.last_start.split(":")[0]);

export const SLOT_START_TIMES: readonly string[] = Array.from(
  { length: LAST_START_HOUR - START_HOUR + 1 },
  (_, i) => `${String(START_HOUR + i).padStart(2, "0")}:00`,
);

export function agendaActorName(locationId: string, date: string): string {
  return `${locationId}-${date}`;
}

export function callbacksActorName(date: string): string {
  return `callbacks-${date}`;
}
