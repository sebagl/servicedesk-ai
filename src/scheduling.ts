import type { BusinessConfig } from "./config";

const TZ = "America/Mexico_City";

// ---------------------------------------------------------------------------
// Date format/calendar validation — pure, no timezone, no I/O
// ---------------------------------------------------------------------------

export function isValidDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [y, m, d] = date.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

// ---------------------------------------------------------------------------
// Slot-time derivation from config — pure
// ---------------------------------------------------------------------------

export function getSlotTimes(config: BusinessConfig): string[] {
  const start = Number(config.slot_hours.start.split(":")[0]);
  const last = Number(config.slot_hours.last_start.split(":")[0]);
  const times: string[] = [];
  for (let h = start; h <= last; h++) {
    times.push(`${String(h).padStart(2, "0")}:00`);
  }
  return times;
}

export function isValidTimeFormat(time: string): boolean {
  if (!/^\d{2}:\d{2}$/.test(time)) return false;
  return time.endsWith(":00");
}

// Syntax-only HH:mm check (permits 09:30, 09:15, etc.). Used by the
// handler for structural validation; the Actor applies business-hour
// eligibility separately via isValidTime(time, config).
export function isValidTimeSyntax(time: string): boolean {
  if (!/^\d{2}:\d{2}$/.test(time)) return false;
  const [h, m] = time.split(":").map(Number);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

export function isValidTime(time: string, config: BusinessConfig): boolean {
  if (!isValidTimeFormat(time)) return false;
  return getSlotTimes(config).includes(time);
}

// ---------------------------------------------------------------------------
// Day of week — from date string, timezone-independent
// ---------------------------------------------------------------------------

const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export function getDayOfWeek(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return DOW[dt.getUTCDay()];
}

export function isOpenDay(date: string, openDays: string[]): boolean {
  return openDays.includes(getDayOfWeek(date));
}

// ---------------------------------------------------------------------------
// Local date/time from injected epoch ms — timezone-aware, no hardcode
// ---------------------------------------------------------------------------

export function getLocalDateString(now: number): string {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(now));
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  return `${y}-${m}-${d}`;
}

export function getLocalTimeParts(now: number): {
  hour: number;
  minute: number;
} {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(new Date(now));
  let hour = Number(parts.find((p) => p.type === "hour")!.value);
  if (hour === 24) hour = 0;
  const minute = Number(parts.find((p) => p.type === "minute")!.value);
  return { hour, minute };
}

// ---------------------------------------------------------------------------
// Calendar-day arithmetic — timezone-independent (operates on UTC dates)
// ---------------------------------------------------------------------------

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// Booking window — calendar-day based, uses injected now
// ---------------------------------------------------------------------------

export function getBookingWindowDates(
  now: number,
  config: BusinessConfig,
): string[] {
  const start = getLocalDateString(now);
  return Array.from({ length: config.booking_window_days }, (_, i) =>
    addDays(start, i),
  );
}

export function isDateInWindow(
  date: string,
  now: number,
  config: BusinessConfig,
): boolean {
  const window = getBookingWindowDates(now, config);
  return window.includes(date);
}

// ---------------------------------------------------------------------------
// Is slot past — timezone-aware comparison with injected now
// "at or before now" → slot start <= local now → excluded
// ---------------------------------------------------------------------------

export function isSlotPast(date: string, time: string, now: number): boolean {
  const todayLocal = getLocalDateString(now);
  if (date < todayLocal) return true;
  if (date > todayLocal) return false;
  const { hour: nowHour, minute: nowMin } = getLocalTimeParts(now);
  const [slotHour, slotMin] = time.split(":").map(Number);
  if (slotHour < nowHour) return true;
  if (slotHour > nowHour) return false;
  return slotMin <= nowMin;
}

// ---------------------------------------------------------------------------
// Candidate slot generation — advisory, not confirmed availability
// ---------------------------------------------------------------------------

export interface CandidateSlot {
  date: string;
  time: string;
}

export function generateDaySlots(
  date: string,
  now: number,
  config: BusinessConfig,
): string[] {
  if (!isOpenDay(date, config.open_days)) return [];
  const todayLocal = getLocalDateString(now);
  if (date < todayLocal) return [];
  return getSlotTimes(config).filter((time) => {
    if (date === todayLocal) return !isSlotPast(date, time, now);
    return true;
  });
}

export function generateCandidateSlots(
  now: number,
  config: BusinessConfig,
): CandidateSlot[] {
  const slots: CandidateSlot[] = [];
  for (const date of getBookingWindowDates(now, config)) {
    for (const time of generateDaySlots(date, now, config)) {
      slots.push({ date, time });
    }
  }
  return slots;
}

// ---------------------------------------------------------------------------
// Request validation — returns error code or null (valid)
// Scheduling rules only; booking_enabled admission is checked separately.
// ---------------------------------------------------------------------------

export type SchedulingError =
  | "date_invalid"
  | "date_out_of_range"
  | "date_not_open"
  | "time_invalid"
  | "slot_in_past";

export function validateSlotRequest(
  date: string,
  time: string,
  now: number,
  config: BusinessConfig,
): SchedulingError | null {
  if (!isValidDate(date)) return "date_invalid";
  if (!isDateInWindow(date, now, config)) return "date_out_of_range";
  if (!isOpenDay(date, config.open_days)) return "date_not_open";
  if (!isValidTime(time, config)) return "time_invalid";
  if (isSlotPast(date, time, now)) return "slot_in_past";
  return null;
}
