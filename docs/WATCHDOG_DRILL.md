# The Protection Watchdog Drill (#28)

A watchdog is only trustworthy if a human has watched it notice. This is the
procedure that proves it does — and the fixture that makes the proof
repeatable.

Two things are being proven:

1. **It notices a position with no protective orders.**
2. **It notices a main-app outage** — the case an in-process watchdog
   structurally cannot catch, and the reason capability #28 is a separate
   process.

Plus two controls that stop the drill from being a rubber stamp:

3. **It does not cry wolf** on a healthy system.
4. **It refuses to call an unreadable database healthy.**

---

## Part 1 — Offline drill (2 minutes, no infrastructure)

```bash
pnpm --filter @workspace/api-server run drill:watchdog
```

This replays the seeded scenarios in
`artifacts/api-server/src/lib/protectiveWatchdog/watchdogDrillFixtures.ts`
through the **real** assessment core, the **real** wire envelope and the
**real** notification mapper — not a description of them — and prints exactly
what the owner would see. Exit `0` only if every scenario produced the finding
it claims to produce.

Expected shape:

```
── baseline_all_clear PASS
   verdict: VERIFIED_HEALTHY (expected VERIFIED_HEALTHY)
   findings: (none)

── position_without_protective_orders PASS
   verdict: FINDINGS (expected FINDINGS)
   findings: unprotected_position:9002
   owner would see: [critical] Open position with no stop loss recorded → /position-control

── main_app_outage PASS
   verdict: FINDINGS (expected FINDINGS)
   findings: main_app_silent
   owner would see: [critical] Main app has gone silent → /system-health

── database_unreadable PASS
   verdict: CANNOT_VERIFY (expected CANNOT_VERIFY)
   findings: cannot_verify:open_positions
   owner would see: [critical] Watchdog CANNOT VERIFY protection state → /system-health
```

The same fixtures are asserted every commit by
`pnpm --filter @workspace/api-server run test:watchdog-deployment`, so the
drill cannot quietly stop proving anything.

## Part 2 — Blindness drill (30 seconds, no infrastructure)

Prove the process itself degrades honestly rather than passing:

```bash
cd artifacts/api-server
ARX_WATCHDOG_DATABASE_URL='postgresql://nobody:nothing@127.0.0.1:1/nope' \
  node --import tsx src/watchdog.ts --once; echo "exit=$?"
```

Expected: `exit=2`, a `cannot_verify:database_connection` CRITICAL line
containing the word `UNVERIFIABLE`, and **no** `watchdog_pass_verified_healthy`
line anywhere in the output.

---

## Part 3 — Live drill (owner, against the deployed app)

Requires the owner presses in `docs/WATCHDOG_DEPLOYMENT.md` §7 (ingest token,
migration, ingest URL).

```bash
export ARX_WATCHDOG_ALERT_INGEST_URL="https://<app-host>/api/watchdog/alerts"
export ARX_WATCHDOG_INGEST_TOKEN="<the value you set on the server>"
pnpm --filter @workspace/api-server run drill:watchdog -- --deliver
```

Every delivered message is prefixed **`DRILL (not a real condition) —`** and
carries a `drill:<scenario>` instance id, so a drill alert can never be mistaken
for a real one and the drill's heartbeat never overwrites a real watchdog's row.
The script **refuses** to run `--deliver` when the alert path is not armed
rather than pretending to send.

Confirm, in this order:

1. `delivery: app:delivered,...` appears for each scenario. Anything else —
   `app:unreachable`, `app:refused`, `app:not_configured` — means the owner was
   **not** told; fix that before trusting the watchdog.
2. Open `/notifications` in the app. Four drill notifications, clearly labelled,
   at the right severities.
3. If web push is configured, confirm the CRITICAL ones reached the phone.
4. `GET /api/admin/watchdog/status` shows the `drill:*` instances.
5. Dismiss the drill notifications.

---

## Part 4 — Real outage drill (owner, deliberate, scheduled)

The only test that proves the whole chain. Do it with **no open live
positions**.

1. Deploy the watchdog in topology (b) or (c) — *not* same-host; a same-host
   watchdog dies with the box and cannot pass this drill by construction.
2. Confirm `GET http://<watchdog-host>:8091/healthz` returns `200` /
   `"status":"watching"`.
3. Stop the api-server (Replit: stop the deployment).
4. Wait for `MAIN_APP_SILENT_MS` (10 minutes) plus one watchdog interval.
5. Expect: a `main_app_silent` CRITICAL on the **operator webhook** — the app
   leg cannot deliver, because the app is what is down. The watchdog logs
   `alert_delivery_degraded {leg:"app", status:"unreachable"}`, which is the
   honest record of exactly that.
6. `/healthz` on the watchdog still returns `200` / `"status":"findings"` — the
   watchdog is healthy; the *app* is not. Confirm the distinction holds.
7. Start the app. Within one interval the watchdog logs
   `watchdog_finding_resolved {key:"main_app_silent"}` and the app leg starts
   delivering again.

**If step 5 produces nothing, the drill has failed and the watchdog is
decorative.** The most common causes, in order: no `ARX_WATCHDOG_WEBHOOK_URL`
(the only leg that survives an app outage); the watchdog deployed same-host and
taken down with the app; and no ADMIN/OWNER account to receive notifications —
which the ingest route reports as `watchdog_alert_has_no_recipient`.

Record the run in `docs/CERTIFICATIONS.md` with the date, the topology, and the
observed delivery summary.
