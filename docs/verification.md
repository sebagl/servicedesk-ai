# Verification Records

Sanitized evidence from verification subtasks. No secrets, credentials, or
personal data. Only local-runtime results; remote behavior is not claimed.

## 1.2 — Local Actor persistence across full stack restart

**Date:** 2026-10-16
**Scope:** Verify that `Counter` actor state persists across a full local
`telnyx-edge dev` stack stop (volumes preserved) and restart.
**Not claimed:** remote persistence, concurrency safety, deployment behavior.

### Environment
- `telnyx-edge` v0.5.12 (`~/.local/bin`), Docker 29.8.0 / Compose v5.5.1
- Project: `servicedesk-ai`, manifest `telnyx.toml`, actor binding `COUNTER` → `Counter`
- Volumes (preserved across stop, NOT deleted):
  - `telnyx-dev-servicedesk-ai-5d084db6_actor-data`
  - `telnyx-dev-servicedesk-ai-5d084db6_actor-state`
  - `telnyx-dev-servicedesk-ai-5d084db6_scheduler-data`

### Commands and HTTP results

```
telnyx-edge dev --no-watch           # start; stack healthy at http://127.0.0.1:8787

# Step 3 — health
GET  /health                                  → 200 {"status":"ok","service":"servicedesk-ai"}

# Step 4 — unique actor name: restart-probe-1-2
GET  /demo/counter/restart-probe-1-2/read     → 200 {"counter":"restart-probe-1-2","count":0}
POST /demo/counter/restart-probe-1-2/increment  (body {"amount":7})
                                             → 200 {"counter":"restart-probe-1-2","count":7}
GET  /demo/counter/restart-probe-1-2/read     → 200 {"counter":"restart-probe-1-2","count":7}

# Step 5 — stop, preserve volumes (NO -v, no prune)
docker compose -f .telnyx/dev/compose.yaml down   → exit 0
# volumes confirmed intact after down

# Step 6 — restart same stack (reattaches preserved volumes)
telnyx-edge dev --no-watch           # stack healthy at http://127.0.0.1:8787

# Step 7 — read SAME actor WITHOUT incrementing
GET  /health                                  → 200 {"status":"ok","service":"servicedesk-ai"}
GET  /demo/counter/restart-probe-1-2/read     → 200 {"counter":"restart-probe-1-2","count":7}
```

### Result

| Actor name | Before shutdown | After restart (read-only) | Persisted? |
|---|---|---|---|
| `restart-probe-1-2` | 7 | 7 | **Yes** |

Actor state survived a full local-stack stop (containers removed, volumes
preserved) and restart (containers recreated, same volumes reattached). The
`ctx.storage.put` write was durable across the restart boundary.

### Limitations of this check
- Local runtime only; does not prove remote/deployed persistence.
- Single sequential request; does not prove single-threaded dispatch under
  concurrent load (see subtask 1.3).
- Volumes were preserved with `down` (not `down -v`); a volume-destroying stop
  would not be expected to preserve state.

## 1.3 — Bounded concurrent updates to a single Actor

**Date:** 2026-10-16
**Scope:** Verify that the `Counter` actor serializes concurrent increments
with no lost updates, using bounded concurrency in the local runtime.
**Not claimed:** production-scale safety, booking correctness, remote behavior.

### Environment
- `telnyx-edge` v0.5.12, Docker 29.8.0 / Compose v5.5.1
- Stack already running at `http://127.0.0.1:8787` (from subtask 1.2)
- Node.js v20.20.0 built-in `fetch`; script run out-of-tree (no project changes)

### Commands and HTTP results

```
GET  /health                             → 200 {"status":"ok","service":"servicedesk-ai"}

# Unique actor name: concurrency-probe-1-3
GET  /demo/counter/concurrency-probe-1-3/read   → 200 {"count":0}

# 20 POST requests, each {"amount":1}, bounded concurrency 5
# Returned counts (by request index):
#  [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20]
# All 20 returned HTTP 200.

GET  /demo/counter/concurrency-probe-1-3/read   → 200 {"count":20}
```

### Result

| Check | Expected | Actual | Pass? |
|---|---|---|---|
| All 20 requests succeeded (HTTP 200) | 20/20 | 20/20 | Yes |
| Final count = initial + 20 | 0 + 20 = 20 | 20 | Yes |
| Each count value returned once | {1..20} each once | {1..20} each once | Yes |
| Duplicates | none | none | Yes |
| Missing values | none | none | Yes |
| Unexpected values | none | none | Yes |

**Initial count:** 0 · **Final count:** 20
**Successful requests:** 20 · **Failed requests:** 0
**Duplicate count values:** none · **Missing count values:** none

The actor serialized all 20 concurrent increments (5 in flight at a time) with
no lost updates: returned counts were exactly 1 through 20, each once, and the
final read confirmed 20. Single-threaded dispatch held under this load.

### Limitations of this check
- 20 requests at concurrency 5; does not prove behavior at production scale or
  under sustained high load.
- Tests `Counter` increment only; does not prove booking-specific correctness
  (conflict detection, idempotency — see subtask 2.5).
- Local runtime only; remote dispatch behavior not verified.

## 1.4 — Smoke-test route authentication (fail-closed auth gate)

**Date:** 2026-10-16
**Scope:** Protect `/demo/counter/*` routes with a dedicated secret; keep
`/health*` public; verify auth gate with mocked unit tests.
**Not claimed:** remote secret behavior, production security audit.

### Implementation
- `telnyx.toml` declares `[[secrets]] binding = "SMOKE_AUTH"`, `name = "SMOKE_TEST_TOKEN"`
- `src/index.ts` checks `env.SECRETS.get("SMOKE_AUTH")` before reaching the Actor:
  - SECRETS absent / empty / retrieval throws → `503 { "error": "service_unavailable" }`
  - Authorization missing / malformed / incorrect → `401 { "error": "unauthorized" }`
  - Valid `Authorization: Bearer <token>` → Actor reached
- `telnyx-env.d.ts` regenerated via `telnyx-edge types` (2 bindings: COUNTER, SECRETS)
- Never logs credentials, Authorization headers, or raw secret errors

### Mocked unit test results (13/13 passed)

| Scenario | Status | Actor called? |
|---|---|---|
| Absent SECRETS binding → 503 | Pass | No |
| Empty secret value → 503 | Pass | No |
| Secret retrieval rejects → 503 | Pass | No |
| Missing Authorization → 401 | Pass | No |
| Malformed Authorization → 401 | Pass | No |
| Incorrect token → 401 | Pass | No |
| Valid credentials → 200 (increment) | Pass | Yes |
| Valid credentials → 200 (read) | Pass | Yes |
| Default amount when body has no amount | Pass | Yes |
| Health without SECRETS → 200 | Pass | N/A |
| Liveness without SECRETS → 200 | Pass | N/A |
| Readiness without SECRETS → 200 | Pass | N/A |
| 404 unknown route | Pass | No |

### Local runtime note
The running stack was started before this change (`--no-watch`, no file
watching), so it still serves the pre-auth-gate bundle. Demo routes will
return `503` after a restart since local `dev` does not emulate `[[secrets]]`.

### Local runtime verification (post-restart, 2026-10-16)

Stack stopped with `docker compose down` (volumes preserved) and restarted
via `telnyx-edge dev --no-watch` to load the auth-gated bundle. CLI output
confirmed: `⚠️ Not available in local dev yet — env.SECRETS ([[secrets]]) is undefined`.

```
GET  /health                                            → 200 {"status":"ok","service":"servicedesk-ai"}
GET  /demo/counter/auth-gate-runtime-check/read         → 503 {"error":"service_unavailable"}
POST /demo/counter/auth-gate-runtime-check/increment      (body {"amount":1})
                                                      → 503 {"error":"service_unavailable"}
```

Health endpoints remain public. Demo routes fail closed with 503 when the
`SECRETS` binding is unavailable (as expected in local `dev`). Actor is not
reached on rejected requests.

### Deployment prerequisites (before remote smoke tests)
1. `telnyx-edge secrets add SMOKE_TEST_TOKEN "<random-value>"` (NOT the Telnyx API key)
2. `telnyx-edge types` (already done — regenerate if binding changes)
3. `telnyx-edge ship`
4. After ship: `curl -H "Authorization: Bearer <value>" <url>/demo/counter/test/read`

## 1.5.4 — Remote deploy and public boundary verification

**Date:** 2026-10-16
**Scope:** Deploy the existing function and verify public health endpoints +
auth-gated demo routes against the remote runtime.
**Not claimed:** remote actor persistence, concurrent dispatch, booking correctness.

### Deployment

- Function ID: `a666861a-13f6-4dd3-8955-8201bee7209c`
- Command: `telnyx-edge ship`
- First attempt failed: platform-side transient build error ("temporary
  problem on our side, not your code"). Retried per CLI guidance.
- Second attempt: **deployed successfully** (5m21s).
- **URL:** `https://servicedesk-ai-a666861a-1.telnyxcompute.com`

### Remote HTTP checks

```
GET  /health                                → 200 {"status":"ok","service":"servicedesk-ai"}
GET  /demo/counter/remote-auth-check/read   → 401 {"error":"unauthorized"}
```

| Check | Expected | Actual | Pass? |
|---|---|---|---|
| Health without auth → 200 + service JSON | 200 | `200 {"status":"ok","service":"servicedesk-ai"}` | Yes |
| Demo read without auth → 401 (binding works) | 401 | `401 {"error":"unauthorized"}` | Yes |

### Interpretation

- **Health is public** and returns the service payload — confirmed remotely.
- **Demo routes return 401 (not 503)** — the `SMOKE_AUTH` (`SMOKE_TEST_TOKEN`)
  secret binding is live and resolved. The handler found the secret but
  rejected the request for missing credentials. This is the expected,
  successful auth verify path.
- A 503 would have indicated the secret binding was unavailable — not observed.
- No authenticated counter operations were performed (per instructions).

### What remains unverified remotely
- Authenticated demo counter operations (increment/read with valid bearer).
- Remote actor persistence across cold starts.
- Concurrent dispatch on the remote runtime.

## 1.5.5 — Remote authenticated smoke test (manual user execution)

**Date:** 2026-10-16
**Scope:** Authenticated Actor read/write against the remote runtime.
**Attribution:** All requests below were executed manually by the user with a
valid `Authorization: Bearer <SMOKE_TEST_TOKEN>` credential. The AI agent did
not run these requests, did not access the credential, and did not redeploy.

### Environment
- URL: `https://servicedesk-ai-a666861a-1.telnyxcompute.com`
- Actor name: `remote-probe-1-5-5`

### Manually executed requests and results

```
# 1. Read initial state
GET  /demo/counter/remote-probe-1-5-5/read
  → 200 {"counter":"remote-probe-1-5-5","count":0}

# 2. Increment by 7
POST /demo/counter/remote-probe-1-5-5/increment   (body {"amount":7})
  → 200 {"counter":"remote-probe-1-5-5","count":7}

# 3. Read after increment
GET  /demo/counter/remote-probe-1-5-5/read
  → 200 {"counter":"remote-probe-1-5-5","count":7}
```

### Verified

| Check | Result |
|---|---|
| Valid bearer authentication accepted | Yes (200, not 401/503) |
| Remote Actor read returns initial state | Yes (count 0) |
| Remote Actor write persists within session | Yes (count 0 → 7 → 7) |
| State retained between separate requests | Yes (increment then read agree) |

### Not verified
- Persistence across remote restarts / cold starts.
- Concurrent dispatch on the remote runtime.
- Booking-specific correctness (conflict detection, idempotency).

## 2.2b — KV namespace provisioned and seeded

**Date:** 2026-10-16
**Scope:** Create one KV namespace, seed demo configuration, verify read-back.
**Not claimed:** the deployed function can read this — the `[storage.kv.CONFIG]`
binding is not connected to `telnyx.toml` yet. No redeploy performed.

### Namespace

| Field | Value |
|---|---|
| Name | `servicedesk-ai-config` |
| ID | `533e7681-de0d-4af6-bf4d-1da671f7f5d3` |
| Status | `provision_ok` (at creation) |
| Existing namespaces before | none |

### Key seeded

- Key: `config/main`
- Source: `config/main.json` in the repository (non-sensitive demo config)
- Method: `telnyx-edge storage kv key put <id> config/main --path config/main.json`
- Existed remotely before: no (`Resource not found`)

### Seed contents (summary)

- 3 services: `oil_change`, `tire_rotation`, `general_maintenance` (all 60 min)
- `location_id`: `"main"`
- `timezone`: `"America/Mexico_City"`
- `open_days`: Mon–Fri
- `slot_hours`: 09:00–17:00, last start 16:00 (8 slots/day)
- `booking_window_days`: 7
- `booking_enabled`: `true`

### Read-back and comparison

```
telnyx-edge storage kv key get 533e7681-de0d-4af6-bf4d-1da671f7f5d3 config/main
```

Remote value (555 bytes) was read back and `JSON.parse`d. Compared against
the local `config/main.json` using Python `json.load` + equality check.

**Result: MATCH — remote and local parsed JSON are identical.**

All fields verified: 3 services, `booking_enabled: true`, `timezone:
America/Mexico_City`, 8-slot schedule, 7-day window.

### Files changed

| File | Change | Purpose |
|---|---|---|
| `config/main.json` | Created | Non-sensitive demo seed config |
| `docs/verification.md` | Appended | This evidence record |

Not changed: `telnyx.toml`, `src/`, `test/`, `telnyx-env.d.ts`, `package.json`.

### Next step required to make this useful
Add `[storage.kv.CONFIG] id = "533e7681-de0d-4af6-bf4d-1da671f7f5d3"` to
`telnyx.toml`, run `telnyx-edge types`, ship. Only then can the deployed
function read `env.CONFIG.get("config/main", { type: "json" })`.

## 2.2c — KV binding connected and config loader tested (mocked)

**Date:** 2026-10-16
**Scope:** Add CONFIG binding to manifest, implement config loader with runtime
validation, add `GET /demo/config` route (auth-gated), test all scenarios with
mocked KV.
**Not claimed:** deployed KV integration (binding not yet shipped). All tests
are mocked — `env.CONFIG` is a `vi.fn` mock, not the real `KvNamespace`.

### Manifest binding added

```toml
[storage.kv.CONFIG]
id = "533e7681-de0d-4af6-bf4d-1da671f7f5d3"
```

`telnyx-edge types` generated 3 bindings in `telnyx-env.d.ts`:
`COUNTER`, `CONFIG` (KvNamespace), `SECRETS`.

### Config loader (`src/config.ts`)

- `loadConfig(kv)` reads `config/main` as JSON via `kv.get(key, { type: "json" })`
- Runtime schema validation (not TypeScript-only):
  - Services: non-empty `id`, non-empty `name`, `duration_minutes === 60`
  - Unique service IDs (duplicates rejected)
  - `booking_enabled` must be a real boolean (`typeof === "boolean"`)
  - `timezone` must be `"America/Mexico_City"`
  - `slot_hours`: `start === "09:00"`, `end === "17:00"`, `last_start === "16:00"`
  - `booking_window_days === 7`
- Missing key (`null` from get) → `{ ok: false }`
- Read failure (throws) → `{ ok: false }`
- Malformed JSON (throws SyntaxError) → `{ ok: false }`
- Invalid schema → `{ ok: false }`
- `booking_enabled: false` is valid → `{ ok: true, config }`
- No caching; no seed fallback

### Route: `GET /demo/config`

- Protected by the same `SMOKE_AUTH` bearer gate as `/demo/counter/*`
- Auth authenticates before reading KV
- Missing `CONFIG` binding → `503 { error: "service_unavailable" }`
- `loadConfig` returns `{ ok: false }` → `503`
- Success → `200` with validated config JSON
- `POST /demo/config` → `404`

### Mocked test results (33/33 passed)

| Scenario | Status | Actor called? | KV read? |
|---|---|---|---|
| Health (no secrets) → 200 | Pass | No | No |
| Counter: absent SECRETS → 503 | Pass | No | N/A |
| Counter: empty secret → 503 | Pass | No | N/A |
| Counter: secret rejects → 503 | Pass | No | N/A |
| Counter: missing/malformed/wrong auth → 401 | Pass | No | N/A |
| Counter: valid auth → Actor reached | Pass | Yes | N/A |
| Config: unauthorized → 401, KV not read | Pass | N/A | No |
| Config: absent SECRETS → 503, KV not read | Pass | N/A | No |
| Config: valid config, booking_enabled=true → 200 | Pass | N/A | Yes |
| Config: valid config, booking_enabled=false → 200 | Pass | N/A | Yes |
| Config: missing CONFIG binding → 503 | Pass | N/A | No |
| Config: KV key null → 503 | Pass | N/A | Yes |
| Config: KV read rejects → 503 | Pass | N/A | Yes |
| Config: malformed JSON (SyntaxError) → 503 | Pass | N/A | Yes |
| Config: empty object → 503 | Pass | N/A | Yes |
| Config: string "false" for booking_enabled → 503 | Pass | N/A | Yes |
| Config: duplicate service IDs → 503 | Pass | N/A | Yes |
| Config: duration_minutes=30 → 503 | Pass | N/A | Yes |
| Config: empty service name → 503 | Pass | N/A | Yes |
| Config: wrong timezone → 503 | Pass | N/A | Yes |
| loadConfig direct: valid → ok | Pass | | |
| loadConfig direct: booking_enabled=false → ok | Pass | | |
| loadConfig direct: null → not ok | Pass | | |
| loadConfig direct: rejects → not ok | Pass | | |
| loadConfig direct: "false" string → not ok | Pass | | |
| loadConfig direct: dup IDs → not ok | Pass | | |
| Route not found → 404 | Pass | No | No |

### Files changed

| File | Change |
|---|---|
| `telnyx.toml` | Added `[storage.kv.CONFIG]` block |
| `telnyx-env.d.ts` | Regenerated (3 bindings) |
| `src/config.ts` | New — config loader with runtime validation |
| `src/index.ts` | Added `GET /demo/config` route, CONFIG binding on Env |
| `test/smoke.test.ts` | 13 → 33 tests (added config loader + route tests) |
| `docs/verification.md` | This evidence record |

### Check results
- `npm run typecheck` (`tsc --noEmit`) → **0 errors**
- `npm run test` (`vitest run`) → **33/33 passed**

### Pending integration (not yet verified)
- Deployed function reading real KV (`env.CONFIG.get("config/main", { type: "json" })`)
  requires `telnyx-edge ship` with the new binding.
- Local `dev` does not emulate `[storage.kv]` — routes return 503 locally.

## 2.2d — CONFIG binding deployed and public boundaries verified

**Date:** 2026-10-16
**Scope:** Deploy the function with the new `[storage.kv.CONFIG]` binding and
verify public health + auth-gated demo config route against the remote runtime.
**Not claimed:** real KV reads verified — the authenticated request will be
executed manually by the user.

### Deployment

- Function ID: `a666861a-13f6-4dd3-8955-8201bee7209c`
- Command: `telnyx-edge ship`
- First attempt failed: transient platform error ("ship failed before the
  build could start"). Retried per CLI guidance.
- Second attempt: **deployed successfully** (5m6s).
- URL: `https://servicedesk-ai-a666861a-1.telnyxcompute.com`

### Remote HTTP checks (without credentials)

```
GET  /health         → 200 {"status":"ok","service":"servicedesk-ai"}
GET  /demo/config    → 401 {"error":"unauthorized"}
```

| Check | Expected | Actual | Pass? |
|---|---|---|---|
| Health without auth → 200 + service JSON | 200 | `200 {"status":"ok","service":"servicedesk-ai"}` | Yes |
| Demo config without auth → 401 (auth gate works) | 401 | `401 {"error":"unauthorized"}` | Yes |

### Interpretation

- **Health is public** and returns the correct service payload — confirmed
  after redeploy with the CONFIG binding.
- **`/demo/config` returns 401** — the `SMOKE_AUTH` secret binding is live and
  the auth gate protects the config route before KV is read.
- A 503 would have indicated the secret binding was unavailable — not observed.

### Not verified
- Real KV read from the deployed function (requires an authenticated request
  with a valid bearer token — to be executed manually by the user).
- Whether `env.CONFIG.get("config/main", { type: "json" })` returns the seeded
  config — pending the user's authenticated smoke test.

## 2.2e (part 1) — Remote authenticated config read (manual user execution)

**Date:** 2026-10-16
**Attribution:** The user manually executed this authenticated request with a
valid `Authorization: Bearer <SMOKE_TEST_TOKEN>` credential. The AI agent did
not run this request or access the credential.

### Manually executed request and result

```
GET  /demo/config   (with valid bearer token)
  → 200
  {
    "services": [
      { "id": "oil_change", "name": "Oil Change", "duration_minutes": 60 },
      { "id": "tire_rotation", "name": "Tire Rotation", "duration_minutes": 60 },
      { "id": "general_maintenance", "name": "General Maintenance Service", "duration_minutes": 60 }
    ],
    "business": {
      "location_id": "main",
      "timezone": "America/Mexico_City",
      "open_days": ["mon","tue","wed","thu","fri"],
      "slot_hours": { "start": "09:00", "end": "17:00", "last_start": "16:00" },
      "booking_window_days": 7,
      "booking_enabled": true
    }
  }
```

### Verified
- Real KV read from the deployed function: **confirmed**.
- `env.CONFIG.get("config/main", { type: "json" })` returns the seeded value.
- All three services present with correct names and 60-minute durations.
- `booking_enabled: true` as seeded.
- Config loader runtime validation accepted the value (200, not 503).

## 2.2e (part 2) — Toggle booking_enabled to false in remote KV

**Date:** 2026-10-16
**Scope:** Change only `business.booking_enabled` from `true` to `false` in
the remote KV key `config/main` (namespace `533e7681-de0d-4af6-bf4d-1da671f7f5d3`).
Preserve all other fields. No redeploy. No source code change.
**Not claimed:** the deployed function's response to the toggle — that HTTP
check is for the user to execute.

### Steps

1. Read current remote value (555 bytes, `booking_enabled: true`).
2. Wrote modified JSON to a temp file with only `booking_enabled` set to `false`.
   Python diff confirmed exactly one field changed.
3. Wrote back via `telnyx-edge storage kv key put <id> config/main --path <tmp>`.
4. Read back and compared parsed JSON.

### Commands

```
# Read before
~/.local/bin/telnyx-edge storage kv key get 533e7681-de0d-4af6-bf4d-1da671f7f5d3 config/main

# Write with booking_enabled=false (temp file, --path)
~/.local/bin/telnyx-edge storage kv key put 533e7681-de0d-4af6-bf4d-1da671f7f5d3 config/main --path <tmp>

# Read back
~/.local/bin/telnyx-edge storage kv key get 533e7681-de0d-4af6-bf4d-1da671f7f5d3 config/main
```

### Read-back verification

| Field | Before | After |
|---|---|---|
| `business.booking_enabled` | `true` | **`false`** |
| `business.location_id` | `main` | `main` (unchanged) |
| `business.timezone` | `America/Mexico_City` | `America/Mexico_City` (unchanged) |
| `business.open_days` | `["mon","tue","wed","thu","fri"]` | unchanged |
| `business.slot_hours` | `{start:"09:00",end:"17:00",last_start:"16:00"}` | unchanged |
| `business.booking_window_days` | `7` | `7` (unchanged) |
| `services` (3 entries) | unchanged | unchanged |

**Read-back MATCH: parsed JSON identical to the written value. Only
`booking_enabled` changed from `true` to `false`. All other fields preserved.**

### Repository seed unchanged
`config/main.json` in the repository was **not modified** — it still has
`booking_enabled: true`. The toggle was applied only to the remote KV value
via a temp file.

### Flag status: remains false

**`booking_enabled` is currently `false` in the remote KV.** It remains false
pending:
1. The user's HTTP check (e.g., `GET /demo/config` with valid bearer → expect
   `booking_enabled: false` in the response).
2. The user's subsequent restoration (toggling back to `true`).

No deploy was performed — KV updates are live without redeployment, so the
deployed function will read `booking_enabled: false` on its next request.

## 2.2e (user confirmation) — Toggle observed via deployed HTTP

**Date:** 2026-10-16
**Attribution:** The user manually executed an authenticated `GET /demo/config`
with a valid bearer token after the KV toggle. The AI agent did not run this
request or access the credential.

### Manually executed request and result

```
GET  /demo/config   (with valid bearer token)
  → 200
  {
    ...
    "business": {
      ...
      "booking_enabled": false
    }
  }
```

### Verified
- The deployed function read the updated KV value **without a redeploy** —
  `booking_enabled: false` was reflected live.
- All three services unchanged in the response.
- The config loader accepted `booking_enabled: false` as valid config (200,
  not 503) — confirming that `false` is a valid configuration, not an
  infrastructure error.

## 2.2f — booking_enabled restored to true; user confirms live

**Date:** 2026-10-16
**Attribution:** The user manually called authenticated `GET /demo/config`
after the restoration and received HTTP 200 with `booking_enabled: true`
without a redeployment. The AI agent restored the flag in KV and performed
the read-back; the user executed the HTTP check. The AI agent did not access
the credential.

### Restoration (AI agent, CLI)

1. Read current remote KV value: `booking_enabled: false`.
2. Wrote modified JSON to a temp file with only `booking_enabled` set to `true`.
3. Wrote back via `telnyx-edge storage kv key put <id> config/main --path <tmp>`.
4. Read back and compared: `booking_enabled: true`, all other fields preserved.

### User confirmation (manual, HTTP)

```
GET  /demo/config   (with valid bearer token)
  → 200
  {
    "services": [3 services unchanged],
    "business": {
      ...
      "booking_enabled": true
    }
  }
```

### Verified
- The deployed function read the restored KV value **without a redeploy** —
  `booking_enabled: true` was reflected live.
- KV toggling works both ways: `true → false` (subtask 2.2e) and `false → true`
  (this subtask), each confirmed via HTTP by the user without redeployment.
- The repository seed `config/main.json` was never modified — it always had
  `booking_enabled: true`.
- Remote KV now matches the repository seed.

## 2.3a — Pure scheduling domain logic (mocked unit tests)

**Date:** 2026-10-16
**Scope:** Implement pure scheduling functions (date/time validation, timezone
handling, slot generation, request validation) with deterministic Vitest tests.
No KV, occupancy, Actors, MCP, or HTTP routes. No new dependencies.
**Not claimed:** runtime scheduling behavior — all tests are mocked/unit.

### Files changed

| File | Change |
|---|---|
| `src/scheduling.ts` | New — pure domain functions for scheduling |
| `test/scheduling.test.ts` | New — 58 deterministic tests |
| `docs/verification.md` | This evidence record |

Not changed: `telnyx.toml`, `src/index.ts`, `src/config.ts`, `src/counter.ts`,
`test/smoke.test.ts`, `package.json`, `telnyx-env.d.ts`.

### Module summary (`src/scheduling.ts`)

- `isValidDate(date)` — strict `YYYY-MM-DD` + actual calendar validity (leap
  years, month lengths). Pure, no timezone.
- `isValidTimeFormat(time)` — `HH:mm` + whole-hour `:00` suffix. Pure, no config.
- `isValidTime(time, config)` — adds slot-range check (09:00–16:00 from config).
- `getSlotTimes(config)` — derives 8 slot times [`09:00`…`16:00`] from config.
- `getDayOfWeek(date)` — `mon`/`tue`/…/`sat`/`sun` via UTC date construction.
- `isOpenDay(date, openDays)` — checks getDayOfWeek against `open_days` list.
- `getLocalDateString(now)` — `America/Mexico_City` date from injected epoch ms
  via `Intl.DateTimeFormat`. **No hardcoded UTC offset.**
- `getLocalTimeParts(now)` — local hour + minute from injected epoch ms.
- `addDays(date, days)` — calendar-day arithmetic via `Date.UTC + setUTCDate`.
- `getBookingWindowDates(now, config)` — 7 dates from local today.
- `isDateInWindow(date, now, config)` — window membership check.
- `isSlotPast(date, time, now)` — past check (timezone-aware). "At or before now"
  is past (slot start == local now → excluded).
- `generateDaySlots(date, now, config)` — advisory candidate slots for one date
  (no past dates; no weekends; future slots filtered by isSlotPast on today).
- `generateCandidateSlots(now, config)` — all candidates across the window.
- `validateSlotRequest(date, time, now, config)` — returns `SchedulingError`
  string (`date_invalid`, `date_out_of_range`, `date_not_open`, `time_invalid`,
  `slot_in_past`) or null. Order: date validity → window → weekday → time → past.

### Local-date handling

- All `now` values are **injected** (epoch ms). No `Date.now()` inside domain
  functions.
- Local date/time derived via `Intl.DateTimeFormat({ timeZone:
  "America/Mexico_City" })`. The machine timezone is never consulted.
- Date math (window, `addDays`) uses UTC date arithmetic (`Date.UTC +
  setUTCDate`), which is calendar-day arithmetic (not duration-based), so
  DST transitions cannot shift a calendar-day result.
- The test calibrator `localEpochMS` (in the test file only) uses the
  timezone-aware API to find the offset — no hardcoded UTC offset anywhere.
- Tests verifiably distinguish UTC date from Mexico City date using a
  2026-10-19 03:00 UTC instant (UTC date = "2026-10-19", local date =
  "2026-10-18"); the booking window correctly starts from the local date.

### Check results

- `npm run typecheck` (`tsc --noEmit`) → **0 errors**
- `npm run test` (`vitest run`) → **91/91 passed** (33 existing + 58 new)

### Test scenarios verified (58 scheduling tests)

**Slot generation (spec item 1):**
- 8 slots on Monday in window ✓
- Weekend dates produce no slots ✓
- Past calendar dates produce no slots ✓
- Window candidate slots exclude all weekends, total 40 across 5 weekdays ✓

**Today's elapsed slots + exact-start boundary (spec item 2):**
- At 10:30 local: 09:00/10:00 past, 11:00–16:00 remain (6) ✓
- At exactly 11:00 local: 11:00 is "at or before now" → past, 5 remain ✓
- At 10:59 local: 11:00 is after now → 6 remain ✓
- At 16:00 local: no slots remain ✓

**Window boundaries (spec item 3):**
- `today+6` (Oct 25) is in window ✓
- `today+7` (Oct 26) out of range ✓
- Yesterday (Oct 18) out of range ✓
- `date_out_of_range` returned by validateSlotRequest for out-of-window dates ✓

**UTC vs local date (spec item 4):**
- Oct 19 03:00 UTC → local date "2026-10-18" ✓
- Booking window starts from local date, includes Oct 19 as second day ✓

**Month/year boundaries + leap dates (spec item 5):**
- `addDays("2026-12-31", 1) === "2027-01-01"` ✓
- Window spelled Dec 28 → Jan 3 (crosses year boundary) ✓
- 2024-02-29 valid (leap) ✓ 2000-02-29 valid ÷400 ✓
- 2026-02-29 invalid, 2100-02-29 invalid (÷100 not ÷400) ✓
- Leap-year difference for `addDays("2024-03-01", -1)` ✓

**Malformed dates + invalid times (spec item 6):**
- `isValidDate` rejects `2026-13-01`, `2026-02-30`, `26-10-19`, `2026/10/19`,
  empty, `0000-00-00`, etc. ✓
- `isValidTime` rejects `09:30`, `17:00`, `08:00`, `9:00`, `10:60`, empty ✓
- `validateSlotRequest` returns the right error code in each pipeline stage ✓

### Not verified this subtask

- KV access (config was supplied directly in tests).
- Occupancy marking / Actor integration.
- HTTP routes / MCP tool exposure.
- kcalories, idempotency, or `booking_enabled` admission (deliberately kept
  separate).

## 2.3a (TZ independence) — Scheduling results identical across process TZs

**Date:** 2026-10-16
**Scope:** Verify that scheduling logic produces identical results regardless
of the process `TZ` environment variable. Interviewers may test from US
timezones; the workshop timezone `America/Mexico_City` is always used for
local-date interpretation.
**Not claimed:** voice/UI implementation (documented below for later steps).

### Test file
`test/scheduling.tz-independence.test.ts` — 13 tests, each spawning child Node
processes with `TZ=UTC`, `TZ=America/New_York`, and `TZ=America/Los_Angeles`,
running scheduling functions against the same injected `now`, and asserting
identical JSON results.

Mechanism: `scheduling.ts` is bundled to CommonJS via `esbuild` (existing dev
dependency); child processes `require()` the bundle with their `TZ` set.
`Intl.DateTimeFormat({ timeZone: "America/Mexico_City" })` is the only timezone
source — the process `TZ` never leaks.

### Scenarios verified (13 tests, all passed)

| Scenario | Injected now | Result identical across TZs? |
|---|---|---|
| JAN_NOON window first + count | `2026-01-12 12:00` MX | Yes |
| JAN_NOON Monday day slots | same | Yes |
| JAN_NOON candidate count | same | Yes |
| JUL_NOON window first + count | `2026-07-13 12:00` MX | Yes |
| JUL_NOON Monday day slots | same | Yes |
| JUL_NOON candidate count | same | Yes |
| JUL_UTC_MORNING local date (Jul 13) | `2026-07-13 09:00` UTC | Yes |
| JUL_UTC_MORNING candidate count | same | Yes |
| JAN_UTC_FOR_JAN11 local date (Jan 11) | `2026-01-12 03:00` UTC | Yes |
| JAN_UTC_FOR_JAN11 window + candidates | same | Yes |
| JAN_NOON validateSlotRequest valid | `2026-01-12 12:00` MX | Yes |
| JAN_NOON validateSlotRequest slot in past | same | Yes |
| JUL_NOON validateSlotRequest valid | `2026-07-13 12:00` MX | Yes |

### Sample results (manual run, all three TZs identical)

```
TZ=UTC                  JAN window first: 2026-01-12
TZ=America/New_York     JAN window first: 2026-01-12
TZ=America/Los_Angeles  JAN window first: 2026-01-12

TZ=UTC                  JAN Monday slots: ["13:00","14:00","15:00","16:00"]
TZ=America/New_York     JAN Monday slots: ["13:00","14:00","15:00","16:00"]
TZ=America/Los_Angeles  JAN Monday slots: ["13:00","14:00","15:00","16:00"]

TZ=UTC                  JAN_UTC local date: 2026-01-11
TZ=America/New_York     JAN_UTC local date: 2026-01-11
TZ=America/Los_Angeles  JAN_UTC local date: 2026-01-11
```

(JAN_NOON is 12:00 local → 09:00/10:00/11:00/12:00 are past; 13:00–16:00
remain. JAN_UTC_FOR_JAN11 = `2026-01-12 03:00 UTC` → local `2026-01-11 21:00`
→ workshop-local date is Jan 11, not Jan 12.)

### Check results
- `npm run typecheck` → **0 errors**
- `npm run test` → **104/104 passed** (33 existing smoke + 58 scheduling + 13
  TZ-independence)

### Files changed

| File | Change |
|---|---|
| `test/scheduling.tz-independence.test.ts` | New — 13 TZ-independence tests |
| `docs/verification.md` | This evidence record + voice/UI requirements |

Not changed: `src/scheduling.ts` (already TZ-independent), `src/config.ts`,
`src/index.ts`, `telnyx.toml`, `package.json`, `telnyx-env.d.ts`,
`test/scheduling.test.ts`, `test/smoke.test.ts`.

---

### Voice/UI timezone requirements (for later implementation)

The workshop timezone is `America/Mexico_City`. The caller, browser, or
server timezone must never affect scheduling. These requirements apply to
the Voice AI conversation and the portal UI (not implemented in this subtask):

1. **Explicitly label offered and confirmed times as Mexico City time.**
   When offering availability or confirming a booking, say "Mexico City time"
   (or the equivalent in the caller's language) and the full date.
   Example: "Tuesday, January 13 at 10:00 AM Mexico City time."

2. **Confirm the full appointment date, time, and workshop timezone.**
   On booking confirmation, speak the complete date, time, and timezone
   label: "Your appointment is confirmed for Tuesday, January 13 at 10:00 AM
   Mexico City time."

3. **Interpret relative dates using the workshop's local date.**
   "Today" / "tomorrow" / "this week" refer to the workshop's local calendar
   date in `America/Mexico_City`, not the caller's local date. A caller at
   23:00 Eastern asking for "tomorrow" is offered slots starting from the
   workshop's next local calendar day.

4. **Never silently convert appointment times using the browser timezone.**
   The portal displays all times in `America/Mexico_City`. No `toLocaleString`
   or `Intl.DateTimeFormat` calls without an explicit `timeZone:
   "America/Mexico_City"` option. The browser `Intl.DateTimeFormat().resolvedOptions().timeZone`
   is never used for appointment display.

5. **Clarify ambiguous caller timezone requests instead of guessing.**
   If the caller says "3 PM" without specifying a timezone, the system should
   clarify: "Do you mean 3 PM Mexico City time?" or interpret as Mexico City
   time by convention and confirm: "I'll book you for 3 PM Mexico City time,
   is that correct?" Never silently assume the caller's timezone for booking.

## 2.3c — Agenda Actor read operation (mocked verification only)

**Date:** 2026-10-16
**Scope:** Implement `DayAgenda` Actor with `getOccupiedSlots()` read-only
method. Validate persisted state at runtime. No writes, no booking creation.
**Not claimed:** runtime isolation, serialization, or atomicity — all tests
are mocked. Real-runtime verification is a separate labeled step.

### Files changed

| File | Change |
|---|---|
| `src/agenda-actor.ts` | New — `DayAgenda` class, `DayAgendaState` type, `getOccupiedSlots()`, runtime validation |
| `test/agenda-actor.test.ts` | New — 22 mocked storage tests |

Not changed: `src/index.ts`, `src/scheduling.ts`, `src/config.ts`,
`src/counter.ts`, `telnyx.toml`, `telnyx-env.d.ts`, `test/smoke.test.ts`,
`test/scheduling.test.ts`, `test/scheduling.tz-independence.test.ts`,
`package.json`.

### Module summary (`src/agenda-actor.ts`)

- **Actor class:** `DayAgenda extends StatefulActor` — read-only this subtask
- **Persisted state type:** `DayAgendaState` (exported) — `{ date, bookings,
  idempotency }` per `booking-domain.md` §6
- **Storage key:** `"agenda"` — single aggregate per Actor instance
- **Public method:** `getOccupiedSlots(): Promise<{ occupied: string[] }>`
  — returns sorted `"HH:mm"` times, no customer data
- **Runtime validation** (not just TypeScript types):
  - `date` is a valid `YYYY-MM-DD` calendar date (reuses `isValidDate` from
    `scheduling.ts`)
  - `bookings` is a `Record<string, Booking>`, **not** an array
  - `idempotency` is a `Record`, not an array
  - Slot keys are valid whole hours `09:00`–`16:00`
  - Each booking: non-empty `id`, `service_id`, `customer_name`,
    `customer_phone`, `created_at`, `idempotency_key`
  - Booking `date` matches aggregate `date`
  - No "future date" rules applied to persisted historical bookings

### Fail-closed behavior

| Condition | `ctx.storage.get` | `getOccupiedSlots` result |
|---|---|---|
| Never written (new agenda) | `undefined` | `{ occupied: [] }` — valid empty |
| Stored as `null` | `null` | throws (caller → 503) — `null` is NOT undefined |
| Storage error | rejects | throws (caller → 503) |
| Non-object state | string/array/number | throws (caller → 503) |
| Missing `date` field | object without `date` | throws |
| Invalid calendar date | `date: "2026-02-30"` | throws |
| `bookings` is array | `{ bookings: [] }` | throws |
| Invalid slot key | `{ "09:30": {...} }` | throws |
| Booking date ≠ aggregate date | booking date "2026-10-21" | throws |
| Missing customer fields | empty `customer_name` | throws |
| Non-string idempotency_key | `idempotency_key: 42` | throws |

Only `undefined` → empty. `null` is NOT undefined — it is a stored value
and must validate (or throw). Everything else either validates or throws.

### Mocked test results (22/22 passed)

| Scenario | Expected | Actual |
|---|---|---|
| `undefined` → empty occupancy | `[]` | `[]` ✓ |
| `null` → throw (not empty) | throws | throws ✓ |
| Multiple bookings → sorted | `["09:00","13:00","16:00"]` | sorted ✓ |
| Single booking | `["10:00"]` | ✓ |
| Empty bookings record | `[]` | `[]` ✓ |
| Rejected storage read | throws | throws ✓ |
| Non-object state | throws | throws ✓ |
| Array state | throws | throws ✓ |
| Missing `date` | throws | throws ✓ |
| Invalid date format (`2026-13-40`) | throws | throws ✓ |
| Impossible date (`2026-02-30`) | throws | throws ✓ |
| `bookings` as array | throws | throws ✓ |
| `idempotency` as array | throws | throws ✓ |
| Invalid slot key `09:30` | throws | throws ✓ |
| Out-of-range slot `08:00` | throws | throws ✓ |
| `17:00` slot | throws | throws ✓ |
| Inconsistent booking date | throws | throws ✓ |
| Missing `customer_name` | throws | throws ✓ |
| Missing `customer_phone` | throws | throws ✓ |
| Non-string `idempotency_key` | throws | throws ✓ |
| No writes on empty-agenda read | no put/delete | ✓ |
| No writes on populated read | no put/delete | ✓ |

### Check results
- `npm run typecheck` (`tsc --noEmit`) → **0 errors**
- `npm run test` (`vitest run`) → **126/126 passed** (33 smoke + 58 scheduling
  + 13 TZ-independence + 22 agenda-actor)

### What mocked tests prove
- Actor class correctly reads `ctx.storage.get("agenda")` and distinguishes
  `undefined`/`null` (empty agenda) from stored values.
- Runtime validation catches malformed state — never silently returns empty
  occupancy when storage has bad data.
- No storage writes are performed on read paths.
- `getOccupiedSlots()` returns only slot times, sorted, no customer data.

### What is NOT proven (needs real-runtime tests)
- `ctx.storage.get` returning `undefined` for a never-written per-instance key
  (verified only on real Actor runtime via `telnyx-edge dev` or production).
- Per-instance isolation across different actor names (`main-2026-10-20` vs
  `main-2026-10-21`).
- Single-aggregate `ctx.storage.put` atomicity guarantee ([C4] open decision).
- Concurrent dispatch within the Actor under load.
- Persistence across container restarts.

## 2.3d — Availability service + GET /demo/availability (mocked verification only)

**Date:** 2026-10-16
**Scope:** Wire agenda availability locally — export DayAgenda, add AGENDA
binding, implement availability service, add auth-gated route, test with
mocks. No booking writes, MCP, or deployment.
**Not claimed:** runtime scheduling/Actor behavior — all tests are mocked.
Pending real-runtime verification is a separate labeled step.

### Files changed

| File | Change |
|---|---|
| `src/index.ts` | Export `DayAgenda`; add `AGENDA` to Env; add `GET /demo/availability?date=YYYY-MM-DD` route |
| `src/availability.ts` | New — `getAvailability` service, `validateDateParam`, `AvailabilityResult` / `AvailabilityError` types |
| `telnyx.toml` | Added `[[actors]] binding = "AGENDA", type = "DayAgenda"` |
| `telnyx-env.d.ts` | Regenerated — 4 bindings (COUNTER, AGENDA, CONFIG, SECRETS) |
| `docs/verification.md` | This evidence record |

Not changed: `src/scheduling.ts`, `src/config.ts`, `src/counter.ts`,
`src/agenda-actor.ts`, existing tests, `package.json`.

### Module summary (`src/availability.ts`)

- `validateDateParam(searchParams)` — extracts and validates exactly one
  date parameter: missing → `{kind:"date_missing"}`, >1 → `"date_duplicate"`,
  malformed → `"date_invalid"`.
- `getAvailability(date, now, config, agenda)` — combines scheduling with
  Actor reads: checks window, generates `generateDaySlots` candidates,
  addresses `AGENDA.idFromName("main-{date}")`, calls `getOccupiedSlots()`,
  marks occupied as `available:false`. Returns `{location_id, date,
  timezone, booking_enabled, slots}`.
- Runtime validation of Actor response shape: non-array `occupied` → 503;
  non-string entries → 503; Actor throw → 503.
- `booking_enabled` is an admission flag, independent from slot occupancy.
  When `false`, slots are still reported but the response does not imply
  new bookings are permitted.
- All dependencies (config, Actor namespace, `now`) are injected.

### Route: `GET /demo/availability?date=YYYY-MM-DD`

- Protected by the same `SMOKE_AUTH` bearer gate as `/demo/config`.
- Authenticates **before** reading KV or calling Actors.
- Missing `CONFIG` / `AGENDA` binding → `503`.
- Invalid config → `503`. Actor call rejects → `503`. Malformed response → `503`.
- Invalid/missing/duplicate date → `400`. Out-of-window date → `400`.
- Health, config, and Counter routes unchanged.

### Mocked test results (32/32 passed in `test/availability.test.ts`)

| Scenario | Expected | Pass |
|---|---|---|
| `validateDateParam` single date | extracts date | ✓ |
| `validateDateParam` missing | `date_missing` | ✓ |
| `validateDateParam` duplicate | `date_duplicate` | ✓ |
| `validateDateParam` invalid | `date_invalid` | ✓ |
| Future weekday, empty agenda | 8 available slots | ✓ |
| Actor addressed as `main-{date}` | correct name argument | ✓ |
| Occupied single slot `10:00` | unavailable, others available | ✓ |
| Today's elapsed slots at 10:30 | 6 remaining (11:00–16:00) | ✓ |
| Saturday returns `slots:[]` | no candidates, Actor not called | ✓ |
| Sunday returns `slots:[]` | no candidates | ✓ |
| `date_out_of_range` today+7 | service-level error | ✓ |
| `date_out_of_range` yesterday | service-level error | ✓ |
| `booking_enabled=false` visible | response includes `false` | ✓ |
| Actor rejects → `service_unavailable` | ✓ | ✓ |
| Malformed Actor response (non-array) → 503 | ✓ | ✓ |
| Malformed Actor response (non-string) → 503 | ✓ | ✓ |
| location_id/timezone/date/booking_enabled present | ✓ | ✓ |
| Route: unauthorized → 401, Actor not called | ✓ | ✓ |
| Route: absent SECRETS → 503, no Actor | ✓ | ✓ |
| Route: future weekday empty → 200 with 8 slots | ✓ | ✓ |
| Route: occupied slot marks unavailable | ✓ | ✓ |
| Route: `booking_enabled=false` visible | ✓ | ✓ |
| Route: addresses Actor as `main-{date}` | ✓ | ✓ |
| Route: 400 missing date | ✓ | ✓ |
| Route: 400 duplicate date | ✓ | ✓ |
| Route: 400 invalid date | `date_invalid` | ✓ |
| Route: 400 out-of-window (far future) | `date_out_of_range` | ✓ |
| Route: 503 missing AGENDA binding | ✓ | ✓ |
| Route: 503 missing CONFIG binding | ✓ | ✓ |
| Route: 503 invalid config (KV null) | ✓ | ✓ |
| Route: 503 rejected Actor call | ✓ | ✓ |
| Route: 503 malformed Actor response | ✓ | ✓ |

### Check results
- `npm run typecheck` (`tsc --noEmit`) → **0 errors**
- `npm run test` (`vitest run`) → **158/158 passed** (33 smoke + 58 scheduling
  + 13 TZ-independence + 22 agenda-actor + 32 availability)

### What mocked tests prove
- Date parameter extraction, validation, and 400 responses
- Scheduling candidate generation and occupancy marking
- Fail-closed behavior on missing bindings, invalid config, Actor errors,
  malformed responses (always 503, never all available)
- Auth gate before KV/Actor access
- Per-Actor addressing as `main-{YYYY-MM-DD}`
- `booking_enabled` is visible independent of slot availability
- Timezone/location labels present in response
- Weekends return empty slots without calling the Actor

### What is NOT proven (needs real-runtime tests)
- End-to-end KV → scheduling → Actor → response on a live `telnyx-edge dev`
  stack (uses real `Date.now()` rather than injected `now`).
- Actor instance routing across `idFromName("main-...")` for different dates.
- Concurrent dispatch between availability reads and future booking writes.
- Production `[[actors]]` registration and Dapr actor type lifecycle.

### Note
The HTTP route uses real `Date.now()` for its `now` parameter (not injected
from the request itself), because the production handler always serves the
real current time. Service-level tests inject `now` explicitly for
deterministic validation of scheduling correctness.

## 2.3e — Deploy DayAgenda Actor + availability route; verify public boundaries

**Date:** 2026-10-16
**Scope:** Deploy the function with the new `[[actors]] AGENDA → DayAgenda`
binding; verify public health + auth-gated availability route against the
remote runtime. No booking writes, no KV modifications.
**Not claimed:** authenticated KV-to-Actor availability integration — the
authenticated request will be executed manually by the user.

### Manifest and pre-deploy verification
- `func_id = a666861a-13f6-4dd3-8955-8201bee7209c` preserved
- `[[actors]] COUNTER → Counter` preserved
- `[[actors]] AGENDA → DayAgenda` newly declared
- `[storage.kv.CONFIG] id = 533e7681-de0d-4af6-bf4d-1da671f7f5d3` preserved
- `[[secrets]] SMOKE_AUTH → SMOKE_TEST_TOKEN` preserved
- `DayAgenda` exported from `src/index.ts` line 2
- 4 typed bindings in `telnyx-env.d.ts` (COUNTER, AGENDA, CONFIG, SECRETS)
- `npm run typecheck` → **0 errors**
- `npm run test` → **158/158 passed**

### Deployment
- Command: `telnyx-edge ship`
- Result: **deployed successfully** in 11m5s
- URL: `https://servicedesk-ai-a666861a-1.telnyxcompute.com`

### Remote HTTP checks (unauthenticated)

```
GET  /health                                 → 200 {"status":"ok","service":"servicedesk-ai"}
GET  /demo/availability?date=2026-10-20       → 401 {"error":"unauthorized"}
```

| Check | Expected | Actual | Pass? |
|---|---|---|---|
| Health unauthenticated → 200 + service JSON | 200 | `200 {"status":"ok","service":"servicedesk-ai"}` | Yes |
| Availability unauthenticated → 401 (auth gate) | 401 | `401 {"error":"unauthorized"}` | Yes |

### Interpretation
- **Health is public** and returns the correct payload after redeploy with the
  new AGENDA binding.
- **`/demo/availability` returns 401** — the `SMOKE_AUTH` secret binding is live
  and protects the availability route before KV (`env.CONFIG`) or Actors
  (`env.AGENDA`) are touched.
- A 503 would have indicated the `AGENDA` binding was unavailable — not observed.

### Not claimed
- Authenticated availability integration (KV read + Actor `idFromName("main-{date}")
  → getOccupiedSlots → response) is **not verified** — pending the user's
  authenticated smoke test.
- Per-instance Actor isolation on the remote runtime is not verified.
- Concurrent dispatch on the remote runtime is not verified.

## 2.4 (user evidence) — Remote authenticated availability confirmed

**Date:** 2026-10-16
**Attribution:** The user manually called authenticated
`GET /demo/availability?date=2026-10-20` against
`https://servicedesk-ai-a666861a-1.telnyxcompute.com` with a valid bearer
token. The AI agent did not run this request or access the credential.

### Manually executed request and result

```
GET  /demo/availability?date=2026-10-20   (with valid bearer token)
  → 200
  {
    "location_id": "main",
    "date": "2026-10-20",
    "timezone": "America/Mexico_City",
    "booking_enabled": true,
    "slots": [
      { "time": "09:00", "available": true },
      { "time": "10:00", "available": true },
      { "time": "11:00", "available": true },
      { "time": "12:00", "available": true },
      { "time": "13:00", "available": true },
      { "time": "14:00", "available": true },
      { "time": "15:00", "available": true },
      { "time": "16:00", "available": true }
    ]
  }
```

### Verified
- End-to-end KV → scheduling → Actor (`getOccupiedSlots`) → response works
  on the remote runtime.
- `booking_enabled: true` reflected from KV.
- Eight available slots from 09:00 to 16:00, all available (empty agenda).
- `location_id`, `timezone`, `date`, `booking_enabled` labels present.

## 2.4b — Actor createBooking (mocked verification only)

**Date:** 2026-10-16
**Scope:** Implement `createBooking` in `DayAgenda` Actor with idempotency,
admission rules, fingerprint, and single-aggregate persistence. No HTTP
wiring. All tests mocked.
**Not claimed:** runtime serialization, atomicity, or persistence — pending
real-runtime verification (subtask 2.5).
**Clock correction:** `now` was removed from `CreateBookingInput`. The Actor
obtains `Date.now()` internally after idempotency lookup, before admission
validation. Tests use Vitest `vi.useFakeTimers` / `vi.setSystemTime` — no
public clock setter, no client-provided timestamp. Same instant is used for
validation and `created_at`.

### Files changed

| File | Change |
|---|---|
| `src/scheduling.ts` | Added `isValidTimeSyntax` (syntax-only HH:mm check, permits 09:30) |
| `src/agenda-actor.ts` | Added `createBooking` method, `CreateBookingInput`/`CreateBookingResult` types (no `now` field), `computeFingerprint`, `IdempotencyEntry` (extended with `booking_time`), `validateIdempotencyEntry` with cross-reference, `hasOwn` utility; `Date.now()` inside Actor after idempotency check |
| `test/agenda-actor.test.ts` | 22 to 55 tests (33 new `createBooking` tests, including 2 clock-regression tests) |
| `docs/verification.md` | This evidence record + user availability evidence |

Not changed: `src/index.ts` (no HTTP route added), `src/availability.ts`,
`src/config.ts`, `src/counter.ts`, `telnyx.toml`, `telnyx-env.d.ts`,
`package.json`.

### createBooking ordering (verified by mocks)

1. Load persisted state (undefined to empty; null to throw; valid to validate).
2. Verify stored date matches requested date (throws on mismatch).
3. Look up idempotency key via `hasOwn` (no prototype contamination).
4. Identical fingerprint to original (no write, [C6] replay).
5. Conflicting fingerprint to `idempotency_key_conflict` (no write).
6. **Obtain `Date.now()` inside the Actor** (after idempotency, before
   admission). Same instant used for validation and `created_at`. No
   client-provided timestamp; no public clock setter.
7. New attempt to admission rules (service catalog, window, open day, business
   hours, confirmation, booking_enabled, slot_in_past) checked with
   `Date.now()` and trusted config.
8. Occupancy check.
9. Backend-generated UUID booking ID (`crypto.randomUUID()`).
10. Single `put("agenda", newState)` — booking + idempotency together.
11. Success only after `put` resolves.

Loaded state is never mutated; `newState` is built fresh.

### Fingerprint

- SHA-256 over canonical JSON (sorted keys) of `{ confirmed, customer_name
  (trimmed), customer_phone (trimmed), date, service_id, time }`.
- Excludes: `idempotency_key`, `config`, `now`.
- No fields silently ignored — any difference to `idempotency_key_conflict`.

### Mocked test results (55/55 passed in test/agenda-actor.test.ts)

| Scenario | Result |
|---|---|
| Successful creation, UUID, single write | pass |
| Occupied slot rejection, no write | pass |
| Identical replay, original ID, no write | pass |
| Conflict: different service_id | pass |
| Conflict: different customer_name | pass |
| Conflict: different confirmed value | pass |
| Replay after booking_enabled=false [C6] | pass |
| Replay after clock past slot [C6] | pass |
| Replay after service removed from catalog [C6] | pass |
| New: unknown_service | pass |
| New: date_out_of_range | pass |
| New: date_not_open (weekend) | pass |
| New: time_invalid (09:30, 17:00, 08:00) | pass |
| New: confirmation_required | pass |
| New: booking_disabled | pass |
| New: slot_in_past (clock set to 11:00) | pass |
| **Clock advances during read: slot past at admission, rejected** | **pass** |
| **Identical replay succeeds despite clock advance during read** | **pass** |
| Null state -> throws | pass |
| Malformed state (array) -> throws | pass |
| Agenda date mismatch -> throws | pass |
| Inconsistent idempotency (non-existent booking) -> throws | pass |
| Inconsistent idempotency (booking_id mismatch) -> throws | pass |
| Read failure -> throws | pass |
| Write failure -> throws, state untouched | pass |
| Write persisted but ack lost -> retry returns original | pass |
| `__proto__` as idempotency key -> safe | pass |
| `constructor` as idempotency key -> safe | pass |
| `toString` as idempotency key -> safe | pass |
| `hasOwnProperty` as stored key -> safe replay | pass |
| No customer details in success result | pass |

### Clock-regression tests (new, 2 tests)

1. **Slot that started by admission time is rejected:** Clock starts at
   09:59; storage read advances clock to 10:01; slot 10:00 is now past at
   admission → `slot_in_past`. No write.
2. **Identical replay still succeeds despite clock advance:** First call at
   08:00 creates booking for 10:00. Replay at 15:00 (storage read further
   advances clock to 17:00). Replay returns original `booking_id` —
   admission bypassed via idempotency ([C6]). No write.

### Check results
- `npm run typecheck` (`tsc --noEmit`) -> **0 errors**
- `npm run test` (`vitest run`) -> **191/191 passed** (33 smoke + 58 scheduling
  + 13 TZ-independence + 55 agenda-actor + 32 availability)

### Platform verification still needed (mocked only)
- `node:crypto` (`randomUUID`, `createHash`) in the Edge runtime container.
- Real-runtime `ctx.storage.put` atomicity for single key ([C4]).
- Concurrent dispatch within the Actor (single-threaded guarantee).
- Persistence and rehydration across instance eviction/restart.
- `ActorOutputGateError` behavior on post-return write rejection.

## 2.4c — POST /demo/bookings HTTP adapter (mocked verification only)

**Date:** 2026-10-16
**Scope:** Protected HTTP booking adapter wired to Actor `createBooking`.
Handler does structural validation only; all business admission stays in the
Actor. No new dependencies, no deploy.
**Not claimed:** runtime HTTP-to-Actor integration — all tests mocked.

### Files changed

| File | Change |
|---|---|
| `src/bookings.ts` | New — `handleBookingRequest`: bounded body reader (10 KiB), structural validation, KV config load, Actor routing, response mapping |
| `src/index.ts` | Wired `POST /demo/bookings` route (auth-gated, after availability route); `AgendaStub` expanded with `createBooking` |
| `test/bookings.test.ts` | New — 41 mocked HTTP tests |
| `docs/verification.md` | This evidence record |

Not changed: `src/agenda-actor.ts`, `src/scheduling.ts`, `src/config.ts`,
`src/availability.ts`, `src/counter.ts`, `telnyx.toml`, `telnyx-env.d.ts`,
`package.json`.

### Handler responsibilities (no business admission)
1. Auth gate (existing `SMOKE_AUTH` bearer) before any KV/Actor access.
2. Bounded JSON body reader (10 KiB byte limit via stream; does not rely
   on `Content-Length`).
3. Structural validation: plain JSON object, expected field types, bounded
   strings, valid calendar date (`isValidDate`), HH:mm syntax
   (`isValidTimeSyntax` — permits 09:30), `confirmed` must be boolean.
4. Rejects unexpected fields: `config`, `now`, `is_retry` — all cause 400.
5. Loads trusted config from KV (failure → 503, including retries).
6. Routes to `AGENDA.idFromName("main-{date}")` and calls `createBooking`
   with validated fields + trusted config. No timestamp passed.
7. Maps Actor results: success → 200, known domain error → 400, unknown
   error / Actor throw / malformed response → 503.

### Response shapes

| HTTP status | Body |
|---|---|
| 200 | `{ booking_id, service_id, date, time, status: "confirmed" }` |
| 400 | `{ error: "<code>" }` (domain or structural) |
| 413 | `{ error: "payload_too_large" }` |
| 503 | `{ error: "service_unavailable" }` |

### Mocked test results (41/41 passed in test/bookings.test.ts)

| Scenario | Status | Actor called? |
|---|---|---|
| Valid request → 200 with booking_id | 200 | yes |
| Actor addressed as main-{date} | verified | yes |
| Trimmed fields passed to Actor | verified | yes |
| No timestamp in Actor input | verified | yes |
| Unauthorized (wrong token) | 401 | no |
| Unauthorized (no auth header) | 401 | no |
| Malformed JSON | 400 | no |
| Bad date format (2026-13-01) | 400 | no |
| Impossible calendar date (2026-02-30) | 400 | no |
| Invalid time syntax (not HH:mm) | 400 | no |
| confirmed as string | 400 | no |
| Empty customer_name | 400 | no |
| Empty customer_phone | 400 | no |
| Empty idempotency_key | 400 | no |
| Unexpected field: config | 400 | no |
| Unexpected field: now | 400 | no |
| Unexpected field: is_retry | 400 | no |
| Oversized body (no Content-Length) | 413 | no |
| Oversized body (misleading short Content-Length) | 413 | no |
| Missing CONFIG binding | 503 | no |
| Missing AGENDA binding | 503 | no |
| KV returns null (infra failure) — first attempt | 503 | no |
| KV returns null (infra failure) — retry same key | 503 | no |
| confirmed:false reaches Actor | 400 (Actor says confirmation_required) | yes |
| Unknown service_id reaches Actor | 400 (Actor says unknown_service) | yes |
| 09:30 time reaches Actor (handler syntax-only) | 400 (Actor says time_invalid) | yes |
| Replay (identical retry) reaches Actor and succeeds | 200 | yes |
| All 9 domain error codes mapped to 400 | 400 each | yes |
| Actor throws | 503 | yes |
| Malformed Actor response (not object) | 503 | yes |
| Malformed Actor response (ok not boolean) | 503 | yes |
| Unknown Actor error code | 503 | yes |
| Body excludes customer_name/phone | verified | yes |
| GET /demo/bookings | 404 | no |

### Check results
- `npm run typecheck` (`tsc --noEmit`) -> **0 errors**
- `npm run test` (`vitest run`) -> **232/232 passed** (33 smoke + 58 scheduling
  + 13 TZ-independence + 55 agenda-actor + 32 availability + 41 bookings)

## 2.4d — Deploy booking endpoint; verify public boundaries

**Date:** 2026-10-16
**Scope:** Deploy the function with the new `POST /demo/bookings` route and
verify public health + auth-gated booking route against the remote runtime.
No bookings created. No credentials accessed.
**Not claimed:** authenticated booking creation, runtime crypto/storage
behavior, or Actor integration — all pending user's manual smoke test.

### Manifest and pre-deploy verification
- `func_id = a666861a-13f6-4dd3-8955-8201bee7209c` preserved
- `[[actors]] COUNTER -> Counter` preserved
- `[[actors]] AGENDA -> DayAgenda` preserved
- `[storage.kv.CONFIG] id = 533e7681-de0d-4af6-bf4d-1da671f7f5d3` preserved
- `[[secrets]] SMOKE_AUTH -> SMOKE_TEST_TOKEN` preserved
- `DayAgenda` exported from `src/index.ts`
- `npm run typecheck` -> **0 errors**
- `npm run test` -> **232/232 passed**

### Deployment
- Command: `telnyx-edge ship`
- Result: **deployed successfully** in 10m15s (single attempt)
- URL: `https://servicedesk-ai-a666861a-1.telnyxcompute.com`

### Remote HTTP checks (unauthenticated)

```
GET  /health                         -> 200 {"status":"ok","service":"servicedesk-ai"}
POST /demo/bookings  (body: {})      -> 401 {"error":"unauthorized"}
```

| Check | Expected | Actual | Pass? |
|---|---|---|---|
| Health unauthenticated -> 200 + service JSON | 200 | `200 {"status":"ok","service":"servicedesk-ai"}` | Yes |
| Bookings unauthenticated (empty `{}`) -> 401 | 401 | `401 {"error":"unauthorized"}` | Yes |

### Interpretation
- **Health is public** and returns the correct payload after redeploy with
  the bookings route.
- **`POST /demo/bookings` returns 401** — the `SMOKE_AUTH` secret binding is
  live and protects the booking route before KV or Actor are touched. The
  empty `{}` body was never parsed for business logic; authentication rejected
  first.
- A 413 or 400 would have meant the auth gate was bypassed — not observed.

### Not claimed
- Authenticated booking creation (`createBooking` with valid bearer) is **not
  verified** — pending the user's manual smoke test.
- `node:crypto` (`randomUUID`, `createHash`) in the Edge container is **not
  verified** on the remote runtime.
- Real-runtime `ctx.storage.put` atomicity and persistence are **not
  verified**.

## 2.4e — Remote booking creation and replay (manual user execution)

**Date:** 2026-10-20
**Attribution:** All requests below were executed manually by the user with
a valid `Authorization: Bearer <SMOKE_TEST_TOKEN>` credential against
`https://servicedesk-ai-a666861a-1.telnyxcompute.com`. The AI agent did not
run these requests or access the credential.

### Parameters

| Field | Value |
|---|---|
| Date | `2026-10-20` |
| Slot | `10:00` |
| Service | `oil_change` |
| Idempotency key | `demo-booking-2-4e-001` |
| Booking ID (returned) | `1d96510d-5753-43c5-90b0-de39b4fa16da` |

### Observed results

```
# 1. Initial authenticated POST /demo/bookings
POST /demo/bookings   (service_id=oil_change, date=2026-10-20, time=10:00,
                       idempotency_key=demo-booking-2-4e-001, confirmed=true)
  -> 200
     { "booking_id": "1d96510d-5753-43c5-90b0-de39b4fa16da",
       "service_id": "oil_change", "date": "2026-10-20",
       "time": "10:00", "status": "confirmed" }

# 2. Subsequent identical POST requests (same idempotency key, same payload)
POST /demo/bookings   (identical body)
  -> 200
     { "booking_id": "1d96510d-5753-43c5-90b0-de39b4fa16da", ... }

# 3. Authenticated availability check after booking
GET /demo/availability?date=2026-10-20
  -> 200
     slots: 10:00 available=false
            09:00, 11:00, 12:00, 13:00, 14:00, 15:00, 16:00 available=true
```

### Verified

| Check | Result |
|---|---|
| Remote booking creation succeeds (200, `status: confirmed`) | Yes |
| Booking ID is a UUID (backend-generated) | Yes (`1d96510d-...`) |
| Identical-request replay returns the same booking ID | Yes (no duplicate) |
| Occupancy reflected in availability (10:00 now unavailable) | Yes |
| Other seven slots remain available | Yes |

This confirms end-to-end: KV config read -> Actor `idFromName("main-2026-10-20")`
-> `createBooking` (including `node:crypto.randomUUID()` for booking ID and
`ctx.storage.put` for persistence) -> availability re-read shows the occupied slot.

### Not claimed

- Concurrent booking attempts (two requests for the same slot simultaneously)
  are **not tested** — runtime serialization is not proven by this manual check.
- Persistence across Actor instance restart/eviction is **not tested** — the
  booking may still be in the Actor's in-memory cache; `ctx.storage`
  rehydration across eviction is not demonstrated.
- General atomicity of the single `ctx.storage.put` call is **not proven** —
  the successful round-trip shows the write completed, but a crash mid-write
  scenario is not tested.
- The idempotency key scope (per-day Actor) is not tested across dates.

## 2.5c (user evidence) — Remote booking conflict checks (manual user execution)

**Date:** 2026-10-20
**Attribution:** All requests below were executed manually by the user with
a valid bearer credential against
`https://servicedesk-ai-a666861a-1.telnyxcompute.com`. The AI agent did not
run these requests or access the credential. Customer details are omitted.

### Observed results

```
# 1. Different key, same occupied slot (10:00, service=tire_rotation)
POST /demo/bookings   (service_id=tire_rotation, date=2026-10-20, time=10:00,
                       idempotency_key=<different-key>, confirmed=true)
  -> 400 { "error": "slot_unavailable" }

# 2. Original successful key with changed service
POST /demo/bookings   (service_id=tire_rotation, date=2026-10-20, time=10:00,
                       idempotency_key=demo-booking-2-4e-001, confirmed=true)
  -> 400 { "error": "idempotency_key_conflict" }
```

### Verified

| Check | Result |
|---|---|
| Different key targeting an occupied slot -> `slot_unavailable` | Yes |
| Original key with changed payload -> `idempotency_key_conflict` | Yes |
| Occupied slot is not double-booked | Yes (second attempt rejected) |
| Conflicting payload is not silently accepted | Yes (conflict detected) |

### Not claimed
- Concurrent requests arriving simultaneously are **not tested** by these
  sequential manual checks. Runtime serialization under true concurrency is
  the purpose of the scripted test in subtask 2.5c.

## 2.5c (user evidence) — Remote bounded concurrency test (manual user execution)

**Date:** 2026-10-20
**Attribution:** The user executed `scripts/verify-booking-concurrency.mjs`
against the deployed `servicedesk-ai` function with a valid bearer credential.
The AI agent did not run the script or access the credential.

### Parameters

| Field | Value |
|---|---|
| Script | `scripts/verify-booking-concurrency.mjs` |
| Target | `https://servicedesk-ai-a666861a-1.telnyxcompute.com` |
| Date | `2026-10-20` |
| Time | `11:00` |
| Run ID | `concurrency-test-001` |
| Requests | 20 |
| Concurrency cap | 5 |

### Observed results

| Metric | Count |
|---|---|
| Confirmed | 1 |
| slot_unavailable | 19 |
| Other domain errors | 0 |
| Unexpected statuses | 0 |
| Network errors | 0 |
| Timeouts | 0 |
| Ambiguous outcomes | 0 |

| Metric | Value |
|---|---|
| Winning booking ID | `f0ebbf6b-3bd4-467d-86ed-cb809e36cd62` |
| Preflight | Slot available, `booking_enabled: true` |
| Postflight | Slot `11:00` on `2026-10-20` is occupied |

### Verified

| Check | Result |
|---|---|
| Exactly 1 of 20 concurrent requests confirmed | Yes |
| Other 19 returned `slot_unavailable` | Yes |
| No unexpected, ambiguous, or timeout outcomes | Yes |
| Winning booking ID is a UUID (backend-generated) | Yes |
| Postflight availability shows `11:00` as occupied | Yes |

This verifies the Actor's single-threaded dispatch for this bounded remote
contention scenario: 20 concurrent requests (capped at 5 in flight) targeting
the same slot produced exactly 1 booking and 19 rejections with no lost
updates or double bookings.

### Not claimed

- General atomicity of `ctx.storage.put` beyond this specific scenario.
- Production-scale behavior under sustained load or higher concurrency.
- Persistence across Actor instance restart/eviction (in-memory cache or
  rehydration not tested).
- This is a single run, not a statistical proof of the serialization guarantee.

### Synthetic bookings on 2026-10-20

Two synthetic bookings now occupy slots on `2026-10-20`:

| Slot | Booking ID | Source |
|---|---|---|
| `10:00` | `1d96510d-5753-43c5-90b0-de39b4fa16da` | Subtask 2.4e |
| `11:00` | `f0ebbf6b-3bd4-467d-86ed-cb809e36cd62` | Subtask 2.5c |

These bookings are not removed — no cleanup/cancellation endpoint exists.

## 2.5d — booking_enabled disabled for remote replay testing

**Date:** 2026-10-20
**Scope:** Temporarily set `business.booking_enabled` to `false` in remote KV
(namespace `533e7681-de0d-4af6-bf4d-1da671f7f5d3`, key `config/main`) so that
new booking attempts are rejected while existing successful replays still
succeed (per [C6]). No source code, seed, bindings, or bookings modified.

### Steps

1. Read current remote KV value: `booking_enabled: true`.
2. Wrote modified JSON to a temp file with only `booking_enabled` set to `false`.
   Python diff confirmed exactly one field changed.
3. Wrote back via `telnyx-edge storage kv key put <id> config/main --path <tmp>`.
4. Read back and compared parsed JSON.

### Read-back verification

| Field | Before | After |
|---|---|---|
| `business.booking_enabled` | `true` | **`false`** |
| `business.location_id` | `main` | unchanged |
| `business.timezone` | `America/Mexico_City` | unchanged |
| `business.open_days` | `["mon","tue","wed","thu","fri"]` | unchanged |
| `business.slot_hours` | `{start:"09:00",end:"17:00",last_start:"16:00"}` | unchanged |
| `business.booking_window_days` | `7` | unchanged |
| `services` (3 entries) | unchanged | unchanged |

**Read-back MATCH: only `booking_enabled` changed. All other fields preserved.**

### Repository seed unchanged

`config/main.json` in the repository was **not modified** — it still has
`booking_enabled: true`. The toggle was applied only to the remote KV value
via a temp file (now cleaned up).

### Flag status: remains false

**`booking_enabled` is currently `false` in the remote KV.** It remains false
pending:
1. The user's manual HTTP tests (e.g., authenticated `POST /demo/bookings` with
   a new key should return `400 booking_disabled`; an identical replay of the
   2.4e booking should return `200` with the original booking ID, per [C6]).
2. The user's subsequent restoration (toggling back to `true`).

No deploy is needed — KV updates are live without redeployment. The deployed
function will read `booking_enabled: false` on its next request and reject new
bookings. Existing successful replays bypass this check via the Actor's
idempotency lookup.

## 2.5e (user evidence) — Remote replay and disabled-booking checks (manual user execution)

**Date:** 2026-10-20
**Attribution:** All requests below were executed manually by the user with
a valid bearer credential against
`https://servicedesk-ai-a666861a-1.telnyxcompute.com`. The AI agent did not
run these requests or access the credential. Customer details are omitted.

### Observed results

```
# 1. Config read confirms booking_enabled=false (no redeploy needed)
GET /demo/config
  -> 200
     { ..., "business": { ..., "booking_enabled": false, ... } }

# 2. Identical replay of the 2.4e booking (key=demo-booking-2-4e-001)
POST /demo/bookings   (service_id=oil_change, date=2026-10-20, time=10:00,
                       idempotency_key=demo-booking-2-4e-001, confirmed=true)
  -> 200
     { "booking_id": "1d96510d-5753-43c5-90b0-de39b4fa16da",
       "service_id": "oil_change", "date": "2026-10-20",
       "time": "10:00", "status": "confirmed" }

# 3. New attempt while booking_enabled=false
POST /demo/bookings   (service_id=oil_change, date=2026-10-20, time=12:00,
                       idempotency_key=demo-disabled-2-5d-001, confirmed=true)
  -> 400 { "error": "booking_disabled" }
```

### Verified

| Check | Result |
|---|---|
| `booking_enabled: false` visible in `/demo/config` without redeploy | Yes |
| Identical replay returns `200` + original `booking_id` despite disabled flag | Yes ([C6]) |
| New booking attempt while disabled returns `400 booking_disabled` | Yes |
| Replay does not create a duplicate booking | Yes (same `booking_id`) |

This confirms the Actor's idempotency-first admission ordering: replays bypass
`booking_enabled` (and all other time-less business rules), while new
attempts are rejected when bookings are disabled — both observed live on the
remote runtime without redeployment.

## 2.5e — booking_enabled restored to true

**Date:** 2026-10-20
**Scope:** Restore `business.booking_enabled` to `true` in remote KV after
the user confirmed the replay-while-disabled behavior. No source code, seed,
bindings, or bookings modified.

### Restoration (AI agent, CLI)

1. Read current remote KV value: `booking_enabled: false`.
2. Wrote modified JSON to a temp file with only `booking_enabled` set to `true`.
   Python diff confirmed exactly one field changed.
3. Wrote back via `telnyx-edge storage kv key put <id> config/main --path <tmp>`.
4. Read back and compared: `booking_enabled: true`, all other fields preserved.

### Read-back verification

| Field | Before (disabled) | After (restored) |
|---|---|---|
| `business.booking_enabled` | `false` | **`true`** |
| `business.location_id` | `main` | unchanged |
| `business.timezone` | `America/Mexico_City` | unchanged |
| `business.open_days` | `["mon","tue","wed","thu","fri"]` | unchanged |
| `business.slot_hours` | `{start:"09:00",end:"17:00",last_start:"16:00"}` | unchanged |
| `business.booking_window_days` | `7` | unchanged |
| `services` (3 entries) | unchanged | unchanged |

**Read-back MATCH: only `booking_enabled` changed. All other fields preserved.**

### Repository seed unchanged

`config/main.json` in the repository was **not modified** — it always had
`booking_enabled: true`. The toggle was applied only to the remote KV value
via a temp file (now cleaned up).

### Flag status: restored to true

**`booking_enabled` is `true` in remote KV**, matching the repository seed.
The KV toggle cycle is complete:
- `true -> false` (subtask 2.5d) — verified via user HTTP checks (2.5e user evidence).
- `false -> true` (this subtask) — verified via CLI read-back.

### Complete KV toggle verification cycle

```
2.2e (part 1): true -> false      (user confirmed via /demo/config)
2.2e (part 1): user HTTP check    (booking_enabled: false visible)
2.2f:          false -> true       (user confirmed via /demo/config)
2.5d:          true -> false       (for replay testing)
2.5e (user):   user HTTP checks   (replay succeeds, new booking rejected)
2.5e:          false -> true       (restored, CLI read-back confirmed)
```

Remote KV now matches the repository seed. No redeploy was needed at any
point — all KV toggles were live without `ship`.

## 3.x — Focused review fixes: state consistency, body-reader errors, malformed occupancy

**Date:** 2026-10-16
**Scope:** Three narrowly-scoped correctness fixes uncovered by review of the
phase 2 booking domain. All changes are local; no remote state, bindings,
credentials, business rules, or stored-state format changed.
**Not claimed:** production incidents, deployment behavior, runtime
behavior beyond mocked unit tests.

### Environment

- Local Vitest suite only (`npm run test`, `npm run typecheck`).
- `@telnyx/edge-runtime` is mocked in `test/agenda-actor.test.ts`,
  `test/availability.test.ts`, and `test/bookings.test.ts`. No remote KV,
  Actor storage, or live runtime is touched.
- Working tree inspected before edits; existing changes from prior subtasks
  were preserved.

### Fix 1 — Persisted agenda consistency (record-key validation)

`DayAgenda.validateState()` already checked each booking's own fields
(`id`, `date`, `time`, `idempotency_key`, ...) and each idempotency
entry's reference back to its booking. It did NOT verify that the record
key equalled the booking's own `time` field, or that the idempotency
record key equalled the referenced booking's `idempotency_key`. A key
mismatch would silently desynchronize the in-memory aggregate from the
record contents.

**Change (src/agenda-actor.ts):**

```ts
// bookings loop
const booking = validateBooking(value, raw.date);
if (booking.time !== key)
  throw new Error(`booking key does not match booking.time: ${key}`);
bookings[key] = booking;

// idempotency loop
const entry = validateIdempotencyEntry(value, bookings);
const referenced = bookings[entry.booking_time]!;
if (referenced.idempotency_key !== key)
  throw new Error(`idempotency key does not match referenced booking: ${key}`);
idempotency[key] = entry;
```

Inconsistent state throws, never silently returns empty availability.
Existing booking ID/date/reference validation preserved (verified by all
prior tests still passing).

### Fix 2 — Bounded HTTP body-reader errors

`readBoundedBody()` in `src/bookings.ts` could let two failure modes
escape:

1. A rejected `reader.read()` (e.g. aborted connection) bubbled out as an
   unhandled error.
2. The `reader.cancel()` on the oversized-body path was `await`ed
   directly — if cancel rejected, the 413 response was never delivered
   and the caller saw a thrown error.

The 10 KiB byte limit and bounded buffering were preserved.

**Change (src/bookings.ts):**

```ts
async function readBoundedBody(req: Request): Promise<
  | { ok: true; text: string }
  | { ok: false; status: 400 }
  | { ok: false; status: 413 }
> {
  const reader = req.body?.getReader();
  if (!reader) return { ok: true, text: "" };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      let readResult: ReadableStreamReadResult<Uint8Array>;
      try {
        readResult = await reader.read();
      } catch {
        return { ok: false, status: 400 }; // generic bad_request
      }
      if (readResult.done) break;
      total += readResult.value.byteLength;
      if (total > MAX_BODY_BYTES) {
        return { ok: false, status: 413 }; // cancel handled in finally
      }
      chunks.push(readResult.value);
    }
    // ... decode ...
    return { ok: true, text };
  } finally {
    try { await reader.cancel(); } catch { /* release lock */ }
  }
}
```

The handler maps `{ ok: false, status: 400 }` → `400 { error: "bad_request" }`
and `{ ok: false, status: 413 }` → `413 { error: "payload_too_large" }`.
No raw exception, body content, or credentials are logged or returned.

### Fix 3 — Malformed occupancy response validation

`getAvailability()` validated only that `occupied` was an array of
strings. A non-canonical value like `"10:0"` (passes `typeof === "string"`)
or a duplicate entry would silently be accepted. `new Set(occupied)` would
even dedupe duplicates for free, masking the corruption.

**Change (src/availability.ts):** validate each entry against the
canonical slot starts imported from `domain/business-rules`:

```ts
const VALID_SLOT_STARTS: ReadonlySet<string> = new Set(SLOT_START_TIMES);
// ...
if (!Array.isArray(occupied)) return { kind: "service_unavailable" };
const occupiedSet = new Set<string>();
for (const t of occupied) {
  if (typeof t !== "string" || !VALID_SLOT_STARTS.has(t))
    return { kind: "service_unavailable" };
  if (occupiedSet.has(t))
    return { kind: "service_unavailable" };
  occupiedSet.add(t);
}
```

Rejection is fail-closed as `service_unavailable`. Invalid entries are
NOT silently dropped. Valid empty/populated responses still parse.

### Commands and results

```
$ npm run typecheck
> tsc --noEmit
(no output, exit 0)

$ npm test
> vitest run

 ✓ test/scheduling.test.ts            (58 tests)
 ✓ test/agenda-actor.test.ts          (64 tests)   ← was 58 (+6 regression)
 ✓ test/availability.test.ts          (37 tests)   ← was 32 (+5 regression)
 ✓ test/smoke.test.ts                 (33 tests)
 ✓ test/bookings.test.ts              (43 tests)   ← was 41 (+2 regression)
 ✓ test/scheduling.tz-independence.test.ts (13 tests)

 Test Files  6 passed (6)
      Tests  248 passed (248)
```

### Test additions (13 new, all passing)

| Suite | Test | Asserts |
|---|---|---|
| `agenda-actor.test.ts` | booking key "10:00" with `booking.time` "11:00" throws | key/booking.time consistency |
| `agenda-actor.test.ts` | booking key "09:00" with `booking.time` "10:00" throws | key/booking.time consistency |
| `agenda-actor.test.ts` | idempotency key differs from referenced `booking.idempotency_key` throws | key/reference consistency |
| `agenda-actor.test.ts` | otherwise-valid inconsistent fixture throws (not empty) | aggregate-level integrity |
| `agenda-actor.test.ts` | valid existing record (key matches `booking.time`) still parses | no regression |
| `agenda-actor.test.ts` | reserved-looking idempotency key with consistent data still parses | no regression |
| `bookings.test.ts` | 400 with `bad_request` body when stream read rejects | KV/Actor not reached; raw error not leaked |
| `bookings.test.ts` | 413 still returned when oversized body and `cancel()` rejects | cancel rejection swallowed; raw error not leaked |
| `availability.test.ts` | malformed `"10:0"` returns `service_unavailable` | canonical slot start enforced |
| `availability.test.ts` | malformed `"not-a-time"` returns `service_unavailable` | canonical slot start enforced |
| `availability.test.ts` | duplicate slot values returns `service_unavailable` | duplicate detection |
| `availability.test.ts` | valid empty Actor response still returns 8 available slots | no regression |
| `availability.test.ts` | valid populated Actor response still marks slots unavailable | no regression |

### Behavior changes

1. `DayAgenda.validateState()` now throws on record-key mismatches (was:
   accepted silently).
2. `handleBookingRequest` returns 400 `{ error: "bad_request" }` on a
   rejected body read (was: rejected read bubbled out as unhandled error).
3. `handleBookingRequest` still returns 413 on oversized bodies even if
   the reader's cancel() rejects (was: a rejecting cancel prevented the
   413 response from being sent).
4. `getAvailability` returns `service_unavailable` on malformed or
   duplicate slot values from the Actor (was: silently accepted and
   deduped via `Set`).

Public success contracts, stored-state format, business rules,
dependencies, bindings, credentials, and remote resources: **unchanged**.

### Limitations of this check

- Discovered and verified with **mocked tests**; no production deployment
  or live runtime exercised.
- The new body-reader tests inject a custom `ReadableStream` whose
  `start()` calls `controller.error()` (rejected read) and whose `cancel()`
  throws (cancel rejection). Real undici/Node fetch behavior may differ
  for streams supplied from the network.
- The malformed-occupancy validation is runtime-only; it does not heal
  the persisted Actor state. If a corrupted aggregate ever exists in
  real storage, the read will throw and the caller will see 503.
