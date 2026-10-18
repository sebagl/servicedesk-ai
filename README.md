# ServiceDesk AI

An AI receptionist for a fictional auto repair shop, built on Telnyx Edge Compute.

This repository contains the booking-domain implementation (HTTP + MCP adapters,
KV config, per-location/day Actor) plus the smoke-test platform probe. See
[docs/architecture.md](docs/architecture.md) for the full design and
[docs/verification.md](docs/verification.md) for recorded evidence.

## Prerequisites

- **Node.js 20+** (tested on v20.20.0)
- **npm** (tested on 10.8.2)
- **`telnyx-edge` CLI v0.5.12+** — install to `~/.local/bin` (no sudo):
  ```bash
  curl -sSL https://github.com/team-telnyx/edge-compute/releases/download/v0.5.12/telnyx-edge-v0.5.12-macos-arm64.tar.gz | tar -xzf -
  mv telnyx-edge-v0.5.12-macos-arm64/telnyx-edge ~/.local/bin/telnyx-edge
  chmod +x ~/.local/bin/telnyx-edge
  telnyx-edge --version  # → v0.5.12
  ```
  Adjust the platform suffix for your architecture (`linux-amd64`, `linux-arm64`,
  `macos-amd64`, `windows-amd64.zip`).
- **Docker + Compose v2.17+** — only needed for `telnyx-edge dev` (local runtime;
  not required for typecheck or mocked tests). Local `dev` does **not** emulate
  `[[secrets]]` or `[storage.kv]` bindings — auth-gated demo routes return
  `503`, `/mcp` returns `503`, and the dynamic-variables webhook answers
  `200 degraded` (its KV-wait fallback is exercised by the mocked test suite).

## Manifest and entrypoint

This project uses a **`telnyx.toml`** umbrella manifest — not `func.toml`.

| Convention | Manifest | HTTP entrypoint | StatefulActors |
|---|---|---|---|
| `func.toml` (classic) | `func.toml` | You own a `node:http` server on `PORT \|\| 8080` | Not supported |
| `telnyx.toml` (umbrella) | `telnyx.toml` | `export default { async fetch(req, env) }` — runtime serves it | TypeScript-only |

StatefulActors require `telnyx.toml`, so this project uses the fetch-handler
contract. There is no Express, Hono, or custom `node:http` server.

Source: [Project Structure](https://developers.telnyx.com/docs/edge-compute/stateful-actors/guides/project-structure)

## HTTP routes

- `GET /health`, `/health/liveness`, `/health/readiness` — public liveness only;
  do not prove KV or Actor reachability.
- `POST /webhooks/dynamic-variables` — Telnyx assistant init webhook (see below).
- `POST /mcp` — MCP server (stateless streamable HTTP, JSON responses), auth-gated
  by `MCP_AUTH`. Browser `Origin` is rejected with `404`.
- `/demo/*` — smoke-test routes, auth-gated by `SMOKE_AUTH` (`SMOKE_TEST_TOKEN`):
  - `GET /demo/config` — returns the validated KV config.
  - `GET /demo/availability?date=YYYY-MM-DD` — slots for one date, marked with
    `DayAgenda` occupancy.
  - `POST /demo/bookings` — create one booking (delegates to the Actor).
  - `POST|GET /demo/counter/:id/{increment,read}` — platform probe.

## MCP tools

Three tools, all bound to the same MCP server (stateless per-request):
- `get_service_catalog` — services + `booking_enabled` admission flag.
  Usable without conversation metadata.
- `get_availability` — open slots for a `YYYY-MM-DD` date. Usable without
  conversation metadata.
- `create_booking` — write path; routes through the
  `ConversationBooking` Actor keyed by conversation id
  (`params._meta["telnyx_conversation_id"]`, sha256-hashed). Requires
  conversation metadata: missing or invalid metadata returns
  `conversation_id_required` and never reaches an Actor. Conversation
  identity is read from SDK metadata only — never from tool arguments
  or correlation headers. One confirmed booking per conversation is
  enforced by the Actor; changed input after a confirmed booking
  returns `conversation_already_booked`. Customer PII (name, phone)
  never leaves the boundary in any response.

## Telnyx AI Assistant init webhook

`POST /webhooks/dynamic-variables` answers at assistant init with
`dynamic_variables` (`booking_enabled`, `system_status`, `today_local`,
`today_weekday`, `now_local_time`, `business_hours`, `service_list`). KV config
load is raced against an **800 ms** deadline; missing/slow/loaded-failed
config returns `200` with `system_status: "degraded"` and
`booking_enabled: "false"`. Every delivery is authenticated against the
Ed25519 public key stored in the `WEBHOOK_PUBLIC_KEY` secret binding
(`TELNYX_PUBLIC_KEY`); the verifier verifies `${timestamp}|${rawBody}` and
enforces a ±300 s replay window. A missing or slow secret lookup, a malformed
key, or an `invalid_configuration` from `crypto.subtle` fails closed with
`503 { error: "service_unavailable" }`; an unverified signature returns
`401 { error: "unauthorized" }`. See `src/webhook-signature.ts` and
`src/dynamic-variables.ts`.

## Operator portal

`GET /portal` serves a single static page (React 18 from a pinned CDN, no
build step) that holds no data. On load it asks once for the portal token
(the `PORTAL_API_TOKEN` secret, bound as `PORTAL_AUTH`), keeps it in
`sessionStorage`, and refreshes every 10 s from `GET /api/appointments`,
`/api/kpis` and `/api/observability`. Those routes require
`Authorization: Bearer <token>` (missing secret `503`, bad token `401`, wrong
method `405`). Tabs:

- **Appointments** — bookings for today and the next 6 days (time, service,
  name, phone) and the callback request queue.
- **Business KPIs** — follow-up opportunities for the last 7 days: callers
  who checked availability but did not book, booking requests we could not
  serve, pending callbacks, and upcoming customers to remind about their next
  service, plus bookings confirmed. Every figure comes from stored data.
- **Observability** — system status, today's webhook counts and average
  latency, per-tool calls/errors/latency, and the 50 most recent events.

Metrics come from a `Metrics` Actor per local day (`metrics-YYYY-MM-DD`)
holding counters, latencies and conversation ids only, never customer data.
Recording is best-effort with a 300 ms bound, so it never changes a webhook
or tool result.

## Local commands

```bash
npm install
npm run typecheck    # tsc --noEmit (strict mode) — 0 errors
npm test             # vitest run (mocked) — 510/510 passing (14 files)
```

### Local runtime (verified historical probe)

Requires Docker. Downloads ~1 GB on first run.

```bash
telnyx-edge dev --no-watch   # serves at http://127.0.0.1:8787
```

The counter snippets below are **historical** evidence recorded before the auth
gate was added (subtasks 1.2/1.3 in `docs/verification.md`). Local `dev` does
not emulate `[[secrets]]`, so `/demo/counter/*` now returns `503` locally and
those exact curls no longer reproduce.

```bash
curl http://127.0.0.1:8787/health
# → {"status":"ok","service":"servicedesk-ai"}

# Pre-auth-gate (historical): counter persistence + isolation were verified
# in subtasks 1.2 and 1.3 against the same local stack. The unauthenticated
# curls in the original README are no longer reproducible locally.
```

Stop the stack:

```bash
docker compose -f .telnyx/dev/compose.yaml down        # stop (keeps state)
docker compose -f .telnyx/dev/compose.yaml down -v      # stop + delete state
```

## Deployed function and recorded public URL

`telnyx.toml` already contains the registered `func_id` from
`telnyx-edge new-func --actor` (recorded 2026-10-16). Do not re-register;
re-running `new-func` would provision a new function.

Recorded public URL (subtasks 1.5.4, 1.5.5, 2.2d, 2.3e, 2.4d, 3.1b, 3.3 in
`docs/verification.md`):

```
https://servicedesk-ai-a666861a-1.telnyxcompute.com
```

All recorded remote checks happened against this URL. The three MCP tools,
the `/demo/*` route set (config / availability / bookings), and the public
boundaries all have recorded deployment evidence (see `docs/verification.md`
subtasks 1.5.4, 1.5.5, 2.2d, 2.3e, 2.4d, 3.1b, 3.3). The 2026-10-16 subtask
3.3 evidence refers to the old content-derived key
(`sha256(phone|date|time|service_id)`) and is preserved as historical, not as
proof of the conversation-Actor implementation. The 2026-10-17 ship
(subtask 5.x in `docs/verification.md`) deployed the
`dynamic-variables` webhook with Ed25519 signature verification and the
`ConversationBooking` Actor routing that replaced the old content-derived
MCP idempotency key; that subtask also records the unauthenticated remote
checks performed against the live URL.

## Secret bindings (separate, never recorded)

`telnyx.toml` declares two independent secret bindings so revocation scopes to
one surface:

- `[[secrets]] SMOKE_AUTH = "SMOKE_TEST_TOKEN"` — protects `/demo/*`.
- `[[secrets]] MCP_AUTH = "MCP_API_TOKEN"` — protects `/mcp`.
- `[[secrets]] WEBHOOK_PUBLIC_KEY = "TELNYX_PUBLIC_KEY"` — Ed25519 public key
  (base64, 32 bytes) used to verify the `telnyx-signature-ed25519` header on
  `/webhooks/dynamic-variables`. The matching private key lives in Mission
  Control; this repo never sees it.

Token values are never committed, logged, or echoed in responses. Before remote
smoke tests:

```bash
telnyx-edge secrets add SMOKE_TEST_TOKEN "<random-value>"
telnyx-edge secrets add MCP_API_TOKEN    "<random-value>"
```

Failure modes (intentionally distinct):

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
  `booking_enabled: "false"` (never blocks the caller). Missing / malformed
  / late `WEBHOOK_PUBLIC_KEY` lookup or `crypto.subtle` failure → HTTP
  `503 { error: "service_unavailable" }`; unverified signature → HTTP
  `401 { error: "unauthorized" }`.

## Logging and PII

The webhook logs a masked phone suffix (`***NNNN`) for correlation; no customer
names or full phone numbers are logged or returned in any response on any
route.

## Pending (not implemented)

- Voice AI Assistant / Conversation Workflow / phone-number integration.
- Monitoring, alerts, and an operations portal.

## Official source URLs

- [Edge Compute CLI (GitHub)](https://github.com/team-telnyx/edge-compute)
- [Runtime overview](https://developers.telnyx.com/docs/edge-compute/runtime/index)
- [HTTP handler contract](https://developers.telnyx.com/docs/edge-compute/runtime/http-handler)
- [Bindings](https://developers.telnyx.com/docs/edge-compute/runtime/bindings)
- [Stateful Actors](https://developers.telnyx.com/docs/edge-compute/stateful-actors)
- [Actor Quick Start](https://developers.telnyx.com/docs/edge-compute/stateful-actors/quick-start)
- [Actor Project Structure](https://developers.telnyx.com/docs/edge-compute/stateful-actors/guides/project-structure)
- [Actor API Reference](https://developers.telnyx.com/docs/edge-compute/stateful-actors/api-reference)
