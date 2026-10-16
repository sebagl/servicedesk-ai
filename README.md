# ServiceDesk AI

An AI receptionist for a fictional auto repair shop, built on Telnyx Edge Compute.

This repository contains the **minimal verified foundation** — a platform
compatibility check, not the full product. See [docs/architecture.md](docs/architecture.md)
for the planned system vs. what is implemented.

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
  not required for typecheck or mocked tests).

## Manifest and entrypoint

This project uses a **`telnyx.toml`** umbrella manifest — not `func.toml`.

| Convention | Manifest | HTTP entrypoint | StatefulActors |
|---|---|---|---|
| `func.toml` (classic) | `func.toml` | You own a `node:http` server on `PORT \|\| 8080` | Not supported |
| `telnyx.toml` (umbrella) | `telnyx.toml` | `export default { async fetch(req, env) }` — runtime serves it | TypeScript-only |

StatefulActors require `telnyx.toml`, so this project uses the fetch-handler
contract. There is no Express, Hono, or custom `node:http` server.

Source: [Project Structure](https://developers.telnyx.com/docs/edge-compute/stateful-actors/guides/project-structure)

## Verified local commands

```bash
npm install          # install dependencies
npm run typecheck    # tsc --noEmit (strict mode)  → 0 errors
npm run test         # vitest run (mocked)         → 13/13 passed
```

### Local runtime (verified)

Requires Docker. Downloads ~1 GB on first run.

```bash
telnyx-edge dev --no-watch   # serves at http://127.0.0.1:8787
```

Verified against the live local runtime:

```bash
curl http://127.0.0.1:8787/health
# → {"status":"ok","service":"servicedesk-ai"}

curl -X POST http://127.0.0.1:8787/demo/counter/counter-a/increment \
  -H 'content-type: application/json' -d '{"amount":5}'
# → {"counter":"counter-a","count":5}

curl -X POST http://127.0.0.1:8787/demo/counter/counter-a/increment \
  -H 'content-type: application/json' -d '{"amount":3}'
# → {"counter":"counter-a","count":8}    (persistence: cumulative)

curl http://127.0.0.1:8787/demo/counter/counter-a/read
# → {"counter":"counter-a","count":8}

curl -X POST http://127.0.0.1:8787/demo/counter/counter-b/increment \
  -H 'content-type: application/json' -d '{"amount":1}'
# → {"counter":"counter-b","count":1}    (isolation: separate instance)

curl http://127.0.0.1:8787/demo/counter/counter-a/read
# → {"counter":"counter-a","count":8}    (isolation: counter-a unaffected)
```

Stop the stack:

```bash
docker compose -f .telnyx/dev/compose.yaml down        # stop (keeps state)
docker compose -f .telnyx/dev/compose.yaml down -v      # stop + delete state
```

### Deploy (not yet configured)

`telnyx.toml` has no `func_id` — it was omitted because `telnyx-edge new-func --actor`
registers a function with the platform (provisioning), which was out of scope for
the foundation task. Before first deploy:

```bash
telnyx-edge auth login           # or: telnyx-edge auth api-key set <key>
telnyx-edge new-func --actor --name=servicedesk-ai   # writes func_id into telnyx.toml
telnyx-edge ship
```

## Smoke-test route protection

The `/demo/counter/*` routes are **intended for controlled smoke tests only**.
They are protected by a dedicated secret (`SMOKE_TEST_TOKEN`), **not** the
Telnyx API key.

- **`GET /health*`** — public, no authentication required (platform probes).
- **`POST /demo/counter/:id/increment`** and **`GET /demo/counter/:id/read`** —
  require `Authorization: Bearer <SMOKE_TEST_TOKEN>`.
- **Fail closed:** if the `SECRETS` binding is absent, the secret value is
  empty, or retrieval fails → `503` (demo routes unavailable). This is the
  default in local `dev` (no secrets emulation) and before the secret is
  configured for deployment.
- **Bad credentials:** missing, malformed, or incorrect `Authorization` →
  `401`.

The secret is declared in `telnyx.toml` as:
```toml
[[secrets]]
binding = "SMOKE_AUTH"
name    = "SMOKE_TEST_TOKEN"
```

Before remote smoke tests:
```bash
telnyx-edge secrets add SMOKE_TEST_TOKEN "<random-value>"
```

> **Note:** Local runtime tests in `docs/verification.md` (subtasks 1.2, 1.3)
> were performed **before** this protection was added, when demo routes were
> unauthenticated. Re-running those tests now requires the `SMOKE_AUTH` bearer
> header, which local `dev` does not emulate (routes return `503`).

## Official source URLs

- [Edge Compute CLI (GitHub)](https://github.com/team-telnyx/edge-compute)
- [Runtime overview](https://developers.telnyx.com/docs/edge-compute/runtime/index)
- [HTTP handler contract](https://developers.telnyx.com/docs/edge-compute/runtime/http-handler)
- [Bindings](https://developers.telnyx.com/docs/edge-compute/runtime/bindings)
- [Stateful Actors](https://developers.telnyx.com/docs/edge-compute/stateful-actors)
- [Actor Quick Start](https://developers.telnyx.com/docs/edge-compute/stateful-actors/quick-start)
- [Actor Project Structure](https://developers.telnyx.com/docs/edge-compute/stateful-actors/guides/project-structure)
- [Actor API Reference](https://developers.telnyx.com/docs/edge-compute/stateful-actors/api-reference)
