# Architecture

One Telnyx Edge Function (`telnyx.toml`, TypeScript) serves everything the assistant
needs: the dynamic-variables webhook, the MCP server and the operator portal. State
lives in one KV namespace and four Stateful Actor types.

```text
Caller ──► Telnyx AI Assistant (Conversation Workflow)
             │ assistant init                 │ MCP tool calls
             ▼                                ▼
   POST /webhooks/dynamic-variables      POST /mcp
             │                                │
             ▼                                ▼
   KV config ◄──────────────── services/ ───► Actors
   (catalog, hours,                          DayAgenda           one per day
    booking_enabled)                         ConversationBooking one per call
                                             DayCallbacks        one per day
                                             Metrics             one per day
                                                 ▲
   GET /portal + /api/* (operator) ──────────────┘
```

## Code layout

| Folder | Responsibility |
|---|---|
| `src/http/` | Router, bearer auth, bounded body reader, Ed25519 verification, route handlers |
| `src/mcp/` | MCP server (official SDK, stateless streamable HTTP); one file per tool in `tools/` |
| `src/services/` | Use cases without HTTP: availability, booking, portal reports |
| `src/domain/` | Pure rules: scheduling, config validation, conversation booking coordinator |
| `src/actors/` | Stateful Actors and their typed bindings |
| `src/observability/` | Structured logger and bounded metric recording |

## Request flows

**Call start.** Telnyx posts `assistant.initialization` to
`/webhooks/dynamic-variables`. The handler verifies the Ed25519 signature
(`${timestamp}|${rawBody}`, ±300 s window) with the public key from Edge secrets,
loads the config from KV and returns `booking_enabled`, `system_status`,
today's date and time in the shop's time zone, business hours and the service list.
The workflow routes on `booking_enabled == "true"`.

**Read tools.** `get_service_catalog` reads KV; `get_availability` combines the
scheduling rules with the day Actor's occupancy (`main-YYYY-MM-DD`).

**Booking.** `create_booking` reads `telnyx_conversation_id` from MCP `_meta` and
calls the `ConversationBooking` Actor for that conversation
(`conversation-<sha256(id)>`). That Actor persists the attempt as *pending*, calls the
`DayAgenda` Actor for the date (actor to actor), then stores *confirmed* or returns to
*idle* on a rejection. `DayAgenda` re-checks every business rule (service, window,
weekday, hours, past slot, `booking_enabled`, occupancy) inside its single-threaded
turn, so two callers can never get the same slot.

**Callback.** `request_callback` appends to the `DayCallbacks` Actor for today
(`callbacks-YYYY-MM-DD`), idempotent per conversation.

**Portal.** `/portal` serves a static page; `/api/appointments`, `/api/kpis` and
`/api/observability` read the day Actors, the callback Actors and the `Metrics` Actors
for fixed day names (no scans).

## Routes

| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | none | Liveness |
| `POST /webhooks/dynamic-variables` | Telnyx Ed25519 signature | Assistant init variables |
| `POST /mcp` | `MCP_API_TOKEN` bearer; browser `Origin` refused | MCP server |
| `GET /call` | HTTP Basic password (`CALL_PAGE_PASSWORD`) | Web call page with the Telnyx AI Agent widget |
| `GET /portal` | none (page holds no data) | Operator portal |
| `GET /api/{appointments,kpis,observability}` | `PORTAL_API_TOKEN` bearer | Portal data |
| `/demo/{config,availability,bookings,callbacks}` | `SMOKE_TEST_TOKEN` bearer | Smoke tests |

Authentication always runs before any KV read or Actor call.

## Stateful Actors

| Actor | Instance | State | Read-modify-write it protects |
|---|---|---|---|
| `DayAgenda` | `main-YYYY-MM-DD` | Bookings by slot + idempotency map | Check-and-book a slot |
| `ConversationBooking` | `conversation-<sha256>` | idle / pending / confirmed | One booking per call, safe retries |
| `DayCallbacks` | `callbacks-YYYY-MM-DD` | Newest 200 callback requests | Append without losing concurrent requests |
| `Metrics` | `metrics-YYYY-MM-DD` | Counters, latency sums, recent events | Increment counters |

Each Actor persists one aggregate in a single `put` and validates it on every read;
invalid stored state fails closed instead of being treated as empty.

## Why KV vs Actor vs function

- **KV** holds what is read on every call and changes rarely: the service catalog,
  business hours and the `booking_enabled` feature flag. Changing it needs no redeploy.
  It never holds bookings — KV is not a transactional store.
- **Actors** hold state that is modified concurrently and must stay consistent, one
  entity per instance: a day's agenda, a call's booking state, a day's callbacks, a
  day's counters.
- **Function logic** holds everything stateless: scheduling rules, validation,
  signature checks and KPI calculations.

## Failure behavior

| Situation | Behavior |
|---|---|
| KV slow or failing at call start | Last good config (≤10 min) logged as `stale`; with none, `200` with `booking_enabled=false`, `system_status=degraded` — the call continues in Bookings Paused |
| Webhook key missing, malformed or slow | `503` (fail closed) |
| Webhook signature invalid or outside the window | `401` |
| MCP tool infrastructure error | Valid MCP result with `isError: true` and `service_unavailable`; never a raw exception |
| Domain rejection | `isError: true` with the code (`slot_unavailable`, `booking_disabled`, …) |
| Callback store unavailable in the portal | Bookings still shown, `callbacks_ok: false` |
| Metrics Actor slow or failing | Ignored after 300 ms; never changes a tool or webhook result |

## Conversation design decisions

- **Variable comparison vs LLM conditions.** Business rules (`booking_enabled`) are
  routed deterministically; caller intent is routed by LLM conditions.
- **Append vs Replace.** Every conversational node appends to the global instructions
  (persona, date, "never invent facts"); End Call replaces them so it only hangs up.
- **Speak nodes** for the AI disclosure and closing messages, which must be verbatim.
- **Tool scoping.** MCP servers attach at assistant level in the portal, so per-node
  scoping is done in instructions; the backend enforces confirmation, business rules,
  the flag and one booking per call regardless of which node calls the tool.
- **No fake transfer.** "Talk to a person" records a callback request that staff see in
  the portal.

## Security and privacy

- Secrets (`MCP_API_TOKEN`, `PORTAL_API_TOKEN`, `SMOKE_TEST_TOKEN`, `TELNYX_PUBLIC_KEY`,
  `CALL_PAGE_PASSWORD`, `TELNYX_ASSISTANT_ID`)
  live in Edge secrets and are never logged or returned. The two on the call path (MCP
  token, webhook public key) are cached per instance after a successful read.
- Customer names and phone numbers are stored only inside Actors and returned only to
  the authenticated portal; logs carry a masked phone (`***1234`) at most.
- Identifiers from requests are logged only if they match a safe character set.
- The `/call` page is password-protected and the assistant id lives in Edge secrets: the
  widget only needs that id, and every web call is billed to the account. Third-party
  scripts on `/call` and `/portal` are pinned with Subresource Integrity.
