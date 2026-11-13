# Structural integration verification

Checkout baseline: `21ccdbb85dd768b01e89d0fa4a87b6ace8acb7f0` (PR #150).
Node 24.16.0 / pnpm 10.26.1; local macOS. No production deployment or orders.

| Check | Final result |
|---|---|
| Structural math/observer/service/feed unit suite | 22 passed; no skipped tests |
| Actual localhost HTTP authentication and user-scoping integration | 1 passed |
| Actual PostgreSQL persistence, idempotent concurrent append and isolation | 1 passed |
| Chart panel, ghost adapter, trendline, tick-stream and stall regression suites | 36 passed in 5 files |
| Existing Phase B safety cases | 20/20 passed |
| Existing emergency kill pre-gate tests | 9 passed |
| Existing Pattern Sync baseline | 15 passed |
| Existing candle history service using isolated PostgreSQL | 33 assertions passed |
| Existing trade-engine pipeline using isolated PostgreSQL | 6 passed |
| Shared libraries, API, dashboard, scripts TypeScript checks | Passed |
| API production bundle, including separate fit worker | Passed |
| Compiled production worker fitting captured V75 history | Passed |
| Dashboard production Vite build | Passed; existing large-chunk warning remains |
| Actual ARXNativeChart browser preview | Rendered chart, saved forecast controls and separate ghost series; archived real-feed fixture, not authenticated production E2E |
| Five-symbol real-feed replay | 375 held-out forecasts, 2,250 horizon evaluations; no prebreak candidate accepted |
| Prospective service + worker + database cycle | One-minute outcome appended without changing issued snapshot; see evidence report |

## Repeatable commands

From `artifacts/api-server`:

```sh
node --import tsx --test --test-force-exit src/lib/structural/structural.test.ts
ARX_STRUCTURAL_TEST_DATABASE_URL=postgresql://USER@127.0.0.1:PORT/arx_structural_pr150_test node --import tsx --test --test-force-exit src/lib/structural/persistence.test.ts src/lib/structural/http.test.ts
node build.mjs
```

The DB suite requires an explicitly created disposable database with existing
Drizzle schema. It refuses other hosts/names, cleans only its own receipt rows,
and skips locally if no dedicated test URL is provided. In CI/release contexts,
a missing dedicated URL is a hard failure. The final reported run did not skip. Never point this command or the schema test setup at production.

From `artifacts/trading-dashboard`:

```sh
node node_modules/vitest/vitest.mjs run src/components/charts/StructuralForecastPanel.test.tsx src/lib/chart-engine/lightweightChartsAdapter.markers.test.ts src/components/charts/ARXNativeChart.trendline-overlay.test.tsx src/components/charts/ARXNativeChart.tick-stream.test.tsx src/components/charts/ARXNativeChart.stall-badge.test.tsx
PORT=5178 BASE_PATH=/ node node_modules/vite/bin/vite.js build
```

From repository root:

```sh
node node_modules/typescript/bin/tsc --build
node node_modules/typescript/bin/tsc -p artifacts/api-server/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p artifacts/trading-dashboard/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p scripts/tsconfig.json --noEmit
```

From `scripts`: `node --import tsx src/qaLivePhaseB.ts`.
Real-feed replay and bounded prospective commands are in the validation report.

## Failures retained and resolved

The first audit batch had 135 passes and 7 failures from the pipeline suite/hook
because no test DB was available. The later isolated DB run passed all six
pipeline tests; candle history also passed 33 assertions. A fresh PG17 instance
could not allocate host shared memory, so a separate database was created in an
already-running local disposable PG16 server. No production schema was touched.

The first whole-history validator rejected genuine off-grid/gapped timestamps.
Fitting now excludes damaged 180-bar training windows and counts them while
current inference remains strict. Replay also exposed a floating-point residual
that could create tiny negative late mass; capacity clamping fixed it. Final
review enforced the two-close one-minute minimum. No gate threshold was tuned.

A repeated DB isolation test initially assumed the other user had no forecasts;
the preceding live test had deliberately created that user's own records. The
test now verifies the correct invariant: the other user cannot see or append to
this user's receipt. Concurrent writes and original-snapshot equality pass.

## Environment and evidence limits

The initial implementation checks used cached dependencies after a clean frozen
install exposed the existing workspace-overrides/lockfile mismatch. The release
follow-up fixes that mismatch: native platform exclusions were removed and the
lockfile regenerated for the two existing loader/esbuild overrides. A separate
source checkout with fresh node_modules now passes `pnpm install --frozen-lockfile`,
both production builds and all four `typecheck:ci` units, without NODE_PATH or
scratch native packages. All 87 repository guards pass. The first clean CI
attempt used an archive without Git metadata; after restoring the exact source
history, the Git-aware guards pass.

The new API, HTTP and chart tests are registered in root CI, and real PostgreSQL
receipt persistence is registered in the integration lane. Set both DATABASE_URL
and ARX_STRUCTURAL_TEST_DATABASE_URL to a separately provisioned local disposable
database named arx_structural_pr150_*. The root aggregate also contains legacy
HTTP tests requiring BASE_URL; it is not fully offline despite older comments.
Release verification uses a loopback Express fixture with broker credentials
excluded. The standalone integration lane uses a different disposable DB.

The post-merge hook now installs dependencies only; it no longer runs an
unconditional schema push. Its two success/failure-path tests and the seven
existing production-environment checks pass. No migration is needed by this
feature. Full aggregate results are recorded in `ARX_STRUCTURAL_RELEASE_CHECK.md`.

The feature builds and has targeted local coverage. Deployed DB permissions and
retention, authenticated broker session E2E, long-running live operation and
prediction edge are not certified.
The temporary browser fixture was removed from application source after review.
All earlier mathematical research files and execution/risk/permission files are
unchanged by the implementation.
