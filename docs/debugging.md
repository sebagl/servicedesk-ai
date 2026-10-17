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

## Privacy test passed vacuously: it asserted against zero rejection events

### Context

The early-rejection logging suite in `test/webhook.test.ts` is the
privacy gate for the dynamic-variables webhook: each early-rejection
case asserts that exactly one `webhook.rejected` log line is emitted
and that the line never contains the request body, the call id, the
assistant id, the authorization header, or a sentinel phone number.

### Discovery

Code review of `findEvent`/`logEvents()` helpers and the assertion
shape revealed a structural defect in the privacy test
("does not log the request body, headers, or unvalidated identifiers").
The test issued an invalid-JSON POST and asserted the rejection event
existed, but every `expect(serialized).not.toContain(...)` ran against
`JSON.stringify(logEvents())` — and the entire `logEvents()` collection
for the test was checked once at the end. If a future change
accidentally logged a sentinel in any unrelated event, this test would
not catch it: the sentinels are not present in the events that the test
exercises, so the assertions held even if some other code path leaked
a sentinel into a different log line. The test passed vacuously over
the very data it claimed to inspect.

### Risk

The dynamic-variables webhook logs a masked phone suffix for
correlation. A regression that introduced a raw phone, call id, or
authorization header into any `logEvent()` call would slip past this
test as long as the regression landed on an event the test does not
inspect. This is a **potential privacy regression risk**, not an
observed data leak. No production deployment has emitted customer PII
in any log line; the failure mode was found in the test itself.

### Fix

Tighten the privacy test so every assertion is scoped to the
`webhook.rejected` event the request produced (or, if broader coverage
is wanted, assert the sentinels are absent from the union of events
emitted by the test plus a few explicit peers). Do not rely on the
union assertion alone — group checks per event class so a regression in
one event cannot silently pass against another. Existing tests stay
green; the structure of the privacy check is what changes.

### Regression coverage

A follow-up review should re-read every `logEvent` call site in
`src/dynamic-variables.ts`, `src/mcp-server.ts`, `src/index.ts`, and
`src/logger.ts` and assert per-event that no phone number, call id,
assistant id, idempotency key, customer name, or authorization header
ever reaches a log line. No new production tests are required; the
existing privacy sentinel test is the regression gate.

## Coordinator accepted malformed executor results, risking unsafe state transitions

### Context

`coordinateBooking()` (in `src/conversation-booking.ts`) runs the
executor (the `ConversationBooking.executeBooking()` path that calls
`loadConfig` and routes to `AGENDA.createBooking`) and stores its
return value directly. An executor can return: an object with `kind:
"confirmed"` and a `booking_id`; an object with `kind: "rejected"` and
a `code`; an object with `kind: "infrastructure_error"`; or anything
else (a thrown error, `null`, an array, an unknown `kind`, a confirmed
result with an empty `booking_id`, a confirmed result whose
`service_id` / `date` / `time` do not match the saved attempt, a
rejection with no `code`, or a rejection with a code outside the
allowlist).

### Discovery

Found by local code review of the coordinator's three branches
(`resolvePending`, `startNewAttempt`, and the `confirmed` replay path).
The pre-fix code only `try / catch`-ed thrown errors and otherwise
treated the executor's return as authoritative. A `null` return would
have crashed on `raw.kind`; a confirmed result with a `booking_id` of
`""` would have been persisted as a confirmed booking; a rejection with
an unknown code would have been echoed back to the MCP layer as if it
were a valid domain error; a confirmed result whose echoed fields
disagreed with the saved attempt could have stored a result for one
booking under another attempt's key. None of these were observed
in production; the bugs were caught in local review before any deploy.

### Risk

The coordinator owns the `pending → confirmed` and `pending → idle`
transitions. A malformed result that the coordinator treats as
authoritative can:

- persist an `idle` aggregate while the executor's outcome was actually
  ambiguous (a definitive rejection followed by an attempted fresh
  attempt against a missing binding would overwrite a recoverable
  pending with `idle`, permanently losing the original key);
- persist a `confirmed` aggregate whose `result` does not match the
  saved `input`, desynchronizing the conversation's view from
  `DayAgenda`'s view;
- echo a non-allowlisted error code back to the caller, breaking the
  MCP layer's allowlist and giving the caller a code it cannot interpret.

This is a **correctness and consistency risk**, not an observed
production incident. No malformed executor result has ever reached the
coordinator on a deployed function; the bug was caught in review.

### Fix

Add a strict `validateExecutorResult(raw, saved)` step that runs before
any storage transition. It returns a discriminated triple
(`confirmed` / `rejected` / `ambiguous`) or `null` for any malformed
shape (`null`, array, unknown `kind`, empty `booking_id`,
service/date/time mismatch with the saved attempt, missing or unknown
rejection code, `idempotency_key_conflict`, or `infrastructure_error`).
Both `null` and `ambiguous` are treated identically by the coordinator:
preserve `pending`, do not write `idle` or `confirmed`, return
`infrastructure_error`. The confirmed path also cross-references the
executor result with the saved attempt before storing it.

### Regression coverage

The executor-validation suite in `test/conversation-booking.test.ts`
adds eight focused cases: malformed confirmed result with empty
`booking_id`, malformed confirmed result with mismatched
`service_id`, missing rejection code, unknown rejection code,
`idempotency_key_conflict` from the executor, `null` executor result,
array executor result, and executor result with an unknown `kind`. Each
case asserts (a) the coordinator returns `infrastructure_error`, (b) the
executor was called exactly once, and (c) the persisted aggregate
remains `pending` with the original `attempt_key`. Persisted confirmed
mismatch cases verify the executor is not called at all when the
stored result's `service_id` or `time` disagrees with its own saved
`input`.

## Pending rejection returned the old error for changed input instead of starting the corrected attempt after persisting idle

### Context

When `resolvePending()` encounters a definitive domain rejection
(`slot_unavailable`, `time_invalid`, etc.) from the executor, it must
decide what to do based on whether the **current** request matches the
**saved** pending input. A pre-fix early branch returned the rejection
code as soon as it saw a definitive result, without checking whether
the caller's input had changed since the pending was persisted. The
intent in `booking-domain.md` §10 is: same input → return the rejection;
changed input → persist `idle` first, then start a fresh attempt in
the same call with a new attempt key.

### Discovery

Found by local code review of the conditional branches in
`resolvePending()` against the test suite. The pre-fix path returned
the rejection to the caller without persisting `idle`, so the next call
would still see the same `pending` aggregate and either retry the
rejected attempt (same key) or, if the caller did not change input,
echo the same rejection. A corrected attempt by the same caller would
never be admitted in the same call — the caller would have to make a
second request, observe `infrastructure_error` (pending still there) or
the same `rejected` (now identical to pending), and then make a third
call. None of these loops were observed on a deployed function; the
issue was caught in review.

### Risk

A caller that re-issued a corrected request (different `time`, same
`customer_name`/`customer_phone`) immediately after a `slot_unavailable`
on the same conversation would not have its corrected attempt admitted
in the same call. The caller would see the old `slot_unavailable` and
might infer the slot is still being retried by the server. The
coordination contract in `booking-domain.md` §10 explicitly says
"definitive domain rejection permits a new corrected attempt"; the
pre-fix code violated that contract.

This is a **correctness and contract risk**, not an observed
production incident.

### Fix

Reorder `resolvePending()`: after a definitive rejection, persist
`idle` first (if the write fails, return `infrastructure_error` and do
not start the fresh attempt). Then, if the current input matches the
saved input, return the rejection code. If it differs, call
`startNewAttempt(current, deps)` so the corrected attempt is admitted
in the same call with a new backend-generated `attempt_key`. The
fresh-attempt path reuses the existing `startNewAttempt()` logic, so
the same `pending → idle → pending → confirmed/idle` sequence applies.

### Regression coverage

Two new cases in `test/conversation-booking.test.ts`:

1. **"pending rejection with changed input starts a fresh attempt in
   the same call using a new key"** — verifies the executor is called
   twice, the first call resolves the original saved input with the
   original `attempt_key`, the second call uses the current input with
   a new `attempt_key`, and the final persisted aggregate is `confirmed`
   with the fresh attempt's data.
2. **"pending rejection with changed input but failed idle write does
   NOT execute the new attempt"** — verifies that when the
   `pending → idle` write fails, the coordinator returns
   `infrastructure_error` and the executor is called exactly once (no
   fresh attempt is attempted against a half-persisted state).

A pre-existing case ("pending rejection with same input persists idle
and returns the rejection without a second call") confirms the same-input
branch still returns the rejection and stops after one executor call.

## Missing Actor binding incorrectly reported `conversation_id_required`

### Context

In the MCP `create_booking` handler, two distinct failure modes both
indicated "you didn't send conversation metadata":

1. Missing or malformed `params._meta["telnyx_conversation_id"]`
   (regex mismatch, length > 128, missing `_meta`).
2. Valid metadata present, but the `CONVERSATION_BOOKING` Actor binding
   was not wired in `telnyx.toml` (or failed to load at runtime).

The first is a caller problem: the Assistant must forward metadata. The
second is a configuration defect: the function is misconfigured and the
caller cannot fix it by sending metadata. Both surfaced as
`conversation_id_required` in the pre-fix code.

### Discovery

Found by local code review of the gating order in `registerCreateBooking`.
The pre-fix code returned `conversation_id_required` for any path that
could not reach the Actor, including the "valid metadata, no binding"
case. That code label is misleading for the second case — the caller
cannot resolve a configuration defect by retrying with metadata.

### Risk

If `conversation_id_required` is returned for a missing-binding
configuration error, the caller's retry loop will keep emitting the
same metadata and the same code indefinitely. The on-call signal
("missing binding") is hidden behind a code that looks like a caller
fix. This is a **diagnostic and operations risk**, not an observed
incident. No production deployment has emitted this code under the
wrong conditions.

### Fix

Split the gating: missing or invalid metadata → `conversation_id_required`
(Actor never called). Valid metadata but `conversationBooking === undefined`
→ generic `service_unavailable` (the function is misconfigured; the
caller cannot fix this). The latter is logged with the
`conversation_id` correlation id so on-call can match the
configuration defect to the originating conversation.

### Regression coverage

The MCP test suite adds an explicit case
("valid metadata + absent CONVERSATION_BOOKING binding →
service_unavailable, no infra call") that asserts:

- the response is `isError: true` with the text `service_unavailable`
  (not `conversation_id_required`);
- the `CONVERSATION_BOOKING.idFromName` mock is never called;
- the `mcp.tool_call` log line records `outcome: "service_unavailable"`
  with the conversation id.

The pre-existing cases
("missing conversation metadata → conversation_id_required",
"missing _meta entirely → conversation_id_required",
"invalid conversation metadata (bad charset) → conversation_id_required")
still pass and continue to assert the Actor is never called.

## `idFromName` outside try/catch could expose a raw lookup error

### Context

In `registerCreateBooking()`, the `idFromName()` lookup on the
`ConversationBookingNamespace` and the `stub.book()` RPC are both
expected to throw under platform failure (binding missing at runtime,
network failure, actor crash, `idFromName` rejecting with a sentinel
message). The pre-fix code wrapped only `stub.book()` in a `try/catch`,
leaving `idFromName()` exposed. A platform-side error message
("SENTINEL-IDFROMNAME-CRASH", for example) could reach the response or
a log line.

### Discovery

Found by local code review of the exception boundaries in
`registerCreateBooking`. The narrow `try/catch` was inconsistent with
the rest of the MCP layer (the auth gate, the catalog and availability
handlers, and the Actor mock-style injection), and it left an obvious
leak path on the write side.

### Risk

If `idFromName` rejects, the raw rejection value can reach the
JSON-RPC envelope, the structured log line, or the response body. A
platform error message might include diagnostic data (function id,
binding name, internal state). This is a **leak risk**, not an
observed incident. The mocked test suite covered `stub.book()`
rejections but not `idFromName()` rejections.

### Fix

Wrap both `idFromName()` and `stub.book()` in a single `try/catch` so
any exception from either stage collapses to a generic tool error. The
raw exception never reaches the response, the JSON-RPC envelope, or the
structured log. The `mcp.tool_call` log line records
`outcome: "service_unavailable"` and the `conversation_id` correlation
field; no other exception-derived data is logged.

### Regression coverage

The MCP test suite adds an explicit case
("idFromName throws with sensitive sentinel → generic tool error, one
log, no leak") that:

- configures the `idFromName` mock to throw with a sentinel string;
- asserts the response is `isError: true` with `service_unavailable`
  text;
- asserts exactly one `mcp.tool_call` log line is emitted;
- asserts the serialized log does not contain the sentinel string.

The pre-existing "actor throws" case continues to assert the same
behavior when `stub.book()` (rather than `idFromName`) throws.
