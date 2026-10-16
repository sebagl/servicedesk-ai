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
