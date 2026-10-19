# Architecture

## Status

The booking-domain core is implemented: Telnyx Edge `telnyx.toml` manifest,
`fetch` handler with public/health, demo, MCP, and dynamic-variables routes,
KV-backed service catalog + business config, and a per-location/day
`DayAgenda` StatefulActor owning authoritative occupancy and idempotency.

The AI receptionist layer (Voice AI Assistant, Conversation Workflows, phone
integration, monitoring, and the operations portal) is **planned, not
implemented** in this repo. The HTTP and MCP adapters are the only entry
points today.

## HTTP routes (`src/http/router.ts`)

| Route | Auth | Purpose |
|---|---|---|
| `GET /health` (and `/health/liveness`, `/health/readiness`) | none | Liveness probe; does not prove KV or Actor reachability |
| `POST /webhooks/dynamic-variables` | Ed25519 signature on `telnyx-signature-ed25519` + `telnyx-timestamp` (`WEBHOOK_PUBLIC_KEY`) | Telnyx Assistant init webhook |
| `POST /mcp` | `MCP_AUTH` bearer (`MCP_API_TOKEN`) | MCP server, stateless streamable HTTP. Browser `Origin` → 404 |
| `GET /demo/config` | `SMOKE_AUTH` bearer (`SMOKE_TEST_TOKEN`) | Returns validated KV config |
| `GET /demo/availability?date=YYYY-MM-DD` | `SMOKE_AUTH` | Slots for one date with Actor occupancy |
| `POST /demo/bookings` | `SMOKE_AUTH` | Create one booking (delegates to `DayAgenda`) |
| `GET /demo/callbacks` | `SMOKE_AUTH` | Pending callback requests across the last 7 local days, merged newest first |

Failure modes (intentionally distinct across surfaces):

- `/demo/*` infrastructure failure (binding absent, secret empty/throws,
  invalid config, Actor error) → HTTP `503 { error: "service_unavailable" }`.
- `/mcp` auth failure (binding absent, secret empty/throws) → HTTP `503
  { error: "service_unavailable" }`. Missing or wrong `Authorization` → `401`.
- `/mcp` tool-execution infrastructure failure (KV read throws, missing
  binding reached the handler, Actor throws) → `200` with an
  `isError: true` MCP tool result (the JSON-RPC envelope stays valid; the
  tool result text is `service_unavailable` or the domain error code).
- `/webhooks/dynamic-variables` KV wait timeout / load failure / absent
  binding → HTTP `200` with `system_status: "degraded"` and
  `booking_enabled: "false"` (never blocks the caller). Signature-verification
  failure modes: missing / malformed `WEBHOOK_PUBLIC_KEY`, slow (>1000 ms)
  secret lookup, or `crypto.subtle` reject → HTTP `503
  { error: "service_unavailable" }`; missing / malformed / out-of-window /
  unverified signature → HTTP `401 { error: "unauthorized" }`.

No raw error messages are returned on any surface. No customer names or full
phone numbers are logged or returned in any response on any route; the
dynamic-variables webhook retains only a masked phone suffix (`***NNNN`) for
correlation.

## MCP tools (`src/mcp/`)

Three tools, each registered on a fresh `McpServer` per request (no shared
session state):

- `get_service_catalog` — `{}` → `{ services, booking_enabled }`. Reads KV
  through the same `loadConfig` so runtime validation and fail-closed
  semantics apply unchanged. Usable without conversation metadata.
- `get_availability` — `{ date }` → `{ date, timezone, booking_enabled,
  available_times }`. Combines `loadConfig` + `getAvailability` + Actor
  occupancy. Usable without conversation metadata.
- `create_booking` — `{ service_id, date, time, customer_name,
  customer_phone, confirmed }` → `{ status, booking_id, service_id, date,
  time }` or a tool-error `{ error }`. **Requires** conversation metadata:
  `telnyx_conversation_id` is read from
  `params._meta["telnyx_conversation_id"]` and matched against
  `/^[A-Za-z0-9:_-]{1,128}$/`. Missing or invalid metadata returns
  `conversation_id_required` and never reaches an Actor. The same
  conversation is routed to the same `ConversationBooking` Actor instance
  (`conversation-${sha256(id)}`), so one confirmed booking per conversation
  is enforced end-to-end. After confirmation, changed input returns
  `conversation_already_booked`; identical replays return the original
  result. Customer PII never leaves the boundary in any response.

## Dynamic-variables webhook (`src/http/routes/dynamic-variables.ts`)

Answers Telnyx Assistant init with a small `dynamic_variables` payload
(`booking_enabled`, `system_status`, `today_local`, `today_weekday`,
`now_local_time`, `business_hours`, `service_list`).

- **Ed25519 signature verification.** Every delivery is verified before the
  JSON body is parsed or KV is touched. `verifyWebhookSignature()`
  (`src/http/webhook-signature.ts`) is a pure function: given the raw body, the
  request headers, the base64 public key, and `Date.now()`, it returns
  `valid` / `invalid_signature` / `invalid_configuration`. The signed payload
  is `${timestampHeader}|${rawBody}` and the timestamp is checked against a
  ±300 s window. A throw from `crypto.subtle` (Ed25519 unavailable, bytes not
  a valid Ed25519 point) collapses to `invalid_configuration` rather than a
  misleading `invalid_signature`. **Fail-closed:**
  - `WEBHOOK_PUBLIC_KEY` missing, empty, slow (>1000 ms), malformed, or
    `crypto.subtle` rejection → HTTP `503 { error: "service_unavailable" }`.
  - Missing / out-of-window timestamp header, missing / wrong-length
    signature header, or a signature that does not verify → HTTP
    `401 { error: "unauthorized" }`.
- **1000 ms bounded secrets wait.** `loadWebhookKeyBounded` races the
  `secrets.get("WEBHOOK_PUBLIC_KEY")` lookup against a fixed
  `WEBHOOK_KEY_WAIT_MS = 1000` deadline so a slow secrets backend cannot stall
  the assistant-init path; the late-resolution / late-rejection semantics
  mirror `loadConfigBounded`.
- **800 ms bounded KV wait.** `loadConfigBounded` races `loadConfig(kv)`
  against a fixed `CONFIG_WAIT_MS = 800` deadline; a late rejection is
  swallowed so it cannot escape as an unhandled promise rejection.
- **Degraded fallback.** `CONFIG` absent, KV read rejected, or timeout →
  `200` with `system_status: "degraded"`, `booking_enabled: "false"`,
  empty `service_list`. The caller never blocks on infrastructure.
- **Structured logs.** `webhook.rejected` (with reason + http_status +
  latency_ms) on early rejections; `webhook.dynamic_variables` on success
  with masked caller phone (`***NNNN`), call_control_id, assistant_id,
  system_status, booking_enabled, config_outcome, latency_ms. No customer
  names or full phone numbers are logged; raw request bodies, header
  values, and unvalidated identifiers are never logged.

## Adapters and the booking-service

`src/app/booking-service.ts` is a transport-independent application service:
trusted `loadConfig`, Actor lookup by name (`agendaActorName(locationId, date)`
→ e.g. `main-2026-10-20`), response-shape validation, and a typed outcome.

- `src/http/routes/bookings.ts` (`POST /demo/bookings`) — HTTP adapter: bounded body
  reader (10 KiB), structural validation, dependency wiring, response
  mapping. **No business admission** — all rules live in the Actor.
- `src/mcp/tools/create-booking.ts` (`create_booking` tool) — MCP adapter: Zod-strict
  input, conversation metadata extracted from `params._meta`,
  `conversationActorName(id) = "conversation-${sha256(id)}"` for stable
  Actor routing, conversation-Actor result validation
  (`confirmed` / domain-rejected / `service_unavailable`), error →
  `toolError(code)`. Read tools (`get_service_catalog`,
  `get_availability`) skip the metadata requirement and are usable
  without conversation identity.

Both write adapters reuse the same `createBooking` for the `DayAgenda`
path so admission rules, replay-first semantics, clock handling, and
persistence are identical regardless of the entry point. The MCP write
path adds the conversation Actor on top, so one confirmed booking per
conversation is enforced in addition to the per-slot
`DayAgenda` admission.

## Stateful Actor — `DayAgenda` (`src/actors/day-agenda.ts`)

- One instance **per `location_id` per `YYYY-MM-DD`**, addressed as
  `main-2026-10-20`. Owns authoritative occupancy + idempotency for that day.
- Single-aggregate storage key `"agenda"`: `{ date, bookings, idempotency }`.
- `getOccupiedSlots()` (read) — sorted slot times, no customer data.
- `createBooking(input)` (write) — load → validate → idempotency lookup →
  admission rules → occupancy check → backend UUID → single `put`. **Idempotency
  is checked before `Date.now()`, before `booking_enabled`, before all other
  time-less rules**, so identical replays succeed even when the flag has been
  flipped or the clock has moved past the slot ([C6]).

The Actor owns admission and persistence; the application service and
adapters do no business validation.

## Stateful Actor — `DayCallbacks` (`src/actors/day-callbacks.ts`)

- One instance **per local calendar date**, addressed as
  `callbacks-2026-10-20`. Persists the newest 200 callback requests in a
  single `"queue"` key, newest first.
- `requestCallback(input)` (write) — per-conversation idempotent inside the
  day; a repeat from the same conversation returns the original entry. Name
  and phone are stored inside the Actor but never returned by the API
  surface.
- `listCallbacks()` (read) — returns the day's entries in stored order.
- The operator listing (`/demo/callbacks` and the portal) merges the last 7
  local days (today + 6 previous) — fixed actor names, no scans — and sorts
  the merged set newest first.

## Stateful Actor — `ConversationBooking` (`src/actors/conversation-booking.ts`)

- One instance **per trusted Telnyx conversation**, addressed as
  `conversation-${sha256(telnyx_conversation_id)}`. Owns the
  one-booking-per-conversation aggregate (booking-domain.md §10).
- Single-aggregate storage key `"booking"`:
  `{ kind: "idle" }` | `{ kind: "pending", input, attempt_key, location_id }`
  | `{ kind: "confirmed", input, attempt_key, location_id, result }`.
- `book(input)` (write) — `coordinateBooking()` loads the aggregate, decides
  between confirmed replay / pending resolution / new attempt, persists
  pending before execution, and only writes `confirmed` or `idle` after the
  executor result is validated. The executor path loads trusted `loadConfig`
  and routes to `DayAgenda.idFromName(...)` (`createBooking()` in
  `src/app/booking-service.ts`).
- The Actor owns attempt-key stability and conversation-scoped state; the
  MCP layer never consults KV or AGENDA before calling. RPC callers never
  supply config, location, attempt key, or credentials; the adapter injects
  them from `this.env` and the persisted saved attempt.

`DayAgenda` remains the authoritative owner of slot occupancy and booking
persistence. The two Actor types do **not** share a transaction or an
exactly-once delivery guarantee.

## Why Actor vs KV vs function

Stateful Actors and KV both persist, but they answer different questions. A
function call is stateless; an Actor holds one aggregate; KV is a flat key
space. Picking the right one keeps each component's responsibilities narrow
and the failure modes obvious.

| Storage | Holds | Why here | Examples |
|---|---|---|---|
| **KV** (`config` namespace) | Service catalog + business config + `booking_enabled` | Read-mostly, owner-tunable without redeploy. Never holds transactional state. | `services[].id`, `slot_hours`, `booking_enabled` |
| **Function logic** (`src/domain/*`, `src/app/*`) | Stateless validation and scheduling | Pure rules; no per-entity ownership; can be re-exercised without coordination. | `isDateInWindow`, `isSlotPast`, `validateSlotRequest`, `computeKpis`, `loadConfig` |
| **Actor** (per-entity) | One authoritative aggregate per entity | Per-entity read-modify-write that must be serialized. Single `put`, no shared transaction with other Actors. | `DayAgenda` (one per `location-day`, owns check-and-book), `ConversationBooking` (one per `telnyx_conversation_id`, owns one-booking-per-conversation), `DayCallbacks` (one per local day, owns the day's callback list), `Metrics` (one per local day, owns per-day counters and latency) |

## KV config (`src/domain/config.ts`)

`loadConfig(kv)` reads `config/main` as JSON and validates at runtime
(non-empty service IDs, unique, 60-minute durations, real boolean
`booking_enabled`, `timezone: "America/Mexico_City"`, `slot_hours`
`09:00–17:00` with `last_start: 16:00`, `booking_window_days: 7`). KV never
holds transactional booking state — only the service catalog and business
configuration. The demo seed lives in `config/main.json` (non-sensitive).

## Secret bindings (`telnyx.toml`)

Three independent `[[secrets]]` entries so revocation scopes to one surface:

- `SMOKE_AUTH → SMOKE_TEST_TOKEN` — `Authorization: Bearer <value>` gate on
  every `/demo/*` route.
- `MCP_AUTH → MCP_API_TOKEN` — `Authorization: Bearer <value>` gate on
  `/mcp`, plus a `404` on browser-originated requests (`Origin` header).
- `WEBHOOK_PUBLIC_KEY → TELNYX_PUBLIC_KEY` — base64 32-byte Ed25519 public
  key used by `verifyWebhookSignature` to authenticate deliveries to
  `/webhooks/dynamic-variables`. The matching private key lives in Mission
  Control; this repo never sees it.

Token and key values are never committed, logged, or echoed in any response.
Authenticates before any KV read or Actor call; rejected requests never
reach infrastructure.

## What's verified vs. what isn't

**Verified — local mocked tests** (`npm run typecheck` 0 errors, `npm test`
passing):

- HTTP routing, method handling, and 404 behavior for every route.
- Full auth gate: absent/empty/rejecting secret → `503`; missing/malformed/
  wrong bearer → `401`; valid bearer → route reached.
- Dynamic-variables webhook: method check, bounded body reader, JSON
  parsing, payload envelope tolerance, 800 ms config race, degraded
  fallback, structured logs (masked phone, no full phone or name leakage),
  unhandled rejection suppression on late KV resolutions/rejections.
- MCP: protocol handling, tool gating on bindings, Zod-strict input,
  domain error → tool-error mapping, correlation id extraction from
  JSON-RPC `_meta` (`telnyx_conversation_id`), stable Actor routing by
  `sha256(conversationId)`, missing/malformed metadata →
  `conversation_id_required`, missing binding → `service_unavailable`,
  malformed Actor result collapse, no PII in logs or responses.
- ConversationBooking Actor + coordinator: pending/confirmed/idle state
  machine, stable attempt keys across retries, pending preservation
  on ambiguous executor outcomes, fresh attempt with new key for a
  corrected request, executor result validation (null, array, unknown
  kind, empty `booking_id`, mismatched fields, unknown rejection code,
  `idempotency_key_conflict`), failed-write recovery, missing CONFIG /
  AGENDA binding closed paths, mismatched persisted `confirmed` shape.
- Booking application service: dependency wiring, response-shape validation,
  domain error mapping. No admission rules — those live in the Actor.
- DayAgenda Actor: admission (service, window, weekday, time, past,
  `booking_enabled`, occupancy), replay-first idempotency (including the
  `booking_enabled` / slot-past / service-removed bypasses), clock-regression
  scenarios, persisted-state validation, idempotency prototype-pollution
  protection, single `ctx.storage.put` boundary on writes. The mocked suite
  exercises this code path; it does not prove real `ctx.storage` atomicity.

**Verified — recorded remote checks** (`docs/verification.md`):

- Public health (200, correct service payload).
- `SMOKE_AUTH` binding live on the deployed function (`401` for unauthenticated
  demo requests).
- Real KV read from the deployed function returns the seeded config.
- End-to-end availability (KV → scheduling → Actor → response).
- End-to-end booking creation, replay, occupancy reflection.
- Bounded remote concurrency: 20 racing POSTs, exactly 1 confirmed, 19
  `slot_unavailable`, no ambiguous outcomes.
- MCP: `initialize` plus `get_service_catalog` (3.1b) and `create_booking`
  with replay + occupancy reflection (3.3) against the deployed function.
  Subtask 3.3 used the **old content-derived idempotency key**
  (`sha256(phone|date|time|service_id)`); it is preserved as historical
  evidence of the prior implementation, not as proof of the current
  conversation-Actor routing.

**Local changes after the recorded evidence are not claimed deployed.** The
dynamic-variables webhook extraction **and** the `ConversationBooking` Actor
routing post-date the 2026-10-16 ship that produced the recorded public URL;
subtask 5.x in `docs/verification.md` records the 2026-10-17 ship that
deployed them, but it does not claim real cross-Actor execution or verified
Telnyx signatures — only the unauthenticated boundary checks performed
against the live URL. The `/demo/*` route set and the read-side MCP tools
(`get_service_catalog`, `get_availability`) are part of the recorded
evidence.

**Local `dev` does not emulate `[[secrets]]` or `[storage.kv]`.** Auth-gated
demo routes and `/mcp` return `503` locally. The dynamic-variables webhook
fails closed at the `WEBHOOK_PUBLIC_KEY` lookup in local `dev` and answers
`503 { error: "service_unavailable" }` (the key is not bound locally), which
is the expected fail-closed path; the mocked suite exercises the rest of the
handler (`CONFIG` wait, JSON parse, payload envelope, structured logs)
independently. Recorded local runtime evidence in subtasks 1.2/1.3 ran
before the auth gate was added and is preserved as historical platform-probe
evidence only.

## Pending (planned, not implemented)

- Voice AI Assistant / Conversation Workflow / phone-number integration.
- Monitoring, alerts, and an operations portal.
