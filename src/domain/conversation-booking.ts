import type {
  BookingDomainError,
  BookingServiceResult,
} from "../services/booking";

// ---------------------------------------------------------------------------
// Conversation-scoped booking coordinator (see docs/architecture.md).
// Persists one aggregate per conversation: idle, pending, or confirmed.
// Pending and confirmed both carry the saved normalized input, the stable
// backend-generated attempt key, and the original location_id; confirmed
// additionally carries the successful result. Config and credentials are
// never persisted. All collaborators are injected — no SDK, no HTTP, no
// MCP, no KV, no Actor registration.
// ---------------------------------------------------------------------------

export interface ConversationBookingInput {
  service_id: string;
  date: string;
  time: string;
  customer_name: string;
  customer_phone: string;
  confirmed: boolean;
}

export interface SavedBookingInput {
  service_id: string;
  date: string;
  time: string;
  customer_name: string;
  customer_phone: string;
  confirmed: boolean;
}

export interface SavedBookingAttempt {
  input: SavedBookingInput;
  attempt_key: string;
  location_id: string;
}

export interface ConfirmedBookingResult {
  booking_id: string;
  service_id: string;
  date: string;
  time: string;
}

export type ConversationAggregate =
  | { kind: "idle" }
  | ({ kind: "pending" } & SavedBookingAttempt)
  | ({
      kind: "confirmed";
      result: ConfirmedBookingResult;
    } & SavedBookingAttempt);

export type ConversationDomainError =
  | BookingDomainError
  | "conversation_already_booked";

export type ConversationBookingResult =
  | {
      kind: "confirmed";
      booking_id: string;
      service_id: string;
      date: string;
      time: string;
    }
  | { kind: "rejected"; code: ConversationDomainError }
  | { kind: "infrastructure_error" };

export interface ActorStorageLike {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

export interface ConversationBookingDeps {
  storage: ActorStorageLike;
  storageKey: string;
  generateAttemptKey(): string;
  executeBooking(attempt: SavedBookingAttempt): Promise<BookingServiceResult>;
  locationId: string;
}

// Recognized rejection codes emitted by DayAgenda. Anything outside this set
// is treated as malformed and surfaced as infrastructure_error.
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

function trim(v: string): string {
  return v.trim();
}

function normalize(input: ConversationBookingInput): SavedBookingInput {
  return {
    service_id: input.service_id,
    date: input.date,
    time: input.time,
    customer_name: trim(input.customer_name),
    customer_phone: trim(input.customer_phone),
    confirmed: input.confirmed,
  };
}

function isSameInput(a: SavedBookingInput, b: SavedBookingInput): boolean {
  return (
    a.service_id === b.service_id &&
    a.date === b.date &&
    a.time === b.time &&
    a.customer_name === b.customer_name &&
    a.customer_phone === b.customer_phone &&
    a.confirmed === b.confirmed
  );
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

function validateSavedInput(raw: unknown): SavedBookingInput {
  if (!isObject(raw)) throw new Error("invalid saved input");
  if (!isString(raw.service_id) || raw.service_id.length === 0)
    throw new Error("invalid service_id");
  if (!isString(raw.date) || raw.date.length === 0)
    throw new Error("invalid date");
  if (!isString(raw.time) || raw.time.length === 0)
    throw new Error("invalid time");
  if (!isString(raw.customer_name) || raw.customer_name.length === 0)
    throw new Error("invalid customer_name");
  if (!isString(raw.customer_phone) || raw.customer_phone.length === 0)
    throw new Error("invalid customer_phone");
  if (!isBoolean(raw.confirmed)) throw new Error("invalid confirmed");
  return {
    service_id: raw.service_id,
    date: raw.date,
    time: raw.time,
    customer_name: raw.customer_name,
    customer_phone: raw.customer_phone,
    confirmed: raw.confirmed,
  };
}

function validateConfirmedResult(raw: unknown): ConfirmedBookingResult {
  if (!isObject(raw)) throw new Error("invalid confirmed result");
  if (!isString(raw.booking_id) || raw.booking_id.length === 0)
    throw new Error("invalid booking_id");
  if (!isString(raw.service_id) || raw.service_id.length === 0)
    throw new Error("invalid service_id");
  if (!isString(raw.date) || raw.date.length === 0)
    throw new Error("invalid date");
  if (!isString(raw.time) || raw.time.length === 0)
    throw new Error("invalid time");
  return {
    booking_id: raw.booking_id,
    service_id: raw.service_id,
    date: raw.date,
    time: raw.time,
  };
}

function validateAggregate(raw: unknown): ConversationAggregate {
  if (!isObject(raw)) throw new Error("aggregate is not an object");
  if (!isString(raw.kind)) throw new Error("aggregate kind missing");

  if (raw.kind === "idle") return { kind: "idle" };

  if (raw.kind !== "pending" && raw.kind !== "confirmed")
    throw new Error("unknown aggregate kind");

  const input = validateSavedInput(raw.input);
  if (!isString(raw.attempt_key) || raw.attempt_key.length === 0)
    throw new Error("invalid attempt_key");
  if (!isString(raw.location_id) || raw.location_id.length === 0)
    throw new Error("invalid location_id");

  if (raw.kind === "pending") {
    return {
      kind: "pending",
      input,
      attempt_key: raw.attempt_key,
      location_id: raw.location_id,
    };
  }

  const result = validateConfirmedResult(raw.result);
  return {
    kind: "confirmed",
    input,
    attempt_key: raw.attempt_key,
    location_id: raw.location_id,
    result,
  };
}

// ---------------------------------------------------------------------------
// Strict executor result validation. Runs BEFORE any storage transition.
// Returns a validated triple (confirmed / rejected / ambiguous) or null
// when the executor's output is malformed (null, array, unknown kind,
// missing/unknown rejection code, empty booking_id, or service/date/time
// that does not match the saved attempt). In every ambiguous or malformed
// case the caller must preserve pending and return infrastructure_error;
// no idle or confirmed write is performed.
// ---------------------------------------------------------------------------

type ValidatedExecutorResult =
  | { kind: "confirmed"; result: ConfirmedBookingResult }
  | { kind: "rejected"; code: BookingDomainError }
  | { kind: "ambiguous" };

function validateExecutorResult(
  raw: unknown,
  saved: SavedBookingInput,
): ValidatedExecutorResult | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const r = raw as Record<string, unknown>;

  if (r.kind === "confirmed") {
    if (!isString(r.booking_id) || r.booking_id.length === 0) {
      return null;
    }
    if (
      r.service_id !== saved.service_id ||
      r.date !== saved.date ||
      r.time !== saved.time
    ) {
      return null;
    }
    // Construct from saved fields — they were already validated and they
    // matched the executor's own echoed fields above.
    return {
      kind: "confirmed",
      result: {
        booking_id: r.booking_id,
        service_id: saved.service_id,
        date: saved.date,
        time: saved.time,
      },
    };
  }

  if (r.kind === "rejected") {
    if (!isString(r.code)) return null;
    if (!KNOWN_DOMAIN_ERRORS.has(r.code)) return null;
    if (r.code === "idempotency_key_conflict") {
      // Ambiguous from the coordinator's perspective: the conversation
      // owns the attempt key, so a key conflict indicates desync.
      return { kind: "ambiguous" };
    }
    return { kind: "rejected", code: r.code as BookingDomainError };
  }

  if (r.kind === "infrastructure_error") {
    return { kind: "ambiguous" };
  }

  // Unknown kind.
  return null;
}

function toConfirmedShape(r: ConfirmedBookingResult): {
  kind: "confirmed";
  booking_id: string;
  service_id: string;
  date: string;
  time: string;
} {
  return {
    kind: "confirmed",
    booking_id: r.booking_id,
    service_id: r.service_id,
    date: r.date,
    time: r.time,
  };
}

// ---------------------------------------------------------------------------
// Public coordinator.
// ---------------------------------------------------------------------------

export async function coordinateBooking(
  input: ConversationBookingInput,
  deps: ConversationBookingDeps,
): Promise<ConversationBookingResult> {
  const current = normalize(input);

  let raw: unknown;
  try {
    raw = await deps.storage.get(deps.storageKey);
  } catch {
    return { kind: "infrastructure_error" };
  }

  let state: ConversationAggregate;
  if (raw === undefined) {
    state = { kind: "idle" };
  } else {
    let parsed: ConversationAggregate;
    try {
      parsed = validateAggregate(raw);
    } catch {
      return { kind: "infrastructure_error" };
    }

    // Confirmed: verify the persisted result matches its own saved input.
    // A mismatch indicates corruption; fail closed without executing.
    if (parsed.kind === "confirmed") {
      if (
        parsed.result.service_id !== parsed.input.service_id ||
        parsed.result.date !== parsed.input.date ||
        parsed.result.time !== parsed.input.time
      ) {
        return { kind: "infrastructure_error" };
      }
      if (isSameInput(current, parsed.input)) {
        return toConfirmedShape(parsed.result);
      }
      return { kind: "rejected", code: "conversation_already_booked" };
    }

    state = parsed;
  }

  if (state.kind === "pending") {
    return await resolvePending(state, current, deps);
  }

  return await startNewAttempt(current, deps);
}

async function resolvePending(
  state: Extract<ConversationAggregate, { kind: "pending" }>,
  current: SavedBookingInput,
  deps: ConversationBookingDeps,
): Promise<ConversationBookingResult> {
  // Always resolve the ORIGINAL input, location, and key first.
  let raw: unknown;
  try {
    raw = await deps.executeBooking({
      input: state.input,
      attempt_key: state.attempt_key,
      location_id: state.location_id,
    });
  } catch {
    return { kind: "infrastructure_error" };
  }

  const validated = validateExecutorResult(raw, state.input);
  if (validated === null || validated.kind === "ambiguous") {
    // Malformed or ambiguous: preserve pending, never write idle/confirmed.
    return { kind: "infrastructure_error" };
  }

  if (validated.kind === "confirmed") {
    const next: ConversationAggregate = {
      kind: "confirmed",
      input: state.input,
      attempt_key: state.attempt_key,
      location_id: state.location_id,
      result: validated.result,
    };
    try {
      await deps.storage.put(deps.storageKey, next);
    } catch {
      return { kind: "infrastructure_error" };
    }

    if (isSameInput(current, state.input)) {
      return toConfirmedShape(validated.result);
    }
    return { kind: "rejected", code: "conversation_already_booked" };
  }

  // Definitive domain rejection. Persist idle FIRST; if the write fails,
  // do not start a fresh attempt in this call.
  try {
    await deps.storage.put(deps.storageKey, { kind: "idle" });
  } catch {
    return { kind: "infrastructure_error" };
  }

  if (isSameInput(current, state.input)) {
    return { kind: "rejected", code: validated.code };
  }

  // Changed current input: start a fresh attempt in this call with a new key.
  return await startNewAttempt(current, deps);
}

async function startNewAttempt(
  current: SavedBookingInput,
  deps: ConversationBookingDeps,
): Promise<ConversationBookingResult> {
  const attempt_key = deps.generateAttemptKey();
  const pending: ConversationAggregate = {
    kind: "pending",
    input: current,
    attempt_key,
    location_id: deps.locationId,
  };

  // Persist pending BEFORE executing. A failed write prevents the executor
  // call entirely.
  try {
    await deps.storage.put(deps.storageKey, pending);
  } catch {
    return { kind: "infrastructure_error" };
  }

  let raw: unknown;
  try {
    raw = await deps.executeBooking({
      input: current,
      attempt_key,
      location_id: deps.locationId,
    });
  } catch {
    return { kind: "infrastructure_error" };
  }

  const validated = validateExecutorResult(raw, current);
  if (validated === null || validated.kind === "ambiguous") {
    return { kind: "infrastructure_error" };
  }

  if (validated.kind === "confirmed") {
    const next: ConversationAggregate = {
      kind: "confirmed",
      input: current,
      attempt_key,
      location_id: deps.locationId,
      result: validated.result,
    };
    try {
      await deps.storage.put(deps.storageKey, next);
    } catch {
      // Failed confirmation write leaves pending in storage. The next call
      // resolves the same attempt key and retries the confirmed write.
      return { kind: "infrastructure_error" };
    }
    return toConfirmedShape(validated.result);
  }

  // Definitive domain rejection.
  try {
    await deps.storage.put(deps.storageKey, { kind: "idle" });
  } catch {
    return { kind: "infrastructure_error" };
  }
  return { kind: "rejected", code: validated.code };
}
