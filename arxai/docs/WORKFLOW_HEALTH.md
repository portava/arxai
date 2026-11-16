# Workflow Health & Startup Readiness — operator preflight

This note exists because of a real incident: the dashboard appeared to take
~7 seconds to load on every page. The cause was **not** frontend render speed —
the `api-server` and `trading-dashboard` workflows were not actually listening
(failed/orphaned). The frontend's first blocking `/api` call hung until proxy
timeout, so the whole shell looked frozen. The code was fine; the processes
were dead.

This hardening makes that state **loud and detectable** instead of silent.

## Services that must be running

| Service | Workflow | localPort | Proves it's alive |
| --- | --- | --- | --- |
| api-server | `artifacts/api-server: API Server` | 8080 | `GET /api/healthz` → 200 `{ok:true}` |
| frontend (app preview) | `artifacts/trading-dashboard: web` | 24210 | `GET /` → 200 HTML |
| mockup-sandbox (design only) | `artifacts/mockup-sandbox: Component Preview Server` | 8081 | `GET /__mockup` (not required for trading) |

There is **no** separate MT5 bridge or websocket workflow to babysit:

- The MT5 **EA** runs on the user's own MT5 terminal/VPS and talks to the
  api-server over per-user bridge endpoints. It is **not** a Replit workflow.
- The Deriv websocket client is started **inside** the api-server process, so
  if api-server is healthy, the quote client is in-process.

Always reach services through the shared proxy at `http://localhost:80` (e.g.
`/api/healthz`, `/`). Never curl the service ports directly.

## How to verify

Run the one-shot health check from the shell:

```bash
pnpm run health:workflows
```

It probes (read-only, GET-only, no auth, no secrets, no trade path):

1. api-server listening + `/api/healthz` returns 200 with a sane payload.
2. frontend listening + `/` serves real HTML, and prints the served build hash.
3. Scanner candles auth behavior: unauthenticated `GET /api/data/candles`
   **must** return `401` (deny-by-default auth gate intact).
4. Best-effort orphan/duplicate detection: how many processes listen on each
   expected port (skipped cleanly if socket introspection is restricted).

Exit code is non-zero if a **required** service is unhealthy, so it is safe to
wire into CI or a manual preflight.

Operators also get an in-app, ADMIN/OWNER-only **Workflow Health** card on
**Admin → Diagnostics** (`/admin/diagnostics`), backed by
`GET /api/admin/runtime-health`. It reports api-server uptime/version, DB
reachability + latency, and aggregate MT5/EA heartbeat health (counts only —
never account numbers, IPs, or tokens). Normal users never see it; they only
ever get a clean "unavailable" message.

On every api-server start, a **startup readiness self-check** pings the DB and
logs an `ARX READINESS — OK` banner (or `ARX READINESS — DEGRADED` at error
level) so a broken dependency is visible in the logs immediately.

## How to detect a dead / orphaned workflow

- The preview is uniformly slow (~seconds) or blank on **every** page, not just
  one screen.
- `pnpm run health:workflows` reports `FAIL` for api-server and/or frontend, or
  the proxy probe errors / times out (a dead workflow cannot answer 200).
- Logs show no recent `ARX READINESS — OK` banner after the last restart, or a
  `DEGRADED` line.
- The orphan check reports more than one PID listening on the same port.

## How to restart safely

1. Restart the affected workflow(s) only — typically
   `artifacts/api-server: API Server` and/or `artifacts/trading-dashboard: web`.
2. Re-run `pnpm run health:workflows` and confirm all required checks pass.
3. Confirm a fresh `ARX READINESS — OK` banner in the api-server logs.

### Live MT5 safety during health repair

- **Do not** casually restart anything on the live MT5 path while repairing the
  frontend/api workflows unless it is actually required. Restarting api-server
  is safe and the EA reconnects on its own heartbeat; do not change live-broker
  configuration, the kill switch, allocation, freeze, or MT5 confirmation rules
  as part of a health fix.
- **Never** place a live trade as part of a health check. All health probes are
  read-only and unauthenticated; nothing in this flow dispatches an order.
