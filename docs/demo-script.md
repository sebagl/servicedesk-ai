# Demo script

Total: ~8–10 min live demo, then ~7–10 min walkthrough.

**Before starting:** portal open on Observability (`/portal`), a terminal running
`telnyx-edge logs servicedesk-ai --tail`, the assistant page ready for a call, and
`booking_enabled = true` in KV.

## Live demo (8–10 min)

1. **The problem (30 s).** A small repair shop misses calls while mechanics work; every
   missed call is a missed booking.
2. **Happy path call (3 min).** "I'd like an oil change on Thursday."
   - Disclosure (speak node) → intent → the assistant offers real open times.
   - Point at the logs: `webhook.dynamic_variables` (signed delivery, today's date,
     `booking_enabled=true`), then `get_availability` and `create_booking` with the same
     `telnyx_conversation_id`.
   - Portal → Appointments: the booking appears.
3. **Edge cases in the same call or a second one (2 min).**
   - Ask for a taken time → not offered, alternatives proposed.
   - "Can I come on Saturday?" → closed day explained.
   - Ask to book again in the same call → `conversation_already_booked` in the log.
4. **Escalation (1 min).** "I want to talk to a person." → callback recorded
   (`request_callback`, `callback.requested`), visible in the portal. No fake transfer.
5. **Feature flag without redeploy (1.5 min).** Set `booking_enabled=false` in KV, call
   again: the variable-comparison edge routes to Bookings Paused. Restore the flag.
6. **Observability and business view (1 min).** Observability tab (counters, latency,
   recent events) and Business KPIs (callers who checked availability but did not book
   → the case for a follow-up bot).

## Walkthrough (7–10 min)

1. **Architecture** — README diagram: Assistant → Workflow → Edge Function → KV /
   Actors → MCP, all in one function.
2. **Workflow design** — speak nodes for verbatim text; variable comparison for the
   flag, LLM conditions for intent; Append everywhere, Replace only in End Call; why
   tool scoping is enforced in the backend.
3. **MCP server** — four tools, one file each; conversation id from `_meta`, set by the
   platform rather than the model.
4. **Dynamic variables** — the flag drives routing; date variables let the model turn
   "next Monday" into a real date in the shop's time zone.
5. **KV vs Actor vs function** — the table in the README; the 20-concurrent-request test
   (1 booked, 19 rejected).
6. **Hardest bug** — [debugging.md](debugging.md) #2 or #3: the log line that exposed
   it, the fix, and the log line that confirmed it.
7. **Telnyx Inference** — OpenCode config, models used, and the context-cost lesson.
8. **Platform feedback** — the list at the end of the README.
