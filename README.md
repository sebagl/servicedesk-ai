# ServiceDesk AI

A voice receptionist for an independent auto repair shop in Mexico City. Callers
ask about services, check real availability and book an appointment in one call;
if they need a person, the assistant records a callback request instead of
pretending to transfer. Everything behind the voice runs on Telnyx Edge Compute.

**Target users:** small service businesses (repair shops, clinics, salons) that
miss calls while their staff is busy, and lose bookings because nobody answers.

| | |
|---|---|
| Function URL | `https://servicedesk-ai-a666861a-1.telnyxcompute.com` |
| Dynamic variables webhook | `POST /webhooks/dynamic-variables` (Telnyx signature) |
| MCP server | `POST /mcp` (streamable HTTP, bearer token) |
| Operator portal | `GET /portal` (data behind a portal token) |
| Health | `GET /health` |
| Talk to the assistant | `GET /call` — web call from the browser (password shared by email). The trial account can only purchase Mexico local numbers, which were out of stock, so no phone number is attached. |

Further reading: [architecture](docs/architecture.md) ·
[debugging stories](docs/debugging.md) · [verification](docs/verification.md) ·
[demo script](docs/demo-script.md)

## How to interact

Open `/call`, enter the password from the email (any username), start the call, allow the
microphone and speak in English:

- *"What services do you offer?"* — answers from the live catalog.
- *"I'd like an oil change on Thursday."* — offers real open times, collects your
  name and phone, reads the booking back and confirms only after your "yes".
- *"Can I come on Saturday?"* — explains the shop is closed and suggests a weekday.
- *"I want to talk to a person."* — records a callback request for the team.

Business rules: Monday–Friday, 09:00–17:00 (last start 16:00), 60-minute slots,
one car per slot, bookings up to 7 days ahead, `America/Mexico_City` time.

## Architecture

```text
Caller (phone / web call)
   │
   ▼
Telnyx AI Assistant ── Conversation Workflow (speak + prompt nodes, LLM and variable edges)
   │                               │
   │ assistant init                │ tool calls (params._meta.telnyx_conversation_id)
   ▼                               ▼
┌──────────────────────── Telnyx Edge Function (servicedesk-ai) ────────────────────────┐
│  /webhooks/dynamic-variables        /mcp (4 tools)               /portal + /api/*      │
│          │                             │                              │               │
│          ▼                             ▼                              ▼               │
│   KV: catalog, hours,      Actors: DayAgenda (per day)       reads Actors + Metrics   │
│   booking_enabled flag             ConversationBooking (per call)                     │
│                                    DayCallbacks (per day)                             │
│                                    Metrics (per day)                                  │
└───────────────────────────────────────────────────────────────────────────────────────┘
   │
   ▼
Structured JSON logs (telnyx-edge logs) + Metrics actor counters (portal Observability tab)
```

Details, request flows and failure modes: [docs/architecture.md](docs/architecture.md).

## Conversation workflow

| Node | Type | Purpose | Instructions |
|---|---|---|---|
| Disclosure | speak | Verbatim AI/recording disclosure | — |
| Identify Intent | prompt | Information, booking or a person | Append |
| Answer FAQ | prompt | Services and hours from `get_service_catalog` | Append |
| Collect Details | prompt | Service, date, time, name, phone; offers only times from `get_availability` | Append |
| Confirm | prompt | Reads the booking back, waits for an explicit yes | Append |
| Book | prompt | Calls `create_booking`; claims success only on `status: confirmed` | Append |
| Bookings Paused | prompt | Bookings switched off: answers questions, no booking | Append |
| Callback Request | prompt | Records `request_callback` instead of a fake transfer | Append |
| Escalate, Goodbye | speak | Verbatim closing messages | — |
| End Call | prompt | Hangs up and says nothing else | **Replace** |

Routing decisions:

- **Variable comparison** for business rules: `booking_enabled == "true"` (from the
  webhook) decides between Identify Intent and Bookings Paused. Anything else —
  including a failed webhook — falls to Bookings Paused.
- **LLM conditions** for caller intent: general question, wants to book, wants a
  person, confirmed, wants changes.
- **Append** keeps the global persona, today's date and the "never invent facts"
  rule in every step; **Replace** is used only for End Call, whose only job is to
  hang up.
- **Speak nodes** carry everything that must be said word for word.

**Tool scoping:** the portal attaches MCP servers at assistant level, so MCP tools
cannot be restricted per node in the UI. Each node's instructions name the only
tools it may use, and the backend is the real guard: `create_booking` requires
`confirmed=true`, the day Actor re-checks every business rule and the flag, and a
conversation can book only once.

## MCP server

Custom MCP server on the same Edge Function (`src/mcp/`), official MCP TypeScript
SDK, stateless streamable HTTP, Zod-strict inputs, one file per tool:

| Tool | What it does | State touched |
|---|---|---|
| `get_service_catalog` | Services and the `booking_enabled` flag | KV |
| `get_availability` | Open times for one date | KV + `DayAgenda` |
| `create_booking` | Books a confirmed slot; retries are safe | `ConversationBooking` → `DayAgenda` |
| `request_callback` | Records a callback request for the team | `DayCallbacks` |

Conversation identity comes from `params._meta.telnyx_conversation_id`, which the
Telnyx platform sets (not the model). Write tools require it. Responses never
contain customer names or phone numbers.

## Dynamic webhook variables

At assistant init Telnyx calls `POST /webhooks/dynamic-variables`. The function
verifies the Ed25519 signature, reads the business config from KV and returns:

| Variable | Used for |
|---|---|
| `booking_enabled` | **Workflow routing** (variable comparison edge) |
| `system_status` | `ok` / `degraded`, visible to the model and the logs |
| `today_local`, `today_weekday`, `now_local_time` | Turning "tomorrow" or "next Monday" into dates in the shop's time zone |
| `business_hours`, `service_list` | Greeting and answers without an extra tool call |

Flipping `booking_enabled` in KV changes the call flow without a redeploy (within
30 s, the config cache TTL).

## Choosing Function vs KV vs Actor

| Primitive | Holds | Why |
|---|---|---|
| **KV** | Catalog, hours, `booking_enabled` | Read-mostly config and a feature flag that changes without redeploy. Never booking state. |
| **Function logic** | Scheduling rules, validation, signature checks, KPI math | Stateless; no entity owns it. |
| **`DayAgenda` Actor** (one per day) | That day's bookings | Check-and-book is a read-modify-write; single-threaded execution means two callers cannot get the same slot (remote test: 20 concurrent requests → 1 booked, 19 `slot_unavailable`). |
| **`ConversationBooking` Actor** (one per call) | idle → pending → confirmed | One booking per conversation and safe retries; calls `DayAgenda` (actor to actor). |
| **`DayCallbacks` Actor** (one per day) | That day's callback requests | Appends without losing concurrent requests; idempotent per conversation. |
| **`Metrics` Actor** (one per day) | Counters, latency sums, recent events | Counters are read-modify-write; feeds KPIs and the Observability tab. |

## Observability

Every request logs one structured JSON line (`src/observability/logger.ts`); phone
numbers are masked (`***1234`) and names are never logged.

| Event | Key fields |
|---|---|
| `webhook.dynamic_variables` | `telnyx_conversation_id`, masked caller, `system_status`, `booking_enabled`, `config_outcome` (`ok`/`stale`/`timeout`), `config_cached`, `latency_ms` |
| `webhook.key_lookup_completed`, `webhook.rejected` | secret lookup time and cache hit; rejection reason |
| `mcp.tool_call` | `tool`, `outcome` (`ok` or the error code), `latency_ms`, `telnyx_conversation_id` |
| `mcp.rejected` | why an MCP request was refused (`missing_bearer`, `invalid_bearer`, `origin_header`, …) |
| `callback.requested`, `portal.report_failed`, `portal.report_partial` | callback writes, portal failures with reason |

Signals beyond logs:

- **Counters and latency** per tool and outcome in the `Metrics` actor, shown live in
  the portal's Observability tab.
- **One trace id per call:** the same `telnyx_conversation_id` appears on the webhook
  line and on every tool call, so a call can be followed Assistant → Function → KV /
  Actors → MCP.

### How we'd know within a minute that the assistant is broken

1. **Portal → Observability** (refreshes every 10 s): status turns `degraded`,
   webhook `degraded`/`rejected` counts rise, or a tool's error count grows.
2. **Live logs:** `telnyx-edge logs servicedesk-ai --tail` — look for
   `webhook.rejected`, `config_outcome` other than `ok`, `mcp.rejected`, or
   `mcp.tool_call` with `outcome: service_unavailable`.
3. **Platform metrics:** `telnyx-edge metrics servicedesk-ai --errors` for 5xx counts.

**What to look at first:** the `webhook.dynamic_variables` line of the failing call.
If it is missing or rejected, the assistant never got its variables (signature or
key problem). If it says `degraded`, KV is slow or failing. If it is fine, follow its
`telnyx_conversation_id` into the `mcp.tool_call` lines to find the failing tool.

The bugs we found this way, with log evidence: [docs/debugging.md](docs/debugging.md).

## Operator portal

`/portal` is a single page with three tabs (the page holds no data; the `/api/*`
endpoints require the portal token):

- **Appointments** — bookings for the next 7 days and recent callback requests.
- **Business KPIs** — follow-up opportunities for a follow-up bot: callers who checked
  availability but did not book, requests the shop could not serve, pending callbacks,
  customers to re-contact for maintenance. Every number comes from stored data.
- **Observability** — system status, webhook and per-tool counts and latency, and the
  latest events with their conversation ids.

## Development with Telnyx Inference (OpenCode)

OpenCode with the `@telnyx/opencode` plugin — config in
[`.opencode/opencode.json`](.opencode/opencode.json).

- **Models:** `zai-org/GLM-5.2` for the foundation and booking domain;
  `MiniMaxAI/MiniMax-M3` for later, well-scoped tasks. The voice assistant itself runs
  on `moonshotai/Kimi-K2.6`.

## Setup

Prerequisites: Node.js 20+, npm, the `telnyx-edge` CLI, and a Telnyx account.

```bash
npm install
npm run typecheck     # strict TypeScript, 0 errors
npm test              # Vitest, 600+ tests (mocked runtime)
```

Configure and deploy (the function is already registered in `telnyx.toml`):

```bash
telnyx-edge auth login
telnyx-edge storage kv key put <kv-namespace-id> config/main --path config/main.json
telnyx-edge secrets add MCP_API_TOKEN "<random>"        # bearer for /mcp
telnyx-edge secrets add PORTAL_API_TOKEN "<random>"     # bearer for /api/*
telnyx-edge secrets add SMOKE_TEST_TOKEN "<random>"     # bearer for /demo/*
telnyx-edge secrets add TELNYX_PUBLIC_KEY "<account public key, base64>"
telnyx-edge secrets add CALL_PAGE_PASSWORD "<password>"   # HTTP Basic password for /call
telnyx-edge secrets add TELNYX_ASSISTANT_ID "<assistant-...>" # assistant embedded by /call
telnyx-edge ship
```

Remote verification scripts (each creates one synthetic booking on the given slot):

```bash
# 20 concurrent bookings for one slot: expects 1 confirmed, 19 slot_unavailable
SMOKE_TEST_TOKEN=<token> node scripts/verify-booking-concurrency.mjs \
  --base-url <function-url> --date <YYYY-MM-DD> --time <HH:mm> --run-id <id>

# One booking per conversation over MCP: confirm, identical retry, second booking rejected
MCP_API_TOKEN=<token> node scripts/verify-mcp-conversation.mjs \
  --base-url <function-url> --date <YYYY-MM-DD> --time <HH:mm> --alternate-time <HH:mm> --run-id <id>
```

Assistant configuration (Telnyx portal):

1. **MCP server:** URL `…/mcp`, type HTTP, API key = an integration secret holding
   `MCP_API_TOKEN`, tool timeout 10000 ms. Add it to the assistant.
2. **Dynamic variables:** webhook URL `…/webhooks/dynamic-variables`, timeout 5000 ms,
   defaults `booking_enabled = false`, `system_status = degraded`.
3. **Workflow:** the nodes and edges above. MCP filler messages: "One moment while I
   check that."
4. **Web calls:** enable unauthenticated web calls on the assistant (Widget tab /
   `supports_unauthenticated_web_calls`) so the `/call` widget can connect.

## Repository layout

```text
src/
  index.ts            entry point: exports the Actors, delegates to the router
  http/               router, auth, body limits, webhook signature; routes/
  mcp/                MCP server; tools/ has one file per tool
  services/           availability, booking, portal reports (no HTTP)
  domain/             pure rules: scheduling, config validation, booking coordinator
  actors/             DayAgenda, ConversationBooking, DayCallbacks, Metrics
  observability/      structured logger, bounded metric recording
  portal/             operator portal page
  call/               password-protected web call page (Telnyx widget)
test/                 mirrors src/, plus integration/ and support/
docs/                 architecture, debugging, verification, demo script
```

## Platform feedback

Found while building, with evidence in [docs/debugging.md](docs/debugging.md):

- A newly registered actor type (`CallbackQueue`) showed `ready` but every invocation
  failed with `failed to lookup actor`; a fresh type name worked.
- `telnyx-edge ship` adds new actor bindings but does not remove ones deleted from
  `telnyx.toml`, so `actors delete` keeps refusing with "still bound".
- Secret reads take ~560–710 ms on a cold instance, against a 1.5 s default webhook timeout.
- MCP tools cannot be scoped per workflow node in the portal.
- The portal MCP form reports `api_key_ref` errors without saying the token must be
  an integration secret.
- Trial accounts can only search Mexico local numbers, which were out of stock.

## Known limitations

- Reached by web call through `/call`: the trial account had no purchasable phone number.
- The `/call` password protects the page, not the assistant: after login the widget
  receives the assistant id in the browser, and anyone holding that id could start web
  calls billed to the account. Unauthenticated web calls are meant to be disabled after
  the evaluation.
- No cancel/reschedule tool: changes go through a callback request.
- Callback requests are stored and visible to staff; there is no automatic call-back.
