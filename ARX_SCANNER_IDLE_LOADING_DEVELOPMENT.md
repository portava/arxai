# Development Scanner idle-loading follow-up

## Terminal outcome

**Scoped source import and automated checks PASS.
Immediate-first-click acceptance FAILS. Idle-dwell measurement INCONCLUSIVE.
The owner's real-app loading delay is NOT proven fixed.**

No parity or launch-ready claim. No further browser measurements or source
adjustments were made after the retained acceptance failures and timeout.

## Exact source and recovery

- Branch: `codex/pr103-smart-chart-development-20261031`.
- Starting/recovery checkpoint: `d5794bcbed9f0e3f3b4b77137c0f151d712c502e`.
- Recovery reference: `codex/backup-before-scanner-idle-20261031`.
- Combined application/measurement checkpoint:
  `f3467de7c5f60038a139a60f00abe56d563f0cc4`.
- Upstream branch: `codex/scanner-idle-candles-20261031`.
- Frozen backup: `2c36bf00f2eb9cfc0220be2eda5473524da67a43`.
- Application source: `2677f595026e86690290c2262cb5087d00396c53`.
- Final measurement source: `41ac93abd73ad740966f2ddc860e0bf8300c1deb`.
- Final documentation/checkpoint SHA: recorded in delivery and ignored
  `checkpoint-receipt.json`, avoiding a self-referential report hash.

The starting HEAD/branch were verified and the working tree was clean.
Recovery was saved before application edits. No concurrent source edits were
observed; no unrelated work was overwritten or normalized.

## Scope and local differences

Reviewed the frozen Scanner idle-candles report and retained manifest and three
candidate receipts. The source delta contains only four non-documentation paths:

1. `artifacts/trading-dashboard/src/hooks/useScannerNavigationWarmup.ts`
2. `artifacts/trading-dashboard/src/hooks/useScannerNavigationWarmup.test.tsx`
3. `scripts/scanner-qa/shared-chart-first-navigation.js`
4. `scripts/scanner-qa/shared-chart-first-navigation.test.mjs`

All four local base blobs matched be4b22d1 before editing. All four imported
blobs exactly match final measurement source 41ac93ab and backup 2c36bf00. No
overlapping local edits needed reconciliation.

The hook now prefetches the selected 200 candles once during eligible visible
idle time, sharing the mounted chart key, transport and five-second cache budget.
It checks access, visibility and data saver, rechecks visibility/data saver at
execution, and cancels queued work when selection/dependencies change or on
unmount. No timer refresh loop, analysis, streams, positions or order calls were
added to this hook. Failed prefetches do not retry or fabricate data.

An eligible visible dashboard may issue one selected-chart GET even if Scanner
is never opened. Selection changes/remounts can schedule another subject to
cache age/deduplication. Explicit navigation intent remains supported.
Provider evidence and timestamps are not made live/fresh by prefetch.

The preservation audit allows only those four source/test/tooling paths and
this report plus an import-tool memory note. All prior stream-reader, cockpit,
local authentication/sign-out, startup/preview, Truth, safety, dependency,
lockfile and test-command changes remain unchanged. No whole-app import,
remote push, branch reset or main merge was performed. The root application
source remains the combined local version, not the older upstream workspace.

## Actual automated combined-source validation

| Check | Result |
|---|---|
| Full frontend | **2,539 passed / 11 skipped / 0 failed**, 2,550 total |
| Frontend files | **174 passed / 1 skipped**, 175 total |
| Warmup hook | **10/10 passed**, included above |
| Scanner timeframe | **26/26 passed**, included above |
| Root typecheck (libraries/API/frontend/scripts) | PASS |
| API production build | PASS |
| Frontend production build | PASS |
| Server account-stream scheduling/route/listener tests | **13 passed / 0 failed** |
| Navigation/disclosure tooling | **16 passed / 0 failed** |
| Freshness-policy fixtures | PASS, including negative display-policy fixtures |
| Guards | **87/87 passed** |
| Bridge bindings | **7 assertions passed** |
| Measurement script syntax and source preservation | PASS |
| Immutable actual-dashboard offline fixture build | PASS |

All ten validation-harness commands exited zero. The 36 warmup/timeframe tests
are included in the frontend total, not additional reruns. Both builds finished
before browser observation. No application source changed after these checks.
The credential-free harness used synthetic unavailable loopback DB/AI targets,
external socket denial and disabled execution/settlement/public-data/auth test
settings, without touching actual account/database fixtures or runtime settings.

These are local counts. Upstream's 2,544 passes and 20 immediate/10 idle target
passes are reviewed provenance only and are not attributed to this workspace.
The existing local test/command differences were preserved, not replaced to make
counts match upstream. Eleven existing frontend skips remain: nine feed-badge
cases and two opt-in reader benchmarks in one skipped file.

## Browser method and immutable source

Static loopback fixture ID **`b00017402e73476c`** was built from clean combined
checkpoint `f3467de7c5f60038a139a60f00abe56d563f0cc4`.
Metadata reported empty status and `sourceUnchanged: true`; production runtime
and asset integrity checks passed.

The ignored fixture uses the actual dashboard main/App/routes/Scanner/adapter
and existing QA witness, not replacement UI components. It is an isolated
production Vite test build, distinct from ordinary development Vite and from
the normal deployable build. Its supporting files were reused from the preceding
reviewed fixture with only repo/import/output paths relocated.

Fresh isolated contexts with service workers blocked; external traffic and
mutations denied before navigation. Mocked authentication is synthetic and does
not establish real sign-in. Historical synthetic OHLC has an 80 ms response
delay, stale/unavailable evidence and no active analysis.

Every measured route uses a full-document reload; initial script preparation
primes browser resources. This is not cold browser-process startup. The exact
saved wrappers were used, with explicit page/source parameters and no relaxed
budget, forced click or inserted hover dwell.

Completion requires canonical AND displayed OHLC/context/source/real-series
agreement on two frames, >=100x100 visible plot intersection and five unobscured
hit-test points. This is not physical paint or proof that analysis completed.
Immediate clicks must be within 150 ms of actionable navigation; idle dwell
must be separately declared at 1,500..1,650 ms. Visible-completion target: 100 ms.

## All browser failures and retained timings

### Initial setup failures: no navigation

The first runner attempted all three planned wrappers with an unbound `page`
reference in its evaluation scope. Each stopped before any fixture navigation,
recording zero samples. Original `batch-{1,2,3}-*.json` and diagnostic placeholders
remain unchanged.

Only the runner invocation was corrected. A cheap Node sentinel contract
verified explicit `page` and expected-source binding for both unchanged wrappers.
The same tester then executed the originally planned measurement pass. No
application change, rebuild or assertion relaxation was used.

### Planned immediate batches: acceptance FAIL

Each row contains five recorded samples, all invalid as immediate acceptance.
Raw medians/maxima below include those invalid samples and are NOT valid-success
distributions. The original scripts correctly leave valid-only medians null.

| Batch | Viewport | Recorded / valid / <=100ms accepted | Raw median / max visible ms |
|---|---|---|---|
| Immediate 1 | Desktop | **5 / 0 / 0** | **146.0 / 181.5** |
| Immediate 1 | Mobile | **5 / 0 / 0** | **138.5 / 151.9** |
| Immediate confirmation | Desktop | **5 / 0 / 0** | **135.3 / 154.0** |
| Immediate confirmation | Mobile | **5 / 0 / 0** | **134.9 / 139.9** |

All indices 0..4 fail in every row. All 20 complete records/outliers are retained.
Ready-to-click was **666.6..796.6 ms**, outside the 150 ms gate.
Raw visible completion was **122.0..181.5 ms**, also outside the 100 ms target.
Therefore these are late, resource-prepared observations, NOT successful
immediate first-entry measurements.

All 20 samples matched the executing build and constructed candle response, and
recorded source-correct visible chart completion relative to that fixture.
This establishes neither real-provider correctness nor a passing latency target.

Each sample recorded exactly one candle request. Requests started
**612.8..757.2 ms before the click**, took **79..82 ms**, and ended
**530.8..676.2 ms before the click**. Prefetch therefore occurred in these late
samples, but did not yield passing post-click completion. The mocked candle
response was already complete; it cannot explain the remaining post-click delay.
The receipts do not isolate precise rendering/module/actionability causes and
must not be used to diagnose the real provider or the owner's five-second delay.

Navigation readiness, trusted clicks, canvas appearance, source agreement and
visible completion are separate fields in the full receipts and compact
`all-retained-immediate-timings.json`. Scanner page/control appearance was not
independently timestamped; detailed module parse/evaluation timing is unavailable.
Completed active analysis was deliberately unavailable, not inferred from canvas.

Each completed batch retained **498 request records, 334 unknown reads,
32 denied POST attempts, 366 HTTP-denial console errors and 0 page exceptions**.
Known denied writes were activity ping, AI-alert scan and scalp focus. They
received local 503 responses and never reached the development API. This is not
evidence that the whole application lacks automatic write attempts. External
traffic was denied; no trading/analysis-trigger control was clicked.

### Explicit idle-dwell batch: INCONCLUSIVE

The combined browser action hit its 45-second execution timeout during the
separate planned idle batch. No completed idle report or full network log was
persisted. A partial subset may have executed; actual attempt/sample counts,
timings, failed indices and writes are **unknown**, not zero or fabricated.

The timeout receipt and unavailable-diagnostics placeholder are retained.
The lost in-memory partial state could not be recovered, so preservation of
every potential idle sample was not achieved. It was not rerun because its
partial execution count was unknown. There is no local idle-target pass claim.
No final actual-Scanner screenshot was captured after this incomplete batch.

The owned static fixture server was stopped. Tester cleanup reported its prior
browser worker/state had been lost and no remaining owned fixture context
handle existed; no other context was touched.

## Development runtime and remaining limits

Only the existing development frontend was restarted once, after automated
checks and browser observations. Vite started cleanly; API/job settings and all
other workflows were left unchanged. Health/readiness GETs returned **200**.
The served transformed warmup module contains executable idle rechecking and
selected-chart prefetch. Anonymous desktop `/login` rendered normally, with an
expected unauthenticated 401; this is not successful sign-in evidence.

The log collector incidentally surfaced a separate deployment-process
termination event. No deployment action or production investigation was
performed, and production availability is not asserted by this report.

Other preparation errors retained here: an ignored audit-helper patch needed
hunk reordering; bulk receipt file callbacks exceeded the serialized file-I/O
budget; a reference to the failed block's binding was unavailable. The scoped
receipts were then saved through a bounded helper. These were tooling failures,
not passing/failing application tests or reasons to substitute upstream results.

Build-size advisories and existing frontend act/chart/DOM warning text remain
in raw logs. No full root CI, real-provider/broker/database integration, physical
touch/heavy-history benchmark, baseline/browser-process-cold comparison or
authenticated owner acceptance was performed. No credentials were requested.

The prior immediate-first-click failure remains unresolved. Historical M2
no-data, zoom/pan, mobile Study overlap, hydration, legacy-page 404 and automatic
POST limitations remain; this follow-up does not close them.
No real-app latency fix, parity or launch readiness is claimed.

No publish/republish/deployment, main merge, existing-database writes/migrations,
credential/account/preference changes, worker/trading activation, orders,
emails or live/demo broker tests were performed.

## Evidence paths

Directory: `generated-artifacts/arx-scanner-idle-validation/` (Git/deploy ignored).

- `import-manifest.json`, `preservation.json`, `audit.py`, `base/`, `candidate/`.
- `upstream-SCANNER_IDLE_CANDLES_2026_10_31.md`, `upstream-manifest.json`,
  `upstream-candidate-{immediate,immediate-repeat,idle}.json`.
- `upstream-navigation-{0,1500}.js`, `browser-brief.md`.
- `run.py`, `offline.cjs`, `validation-summary.json`.
- `stream-frontend-results.json`, `stream-frontend-0.log`.
- `stream-checks-results.json`, `stream-checks-{0..7}.log`.
- `stream-fixture-results.json`, `stream-fixture-0.log`, `fixture/`,
  `fixture-build-id.txt`, `builds/b00017402e73476c/`.
- Original zero-sample setup failures:
  `batch-1-immediate{,-fixture-log}.json`,
  `batch-2-immediate-confirmation{,-fixture-log}.json`,
  `batch-3-idle-1500{,-fixture-log}.json`.
- `invocation-contract.cjs`, `invocation-contract.log`.
- Corrected measurements/timeout:
  `corrected-batch-1-immediate{,-fixture-log}.json`,
  `corrected-batch-2-immediate-confirmation{,-fixture-log}.json`,
  `corrected-batch-3-idle-1500{,-fixture-log}.json`.
- `all-retained-immediate-timings.json`, `runtime-checks.json`,
  `anonymous-login.jpg`, `checkpoint-receipt.json`, `evidence-manifest.json`.
