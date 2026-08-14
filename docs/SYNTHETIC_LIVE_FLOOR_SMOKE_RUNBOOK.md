# Deriv-synthetic LIVE-floor smoke runbook (production)

A supported, repeatable, default-deny way to run the **live-fire** synthetic-feed
safety check (`scripts/src/syntheticLiveFloorQa.ts`) against the **deployed**
environment — on demand or as a scheduled one-off — so a real-world drift the
DB-free unit test cannot see is caught early.

## Why a production run is worth it

Two automated guards already cover the Deriv-synthetic LIVE-confirmation floor:

| Guard | What it proves | Where it runs |
| --- | --- | --- |
| `pnpm --filter @workspace/scripts run test:synthetic-live-floor-unit` (`syntheticLiveFloorUnitTest.ts`) | The floor **logic** (DB-free): non-ticking synthetic → `SYNTHETIC_FEED_NOT_LIVE_CONFIRMED`, ticking → `ALLOWED`, owner/broker/stale edge cases. | `pnpm run ci` (pre-commit) |
| `pnpm --filter @workspace/scripts run test:synthetic-live-floor` (`syntheticLiveFloorQa.ts`) | The floor **end-to-end** through the real `liveCommandPipeline` at BOTH chokepoints (preflight + dispatch re-check), across a representative slice of the Deriv synthetic catalog. | By hand, against a real DB + real Deriv master connection |

The unit test cannot see what only exists at runtime in the deployed
environment: the **real broker-connection shape** (`brokerName` actually reports
"Deriv …"), **master-account resolution** (`resolveActiveMasterConnectionId()`
returns a live, fresh connection), and the per-symbol `resolveDerivSymbol()` /
`getSymbolTradability()` classification against the live symbol directory. A
scheduled/operator-run smoke against production catches drift in any of those
before it can matter.

## What the harness does (and does not do)

For each of `V75`, `V100_1S`, `BOOM1000`, `CRASH1000`, `STEP` it proves:

- **Pre-floor** — the symbol resolves to a real Deriv broker symbol AND
  classifies as a Deriv synthetic/data-only market (a `NOT_FOUND` resolution or
  misclassification FAILS loudly instead of letting the floor pass vacuously).
- **Test 1 (preflight)** — an un-ticking synthetic is refused at
  `createLiveDraft()` with `SYNTHETIC_FEED_NOT_LIVE_CONFIRMED`; no
  `arx_live_commands` row is written.
- **Test 2 (dispatch re-check)** — a draft created while ticking confirms, but
  if the tick goes stale before dispatch the re-check refuses with
  `LIVE_BLOCKED` / `SYNTHETIC_FEED_NOT_LIVE_CONFIRMED:<sym>_no_live_tick`; the DB
  row is `LIVE_BLOCKED` and was **never** sent to MT5 (`sentToMt5At` null).
- **Test 3 (negative control)** — a genuinely-ticking synthetic is NOT blocked
  by the synthetic floor and proceeds until a LATER, unrelated gate (this user is
  not admin-approved). Proves the floor is per-symbol accurate, not a blanket ban.

**Safety properties (unchanged by this runbook):**

- Seeds a **throwaway OWNER** test user (`passwordHash: "qa-no-login"`, never
  logs in) and deletes it in `finally`.
- **No real fill is possible.** The master switch / DB arm flag are not enabled,
  every command transitions to `LIVE_BLOCKED`, never `SENT_TO_MT5_LIVE`.
  Dispatch ≠ execution.
- The Deriv WS tick cache is stubbed (the documented test-only seam) to
  present/withhold a live tick per symbol; the floor logic itself runs unchanged
  and is never weakened. The master broker is asserted to be genuinely Deriv —
  never faked.
- The master connection's balance/equity/free-margin/heartbeat are briefly
  bumped for pool freshness/headroom and **restored** in `finally`; this is a
  seconds-long window. `arx_live_commands` is asserted back to its starting
  baseline at the end.

## Required environment

| Variable | Value | Why |
| --- | --- | --- |
| `DATABASE_URL` | the **production** connection string | The harness talks only to the DB this points at. Run it from a context where this is production (see below) — do **not** copy production credentials into the agent dev environment. |
| `QA_ALLOW_DB_MUTATION` | `true` | Acknowledges the harness writes to the DB. Without it the harness refuses to run anywhere. |
| `QA_ALLOW_PROD_SMOKE` | `true` | **Dedicated production opt-in.** Production is default-deny; the harness refuses a production-like target (`NODE_ENV=production` or a `*.replit.app` `QA_BASE_URL`) unless this is also explicitly set. |
| `DERIV_APP_ID` | the configured app-id (optional) | If set, the WS feed-status helper reports honestly; if unset the harness uses `test-app-id`. No `DERIV_API_TOKEN` is needed (the harness deletes it to keep the AUTH_FAILED branch out of play). |

> Setting `QA_ALLOW_PROD_SMOKE=true` lifts **only** the production refusal. It
> does not enable a real fill, change any gate, or alter the harness's
> seed/restore + baseline-assertion behaviour.

## How to run it against production

The harness only ever talks to the database in `DATABASE_URL`. To target
production, run it **in** production — not from the agent dev environment.

1. **Publish first** (if the floor or its dependencies changed). Confirm with
   the database skill (`environment: "production"`, read-only) that the live DB
   has an active Deriv master connection.
2. **Run the smoke** from a context whose `DATABASE_URL` is the production
   connection string (the production deployment shell, or a one-off Scheduled
   Deployment — see below):
   ```
   QA_ALLOW_DB_MUTATION=true QA_ALLOW_PROD_SMOKE=true \
     pnpm --filter @workspace/scripts run qa:synthetic-live-floor:prod
   ```
   (`qa:synthetic-live-floor:prod` and `test:synthetic-live-floor` run the same
   harness; the `:prod` alias is the documented handle for scheduled/operator
   runs.)
3. **Read the output** (see below). Exit code `0` = all checks passed; `1` = at
   least one check FAILED; `2` = refused/aborted before the checks ran (missing
   env, no master connection, or master broker not Deriv).

### Running it as a scheduled / one-off job

Use a **Scheduled Deployment** (deployment skill → `scheduled` target) whose run
command is the line in step 2 above and whose secrets include the production
`DATABASE_URL`. Add `QA_ALLOW_DB_MUTATION` and `QA_ALLOW_PROD_SMOKE` (`true`) to
its environment. Inspect the run logs; the job exits non-zero if any check fails,
so the schedule surfaces a real-world floor regression on its own.

## Expected output

A healthy run prints per-symbol `PASS` lines and a final tally, for example:

```
WARNING: running the synthetic-live-floor smoke against a PRODUCTION-like target (…) — QA_ALLOW_PROD_SMOKE=true. …
PASS  V75 resolves to a real Deriv broker symbol (not NOT_FOUND)
PASS  V75 classifies as Deriv synthetic/data-only (floor engages)
…
PASS  active master broker is Deriv (real, not faked): Deriv (SVG) LLC

── V75 ──
PASS  [V75] preflight refuses un-ticking synthetic with SYNTHETIC_FEED_NOT_LIVE_CONFIRMED
PASS  [V75] preflight refusal wrote NO arx_live_commands row
PASS  [V75] dispatch re-check blocks stale synthetic with LIVE_BLOCKED
PASS  [V75] dispatch primaryReason is SYNTHETIC_FEED_NOT_LIVE_CONFIRMED:<sym>_no_live_tick
PASS  [V75] DB row is LIVE_BLOCKED and was NEVER sent to MT5 (sentToMt5At null)
PASS  [V75] ticking synthetic is NOT blocked by the synthetic floor at dispatch
…
PASS  arx_live_commands restored to baseline (N → N)

NN/NN PASS · 0 FAIL
```

- Final line `NN/NN PASS · 0 FAIL` and exit `0` → the floor holds end-to-end in
  production. **Take no action.**
- Any `FAIL` line and exit `1` → a real-world floor regression. The failing
  check names the symbol and the exact contract that broke (e.g. a symbol no
  longer resolves, the master broker is no longer Deriv, or a chokepoint stopped
  blocking). Investigate before any live trading continues.
- `REFUSED:` / exit `2` → the harness never ran its checks. Common causes:
  `QA_ALLOW_DB_MUTATION` / `QA_ALLOW_PROD_SMOKE` not set, no active master
  connection configured, or the master broker is not Deriv (so the synthetic
  reason path cannot fire). Fix the precondition and re-run.

## Safety properties (summary)

- Production is **default-deny**; a production run needs the dedicated
  `QA_ALLOW_PROD_SMOKE=true` opt-in **in addition to** `QA_ALLOW_DB_MUTATION`.
  This default-deny posture is locked by the
  `synthetic-floor-prod-default-deny` CI guard
  (`scripts/src/ci/check-synthetic-floor-prod-default-deny.ts`, wired into
  `pnpm run ci:guards`): the build fails if either the `QA_ALLOW_DB_MUTATION` or
  the production `QA_ALLOW_PROD_SMOKE` refusal is removed from the harness.
- The smoke adds **no new write path** to the app and never weakens the floor
  under test.
- No real fill can occur; every command ends `LIVE_BLOCKED`, never
  `SENT_TO_MT5_LIVE`.
- All seeded rows and the master-connection bump are restored in `finally`, and
  `arx_live_commands` is asserted back to baseline.

See [`PRODUCTION_MAINTENANCE_RUNBOOK.md`](./PRODUCTION_MAINTENANCE_RUNBOOK.md)
for the sibling pattern (idempotent data fixes run the same way), and
[`SAFETY_NOTES.md`](./SAFETY_NOTES.md) for the inviolable live-trading invariants.
