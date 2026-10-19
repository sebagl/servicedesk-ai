# Debugging log

Seven representative bugs. The first five were found in production through the
structured logs and CLI evidence; the last two were caught during development.
Log lines are copied from `telnyx-edge logs servicedesk-ai` (phone numbers are
masked by the logger).

| # | Bug | Found through |
|---|---|---|
| 1 | Webhook secret lookup slower than its timeout | `webhook.rejected` + `webhook.key_lookup_completed` timing |
| 2 | Cold KV read reported bookings as disabled | `config_outcome=timeout` on `webhook.dynamic_variables` |
| 3 | Callback actor type unreachable on the platform | `portal.report_failed` + `telnyx-edge actors` |
| 4 | Model sent the display name as `service_id` | `mcp.tool_call` outcome sequence |
| 5 | MCP tools usable from nodes that should not book | webhook flag vs tool calls on the same conversation id |
| 6 | Invalid stored state read as an empty agenda | development review |
| 7 | `__proto__` idempotency key lost after persistence | development review + serializing test storage |

---

## 1. Webhook secret lookup slower than its timeout (503 on every delivery)

**Symptom.** After enabling Ed25519 signature verification, every delivery to
`/webhooks/dynamic-variables` returned `503`, so the assistant never received its
variables.

**Evidence.** The first version logged every key failure as the same
`reason: key_unavailable`, which could mean a missing, malformed or slow key. We
added distinct reasons and a completion event with timing; the next deliveries
showed:

```text
webhook.rejected              reason=key_timeout  http_status=503      (at 503 ms, bound 500 ms)
webhook.key_lookup_completed  outcome=ok  after_timeout=true  elapsed_ms=677
webhook.key_lookup_completed  outcome=ok  after_timeout=false elapsed_ms=708   (warm, bound 1000 ms)
```

**Root cause.** Reading the public key from Edge secrets takes ~560–710 ms in
production. The first deadline was 200 ms, so the lookup always lost the race and
the handler failed closed.

**Fix.** Deadline raised to 1000 ms, and a successful key read is cached per
instance (failures are never cached). After the fix, the first call on an instance
pays the lookup and the next ones skip it:

```text
webhook.key_lookup_completed  outcome=ok  elapsed_ms=559  cached=false
webhook.key_lookup_completed  outcome=ok  elapsed_ms=0    cached=true
```

**Lesson.** One generic failure reason hid three different causes. Splitting the
reasons and logging the elapsed time turned a guess into a number.

---

## 2. Cold KV read reported bookings as disabled

**Symptom.** In the first end-to-end web call the conversation went well, but the
webhook had told the assistant that bookings were disabled and the system degraded,
while `booking_enabled` was `true` in KV.

**Evidence.**

```text
17:41:42 webhook.key_lookup_completed  elapsed_ms=580 cached=false
17:41:42 webhook.dynamic_variables     system_status=degraded booking_enabled=false
                                       config_outcome=timeout latency_ms=1400
```

**Root cause.** On a cold instance the KV config read exceeded its 800 ms bound
(sized for Telnyx's default 1.5 s webhook timeout), so the webhook answered with its
safe fallback: bookings off.

**Fix, round 1.** Assistant webhook timeout raised to 5000 ms, config bound raised to
2500 ms, successful config cached for 30 s, and `telnyx_conversation_id` added to the
webhook log line so it can be joined with the tool calls of the same call.

**Round 1 was not enough.** The next test run showed a cold read slower than 2500 ms:

```text
18:31:01 webhook.dynamic_variables  telnyx_conversation_id=ce937e0d-…
                                    system_status=degraded booking_enabled=false
                                    config_outcome=timeout latency_ms=2510
```

**Fix, round 2.** When KV is slow or failing, the webhook now uses the last good
config (up to 10 minutes old) and logs `config_outcome: "stale"`. Only an instance that
has never read KV degrades. Covered by tests for the stale path and for configs older
than 10 minutes.

---

## 3. Callback actor type unreachable on the platform

**Symptom.** The operator portal showed `Service unavailable (503)` on Appointments and
KPIs, while Observability worked.

**Evidence.** The portal route returned 503 without logging why, so the first step was
to log the reason. The next requests showed:

```text
portal.report_failed route=/api/appointments
  reason="actor invocation …__CallbackQueue/main.listCallbacks returned 500:
          error invoke actor method: failed to lookup actor"
```

Narrowing it down:

- Portal auth worked (`/api/observability` 200, bad token 401).
- Every day agenda was healthy (`get_availability` OK for all 7 days).
- Writes failed too: `request_callback` returned `service_unavailable`.
- `telnyx-edge actors list`: `CallbackQueue` registered and `ready`.
- `telnyx-edge actors instances CallbackQueue`: instance `main` with **0 B** of state.
- `telnyx-edge actors logs CallbackQueue`: **no logs** — invocations never reached it.

**Root cause.** The actor type was registered but the platform could not place it at
invocation time. It had never worked remotely; the unit tests mock the runtime.

**Fix.** Redesigned the queue as a per-day actor (`DayCallbacks`, `callbacks-YYYY-MM-DD`),
which is also a better fit for "one actor per entity" than a single global queue, and is
registered as a new type. Verified remotely:

```text
request_callback → {"status":"recorded","request_id":"94d86792-…"}
/api/appointments → 200 callbacks_ok=true
/api/kpis         → 200 callbacks_ok=true pending_callbacks=1
```

The portal now degrades instead of failing: if callbacks cannot be read, bookings are
still shown and `portal.report_partial` is logged. Reported to Telnyx as platform
feedback, together with `ship` not removing the old binding.

---

## 4. The model sent the display name as `service_id`

**Evidence.** One conversation, in order:

```text
18:40:36 mcp.tool_call tool=create_booking      outcome=unknown_service     conv=12ca088f-…
18:40:37 mcp.tool_call tool=get_service_catalog outcome=ok                  conv=12ca088f-…
18:40:38 mcp.tool_call tool=create_booking      outcome=ok                  conv=12ca088f-…
```

**Root cause.** The model booked with the service name ("Oil Change") instead of the
catalog id (`oil_change`). It recovered by reading the catalog and retrying, but only
because the error code was specific.

**Fix.** The `create_booking` input schema now describes `service_id` as "service id
from `get_service_catalog`, e.g. `oil_change` — not the display name" (also `date` and
`time` formats), and the Collect Details node tells the model to use catalog ids.

---

## 5. MCP tools usable from nodes that should not book

**Evidence.** Two calls where the webhook said bookings were off:

```text
18:31:01 webhook.dynamic_variables booking_enabled=false   conv=ce937e0d-…
18:31:51 mcp.tool_call create_booking outcome=ok           conv=ce937e0d-…

18:46:21 webhook.dynamic_variables booking_enabled=false config_outcome=ok conv=46e8f806-…
         (assistant offered a callback for an oil change; no request_callback was logged)
```

**Root cause.** The portal attaches MCP servers at assistant level, so every workflow
node can call every MCP tool. "Bookings Paused" restricted tools only by instructions,
and the model sometimes ignored them.

**Fix.** Node instructions now forbid booking and callbacks explicitly in Bookings
Paused. The real guard stays in the backend: the day Actor re-reads the flag and rejects
with `booking_disabled` when bookings are off in KV (verified remotely), confirmation is
required, and a conversation can book only once. Bug 2's stale-config fix also removes
the false "disabled" that caused the first call.

---

## 6. Invalid stored state read as an empty agenda (development)

**Found by** reviewing an implementation report against the spec: `getOccupiedSlots`
treated both `undefined` and `null` from storage as "no bookings yet".

**Risk.** If the stored aggregate ever became `null` or malformed, the day would show
every slot as free and allow double bookings.

**Fix.** Only `undefined` (key never written) means an empty agenda; anything else must
pass validation or the Actor throws and the caller answers `503`. The test that
asserted the wrong behavior was replaced by one that requires the rejection.

---

## 7. `__proto__` idempotency key lost after persistence (development)

**Found by** code review, then reproduced with a test storage that serializes values
like the real runtime.

**Symptom.** A booking with idempotency key `__proto__` succeeded, but an identical
retry returned `slot_unavailable` instead of the original booking.

**Root cause.** Rebuilding the idempotency map on a plain `{}` turned
`map["__proto__"] = …` into a prototype assignment, so the entry was silently dropped.
The existing tests passed because their mock storage returned live objects and never
serialized.

**Fix.** Records are rebuilt on null-prototype objects, and the shared test storage now
serializes on every write, so tests see what the platform persists.
