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
