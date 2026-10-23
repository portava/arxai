---
name: Integration-lane dev-DB data-pollution tests
description: Which safety-integration lane tests fail on accumulated shared dev-DB state (not code regressions), and how to tell.
---

# Integration-lane tests that fail on shared dev-DB pollution

The `safety-integration` lane (`pnpm run ci:integration`) runs against the
shared dev Postgres. A few DB-state-dependent tests assert on *live* data the
lane does not own, so they go red when prior runs in the same session leave
rows behind — these are NOT code regressions:

- **`test:arx-focus-superset`** (`scripts/src/arxFocusSupersetGuardTest.ts`) —
  fails `open arx_live_positions all approved … OFF-UNIVERSE: ["Volatility 25 Index"]`
  when an open off-universe live position is left in the dev DB. CAUTION: these
  are NOT always test seeds — they can be the OWNER's REAL broker-closed ghost
  positions (closed at the broker, never mirrored closed in `arx_live_positions`).
  The HONEST fix is the audited `reconcile:owner-phantom-broker-state` script
  (broker-evidence-gated: live + margin=0 + equity==balance), NOT deleting rows or
  weakening the guard. See `phantom-live-position-reconcile.md`. The guard's PART-2
  query filters `closed_at IS NULL` only (ignores reconcile_state), so stamping
  `closed_at` via that script clears the red; already-`IGNORED` rows (closed_at
  NULL) stay counted but pass when their symbols are approved.
- **`test:fundbook-tier`** (`scripts/src/fundBookTierIntegrationTest.ts`) —
  fails `baseline active tier is T1 (got 2)` / `buy-in price is $1.00` when the
  shared BALANCED seed pool has a leftover `fund_book_pool_tier_state` row stuck
  at T2. SELF-PERPETUATING: the test's cleanup only deletes the tier_state row
  when the pool had NO state at run-start (`!balancedHadState`); once any run
  leaves a row behind (e.g. interrupted before cleanup, or a run that started with
  state), every later run sees `hadState=true`, leaves the stale T2 in place, and
  the engine's no-downgrade stair-step means a zeroed-NAV baseline recompute can
  never bring it back to T1. The leftover T2 is provably garbage (BALANCED is a $0
  pool: deposits/units/value all 0, and ZERO `fund_book_pool_tier_events` back the
  T2). Unlike the arx_live ghosts there is NO audited repair path for pool tier
  state — do NOT raw-`DELETE` it to green the lane (lane-constraint + below);
  document + `skip_validation_reason`.

- **`test:fundbook`** (`scripts/src/fundBookUnitAccountingTest.ts`, FULL `ci`
  lane) — NOT pollution but the same "stale contract premise" pattern: 7 asserts
  red (`investor A sees the pool in their Fund Book view` → `poolFromView` null)
  because the investor view route (`meFundBook.ts`, "Balanced-only investor
  visibility", 2026-06-19) now filters `/api/me/investor/fundbook`
  pools to `BALANCED` only, while the test (last touched 2026-06-04) still
  issues/reads against `CASH_RESERVE` and expects it in the investor view.
  Admin issue/redeem asserts still pass. RESOLVED 2026-07-03: the test was
  reworked to the BALANCED-only contract (hidden pools asserted via direct DB
  truth, `CASH_RESERVE` stays hidden) and is green. Never re-broaden the
  investor view to make it pass. The DB-backed fundbook suites
  (overlay/capital/waterfall/weekly) can still go red on shared dev-DB pool
  drift — same pollution class, prove-unrelated via diff-has-zero-refs.
- **`test:mode-scope` PART G** (`scripts/src/modeScopeContractTest.ts`) — a pure
  source-scan (no DB) asserting "none of the patched routes import the live
  dispatch pipeline (T006 reads only)" across liveIntent / mePerformanceCalendar /
  meTrades / performanceCommandCenter / mePositionsUnified. It now FAILS because
  `meTrades.ts` legitimately gained a `liveCommandPipeline` import for the Cluster D
  close-after-revocation handler (a later merge). Stale contract premise, NOT a
  regression — confirm `meTrades.ts` (and the other 4) are absent from your diff.
  The honest fix is a separate task: narrow PART G to allow meTrades' read/close
  use, don't broaden it blindly.
- **`meCachedReadEndToEndTest`** (inside `test:ci-inprocess`, OFFLINE `ci` lane) —
  `/api/me/opportunity-map` cross-user cache asserts go red when an upstream
  provider (TwelveData) returns **HTTP 429** mid-run on metals (XAGUSD), evicting
  the expected cache entry. Tell-tale: a `marketProvider http non-2xx … status:
  429` line right before the `✗`, and the "CROSS-USER SHARED … SAME cached core"
  failure shows two DIFFERENT timestamps (expected identical) — that's a flake, NOT
  a data leak. External-rate-limit / environment-blocked.

**How to tell it's pollution, not your change:** `git diff HEAD` has zero
references to the failing surface (`arx_live_positions`, `arxFocus`, `superset`,
`fundbook`, pool tiers, the mode-scope routes, `opportunity-map`). The rest of the
lane passes. Your own new suite passes both standalone AND inside the lane.

**Why:** these guards read shared live/pool tables instead of self-seeding into
an isolated scope, so they inherit whatever the session accumulated.

**How to apply:** don't "fix" them by mutating live positions / fund pools to
make them pass — that touches safety-evidence tables unrelated to your task.
Confirm your own lane test is green, document the unrelated pre-existing
failures, and use them as a `skip_validation_reason`. (Cf. the synthetic-floor
BOOM300/CRASH300 fixture-drift note — same "pre-existing lane red" pattern.)
