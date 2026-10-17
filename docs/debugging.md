# Debugging Log

## DayAgenda null-vs-undefined: invalid state masked as empty agenda

### Context

`DayAgenda.getOccupiedSlots()` reads persisted agenda state from
`this.ctx.storage.get("agenda")` to determine which appointment slots are
occupied on a given location/day. The agreed contract (documented in
`docs/booking-domain.md` and subtask 2.3c) specifies that **only `undefined`**
— the value returned when the storage key has never been written — means a
brand-new, empty agenda. Any other stored value must pass runtime validation
or fail closed with a state-validation error.

### Discovery

The bug was found by reviewing the subtask 2.3c implementation report. The
report stated that both `undefined` and `null` from `ctx.storage.get` returned
empty occupancy (`{ occupied: [] }`). This contradicted the spec, which permits
only `undefined` as the empty-agenda signal. The review was a documentation
audit, not a production incident.

### Root cause

The empty-check condition was:

```ts
if (raw === undefined || raw === null) {
  return { occupied: [] };
}
```

`null` is a valid stored value in the Edge runtime's `ActorStorage.get`
(return type is `Promise<T | undefined>`), but it is semantically distinct from
`undefined`: `undefined` means "key never written"; `null` means "something
wrote `null` here." By treating `null` the same as `undefined`, the code
silently replaced malformed stored state with an empty agenda instead of
failing closed.

A test also reinforced the bug: `"returns [] when storage.get returns null"`
asserted `result.occupied` was `[]` — exactly the incorrect behavior the spec
prohibits.

### Risk

If `null` (or a future codec quirk that deserializes to `null`) appeared in
the persisted agenda key, the Actor would report all slots as available. This
is a **potential risk**, not an observed double booking or outage. The bug was
discovered and corrected with mocked tests before any booking-write
functionality or production deployment existed.

### Fix

The condition was narrowed to check only `undefined`:

```ts
if (raw === undefined) {
  return { occupied: [] };
}
```

`null` now falls through to `validateState`, which throws because `null` is
not an object. The caller (HTTP/MCP layer) maps the thrown error to a generic
`503`. A comment was added explaining that `null` is a stored value and must
validate.

### Regression coverage

The incorrect `null` test was replaced with a dedicated test that asserts
the corrected behavior:

- **`undefined`** → `{ occupied: [] }` (valid empty agenda, no writes).
- **`null`** → `getOccupiedSlots()` **rejects**; no storage writes performed
  (`put`, `delete`, `deleteAll` all not called).

Both cases are in separate `describe` blocks. The total test count stayed at
22 (one incorrect test was replaced, not added).

### Evidence

- `npm run typecheck` (`tsc --noEmit`) — **0 errors**
- `npm run test` (`vitest run`) — **126/126 passed**, including 22 mocked
  Actor tests
- Test count unchanged (22 Actor tests): the incorrect `null` test was
  replaced, not supplemented

### Limits

- Discovered and verified with **mocked tests** before production booking
  functionality was implemented.
- No production incident, double booking, or outage is claimed.
- Real-runtime verification of `ctx.storage.get` returning `null` vs
  `undefined` on a live Actor runtime is still pending (see `docs/verification.md`
  §2.3c "What is NOT proven").

### Interview explanation

> The Actor's `getOccupiedSlots` conflated `undefined` (key never written →
> empty agenda) with `null` (a stored value → must validate). The fix is a
> > one-line narrowing: only `undefined` returns empty; `null` goes through
> > validation and throws. A test that expected `null` to return `[]` was
> > replaced with one that expects `null` to reject. Global tests stayed at 126.

## DayAgenda.createBooking: client-provided clock in the Actor input

### Context

`DayAgenda.createBooking` validates slot eligibility (e.g. `slot_in_past`)
against the current time. The original implementation accepted `now` as a
field in `CreateBookingInput`, injected by the caller. The agreed design
(after the 2.4a plan review) requires the Actor to obtain the clock itself
— after idempotency lookup, immediately before admission validation — so
that the caller cannot influence which slots are eligible and replays
bypass admission regardless of how much time has passed.

### Discovery

The 2.4b initial implementation used `const now = input.now` inside the
Actor. This contradicted the revised plan, which explicitly states:

- Obtain current time inside the Actor when processing a NEW booking, after
  replay lookup.
- Make the clock controllable in tests without exposing a public RPC clock
  setter or trusting client-provided time.

The bug was found during implementation review, before HTTP wiring or
deployment. No production booking was attempted with a client-supplied
timestamp.

### Root cause

`CreateBookingInput` had a `now: number` field. The handler or any
caller could pass any timestamp, enabling a request to claim a slot that
had already started by lying about the current time. Even if the handler
always passed `Date.now()`, the Actor's public API accepted the value as
untrusted input, violating the "backend is the authority" principle from
`booking-domain.md`.

A related risk: if `now` was obtained before the storage read (in the
handler or at the top of the Actor method), a slow storage read could
produce a stale `now` — the slot might have started during the read but
the Actor would still admit it. The clock needed to be sampled **after**
idempotency lookup (for new bookings only), so that the admission instant
is as close to the write as possible.

### Risk

A client-supplied `now` could be manipulated to book past slots or bypass
`slot_in_past` validation. This is a **potential security and correctness
risk**, not an observed incident. The bug was discovered and corrected with
mocked tests before any HTTP route was wired or deployed.

### Fix

1. **Removed `now` from `CreateBookingInput`.** The type no longer has a
   `now` field; callers cannot supply a timestamp.

2. **Actor obtains `Date.now()` internally**, after the idempotency lookup
   and before admission validation:
   ```ts
   // After idempotency replay/conflict checks pass:
   const now = Date.now();
   // ... uses `now` for isDateInWindow, isSlotPast, and created_at
   ```
   The same instant is used for all time-dependent validation and for the
   `created_at` field of the persisted booking.

3. **Tests use Vitest clock mocking** (`vi.useFakeTimers()` /
   `vi.setSystemTime()`), not an injected `now` parameter. No public clock
   setter exists on the Actor.

4. **Replay-first behavior preserved.** The clock is never sampled for
   idempotent replays — those return the original booking without any
   time check, per [C6].

### Regression coverage

Two new dedicated regression tests were added:

1. **Clock advances during storage read → slot rejected:**
   Clock starts at 09:59 (slot 10:00 is still future). The storage read
   callback advances the clock to 10:01. At admission time the slot has
   started → `slot_in_past`. No write. This verifies that `Date.now()` is
   sampled after the read, not before.

2. **Identical replay succeeds despite clock advance:**
   First call at 08:00 creates a booking for 10:00. Replay at 15:00
   (storage read further advances clock to 17:00). Replay returns the
   original `booking_id` — admission is bypassed via idempotency ([C6]).
   No write. This verifies that replays never sample the clock.

All existing createBooking tests were converted from `input.now` to
`vi.setSystemTime`. The total agenda-actor test count went from 53 to 55
(2 new regression tests).

### Evidence

- `npm run typecheck` (`tsc --noEmit`) — **0 errors**
- `npm run test` (`vitest run`) — **191/191 passed**, including 55 mocked
  Actor tests
- The `now` field no longer exists in `CreateBookingInput`; TypeScript
  would reject any caller attempting to pass it.

### Limits

- Discovered and verified with **mocked tests** before HTTP wiring or
  deployment. No production incident is claimed.
- The clock is `Date.now()` on the Actor's Node process — real-runtime
  clock skew between the handler and Actor container is not a concern
  (same container), but clock skew across geographically distributed Actor
  instances is not tested.
- `vi.useFakeTimers` controls the clock in test only; in production the
  Actor has no mechanism to receive a mocked timestamp.

### Interview explanation

> `createBooking` accepted `now` from the caller, allowing a client to
> claim past slots by lying about the time. The fix removes `now` from the
> input type; the Actor calls `Date.now()` itself after the idempotency
> check, so only new bookings sample the clock and replays bypass
> admission entirely. Tests use Vitest's `vi.setSystemTime` instead of an
> injected parameter. A regression test verifies that a slot which starts
> during a slow storage read is rejected.

## DayAgenda `__proto__` idempotency key lost on persistence round-trip

### Context

`DayAgenda.createBooking` stores a `DayAgendaState` aggregate containing a
`bookings` record keyed by slot time and an `idempotency` record keyed by
the client-supplied idempotency key. On a replay, `validateState()` reads
the persisted state, builds fresh records, and uses `hasOwn()` to look up
the idempotency entry. If the key is `"__proto__"`, the assignment
`idempotency[key] = ...` on a plain `{}` object silently sets the prototype
instead of creating an own property — so `hasOwn()` never finds it, the
entry is lost on `{ ...state.idempotency }` spread, and the replay returns
`slot_unavailable` instead of the original booking.

### Discovery

The bug was identified by code review prompted by the observation that a
booking with `idempotency_key: "__proto__"` succeeds on the first call but
returns `{ ok: false, code: "slot_unavailable" }` on identical replay after a
storage round-trip. Existing tests did not catch it because the mocks returned
live object references — the `__proto__` assignment landed on the prototype
but the test could still read it (the live object had the prototype set), and
no JSON serialization step existed in the test harness.

### Root cause

`validateState()` built records with plain object literals:

```ts
const bookings: Record<string, Booking> = {};
const idempotency: Record<string, IdempotencyEntry> = {};
```

JavaScript's `{}` object has a prototype chain with a `__proto__` setter.
Assigning to `obj["__proto__"]` on such an object triggers the setter rather
than creating an own enumerable property. `hasOwn(".__proto__")` returns
`false` — the entry was never stored as own data. On the next read, the
entry is gone from `Object.entries()` and from `{ ...spread }`, so the
Actor treats the replay as a new attempt and rejects it as `slot_unavailable`.

`createBooking` also used spread (`{ ...state.idempotency }`) to build the
new aggregate, which produces a plain `{}` — so even if the loaded state
had a null-prototype idempotency record, the write would reintroduce the bug
on the next round trip.

### Risk

Any idempotency key that collides with a prototype property name (primarily
`"__proto__"`) would silently lose its booking on replays after a storage
round-trip. The booking itself persisted (in `bookings[time]`), but the
idempotency link was lost, so replays created a duplicate attempt that was
rejected as `slot_unavailable` — correct rejection (slot occupied) but
wrong reason (should be replay, not conflict). The customer would see a
failed retry for a booking that succeeded. This is a correctness risk, not
a security or double-booking risk.

### Fix

Build both `bookings` and `idempotency` records with `Object.create(null)`
in `validateState()`:

```ts
const bookings = Object.create(null);
// ... bookings[key] = validateBooking(...)
const idempotency = Object.create(null);
// ... idempotency[key] = validateIdempotencyEntry(...)
```

Also fixed `createBooking`'s `newState` construction to use
`Object.assign(Object.create(null), ...)` instead of spread:

```ts
const newBookings = Object.assign(Object.create(null), state.bookings);
newBookings[time] = newBooking;
const newIdempotency = Object.assign(Object.create(null), state.idempotency);
newIdempotency[key] = { ... };
```

The persisted JSON shape is unchanged — `JSON.stringify` of a null-prototype
object produces the same output as a plain object. Existing remote state is
unaffected. On the next read, `validateState()` reconstructs with null
prototypes, so even existing persisted data with `"__proto__"` keys (from
before the fix) is now handled correctly.

### Regression coverage

A new `test/support/fake-actor-storage.ts` provides an in-memory
`ActorStorage` fake whose `put()` serializes via `JSON.stringify` and `get()`
returns a `JSON.parse`d fresh copy — mimicking real persistence so live
reference tricks no longer hide the bug.

Three regression tests cover `"__proto__"`, `"constructor"`, and
`"hasOwnProperty"`: each creates a booking, then issues an identical replay
through the serializing fake, and asserts the same `booking_id` is returned
with `put()` called exactly once. These tests failed before the fix (for
`"__proto__"`) and pass after.

### Evidence

**Before fix (failing):**
```
× regression: reserved-key idempotency survives JSON round-trip
  > replay of "__proto__" through serializing fake returns booking_id
  → expected false to be true
Tests  1 failed | 4 passed | 53 skipped
```

**After fix (passing):**
```
✓ test/agenda-actor.test.ts (58 tests)
Tests  235 passed (235)
```

- `npm run typecheck` — **0 errors**
- `npm run test` — **235/235 passed** (was 232; +3 regression tests)
- Changed files: `src/agenda-actor.ts` (null-prototype records + Object.assign in createBooking), `test/agenda-actor.test.ts` (3 new regression tests), `test/support/fake-actor-storage.ts` (new fake storage)

### Interview explanation

> `validateState()` built idempotency records with `{}`, so
> `obj["__proto__"] = entry` hit the prototype setter instead of creating an
> own property. On replay, `hasOwn("__proto__")` returned false, the entry
> was lost, and the Actor treated the replay as a new booking — rejected as
> `slot_unavailable`. The fix uses `Object.create(null)` for both records and
> `Object.assign(Object.create(null), ...)` in `createBooking`'s spread. A
> serializing fake storage (`JSON.stringify` / `JSON.parse`) was added to
> reveal the bug that live-reference mocks hid.

## Persisted agenda: record-key mismatch not validated

### Context

`DayAgenda.validateState()` checked each booking's own fields and each
idempotency entry's reference back to its booking. It did not verify that
the record key equalled the booking's own `time` field, or that an
idempotency record key equalled the referenced booking's
`idempotency_key`. A key mismatch (e.g. `bookings["10:00"]` containing a
booking with `time: "11:00"`) would silently desynchronize the in-memory
aggregate from the record contents.

### Discovery

Found by code review of the phase 2 booking domain — no production
incident is claimed. The pre-fix validator would accept the inconsistent
record and return the (now-misaligned) occupied slots downstream.

### Fix

In `validateState`, after each booking is validated, require
`booking.time === key`. After each idempotency entry is validated,
require the referenced booking's `idempotency_key === key`. Both
mismatches throw, so the caller maps to a generic 503 rather than
returning an empty or misaligned availability result. Existing booking
ID/date/reference validation is preserved.

## Body-reader: rejected read and rejecting cancel escaped the handler

### Context

`readBoundedBody()` in `src/bookings.ts` only awaited `reader.read()` and
`reader.cancel()` directly. Two failure modes were not handled:

1. A rejected `read()` (e.g. aborted connection) bubbled out of the
   function as an unhandled error.
2. The `cancel()` on the oversized-body path was `await`ed without a
   guard. If it rejected, the 413 response was never delivered and the
   caller saw a thrown error.

### Discovery

Found by code review — no production incident is claimed. The 10 KiB
byte limit and bounded buffering were not changed.

### Fix

Wrap `reader.read()` in a local `try/catch` that returns
`{ ok: false, status: 400 }` on rejection. Move `reader.cancel()` into a
`finally` block that swallows any rejection so the reader lock is always
released and the response (413 for oversized, 400 for read failure) is
always delivered. The handler maps both variants to the correct public
response codes without logging raw exception messages, body content, or
credentials.

## Occupancy response: malformed and duplicate slot values were silently accepted

### Context

`getAvailability()` validated only that `occupied` was an array of
strings. A non-canonical value like `"10:0"` (passes `typeof ===
"string"`) or a duplicate entry would be silently accepted. The
subsequent `new Set(occupied)` even deduplicated duplicates for free,
masking the corruption. The downstream `slots` array could over-report
availability if the Actor returned bad data.

### Discovery

Found by code review of the Actor-response validator in
`src/availability.ts` — no production incident is claimed.

### Fix

Import `SLOT_START_TIMES` from `domain/business-rules.ts` (the same
shared rule the Actor uses for persisted slot validation) and require
every entry in `occupied` to be a string in that set, with no
duplicates. Any failure returns `{ kind: "service_unavailable" }` —
fail-closed, no silent dropping. Valid empty and populated responses
still parse and produce the same `slots` output.
