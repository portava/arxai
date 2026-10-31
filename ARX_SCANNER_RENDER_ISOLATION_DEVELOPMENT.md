# Scanner render isolation — development validation, 31 October 2026

## Outcome and exact source

Development-only selective integration completed. Correctness/build checks
pass on the corrected combined source; performance acceptance remains FAILED.
No instant-loading, real-app latency fix, parity or launch-readiness claim.

- Branch: `codex/pr103-smart-chart-development-20261031`.
- Recovery checkpoint: `58a338b43184c0a9f1240570c05b2e97c850cc0e`.
- Recovery ref: `codex/backup-before-scanner-isolation-20261031`.
- Preserved preceding application: `d74197cf9f7affbbc5390de53bdc38e2c27ac063`.
- Reviewed upstream report checkpoint: `6345956d4ada4171cbb40d9c97c20127e5e1b361`.
- Tested upstream source: `8941184919f01a02df4a238185116cd6ca0db1cf`.
- Upstream application change: `3dd8cd018abc61189f6fff07acf17ce9d6cf6be8`.
- Initial incomplete import: `2c37990b54964f1f1d77217400a0ee87ede91cd5`.
- **Corrected, tested combined application:**
  `b87e3629ce7f4744a806f8b86c966711a19bfc65`.
- Final documentation-only checkpoint/full clean-state receipt:
  `generated-artifacts/arx-scanner-isolation-validation/final-checkpoint.json`.
  The report does not attempt to embed its own commit hash.

Evidence paths below are relative to
`generated-artifacts/arx-scanner-isolation-validation/`.

## Selective review and preservation

The nine touched application/test files matched their upstream base locally
(five existing files and four new files). The tested-source follow-up adds the
page-level exact-expiry regression; no other application changes were carried.
The first combined checks then identified an unchanged upstream dependency
missing locally: the freshness-boundary helper. Its two source/test files were
reviewed and added from the same tested source. Existing freshness predicates,
30-second age and 5-second skew rules were not changed.

All **11 scoped files** match their pinned upstream blobs. The remaining tracked
application source is unchanged from recovery: dock/controls, channels/scaling,
auth/sign-out, startup, Truth/safety/role/dispatch gates, funds/backend, dependencies,
stream reader, candle preparation and durable navigation recorder preserved.
No concurrent source edits appeared during integration.

Memoization isolates chart and Focus subtrees from unrelated parent updates,
without hiding or deferring panels. Own queries/context/symbol updates remain.
The page clock wakes at setup/ticket boundaries; visible age/countdown labels
own local clocks and stop while hidden. Action handlers retain real-clock gates.
Held toolbar phase `293483c5`, toolbar `81b7f0a8`, containment `363c9e43` and other
held experiments were not imported. No branch reset, main merge or GitHub write.
Review records: `upstream-review.json`, `tested-followup.json`, `scope.json`,
`preservation-audit.json`, pinned `candidate/` and `upstream-probes/`.

## Actual combined-source validation

Checks used dummy localhost DB/AI configuration and an outbound socket guard,
not existing databases/providers. Results are this workspace's, not upstream's.

| Check on corrected source | Actual result |
|---|---|
| Full frontend | **2,575 passed, 11 skipped, 0 failed** |
| Root/project-reference typecheck | PASS |
| API production build | PASS |
| Frontend production build | PASS |
| Account-stream scheduling regressions | **13 passed** |
| Recorder/navigation/disclosure regressions | **22 passed** |
| Safety/static guards | **87/87 passed** |
| Binding assertions | **7 passed** |
| Corrected immutable fixture build | PASS |
| Scoped blob/preservation/whitespace checks | PASS |

The suite includes render-isolation, local-clock, invalid-timestamp, background,
clock-change, independent timestamp, future-skew, held-ticket, cleanup and
long-timeout tests. Page-level fake-clock testing retains the setup and mock
ticket at 30,000ms, withdrawing both at 30,001ms. These are offline mocked
regressions, NOT real broker/ticket acceptance or browser expiry acceptance.

**Initial failures retained:** on `2c37990b`, frontend had **2,559 passed,
13 failed, 11 skipped**; root typecheck and frontend build failed for the missing
freshness helper; initial fixture build also failed. API build, server/recorder
regressions and guards passed. All originals and their source identity are under
`failed-initial-import/`; they were not overwritten by corrected results.
Corrected results/logs are `iso-frontend-*`, `iso-checks-*`,
`candidate-fixture-*`. Upstream's 2,577 passes are not attributed to this source.

## Matched offline measurement procedure

Baseline was measured BEFORE application edits on exact clean checkpoint
`58a338b4`, immutable fixture **`a9cd412a8b4060f2`**. Corrected source uses fixture
**`ad5c83e3b38a7cd2`**. Both compile the actual production React application,
not a profiling runtime, with fixture-only adapter witnesses and synthetic data.

Order for each source: navigation1x, navigation4x, sustained zoom4x. All executions
were serial, with no owned builds, test suites or functional browsers running.
Fresh browser per run, same unchanged setup, viewport, probes and source checks.
Host is shared and uncontrolled, not an exclusive laboratory. Raw load/cgroup
snapshots retained; no causal attribution from overlap or lower partial medians.

Runtime: Node **24.22.1**, Playwright **1.64.1**, headless Chromium
**152.0.7977.64**, `/repl/tools/bin/chromium`, slowMo0, DPR1, service workers blocked.
Eight logical CPUs; cgroup cpu.max `800000 100000`. CDP throttling explicitly
1x/4x, reset/closed afterward; no additional external CPU throttle was applied
by this work. Other host scheduling/throttling cannot be excluded.

Driver deadline **180,000ms**, outer shell **240,000ms**. The 100ms target,
150ms readiness window, 8-second locator timeout, full source/data/engine/range
witnesses and two rendering frames were unchanged. Two frames are not hardware
paint. Navigation baseline/candidate probes differ only in expected source SHA;
the wrapper substitutes exact local source, records hashes and never forces
clicks. All external traffic and application mutations were blocked before
navigation; only the isolated private receipt recorder may accept writes.
No completed analysis/live-feed result is inferred from controls or candles.

### First navigation: FAILED on both sources

| Source / condition | Recorded | Valid immediate | Accepted <=100ms |
|---|---:|---:|---:|
| Baseline 1x: desktop5 + mobile5 |10|0|0|
| Baseline 4x: desktop5 + mobile5 |10|0|0|
| Combined 1x: desktop5 + mobile5 |10|0|0|
| Combined 4x: desktop5 + mobile5 |10|0|0|

All normal-CPU clicks were outside the 150ms readiness window.
Baseline readiness-to-click range **1,339.7–1,596.1ms**, late-click visible
completion **287.2–575.2ms**. Combined readiness **1,301.1–1,608.7ms**, late-click
completion **414.2–699.8ms**. These are invalid late-click diagnostics, NOT valid
immediate-click distributions. Valid-only medians/maxima remain null.

Every slowed slot timed out after 8 seconds waiting for its sidebar Scanner
anchor or mobile bottom-navigation control. No trusted click, correct executing
build/candle completion or completion duration was established for those slots.
Their timings stay null, not zero; initial fixture preflight is not a substitute.
Application-versus-runner cause remains unproven.

All40 slots, errors, outliers, module/request/browser candle observations remain
in `baseline/navigation-*-workspace.json` and `candidate-run/navigation-*-workspace.json`,
their eventsJSONL and executed wrappers. Four durable navigation journals are
copied under each phase's `retained-navigation-receipts/`; originals remain in
`builds/*-navigation-receipts/`. Source/build witnesses and all samples retained.

### Sustained 4x zoom: INCOMPLETE and timing FAILED

Original planned workload: 60 trusted zoom actions with120ms inter-action gaps.
Both runs hit the unchanged **180-second outer driver deadline**; closing the
browser also produced retained page-closed errors. No timeout was reclassified
as success or missing duration as zero.

| Source | Recorded slots | Completed | Under100ms | Completed-subset median / max |
|---|---:|---:|---:|---:|
| Baseline |19: one unfinished|18|0|860.4 /1,487.3ms|
| Combined |29|29|0|640.0 /1,188.6ms|

All completed slots passed their exact-data, engine identity, range-direction
and visible-frame checks. Baseline41 and combined31 planned slots never started;
they are not passes. Partial unequal, deadline-censored samples DO NOT prove
an improvement; the full60-action/frame-gap/long-task acceptance is incomplete.
These sustained probes differ from the prior dock report's10-action zoom batches.
No more timing attempts were started to obtain a green result.

Raw: each phase's `steady-zoom-workspace.json`, eventsJSONL and exact wrapper.
`validation-summary.json` explicitly preserves partial slots, nulls and failures.

## Offline functional browser results and limits

One functional pass plus narrow viewport-fixture correction used the exact
compiled combined source/build. No timing measurements were repeated.

- Unchanged primary functional probe PASS at390x844/1440x1100: dock reachability,
  own-button Quick Actions closing, drafts, fullscreen and off-chart restoration,
  unchanged complete200-bar data and chart/series identity.
- Unchanged comparison probe PASS at1440x1100. Archived viewport-only variant
  PASS at explicit390x844: both chart/series IDs and complete300-candle data held,
  nested chart stays fullscreen when Search closes with Escape; header usable.
- Pinned context probe PASS all6 GBPUSD/USDJPY/EURUSD xM5/M15 combinations.
  Mobile-only viewport variant PASS the same6. Canonical/displayed values match
  intercepted candles; chart/series identity remained stable across switches.
  Symbols->Focus works, historical live-price affordance stays false.
- Mobile keyboard Search Enter/Escape and Zoom Enter PASS after explicit viewport
  verification. Range changes without changing candles/chart/series identity.
- **Supplemental failure retained:** initial keyboard zoom used an actual
  1440x1100 viewport despite its mobile label and rangeChanged=false. Corrected
  fixture explicitly sets390x844; no application code or timing gate changed.
  The initially misnamed comparison screenshot was desktop; the focused mobile
  comparison correction, original assertions and screenshot are separately saved.

Functional-only approved-symbol enrichment supplies three nontradeable,
unconfirmed symbols; it was NEVER used for timing. Unprovided APIs/mutation
attempts returned intercepted503s, not fake successes. Logs retain initialization/
background writes and expected offline console errors; no page errors reported.
The supplemental mobile comparison has62 requests,3 blocked writes and36
unprovided API paths. No Quick Action item, voice, trade/order or live analysis
was activated. Historical/conflict/safe-mode warnings remain visible; matching
synthetic arrays does not certify live provenance, valid trading data or AI.

Evidence: `functional/results.json`, `functional/testing-agent-result.txt`,
`functional/comparison-mobile-functional-results.json`, full drivers/probes/logs,
and `functional/testing-agent-mobile-result.txt`.
Inspected screenshots: `functional/primary-mobile-viewport.png` and
`functional/comparison-mobile-390x844-fullscreen.png`.
Real-user, physical-device, cross-engine, provider, visible browser expiry and
full accessibility acceptance remain unverified.

## Development serving, preservation and final receipts

Only managed development frontend restarted once; Vite7.3.2 ready1,976ms.
API/other workflows and job settings unchanged. Transformed executable module
GETs returned200 for Scanner memo/clock code, local time label and freshness
helper (`served-source-checks.json`, savedJS). Anonymous `/login` renders normally;
expected401 session response is NOT signed-in owner acceptance.
Owned fixture4199 and all owned browsers were closed after evidence collection.

Preserve prior dock zoom4x0/10 (median723.8ms/max876.5ms), both dock navigation
conditions0/10 valid, prior slowed-touch5/5 failures, earlier first-load failures
and lost idle-timeout evidence in `ARX_CHART_DOCK_DEVELOPMENT.md`,
`ARX_CHART_CHANNELS_DEVELOPMENT.md`, `ARX_NAVIGATION_RECORDER_DEVELOPMENT.md`.
M2/no-data, earlier range-acceptance, hydration, legacy404, ordinary automatic
POST, physical touch and broader parity/launch gaps were not declared resolved.

One initial functional-agent dispatch string failed to parse before dispatch;
the corrected brief dispatched normally. Recorded as tooling, not app failure.
Source differences, complete raw receipts and SHA256 manifest are retained.
No database changes/migrations, credentials changes, workers/trading activation,
emails, funds movement, broker/demo/live tests, orders, deployment or publishing.
