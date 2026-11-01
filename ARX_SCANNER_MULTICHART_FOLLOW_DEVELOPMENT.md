# ARX development: Scanner layouts and comparison interval following

Completed 1 November 2026. Development-only selective import. Feature checks
passed with the viewport and acceptance limits below; no startup-speed,
real-provider, platform-parity or launch-readiness claim.

## Exact source and recovery

- Application: `a861d94a7e83618aef531203c849e9555b2ab5f8`.
- Branch: `codex/pr103-smart-chart-development-20261031`.
- Recovery checkpoint: `240db58bece906d00b5cba0e7351a85ec9a5be7e`.
- Recovery ref: `codex/backup-before-follow-interval-20261101`.
- Prior application retained: `07199ca96df53f6af1db1daa9feb723c509b0638`.
- Older checkpoint `e134a2203fffebcaa4dd6322532016a4922395f5` retained.
- Upstream report head: `c9b3c6e215937a10b803217e22c3ebfbaf23bff4`.
- Upstream tested application: `0ba7e8ddbb1ab12c8693da2f22a6c2692d63a063`.
- Ordinary-runtime immutable fixture: `2414d5f3bcd77598`.
- Final workspace checkpoint is recorded after this report is committed in
  `generated-artifacts/arx-follow-interval-validation/final-checkpoint.json`.

The initial tree, application commit and pre-report tree were clean. No newer
concurrent tracked changes were found or overwritten. All six touched file bases
matched upstream; resulting bytes match the candidate and tested-source blobs.
No wholesale replacement, reset, main merge or upstream push occurred.

## Selective scope and preserved work

Only these files under `arxai/artifacts/trading-dashboard/src/` changed:

- `components/charts/SmartChartLayout.tsx` and `.test.tsx`
- `components/scanner/ScannerChartPanel.tsx` and `.intervals.test.tsx`
- `lib/chart-engine/chartLayout.ts`
- `pages/live-chart.tsx`

All other auth/sign-out, startup, dependencies/lockfiles, Truth, safety, funds,
study/drawing/dock, early-candle and recorder differences are unchanged. API/job
settings and held experiments were not imported or modified. Upstream browser
scripts and the updated observer remain ignored evidence; only the isolated
fixture imports `fixture/witness.ts`. No normal-app diagnostic import was added.

Scanner uses a separate saved layout key, defaulting to one chart independently
of Live Chart or legacy layouts. Single-chart layout controls are below the
primary; multi-chart controls intentionally move above the charts. Primary
mount/context remains stable across one/two/four choices. Comparisons retain
local instruments, intervals and drawing focus; existing range/crosshair links
retain loaded-history/receiving-candle semantics.

Follow primary interval is off by default, explicit per comparison and outside
the instrument picker. Only boolean true restores following. It derives the
displayed interval from the primary without changing the primary symbol,
timeframe, setup or trade context. Unfollow retains the displayed interval;
direct comparison interval selection stops following. Hidden comparisons use
the current primary interval when restored. W1/MN1 remain held rather than
silently substituted; this behavior has unit/source coverage, not new browser
calendar acceptance. This is one-way following, not two-way synchronization.

## Exact combined-source validation

| Check | Pass | Fail | Skip |
|---|---:|---:|---:|
| Full frontend | 2717 | 0 | 11 |
| Pure API chart/truth contracts | 76 | 0 | 0 |
| Account scheduling | 13 | 0 | 0 |
| Recorder/navigation/disclosure | 22 | 0 | 0 |
| Guards | 87 | 0 | — |
| Bindings | 7 | 0 | — |
| Follow browser assertions | 39 | 0 final | — |
| Multiview browser assertions | 23 | 0 final | — |

Frontend: 180 passing files and one skipped file, seven more passes than the
preceding combined source. Root/project-reference/leaf typechecks, API build,
dashboard build and immutable fixture build passed. Existing large-chunk warning
remains. Upstream's 2719 passes are not the workspace count.

Native headless Chromium 152.0.7977.64, Node v24.22.1, no external CPU throttling.
The final two prescribed probes each executed once. Their 62 raw assertions
overlap and are not 62 unique capabilities. Supplemental observations are not
added to this count. Source metadata was clean/unchanged and production runtime
was checked; no hardware paint or provider acceptance is implied.

Follow assertions checked exact full canonical/displayed OHLC against the
correct instrument/interval/limit response, primary 200 versus comparison 300,
follow/unfollow/direct selection, reload persistence, engine/context continuity,
historical/non-live truth, mobile overflow and no order/confirmation requests.
Multiview assertions checked one/two/four, primary continuity, independent
intervals, chart-local Delete/Undo, linked time range/receiving crosshair truth
and unlinking. The prescribed probes used EURUSD, not distinct instruments.

## Retained failures and state-correct viewport audit

Two initial runner setups failed before probe assertions with `ReferenceError:
innerWidth is not defined` in Node-side wrapper code. Their zero-assertion
receipts remain. Correcting the wrapper did not change the app or assertions.

The tester's first verdict then incorrectly treated a multi-chart screenshot as
default-single-chart evidence, reporting controls above the primary and a
below-fold mobile plot. Both the original verdict and screenshots remain.
A targeted continuation audited the same immutable source, without replaying
the 39/23 probes or running timing benchmarks:

- Single mode confirmed count 1, zero comparisons, One pressed and Two/Four
  unpressed. Controls computed order 1; primary wrapper order 0.
- Desktop 1600x1100, scrollY 0: plot y=969.5–1489.5, geometric viewport
  intersection 130.5px of 520px; controls y=1669.7.
- Mobile 390x844, recorded scrollY 13 after layout interactions, with no issued
  scroll action: plot y=663.2–1023.2, intersection 180.8px of 360px; controls
  y=1484.2. This is not a zero-offset cold-navigation sample.
- The single plot was partially, not wholly, in the viewport. Fixed mobile
  navigation obscures some lower intersection. Geometric intersection is not
  full unobscured-chart fit or a source-correct completion timestamp.
- Counts/pressed states matched one/two/four and zero/one/three comparisons.
  Multi-chart controls above the charts are intentional, not the single-mode
  control-order regression originally alleged.

A supplemental browser-local persisted GBPUSD/H1 comparison verified exact
300-bar canonical/displayed response data while EURUSD/M15/200 stayed primary.
This establishes distinct-symbol rendering/source authority, not instrument
picker acceptance; the picker remains an unverified fixture limitation.

The targeted continuation changed no application source. Initial/corrected
diagnoses and supplemental receipts are separately retained, not erased or
relabeled as additional unique feature assertions.

## Offline safety, limitations and performance

External HTTP/WS and all mutating app requests were blocked before navigation;
unsupported GETs received fixture 503, not fake success. Prescribed final probes
recorded blocked mutations 11/5, unknown GETs 99/54, analysis-related requests
23/13 and console messages 111/59. There were zero page exceptions; one aborted
request in follow is retained. No order/confirmation attempt was observed.
Ordinary automatic analysis requests existed but no analysis response or
successful mutation was supplied. Do not claim their global absence.

Historical/non-live and safe-mode/data-integrity warnings remain visible in the
synthetic fixture. Equality with its authoritative candle responses is not proof
of a healthy provider, valid live feed or analysis/trading permission. Real-owner
sign-in, physical devices, provider and published-app acceptance remain unverified.
Instrument picker interaction, browser W1/MN1 follow, rapid out-of-order
comparison transitions and browser storage-denial integration remain gaps.
Earlier unfinished gestures, text-note-specific shortcuts, DMI replay, M2 data
and legacy-route limitations are not resolved here.

No navigation, zoom, cached-follow latency or CPU benchmark was planned/run.
Original 150ms readiness and 100ms full source-correct visible-completion rules
were not relaxed. Prior remote source `e83090cb` remains **0 valid / 1 invalid /
9 unstarted**, 1393ms readiness and 239.3ms completion, valid median/max null.
Earlier 0/4/16, forty invalid slots, sustained-zoom deadlines and slowed-touch,
first-load/idle failures remain open.

Upstream's twenty cached-follow clicks below 100ms are archived upstream-only
results, not workspace startup or provider evidence. Upstream multiview's initial
ten invalid visibility attempts and final forty source/visibility-valid attempts
(twenty slowed failures, including 420.6ms outlier) remain archived. Nothing was
discarded or attributed to the new combined source.

Two optional offline follow-ups were proposed for out-of-order comparison
responses and browser storage failure. No new feature work was started on them.

## Served preview and boundaries

Only the development frontend was restarted, once after checks. Vite started
cleanly. Four shared-router executable modules returned 200 with the new
layout/follow/Scanner/Live Chart anchors. Anonymous `/login` rendered, with
expected identity 401; private owner sign-in was not attempted or claimed.

**API activation remains deferred**, including refreshed-process volume
correction acceptance. API and workers were not started/restarted or enabled.
Owned synthetic fixtures and browsers were closed; port 4199 is closed.
No main merge, publication/deployment, existing database/account/credential
change or migration, email, trading/settlement enablement, funds movement,
order or broker/live/demo test occurred.

## Evidence

Root: `generated-artifacts/arx-follow-interval-validation/`

- `source-commit.txt`, `scope-audit.json`, `preservation-audit.json`,
  `base-blobs.json`, `tested-blobs.json`, `upstream-receipts.json`
- `validation-summary.json`, `core-check-summary.json`, `final-checkpoint.json`,
  `evidence-sha256.json`, `measurement-decision.json`
- `follow-frontend-*`, `follow-checks-*`, `follow-fixture-*`
- `functional/run-summary.json`, `follow-interval-raw-results.json`,
  `multiview-raw-results.json`, initial harness failures and retained screenshots
- `functional/initial-testing-verdict.md`,
  `corrected-layout-testing-verdict.md`
- `functional/supplemental-layout-symbol-audit/supplemental-observation.json`
  and default-single desktop/mobile screenshots
- `served-source-checks.json`, `frontend-startup.log`,
  `anonymous-login-smoke.jpg`, `fixture-shutdown.json`
- `candidate/docs/CHART_FOLLOW_INTERVAL_2026_11_01.md`
- `candidate/docs/SCANNER_MULTIVIEW_2026_10_31.md`
- `candidate/docs/validation/{chart-follow-interval-20261101,chart-multiview-20261031}/`
  contains originals and compressed archives, all 118 manifest entries verified.

Prior workspace receipts remain under `arx-early-candles-validation`,
`arx-dmi-shortcuts-validation`, `arx-pending-engine-validation` and earlier
directories within `generated-artifacts/`.
