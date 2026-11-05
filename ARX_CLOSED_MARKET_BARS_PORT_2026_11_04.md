# ARX closed-market bars — development port, 4 November 2026

## Source and recovery

- Workspace branch: `codex/pr103-smart-chart-development-20261031`.
- Application commit built and activated: **`dfb6e5e8b3916aec57e82d8af4a59ce2a22d8f69`**.
- Starting checkpoint: `d1471644a958c5fbb7b444d1c5571793178fb952`.
- Added recovery branch: `recovery/pre-closed-market-bars-20261104-d1471644`.
- Existing recovery `recovery/pre-replit-port-20261104-0fca9a1d` preserved.
- Reviewed upstream: `arxai-upstream/claude/closed-market-bars-20261104`,
  **`1150ab2135a056ec32e9f289e8ba73ee7cc7a6b0`**, PR #112.
- This is a selective behavioral port under `arxai/`, not a cherry-pick,
  wholesale upstream replacement, PR #108 import, or GitHub merge.
- The subsequent report-only commit contains this report; the application
  commit above identifies the exact code tested and running.

## What changed

The existing chart service now accepts an explicit stored-history opt-in.
Only the existing `/api/chart/candles` and `/api/chart/feed-status` display
handlers opt in. Router, decision, scanner-analysis, Eleanor, execution and
trading callers retain their previous defaults.

The new separate `storedCandleHistory.ts` reads the requested symbol and
timeframe from `market_candles`: one source only, preferring a populated
`mt5_broker` mirror, otherwise the source with the newest bar. Mock, development
and test sources are refused. No eligible/readable bars returns the original
empty result. There is no provider request or cache backfill in this helper.

Stored results have `notLiveReason: "stored_history"`, `isLive: false`,
`aiUsable: false`, null market evidence, null delayed/bridge attribution,
and no forming tip. The existing Native Smart Chart renders these bars with
the stored-history chip and does not subscribe to forming-tick updates for
this state. The ordinary confidence calculation keeps AI-confirmed badges off.
The API schema, generated client type and Zod contracts include the optional
field. The timestamp in the message is the stored bar's ISO representation;
this does not establish original UTC clock authority or research eligibility.

No existing scheduled-weekend message was present in this workspace's chart
service; no unrelated upstream weekend/feed-layer implementation was imported.

### Adaptations

- Kept the workspace's existing chart normalization, integrity/freshness
  checks, score and source owners, rather than importing PR #108 assumptions.
- Namespace-imported the cache in the new helper so opt-out tests with narrow
  cache mocks remain compatible. No new export was added to `marketDataRouter`.
- Updated two existing test fixtures without weakening assertions:
  `chart-setup-safety.test.tsx` now supplies the QueryClient required by the
  previously merged one-click hook; `formingTipSourceIsolation.test.ts` now
  supplies EventEmitter response methods and a successful `write()` result
  required by the previously merged backpressure writer.
- Normal code generation failed because it emitted newer Zod APIs such as
  `zod.int` against the installed Zod 3 package, plus broad unrelated SDK
  rewrites. The failed output is archived. Only the additive generated field
  was reconciled into the existing generated types and three response schemas;
  unrelated generated changes were not retained. All consumer typechecks pass.

## Preservation

All **44 protected shell/layout files match their saved SHA-256 hashes**.
`ScannerChartPanel` and the API launcher/startup file are unchanged from the
starting checkpoint. Viewport-bound chart sizing, its resize observer,
keep-mounted closed panels, side rails, peek behavior and saved layouts remain.
No authentication, role, risk, order, strategy, broker, account-mode or
trading-switch logic changed.

## Final validation

| Check | Pass | Fail | Skip | Result |
|---|---:|---:|---:|---|
| Shared-library typecheck/build references | — | 0 | 0 | Exit 0 |
| API typecheck | — | 0 | 0 | Exit 0 |
| Dashboard typecheck | — | 0 | 0 | Exit 0 |
| New stored-history server regression file | 14 | 0 | 0 | Included in final server run |
| All chart/data server tests | 448 | 13 | 0 | 461 total; exit 1 |
| Dashboard charts, confidence and native-page tests | 403 | 0 | 2 | 24 files passed, 1 skipped; exit 0 |
| New stored-history chip cases | 4 | 0 | 0 | Included in dashboard totals |
| Application-root guards | 83 | 4 | 0 | Known failures retained; exit 1 |
| API build during workflow restart | — | 0 | 0 | Successful |
| Protected shell/layout hashes | 44 | 0 | 0 | Exact matches |

The server suite used a non-app dummy database target and a preload that
blocks TCP except test-owned loopback fixtures. No destructive fixture reached
the application database. Its 13 failures need database fixtures and came from:

- `patternOutcomeLearning.test.ts`
- `trendlineOutcomeLearning.test.ts`
- `sessionProfile.test.ts`
- `sessionAwareChartFeed.test.ts`

Twelve failure records show the explicit offline TCP rejection; one reports a
pool connection timeout against the dummy target. These are actual failed
tests, not skips or a green suite. They were not rerun against the app database.

The four known root guard failures remain:
`risky-wording-frontend` (50 findings), `no-internal-names-user-ui` (25),
`investor-no-guaranteed-return` (3), and `test-scripts-wired` (4).
No guards, allowlists or thresholds were relaxed. The new
`test:chart-stored-history` script is directly wired into application-root CI.

Retained earlier attempts: first server run **435 pass / 17 fail / 0 skip**;
first dashboard run **399 pass / 4 fail / 2 skip**; first standalone new server
test **13 pass**, before adding synthetic-index coverage; failed full codegen.
The import-level cache-mock error and two stale fixtures were then corrected.
Their final results are in the table above; earlier failures were not deleted.

## Real development cache and service result

Read-only SQL, repeated direct service exercise after restart, and no provider
or broker calls found **zero `market_candles` rows at any timeframe** for:
**XAUUSD, EURUSD, US30, BTCUSD and R_75**.

With live routing deliberately forced unavailable, the actual chart service
at M30 returned zero candles, no source, `isLive: false`, `aiUsable: false`,
null evidence and the honest no-feed message for each. Feed status agreed.
This exercise used real cache reads, not seeded bars; the unavailable live
router was a test double. It is not a real-provider acceptance test.

**Consequently gold and these other checked markets will still be empty when
their feeds are unavailable until genuine history has been stored.** This port
does not invent bars, seed the cache, import broker history or enable a worker.
Positive stored-history rendering and source selection were verified using
synthetic unit fixtures, not an existing positive-cache account session.

## Activated preview

- Restarted only `artifacts/api-server: API Server` using its existing launcher.
- Actual Node PID: **47631**, started **2026-11-04 12:49:37.58 UTC**.
- Built/running application source: `dfb6e5e8b3916aec57e82d8af4a59ce2a22d8f69`.
- API bundle: `arxai/artifacts/api-server/dist/index.mjs`.
- Bundle SHA-256:
  `22499d0c498765e66f434b56db435e261ff7bebdeb020afaed72f891f83bd820`.
- Compiled bundle contains the new stored-history message.
- Proxied `/api/healthz`: **200**. Frontend `/`: **200**.
- Anonymous `/api/chart/candles?symbol=XAUUSD&timeframe=M30`: **401**,
  preserving authentication.
- Vite serves the new chip and the Native Chart stored-history stream guard.
  No frontend workflow restart or production frontend build was needed.
- Fresh anonymous screenshot renders the normal sign-in page; its only
  resource error was the expected unauthenticated 401. This is not
  authenticated chart visual acceptance.
- Earlier HMR logs contain `Object is disposed` events during source refresh.
  A fresh authenticated chart reload was not exercised; no engine/lifecycle
  fix or claim of clean authenticated-canvas acceptance is made.
- Existing startup logged preview-safe background-job pause and no schema
  migration. The already-approved assistant watch sweeper logged its unchanged
  default startup. No environment variable or switch was changed.

No publishing/deployment, migrations/schema push, post-merge database hook,
credentials changes, real broker tests, orders, MT5-terminal actions or
GitHub pushes were performed.

## Evidence

Retained under `generated-artifacts/arx-closed-market-bars-20261104/`:

- `server-chart-data-final.log`, `dashboard-charts-final.log`, `root-guards.log`
- `stored-history-first.log`, `server-chart-data.log`, `dashboard-charts.log`
- `typecheck-libs.log`, `typecheck-api-final.log`, `typecheck-dashboard-final.log`
- `codegen.log`, `full-unaccepted-codegen-output.tar.gz`,
  `selected-generated-field.json`
- `actual-cache-service.log`, `actual-cache-service-after-restart.log`
- `read-cache-service.mjs`, `offline-preload.cjs`
- `runtime-after.json`, `healthz.json`, `anonymous-chart.json`,
  `served-stored-history-chip.js`, `preview-after.jpg`

The generated evidence directory is excluded from Git; the report and source
are committed. This is not a release-green, parity or latency claim.
