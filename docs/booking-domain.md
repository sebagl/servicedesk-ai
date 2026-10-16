# Booking Domain Specification

> Status: **Specification — not implemented.** This document defines the
> booking domain for the ServiceDesk AI demo: a fictional auto repair shop.
> Implementation is a later subtask. No application code exists yet for this
> domain.
>
> Supersedes the subtask 2.1 plan. Applies reviewed corrections (items 1–8
> referenced inline as `[C1]`–`[C8]`).

## 1. Business rules

- **Location:** `location_id = "main"` — one location. `[C1]`
- **Services:** Oil Change (`oil_change`), Tire Rotation (`tire_rotation`),
  General Maintenance Service (`general_maintenance`).
- **Duration:** 60 minutes for all services — explicit demo simplification.
- **Schedule:** Monday–Friday, 09:00–17:00, last start at 16:00.
  Valid start times are exactly the whole hours 09:00, 10:00, 11:00, 12:00,
  13:00, 14:00, 15:00, 16:00 — **eight slots** per open day.
  Times such as 09:30 are rejected. `[C1]`
- **Time zone:** `America/Mexico_City`. Deterministic local date/time is
  derived through timezone-aware APIs (`Intl.DateTimeFormat` with
  `timeZone: "America/Mexico_City"`), not a hardcoded UTC offset. `[C2]`
- **Booking window:** today plus the next six local calendar days (7 dates
  inclusive).
- **Never offer:** past slots, weekends, slots outside business hours,
  dates beyond the window.
- **Capacity:** one appointment per slot across all services.
- **Required customer data:** `customer_name` and `customer_phone`
  (non-empty; no format validation in this demo).
- **Required booking data:** `service_id` and a `slot` (`date` + `time`).
- **Confirmation:** the backend requires `confirmed: true` as a precondition;
  this is **not proof of verbal consent**. The conversation workflow must
  obtain the customer's explicit confirmation before calling `create_booking`. `[C7]`
- **Future expansion (documentation only):** with customer consent, a
  follow-up agent could encourage recurring maintenance and book through the
  same tools. Scheduling would depend on service, vehicle, and mileage. Not
  implemented now; no additional data collected for it. Booked
  appointments are not realized revenue.

## 2. Domain entities and minimal fields

Dates are `YYYY-MM-DD` strings. Malformed or impossible calendar dates
(e.g. `2026-02-30`, `2026-13-01`) are rejected as `date_invalid`. `[C1]`

**Service** (KV catalog):
```ts
interface Service {
  id: "oil_change" | "tire_rotation" | "general_maintenance";
  name: string;
  duration_minutes: 60;
}
```

**BusinessConfig** (KV):
```ts
interface BusinessConfig {
  location_id: "main";
  timezone: "America/Mexico_City";
  open_days: ["mon", "tue", "wed", "thu", "fri"];
  slot_hours: { start: "09:00"; end: "17:00"; last_start: "16:00" };
  booking_window_days: 7;   // today + 6 calendar days
  booking_enabled: boolean;
}
```

**Slot:**
```ts
interface Slot {
  date: string;      // YYYY-MM-DD
  time: string;      // HH:mm (whole hour, 09:00–16:00)
  available: boolean;
}
```

**Booking** (Actor state):
```ts
interface Booking {
  id: string;            // actor-generated
  service_id: string;
  date: string;          // YYYY-MM-DD
  time: string;          // HH:mm
  customer_name: string;
  customer_phone: string;
  created_at: string;    // ISO 8601
  idempotency_key: string;
}
```

## 3. Operations and input/output contracts

### get_service_catalog
- Input: `{}`
- Output: `{ services: Service[]; booking_enabled: boolean }`
- Source: KV read. If KV is unavailable → infrastructure failure (see §7).

### get_availability
- Input: `{ date?: string }` — if omitted, returns all open dates in the window.
- Output: `{ dates: Array<{ date: string; slots: Slot[] }> }`
- Flow: KV config → pure domain computes valid slots for the window → Actor
  read marks occupied slots.
- Availability is **advisory**: a slot shown available may be taken by the
  time `create_booking` runs. Only `create_booking` success is authoritative.

### create_booking
- Input:
  ```ts
  {
    service_id: string;
    date: string;            // YYYY-MM-DD
    time: string;            // HH:mm
    customer_name: string;
    customer_phone: string;
    idempotency_key: string;
    confirmed: boolean;
  }
  ```
- Output:
  ```ts
  {
    booking_id: string;
    service_id: string;
    date: string;
    time: string;
    status: "confirmed";
  }
  ```
- Flow: KV config (catalog + `booking_enabled`) → pure domain validates input
  → Actor atomic check-and-book.

## 4. Validation rules and error outcomes

### Domain errors (4xx, ordinary business rejection)

| Rule | Error code |
|---|---|
| `booking_enabled` is false | `booking_disabled` |
| `service_id` not in catalog | `unknown_service` |
| `date` malformed or impossible calendar date | `date_invalid` `[C1]` |
| `date` outside booking window | `date_out_of_range` |
| `date` is a weekend | `date_not_open` |
| `time` malformed or not a whole hour 09:00–16:00 | `time_invalid` `[C1]` |
| `time` is in the past (local timezone) | `slot_in_past` |
| `customer_name` missing/empty | `missing_customer_name` |
| `customer_phone` missing/empty | `missing_customer_phone` |
| `confirmed` is not `true` | `confirmation_required` `[C7]` |
| Slot already occupied | `slot_unavailable` |
| `idempotency_key` reused with different input | `idempotency_key_conflict` |
| `idempotency_key` reused with same input | Returns original result (see §5) |

### Infrastructure failures (5xx, fail closed) `[C8]`

Unavailable configuration or storage must **not** be treated as an empty
agenda, an available slot, or ordinary invalid customer input. Fail closed
with a generic 5xx error; do not leak raw infrastructure messages.

| Condition | Behavior |
|---|---|
| KV catalog/config unavailable | `503 { error: "service_unavailable" }` |
| Actor storage unavailable | `503 { error: "service_unavailable" }` |
| Secret binding unavailable | `503` (existing pattern from 1.4) |

## 5. Idempotency

**Semantics:** the `idempotency_key` represents a **stable booking attempt**,
not a fresh value invented by the LLM on each call. Reuse across retries of
the same logical request is expected; inventing a new key per call defeats
dedup. `[C5]`

**Scoping:** the key is scoped to the location/day Actor
(`main-{YYYY-MM-DD}`). Cross-date reuse of the same key is **not detected**
by that Actor — each day's Actor owns its own idempotency map. `[C5]`

**Retry of an existing successful booking:** if the same `idempotency_key`
with the same input is retried, the Actor returns the original result even if
the slot has since become past or `booking_enabled` was later disabled. The
booking already succeeded; time and policy changes do not unwind it. `[C6]`

**Conflicting payload:** same `idempotency_key` with different input
(`service_id`, `date`, `time`, `customer_name`, or `customer_phone`) is
rejected as `idempotency_key_conflict`. `[C6]`

**Trusted source:** the concrete integration that supplies the
`idempotency_key` from the conversation/tool-call flow is an **explicit
decision for the MCP integration step.** No Telnyx-provided field is assumed
here. `[C5]`

## 6. Actor state and persistence

**Naming:** `main-{YYYY-MM-DD}` (one Actor per location per local calendar
date).

**Single aggregate:** occupancy and idempotency must be **persisted together
in a single write** — not two separate `ctx.storage.put` calls that could
partially fail. For this small daily agenda the preferred shape is one
persisted aggregate record: `[C4]`

```ts
interface DayAgenda {
  date: string;              // YYYY-MM-DD
  bookings: Record<string, Booking>;   // keyed by "HH:mm"
  idempotency: Record<string, { 
    input_hash: string; 
    booking_id: string; 
  }>;                        // keyed by idempotency_key
}
```

Subject to verifying the runtime's `ctx.storage` atomicity guarantee during
Actor implementation. Do **not** claim atomicity from two separate writes. `[C4]`

**Single-threaded dispatch** (Actor guarantee) serializes competing writes to
the same slot; no lock code is needed. Mocked tests do not prove runtime
serialization — label real-runtime concurrency verification separately. `[C3]`

## 7. Responsibility split

| Layer | Owns | Does NOT do |
|---|---|---|
| **Pure domain logic** (no I/O, fully unit-testable) | Slot generation (8 whole-hour slots per open day), date/time validation, timezone boundary checks, input hashing for idempotency, customer-name/phone presence | Storage access, network, KV, Actor calls |
| **KV** (`env.CONFIG`) | Service catalog, business config, `booking_enabled` — read by function | Transactional booking state (KV is not the agenda) |
| **Actor** (per `main-{date}`, `ctx.storage`) | Authoritative occupancy + idempotency in a single aggregate, atomic check-and-book | Catalog/config (delegates to KV via function) |
| **HTTP/MCP layer** (`fetch` handler) | Request parsing, KV reads (catalog/config), compute advisory availability, delegate `create_booking` to Actor, format responses, fail closed on infra errors | Validation authority (uses pure domain); booking authority (Actor) |

## 8. Test cases

### Slot generation (pure domain, mocked config, injected `now`) `[C2]`
- Eight slots: 09:00–16:00 for each weekday in the 7-day window
- Saturdays and Sundays excluded
- Past times on today's date excluded (uses injected `now`, not wall clock)
- `date = today + 7` → `date_out_of_range`
- `date = 2026-02-30` → `date_invalid` `[C1]`
- `time = "09:30"` → `time_invalid` `[C1]`

### Timezone boundaries `[C2]`
- `slot_in_past` uses `America/Mexico_City` local time via
  `Intl.DateTimeFormat({ timeZone: "America/Mexico_City" })`, not UTC
- Window edge: local-calendar today + 6 included, +7 rejected
- Tests inject `now` to pin local-date boundaries deterministically
- Tests do **not** assume this location currently observes seasonal DST
  transitions; they use the timezone-aware API so the result tracks whatever
  the IANA TZ data says

### Slot conflicts (Actor, mocked storage) — labeled as mocked `[C3]`
- Same slot, 20 sequential attempts: exactly 1 succeeds, 19 `slot_unavailable`
- Same slot, 20 concurrent attempts (bounded 5): at most 1 booking
- **Different slots on one day, 20 concurrent attempts (bounded 5): at most
  8 successful bookings** (one per slot) `[C3]`
- These mocked tests verify logic, **not** runtime serialization. Real-runtime
  concurrency verification is a separate labeled task. `[C3]`

### Idempotent retries (Actor, mocked storage) `[C5]` `[C6]`
- Same key + identical input → returns original `booking_id`; occupancy
  count unchanged (no duplicate)
- Same key + different `service_id` → `idempotency_key_conflict`
- Same key + different `customer_name` → `idempotency_key_conflict`
- Same key + identical retry after slot becomes past → still returns original
  result `[C6]`
- Same key + identical retry after `booking_enabled` set to false → still
  returns original result `[C6]`
- Different keys targeting the same slot → first `confirmed`, second
  `slot_unavailable`

### Validation (pure domain + mocked KV)
- `booking_enabled=false` → `booking_disabled`
- `customer_name=""` → `missing_customer_name`
- `customer_phone=""` → `missing_customer_phone`
- `confirmed=false` → `confirmation_required`

### Infrastructure failure (fail closed) `[C8]`
- KV unavailable during `get_service_catalog` → `503`
- KV unavailable during `get_availability` → `503` (not empty schedule)
- Actor storage unavailable during `create_booking` → `503` (not
  `slot_unavailable`)

### Data hygiene
- No test output or log line contains `customer_name` or `customer_phone`
  values. Assert in tests.

## 9. Open decisions

| Item | Status | Note |
|---|---|---|
| `idempotency_key` source | Deferred to MCP step `[C5]` | Must be stable per booking attempt, not LLM-invented per call. No Telnyx field assumed. |
| Phone validation | Non-empty only (demo) | Can tighten later |
| `ctx.storage` atomicity for single `put` | Verify during implementation `[C4]` | Single aggregate write preferred; confirm runtime guarantee |
| KV binding name | TBD in implementation | `[storage.kv.CONFIG]` or similar; unavailable in local `dev` (mocked) |
| Actor type name | TBD in implementation | Replace `Counter` demo actor with `DayAgenda` or similar |
| Confirmation enforcement | Backend precondition only `[C7]` | Conversation workflow must obtain verbal consent; backend cannot verify it happened |
| Follow-up agent | Future expansion, not implemented | Not in current scope; no extra data collected |
