# Independent Protection Watchdog (#28)

A **separate process** that verifies, from outside the api-server, that open
positions carry protective orders, that queued commands are moving, and that
the main app is alive — and alerts when any of that is false or unverifiable.

- Entrypoint: `artifacts/api-server/src/watchdog.ts` (own process; imports
  only `pg` + the pure core `src/lib/protectiveWatchdog/watchdogCore.ts` —
  no app.ts, no routes, no workers, no `@workspace/db` singleton).
- Own DB connection, forced read-only: the session executes
  `SET default_transaction_read_only = on` immediately after connect, so
  Postgres itself refuses any write from this process.
- Authority: **alerting only.** It cannot close, place, or modify anything
  and holds no execution surface. Unverifiable state (unreachable DB, failed
  query) is a CRITICAL `cannot_verify:*` alert — never a quiet pass.

## Running it

**`docs/WATCHDOG_DEPLOYMENT.md` is the runnable package** — the command, the
full environment table, the liveness surface, the three topologies with what
each does *not* protect against, and the owner-press list. This section is the
summary.

```bash
pnpm run watchdog             # loop mode, default 60s interval
pnpm run watchdog:once        # single pass; exit 0 healthy/warn, 1 critical, 2 cannot-verify-db
```

> Correction (branch `hold/watchdog-deploy`): this file previously documented
> `pnpm run watchdog` when **no such root script existed**. It does now, and
> `test:watchdog-deployment` asserts every documented script is real so the
> claim cannot rot again.

Environment (full table in `docs/WATCHDOG_DEPLOYMENT.md`):

| Variable | Meaning |
|---|---|
| `ARX_WATCHDOG_DATABASE_URL` | Connection string for the watchdog (preferred: a read-only role — see below). Falls back to `DATABASE_URL`. |
| `ARX_WATCHDOG_INTERVAL_MS` | Loop interval (default 60000, floor 5000). |
| `ARX_WATCHDOG_ALERT_INGEST_URL` | The app's `/api/watchdog/alerts`. Findings land in the product's own notification service (in-app + push). |
| `ARX_WATCHDOG_INGEST_TOKEN` | Shared bearer secret, ≥16 chars, set by the **owner** on both sides. Unset → the route 503s and the watchdog says its alert path is not armed. |
| `ARX_WATCHDOG_WEBHOOK_URL` | Independent operator webhook — the only leg that survives the app itself being down. |
| `ARX_WATCHDOG_TOPOLOGY` | `same_host` \| `second_repl` \| `external_host`; recorded on the heartbeat. |
| `ARX_WATCHDOG_HEALTH_PORT` | Its own liveness port (default 8091): `/healthz` (503 unless the last pass actually read everything) and `/livez`. |

Delivery is never assumed: a failed POST is logged as `alert_delivery_degraded`
with its reason and shown on `/healthz`. The drill that proves all of this is
`docs/WATCHDOG_DRILL.md` (`pnpm --filter @workspace/api-server run
drill:watchdog`).

## What it checks (read-only)

1. **Unprotected positions** — `live_positions` open rows with no stop loss → CRITICAL.
2. **Stale/never-synced positions** — open rows unsynced > 5 min → WARN.
3. **Stuck commands** — `mt5_commands` non-terminal > 10 min → WARN.
4. **Main-app liveness** — newest `system_health_checks` / `audit_events`
   activity older than 10 min → CRITICAL (the app may be down with positions open).
5. **Kill-switch context** — engaged switch with open positions → WARN (verify broker-side protection independently).
6. **Its own blindness** — any unreadable section → CRITICAL `cannot_verify:*`.

Repeat findings are suppressed by stable key; resolution is logged once.

## Deployment options — honest trade-offs

Superseded in detail by **`docs/WATCHDOG_DEPLOYMENT.md` §4**, which names each
topology by its `ARX_WATCHDOG_TOPOLOGY` value and spells out what each one does
NOT protect against. The summary below is retained because it is still
accurate.

The watchdog is a separate **process**. How separate its *failure domain* is
depends on where it runs, and that is an **owner infrastructure decision**:

| Option | What it survives | What it does NOT survive | Notes |
|---|---|---|---|
| **A. Second process, same Repl/host** (available today: `pnpm run watchdog` alongside the server) | api-server crash, wedged event loop, OOM-killed app process | host/Repl outage, network partition of the host, DB outage detection is still possible (it alerts CANNOT_VERIFY) but webhook delivery may die with the host | Weakest isolation, zero infra work. Real value: detects a dead/wedged main app. |
| **B. Separate Repl / separate host** (owner decision — needs a second deploy target with `ARX_WATCHDOG_DATABASE_URL` + webhook secret) | everything in A, plus host outage of the main app | simultaneous outage of both hosts; DB outage still only alertable | The honest recommendation for live capital. Pair with the read-only DB role below. |
| **C. External scheduler (cron/Actions) running `--once`** | everything in B for its scheduled instants | anything between runs; interval granularity | Cheapest true off-host option; exit codes (0/1/2) make it CI-alertable. |

None of these can protect positions when the **broker venue** itself is the
failure — broker-side protective orders (SL/TP living at the venue) are the
layer that survives every option above, which is why the watchdog's first
check is that they exist.

## Read-only DB role (defense in depth, owner-applied)

Self-enforced read-only is real (Postgres refuses writes on the session), but
a dedicated role removes even the theoretical possibility. Template (also in
`docs/migrations-pending/build-resilience.sql` as a comment — deliberately
NOT part of the migration):

```sql
CREATE ROLE arx_watchdog_ro LOGIN PASSWORD '<set-by-owner>';
GRANT CONNECT ON DATABASE <dbname> TO arx_watchdog_ro;
GRANT USAGE ON SCHEMA public TO arx_watchdog_ro;
GRANT SELECT ON live_positions, mt5_commands, safety_core,
  system_health_checks, audit_events TO arx_watchdog_ro;
```

## What is deliberately out of scope

- **No auto-close, no auto-anything.** Auto-close remains ALERT_ONLY
  platform-wide (CLAUDE.md §3); a watchdog with execution authority would be
  a second execution path, which is prohibited.
- **Outage-drill / emergency-close certification** is operator work with the
  owner at the controls; this process provides the detection side only. The
  detection half of that drill is now written down and runnable —
  `docs/WATCHDOG_DRILL.md`, parts 1–3 offline/dry, part 4 the real deliberate
  outage with the owner at the controls.
- **No secret is ever generated here.** The ingest token, the operator webhook
  URL and the read-only role's password are all owner-chosen and owner-set;
  until they are, the alert path announces itself as not armed rather than
  looking configured.
