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

## HTTP routes (`src/index.ts`)

| Route | Auth | Purpose |
|---|---|---|
| `GET /health` (and `/health/liveness`, `/health/readiness`) | none | Liveness probe; does not prove KV or Actor reachability |
| `POST /webhooks/dynamic-variables` | none (signature verification pending) | Telnyx Assistant init webhook |
| `POST /mcp` | `MCP_AUTH` bearer (`MCP_API_TOKEN`) | MCP server, stateless streamable HTTP |
| `GET /demo/config` | `SMOKE_AUTH` bearer (`SMOKE_TEST_TOKEN`) | Returns validated KV config |
| `GET /demo/availability?date=YYYY-MM-DD` | `SMOKE_AUTH` | Slots for one date with Actor occupancy |
| `POST /demo/bookings` | `SMOKE_AUTH` | Create one booking (delegates to the Actor) |
| `POST\|GET /demo/counter/:id/{increment,read}` | `SMOKE_AUTH` | Platform probe (Counter actor) |

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
  `booking_enabled: "false"` (never blocks the caller).

No raw error messages are returned on any surface. No customer names or full
phone numbers are logged or returned in any response on any route; the
dynamic-variables webhook retains only a masked phone suffix (`***NNNN`) for
correlation.

## MCP tools (`src/mcp-server.ts`)

Three tools, each registered on a fresh `McpServer` per request (no shared
session state):

- `get_service_catalog` — `{}` → `{ services, booking_enabled }`. Reads KV
  through the same `loadConfig` so runtime validation and fail-closed
  semantics apply unchanged.
- `get_availability` — `{ date }` → `{ date, timezone, booking_enabled,
  available_times }`. Combines `loadConfig` + `getAvailability` + Actor
  occupancy.
- `create_booking` — `{ service_id, date, time, customer_name,
  customer_phone, confirmed }` → `{ status, booking_id, service_id, date,
  time }` or a tool-error `{ error }`. The idempotency key is **server-derived
  (sha256 of `customer_phone|date|time|service_id`)** — identical arguments
  reuse the booking; a different `time` with the same caller will create a
  different booking. Customer PII never leaves the boundary in any response.

## Dynamic-variables webhook (`src/dynamic-variables.ts`)

Answers Telnyx Assistant init with a small `dynamic_variables` payload
(`booking_enabled`, `system_status`, `today_local`, `today_weekday`,
`now_local_time`, `business_hours`, `service_list`).

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
  names or full phone numbers are logged; raw request bodies are never
  logged.

## Adapters and the booking-service

`src/booking-service.ts` is a transport-independent application service:
trusted `loadConfig`, Actor lookup by name (`agendaActorName(locationId, date)`
→ e.g. `main-2026-10-20`), response-shape validation, and a typed outcome.

- `src/bookings.ts` (`POST /demo/bookings`) — HTTP adapter: bounded body
  reader (10 KiB), structural validation, dependency wiring, response
  mapping. **No business admission** — all rules live in the Actor.
- `src/mcp-server.ts` (`create_booking` tool) — MCP adapter: Zod-strict
  input, server-derived idempotency key, identical `BookingServiceDeps`
  shape, error → `toolError(code)`.

Both adapters reuse the same `createBooking` so admission rules, replay-first
semantics, clock handling, and persistence are identical regardless of the
entry point.

## Stateful Actor — `DayAgenda` (`src/agenda-actor.ts`)

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

## KV config (`src/config.ts`)

`loadConfig(kv)` reads `config/main` as JSON and validates at runtime
(non-empty service IDs, unique, 60-minute durations, real boolean
`booking_enabled`, `timezone: "America/Mexico_City"`, `slot_hours`
`09:00–17:00` with `last_start: 16:00`, `booking_window_days: 7`). KV never
holds transactional booking state — only the service catalog and business
configuration. The demo seed lives in `config/main.json` (non-sensitive).

## Secret bindings (`telnyx.toml`)

Two independent `[[secrets]]` entries so revocation scopes to one surface:

- `SMOKE_AUTH → SMOKE_TEST_TOKEN` — `Authorization: Bearer <value>` gate on
  every `/demo/*` route.
- `MCP_AUTH → MCP_API_TOKEN` — `Authorization: Bearer <value>` gate on
  `/mcp`, plus a `404` on browser-originated requests (`Origin` header).

Token values are never committed, logged, or echoed in any response.
Authenticates before any KV read or Actor call; rejected requests never
reach infrastructure.

## What's verified vs. what isn't

**Verified — local mocked tests** (`npm run typecheck` 0 errors, `npm test`
337/337 passing):

- HTTP routing, method handling, and 404 behavior for every route.
- Full auth gate: absent/empty/rejecting secret → `503`; missing/malformed/
  wrong bearer → `401`; valid bearer → route reached.
- Dynamic-variables webhook: method check, bounded body reader, JSON
  parsing, payload envelope tolerance, 800 ms config race, degraded
  fallback, structured logs (masked phone, no full phone or name leakage),
  unhandled rejection suppression on late KV resolutions/rejections.
- MCP: protocol handling, tool gating on bindings, Zod-strict input,
  domain error → tool-error mapping, server-derived idempotency, correlation
  id extraction from JSON-RPC `_meta`.
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
- MCP: `initialize` plus all three tools (`get_service_catalog`,
  `get_availability`, `create_booking`) including `create_booking` replay and
  occupancy reflection through the MCP transport.

**Local changes after the recorded evidence are not claimed deployed.** The
dynamic-variables webhook extraction (and any later local changes) post-date
the 2026-10-16 ship that produced the recorded public URL; re-run
`telnyx-edge ship` before relying on them remotely. The three MCP tools and
the `/demo/*` route set are part of the recorded evidence.

**Local `dev` does not emulate `[[secrets]]` or `[storage.kv]`.** Auth-gated
demo routes and `/mcp` return `503` locally. The dynamic-variables webhook is
unaffected — it answers `200 degraded` when `CONFIG` is absent, which is the
expected local-dev behaviour and is exercised by the mocked suite. Recorded
local runtime evidence in subtasks 1.2/1.3 ran before the auth gate was added
and is preserved as historical platform-probe evidence only.

## Pending (planned, not implemented)

- Voice AI Assistant / Conversation Workflow / phone-number integration.
- Webhook signature verification on `/webhooks/dynamic-variables`.
- A stable, caller-supplied booking-attempt idempotency strategy for the
  MCP `create_booking` tool. Today the MCP key is derived from
  `customer_phone|date|time|service_id`, so identical arguments dedupe but a
  changed `time` for the same caller can create another booking. HTTP
  `/demo/bookings` already accepts a caller-provided `idempotency_key`.
- Monitoring, alerts, and an operations portal.
