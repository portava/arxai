---
name: CI test-script wiring triage
description: How to classify test:* scripts as ci-promotable vs allowlist-only when triaging check-test-scripts-wired.ts ALLOWLIST.
---

# Classifying test:* scripts for the root `ci` aggregate

The wired-check guard (`scripts/src/ci/check-test-scripts-wired.ts`) fails if a
`test:*` script is BOTH wired into root `ci` AND in ALLOWLIST, OR allowlisted but
deleted. So promotion = add `pnpm --filter <pkg> run <script>` to `ci` in
`package.json` AND delete the exact `<pkg>::<script>` ALLOWLIST line in lockstep.

## Empirical classifier (the reliable one)
Static import-scanning is NOT enough — a test can statically look "pure" yet hang
on a transitive DB import. Run each candidate: `pnpm --filter <pkg> run <script>`
with a timeout, read the exit code:
- **exit 0** = clean pass AND clean process exit → PROMOTE (deterministic+offline-safe).
- **exit 124 (timeout)** = hangs holding an open handle; node --test prints
  `'Promise resolution is still pending but the event loop has already resolved'`.
  These keep a DB pool/timer alive and would hang CI forever → KEEP allowlisted,
  even if the assertions printed PASS first.
- **exit 1** = needs a running server/DB-with-data → KEEP allowlisted.

**Why:** in this sandbox the server/workflows are down (502) but DATABASE_URL is
set, so a DB-touching test either hangs (open pool) or fails — both are caught by
exit code. tsx itself does NOT inherently hang (a wired tsx ci test exits in ~3s);
a hang means a real transitive env dependency.

## Caveats that change a verdict
- **Flaky hang-on-exit**: a tsx script can pass-and-exit once but hang the next run
  (e.g. an intermittent open timer). Re-run tsx candidates twice; exclude any that
  ever hits 124. (mt5-feed-staleness was exactly this.)
- **Feed/network timing variance**: api-server market-data tests (scanner/candle/
  symbol/deriv/algorithm-locks/selected-market) pass offline but their runtime
  swings wildly (e.g. 17s→51s) because they attempt provider fetches. Outcome is
  deterministic but timing is env-dependent → KEEP allowlisted (treat as
  env-dependent, not offline-safe).
- vitest (trading-dashboard) and node --test pure-logic suites (scalp-*, cache)
  exit deterministically and are safe; they don't have the tsx hang-on-exit risk.
- **Order-dependent global-state false-pass**: a standalone-green test can still
  be lane-UNSAFE if it asserts a near-zero *shared* DB aggregate (e.g. master-account
  open-exposure / arx_live_positions lots). Earlier lane tests (shared-positions-truth,
  live-position-exposure) leave open rows, so its first "succeeds under cap" probe
  flips to MASTER_ACCOUNT_EXPOSURE_LIMIT_REACHED. Parallel triage runs can pass by
  luck; only a full *sequential* lane re-run exposes it. Fix = self-isolate, then
  promote: one-click-concurrency now seeds a DEDICATED `shared_master_accounts`
  fixture (sentinel connection_id, deleted before+after) so its exposure baseline is
  zero regardless of order — a brand-new master id is referenced by no
  shared_trade_attribution rows, so sumExposure() reads 0. NOTE the exposure sum is
  over `shared_trade_attribution` (pending|open) + RESERVED reservations, NOT
  arx_live_positions; arx_dispatch_exposure_reservations.shared_master_account_id has
  no FK so deleting the fixture master is safe. Now in the integration lane.

## How to apply
Build candidate keys, run each with a 40-70s timeout in parallel (`xargs -P`),
record `exit|dur|key`. Promote only exit-0, stable, fast pure-logic + vitest +
contract/guard tsx tests. Verify with the guard:
`pnpm --filter @workspace/scripts exec tsx src/ci/check-test-scripts-wired.ts`
then `pnpm run ci:guards`. Full `pnpm run ci` is too slow to run end-to-end here.
