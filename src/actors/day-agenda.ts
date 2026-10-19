import { StatefulActor } from "@telnyx/edge-runtime";
import { randomUUID, createHash } from "node:crypto";
import {
  isValidDate,
  isValidTime,
  isDateInWindow,
  isOpenDay,
  isSlotPast,
} from "../domain/scheduling";
import type { AppConfig } from "../domain/config";

// ---------------------------------------------------------------------------
// Persisted state — the daily agenda aggregate (see docs/architecture.md).
// Occupancy + idempotency persisted together in a single key.
// ---------------------------------------------------------------------------

export interface Booking {
  id: string;
  service_id: string;
  date: string;          // YYYY-MM-DD
  time: string;          // HH:mm
  customer_name: string;
  customer_phone: string;
  created_at: string;
  idempotency_key: string;
}

export interface DayAgendaState {
  date: string;
  bookings: Record<string, Booking>;
  idempotency: Record<string, IdempotencyEntry>;
}

export interface IdempotencyEntry {
  input_hash: string;
  booking_id: string;
  booking_time: string;
}

// ---------------------------------------------------------------------------
// createBooking input and result types
// ---------------------------------------------------------------------------

export interface CreateBookingInput {
  service_id: string;
  date: string;
  time: string;
  customer_name: string;
  customer_phone: string;
  idempotency_key: string;
  confirmed: boolean;
  config: AppConfig;
}

export type CreateBookingResult =
  | {
      ok: true;
      booking_id: string;
      service_id: string;
      date: string;
      time: string;
      status: "confirmed";
    }
  | { ok: false; code: string };

const STORAGE_KEY = "agenda";

const VALID_SLOT_KEYS = new Set([
  "09:00", "10:00", "11:00", "12:00",
  "13:00", "14:00", "15:00", "16:00",
]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

// Own-property lookup — prevents __proto__, constructor, toString, etc.
// from resolving inherited properties on a Record.
function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// ---------------------------------------------------------------------------
// Fingerprint — deterministic SHA-256 over normalized request fields.
// Excludes: idempotency_key (the lookup index), config, current time.
// Includes: service_id, date, time, customer_name (trimmed),
//           customer_phone (trimmed), confirmed (boolean value).
// ---------------------------------------------------------------------------

function trim(v: string): string {
  return v.trim();
}

export function computeFingerprint(input: {
  service_id: string;
  date: string;
  time: string;
  customer_name: string;
  customer_phone: string;
  confirmed: boolean;
}): string {
  const canonical = JSON.stringify({
    confirmed: input.confirmed,
    customer_name: trim(input.customer_name),
    customer_phone: trim(input.customer_phone),
    date: input.date,
    service_id: input.service_id,
    time: input.time,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

// ---------------------------------------------------------------------------
// Runtime validation of persisted aggregate. Throws on malformed state —
// the caller (HTTP/MCP layer) maps the thrown error to a generic 503.
// ---------------------------------------------------------------------------

function validateBooking(raw: unknown, agendaDate: string): Booking {
  if (!isObject(raw)) throw new Error("invalid booking entry");
  const b = raw;
  if (!isString(b.id) || b.id.length === 0) throw new Error("invalid booking id");
  if (!isString(b.service_id) || b.service_id.length === 0)
    throw new Error("invalid booking service_id");
  if (!isString(b.date) || !isValidDate(b.date))
    throw new Error("invalid booking date");
  if (b.date !== agendaDate)
    throw new Error("booking date does not match aggregate date");
  if (!isString(b.time) || !VALID_SLOT_KEYS.has(b.time))
    throw new Error("invalid booking slot key");
  if (!isString(b.customer_name) || b.customer_name.length === 0)
    throw new Error("invalid customer_name");
  if (!isString(b.customer_phone) || b.customer_phone.length === 0)
    throw new Error("invalid customer_phone");
  if (!isString(b.created_at) || b.created_at.length === 0)
    throw new Error("invalid created_at");
  if (!isString(b.idempotency_key) || b.idempotency_key.length === 0)
    throw new Error("invalid idempotency_key");
  return {
    id: b.id,
    service_id: b.service_id,
    date: b.date,
    time: b.time,
    customer_name: b.customer_name,
    customer_phone: b.customer_phone,
    created_at: b.created_at,
    idempotency_key: b.idempotency_key,
  };
}

function validateIdempotencyEntry(
  raw: unknown,
  bookings: Record<string, Booking>,
): IdempotencyEntry {
  if (!isObject(raw)) throw new Error("invalid idempotency entry");
  const e = raw;
  if (!isString(e.input_hash) || e.input_hash.length === 0)
    throw new Error("invalid input_hash");
  if (!isString(e.booking_id) || e.booking_id.length === 0)
    throw new Error("invalid booking_id");
  if (!isString(e.booking_time) || !VALID_SLOT_KEYS.has(e.booking_time))
    throw new Error("invalid booking_time");
  // Cross-reference: the referenced booking must exist and match.
  if (!hasOwn(bookings, e.booking_time)) {
    throw new Error("idempotency references non-existent booking time");
  }
  const referenced = bookings[e.booking_time]!;
  if (referenced.id !== e.booking_id) {
    throw new Error("idempotency booking_id mismatch");
  }
  return {
    input_hash: e.input_hash,
    booking_id: e.booking_id,
    booking_time: e.booking_time,
  };
}

function validateState(raw: unknown): DayAgendaState {
  if (!isObject(raw)) throw new Error("state is not an object");

  if (!isString(raw.date) || !isValidDate(raw.date))
    throw new Error("invalid aggregate date");

  // bookings must be a Record<string, Booking>, not an array.
  if (!isObject(raw.bookings)) throw new Error("bookings is not a record");

  // Null-prototype objects so "__proto__" as a key becomes an own property,
  // not a prototype setter. This is the same shape JSON.parse produces.
  const bookings: Record<string, Booking> = Object.create(null);
  for (const [key, value] of Object.entries(raw.bookings)) {
    if (!VALID_SLOT_KEYS.has(key))
      throw new Error(`invalid slot key in bookings: ${key}`);
    const booking = validateBooking(value, raw.date);
    // The record key MUST equal the booking's own time field. A mismatch
    // (e.g. key "10:00" but booking.time "11:00") is a corrupted aggregate —
    // it could otherwise silently mark the wrong slot occupied.
    if (booking.time !== key)
      throw new Error(`booking key does not match booking.time: ${key}`);
    bookings[key] = booking;
  }

  // idempotency must be a Record too.
  if (!isObject(raw.idempotency)) throw new Error("idempotency is not a record");

  const idempotency: Record<string, IdempotencyEntry> = Object.create(null);
  for (const [key, value] of Object.entries(raw.idempotency)) {
    if (!isString(key) || key.length === 0)
      throw new Error("invalid idempotency key");
    const entry = validateIdempotencyEntry(value, bookings);
    // The idempotency record key MUST equal the referenced booking's
    // idempotency_key. A mismatch indicates the entry was written for a
    // different request and would cause replays to look up the wrong entry.
    const referenced = bookings[entry.booking_time]!;
    if (referenced.idempotency_key !== key)
      throw new Error(`idempotency key does not match referenced booking: ${key}`);
    idempotency[key] = entry;
  }

  return {
    date: raw.date,
    bookings,
    idempotency,
  };
}

// ---------------------------------------------------------------------------
// DayAgenda Actor — read + create-booking operations.
// One instance per location/local-calendar-date, e.g. main-2026-10-19.
// ---------------------------------------------------------------------------

export interface BookingListItem {
  time: string;
  service_id: string;
  customer_name: string;
  customer_phone: string;
  created_at: string;
}

export class DayAgenda extends StatefulActor {
  // Operator view of the day: includes customer name and phone by design.
  // Callers must keep this behind an authenticated route and never log it.
  async listBookings(): Promise<{ bookings: BookingListItem[] }> {
    let raw: unknown;
    try {
      raw = await this.ctx.storage.get<unknown>(STORAGE_KEY);
    } catch {
      throw new Error("agenda storage read failed");
    }
    if (raw === undefined) return { bookings: [] };
    const state = validateState(raw);
    const bookings = Object.keys(state.bookings)
      .sort()
      .map((time) => {
        const b = state.bookings[time]!;
        return {
          time: b.time,
          service_id: b.service_id,
          customer_name: b.customer_name,
          customer_phone: b.customer_phone,
          created_at: b.created_at,
        };
      });
    return { bookings };
  }

  async getOccupiedSlots(): Promise<{ occupied: string[] }> {
    let raw: unknown;
    try {
      raw = await this.ctx.storage.get<unknown>(STORAGE_KEY);
    } catch {
      throw new Error("agenda storage read failed");
    }

    if (raw === undefined) {
      return { occupied: [] };
    }

    const state = validateState(raw);
    const occupied = Object.keys(state.bookings).sort();
    return { occupied };
  }

  async createBooking(
    input: CreateBookingInput,
  ): Promise<CreateBookingResult> {
    const {
      service_id,
      date,
      time,
      customer_name,
      customer_phone,
      idempotency_key,
      confirmed,
      config,
    } = input;

    // ---- Step 1: Load and validate persisted state ----
    let raw: unknown;
    try {
      raw = await this.ctx.storage.get<unknown>(STORAGE_KEY);
    } catch {
      throw new Error("agenda storage read failed");
    }

    let state: DayAgendaState;
    if (raw === undefined) {
      state = { date, bookings: {}, idempotency: {} };
    } else {
      state = validateState(raw);
    }

    // ---- Step 2: Verify stored agenda date matches the requested date ----
    if (state.date !== date) {
      throw new Error("agenda date mismatch");
    }

    // ---- Step 3: Look up idempotency key ----
    const existingEntry = hasOwn(state.idempotency, idempotency_key)
      ? state.idempotency[idempotency_key]
      : undefined;

    // ---- Step 4: Identical fingerprint → original result; conflict → error ----
    if (existingEntry !== undefined) {
      const fingerprint = computeFingerprint({
        service_id,
        date,
        time,
        customer_name,
        customer_phone,
        confirmed,
      });

      if (fingerprint === existingEntry.input_hash) {
        // Identical replay → return original booking result.
        // A confirmed booking stays confirmed: the replay succeeds even if
        // booking_enabled was later disabled or the slot is now past. No write.
        const originalBooking =
          state.bookings[existingEntry.booking_time]!;
        return {
          ok: true,
          booking_id: existingEntry.booking_id,
          service_id: originalBooking.service_id,
          date: originalBooking.date,
          time: originalBooking.time,
          status: "confirmed",
        };
      }

      // Changed payload → conflict. No write.
      return { ok: false, code: "idempotency_key_conflict" };
    }

    // ---- Step 5: New attempt → validate current business rules and confirmation ----
    // Obtain current time inside the Actor, after idempotency lookup.
    // Use that same instant for validation and created_at.
    const now = Date.now();
    const biz = config.business;

    // Service catalog membership
    const knownServices = new Set(config.services.map((s) => s.id));
    if (!knownServices.has(service_id)) {
      return { ok: false, code: "unknown_service" };
    }

    // Booking window
    if (!isDateInWindow(date, now, biz)) {
      return { ok: false, code: "date_out_of_range" };
    }

    // Open day
    if (!isOpenDay(date, biz.open_days)) {
      return { ok: false, code: "date_not_open" };
    }

    // Business hours (full check with config, not syntax-only)
    if (!isValidTime(time, biz)) {
      return { ok: false, code: "time_invalid" };
    }

    // Confirmation (new bookings only)
    if (confirmed !== true) {
      return { ok: false, code: "confirmation_required" };
    }

    // Booking enabled (new bookings only)
    if (!biz.booking_enabled) {
      return { ok: false, code: "booking_disabled" };
    }

    // Slot not past (new bookings only)
    if (isSlotPast(date, time, now)) {
      return { ok: false, code: "slot_in_past" };
    }

    // ---- Step 6: Check occupancy ----
    if (hasOwn(state.bookings, time)) {
      return { ok: false, code: "slot_unavailable" };
    }

    // ---- Step 7: Generate backend booking ID ----
    const bookingId = randomUUID();
    const createdAt = new Date(now).toISOString();

    // ---- Step 8: Persist booking and idempotency together ----
    // Build a NEW aggregate; do not mutate the loaded `state`.
    const fingerprint = computeFingerprint({
      service_id,
      date,
      time,
      customer_name,
      customer_phone,
      confirmed,
    });

    const newBooking: Booking = {
      id: bookingId,
      service_id,
      date,
      time,
      customer_name: trim(customer_name),
      customer_phone: trim(customer_phone),
      created_at: createdAt,
      idempotency_key,
    };

    // Build new records with null-prototype objects so "__proto__" and
    // other reserved-looking keys are own properties, not prototype setters.
    const newBookings: Record<string, Booking> = Object.assign(
      Object.create(null),
      state.bookings,
    );
    newBookings[time] = newBooking;

    const newIdempotency: Record<string, IdempotencyEntry> = Object.assign(
      Object.create(null),
      state.idempotency,
    );
    newIdempotency[idempotency_key] = {
      input_hash: fingerprint,
      booking_id: bookingId,
      booking_time: time,
    };

    const newState: DayAgendaState = {
      date,
      bookings: newBookings,
      idempotency: newIdempotency,
    };

    try {
      await this.ctx.storage.put(STORAGE_KEY, newState);
    } catch {
      // A rejected write has an ambiguous outcome — the data may or may not
      // have been persisted. We throw; the caller maps to 503. Recovery uses
      // the SAME idempotency key: if the write DID persist, the retry
      // succeeds as an identical replay; if not, it creates a new booking.
      throw new Error("agenda storage write failed");
    }

    // ---- Step 9: Return success only after awaiting persistence ----
    return {
      ok: true,
      booking_id: bookingId,
      service_id,
      date,
      time,
      status: "confirmed",
    };
  }
}
