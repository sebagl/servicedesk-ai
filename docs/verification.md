# Verification

What has been verified, where, and what has not. "Remote" means the deployed
function at `https://servicedesk-ai-a666861a-1.telnyxcompute.com`; "live call" means a
real Telnyx Assistant web call.

## Automated tests

```bash
npm run typecheck   # strict TypeScript: 0 errors
npm test            # 601 tests, mocked runtime
```

Coverage highlights: scheduling rules and time-zone independence (run under UTC,
New York and Los Angeles process time zones), Actor admission and idempotency, the
conversation booking state machine, webhook signature verification, auth gates on
every route, MCP tool contracts, metrics never breaking a request, and no customer
data in logs or responses. The test actor storage serializes values like the real
runtime.

## Platform behavior (local runtime and remote)

| Check | Result |
|---|---|
| Actor state survives a full local stack restart | Value read back unchanged |
| 20 concurrent increments on one Actor (local) | Exactly 1…20, no lost updates |
| KV config read from the deployed function | Seeded catalog returned |
| `booking_enabled` toggled in KV, no redeploy | Change visible on the next request; restored afterwards |

## Booking domain (remote)

| Check | Result |
|---|---|
| Availability for a weekday | 8 slots 09:00–16:00 in `America/Mexico_City` |
| Create a booking, then retry it | Same `booking_id`; slot shown as taken |
| Different request for a taken slot | `slot_unavailable` |
| Same idempotency key with changed details | `idempotency_key_conflict` |
| 20 concurrent requests for one slot (5 at a time) | 1 confirmed, 19 `slot_unavailable`, 0 errors |
| Bookings disabled in KV | Retry of an existing booking still returns it; a new booking gets `booking_disabled` |

## MCP server (remote)

| Check | Result |
|---|---|
| `initialize`, `tools/list` | 4 tools with strict schemas |
| Request without bearer token | `401` |
| `get_service_catalog`, `get_availability` | Live KV data and Actor occupancy |
| `create_booking` through `ConversationBooking` (actor → actor) | Confirmed; identical retry returns the same `booking_id`; a second booking in the same conversation gets `conversation_already_booked` |
| `request_callback` through `DayCallbacks` | `status: recorded`; visible in the portal |

## Live web calls (2026-10-19)

All calls went through the real Telnyx Assistant, so webhook deliveries carried real
Telnyx signatures.

| Scenario | Result |
|---|---|
| Ask for services | Catalog read; caller told the services; call ended cleanly |
| Book an oil change | Times offered from availability; read-back; `create_booking ok` |
| Ask for a taken time | Not offered; alternatives proposed |
| Ask for Saturday | Closed day explained; weekday suggested |
| Ask for a person | `request_callback ok`; request visible in the portal |
| Second booking in the same call | `conversation_already_booked` |
| Bookings disabled in KV | Routed to Bookings Paused; no booking created |
| Trace | Same `telnyx_conversation_id` on the webhook line and on every tool call |

Issues found in these runs and their fixes: [debugging.md](debugging.md) (bugs 2, 4, 5).

## Scope

- Calls were made through Telnyx web calls; the trial account had no purchasable phone
  number. Evaluators use the password-protected `/call` page.
- The stale-config fallback (debugging bug 2) is verified by automated tests.
- Concurrency was verified with 20 simultaneous requests for one slot; no load testing
  beyond that.
