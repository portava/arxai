# ARX development: Smart Chart price and calendar-time ruler

Completed 1 November 2026. Development-only feature import; not release-green,
first-navigation acceptance or competitor parity.

## Source, recovery and scope

- Application: `4348fc6ae7cfbbdbdc527163ab18ee06416f47cd`.
- Branch: `codex/pr103-smart-chart-development-20261031`.
- Recovery checkpoint: `65581561a7efe21b674685da0dea2b72ed87d87b`.
- Recovery ref: `codex/backup-before-range-ruler-20261101`.
- Prior application preserved: `a861d94a7e83618aef531203c849e9555b2ab5f8`.
- Older recovery `240db58bece906d00b5cba0e7351a85ec9a5be7e` retained.
- Upstream: `codex/chart-range-ruler-20261101`, saved report head
  `26398f1606a9d9ea3c711607ead06b4f9f408853`.
- Tested upstream application: `4357a358e31475650204e5ca24bd42626dcd4779`.
- Combined immutable ordinary-runtime fixture: `3110f585cc249171`.
- Final workspace checkpoint, written after committing this report:
  `generated-artifacts/arx-ruler-validation/final-checkpoint.json`.

Initial source and pre-report source were clean at the expected commits; no
newer concurrent tracked work was found or overwritten. Four existing file bases
matched upstream. All six resulting source/test files byte-match both the
candidate and tested-source blobs.

Only these files under `arxai/artifacts/trading-dashboard/src/` changed:

- `components/charts/ChartWorkbenchTools.tsx` and `.test.tsx`
- `lib/chart-engine/chartDrawingPrimitive.ts`
- `lib/chart-engine/chartWorkspace.ts`
- New `lib/chart-engine/chartRangeMeasurement.ts` and `.test.ts`

All other local authentication/sign-out, startup, dependencies/lockfiles, Truth,
safety, funds, studies, chart controls, multi-chart/following, candle readiness
and recorder differences remain unchanged. No wholesale replacement or held
performance work was imported, including compact-initial, mount-budget,
toolbar/phase, resize-dedup and containment. The upstream probe, setup and
receipt files remain ignored evidence, not ordinary app-runtime tooling.

## Feature and semantics

Select **Price and time ruler**, then select two chart points by pointer or
touch. The ruler shows signed price change, percentage relative to the first
price and absolute elapsed calendar time; reversed time selection says earlier.
Same-candle different-price measurements are accepted and show zero elapsed
time. Prices are selected canonical price coordinates, not necessarily closes.

Existing drawing controls provide exact price editing, handles, hide/show,
locking, undo/redo and browser persistence scoped by instrument/interval.
The plot uses three segments and a compact clipped readout; Objects retains
the full readout when a pane is too small. Extreme ratios report percentage
unavailable rather than Infinity.

The explanation remains: **Elapsed calendar time includes market closures; this
is not profit, pips or a count of bars.** Source and the actual served executable
JSX contain that copy. The browser probe verified the accessible computed price
readout, but did not independently assert this explanatory sentence. Display
transformations do not reinterpret saved measurement values as transformed
prices. No signal, AI permission, market-data mutation or trade is created.

## Actual combined-source results

| Check | Pass | Fail | Skip |
|---|---:|---:|---:|
| Full frontend | 2725 | 0 | 11 |
| Pure API candle/truth contracts | 76 | 0 | 0 |
| Account scheduling | 13 | 0 | 0 |
| Recorder/navigation/disclosure | 22 | 0 | 0 |
| Guards | 87 | 0 | — |
| Bindings | 7 | 0 | — |
| Actual offline Scanner ruler assertions | 23 | 0 | 0 unfinished |

Frontend: 181 passing files, one skipped file. Eight new passes over the
preceding combined source's 2717; upstream's 2727 is not our workspace count.
Root/project-reference/leaf typechecks, API build, dashboard build and immutable
fixture build passed. The existing large-chunk warning remains.

One browser probe ran exactly once, with no new harness failures or retries.
Fixture metadata pinned the exact application above, empty source status,
sourceUnchanged true and checked production runtime. Native headless Chromium
152.0.7977.64, Node v24.22.1, no external CPU throttling; context hasTouch true,
isMobile false, service workers blocked. Desktop was 1440x1100, mobile width
390x844; touch used actual CDP Input.dispatchTouchEvent, not a physical device.

The 23 assertions checked exact selected EURUSD/M15/200 canonical and displayed
OHLC against its response; mouse two-point placement; signed price/percentage
and elapsed text; three strokes/two handles; accessible price readout; exact
endpoint edit and undo; hide/show/lock; log/percent/indexed/linear and Heikin Ashi
invariance; full reload including explicitly unlocked saved state; actual
mobile touch with same-candle zero elapsed; overflow; unchanged canonical
candles/reloaded engine; no page exceptions or order/confirmation attempts.
Desktop/mobile screenshots were inspected and show the actual rulers and
labels. Geometry observations and screenshots are not independent GPU-paint
timestamps. Price-input editing passed; broader handle-drag acceptance was not
newly exercised.

## Retained failures, offline limits and previous timing gaps

No new application assertion or harness failed in this run; no browser assertion
remained unfinished. Upstream's original closed browser session/two setup
failures, first 16-pass run's reload-oracle failure (missing explicit
locked:false), and wrong-directory test append failure remain in its archived
receipts. The corrected final upstream probe was imported, not its faulty
expectation; upstream results are not substituted for combined-source checks.

External traffic/streams and all mutations were intercepted before navigation.
Eight mutations, including automatic ai-alerts/scan and focus/activity requests,
received 503. There were 76 unknown GET occurrences and 84 console resource
errors, zero page exceptions and zero failed network requests. Unknown endpoints
were unavailable, not fabricated successful responses. Automatic analysis-
related requests existed; no manual analysis/Scan, trade or voice action was
taken and no successful automatic mutation was provided.

Synthetic historical candles remain explicitly invalid/not AI-usable with
visible data-validation/safe-mode warnings. Source-response equality does not
validate live market truth or real-provider/API health. Real-owner sign-in,
physical devices, live/private providers and the published app remain
unverified. Prior instrument-picker, new calendar-browser, rapid response-race,
storage-denial, unfinished-gesture/text-note and replay gaps remain open.
The prior 39 follow/23 multiview assertions were not rerun or claimed anew here.

**No new navigation, cached-ruler, CPU or zoom timing batch was planned/run.**
The original 150ms readiness and 100ms full source-correct visible-completion
rules remain unchanged. Prior remote navigation remains **0 valid / 1 invalid /
9 unstarted**, 1393ms readiness and 239.3ms completion; valid median/max null.
Earlier 0/4/16, forty invalid slots, sustained-zoom deadlines, slowed-touch,
first-load/idle failures and upstream outliers remain retained.

Prior partial viewport visibility also remains: desktop geometric intersection
130.5px, mobile 180.8px with 13px post-interaction offset and potential fixed-nav
obstruction. That is not whole-plot fit or cold-navigation acceptance. This
scrolled ruler probe makes no new default-layout/first-load claim.

Upstream's twenty cached second-anchor completions under 33ms remain archived
upstream-only observations. They are not new workspace timings, first-navigation,
physical-paint, provider or competitor evidence. No outlier was removed and
invalid/missing timings were not treated as zero-duration passes.

## Served frontend and operating boundaries

Only the development frontend was restarted once after checks. Vite started
cleanly. Four shared-router executable modules returned 200 and expose the ruler
kind/name, measurement functions, rendering and semantic caveat outside source
map comments. Anonymous `/login` rendered with expected identity 401; private
owner sign-in was not attempted or claimed.

**API activation remains deferred.** The existing API process and workers were
not started/restarted or enabled; refreshed-process volume-correction acceptance
remains unverified. The broad preview integration workflow was not run.
Owned fixture/browser processes closed and port 4199 is closed.

No main merge, GitHub push, publication/deployment, existing database/account/
credential change or migration, email, trading/worker/settlement activation,
funds movement, order or broker/live/demo test occurred.

## Evidence

Root: `generated-artifacts/arx-ruler-validation/`

- `source-commit.txt`, `compare.json`, `scope-audit.json`, `preservation-audit.json`
- `base-blobs.json`, `tested-blobs.json`, `upstream-receipts.json`,
  `upstream-evidence-audit.json`
- `core-check-summary.json`, `validation-summary.json`,
  `measurement-decision.json`, `final-checkpoint.json`, `evidence-sha256.json`
- `ruler-frontend-*`, `ruler-checks-*`, `ruler-fixture-*`
- `functional/run-summary.json`, `ruler-raw-results.json`, `testing-verdict.md`,
  fixture startup/exit logs, runner and inspected `desktop.png`/`mobile.png`
- `served-source-checks.json`, `served-*.js`, `frontend-startup.log`,
  `anonymous-login-smoke.jpg`, `fixture-shutdown.json`
- `candidate/docs/CHART_RANGE_RULER_2026_11_01.md`
- `candidate/docs/validation/chart-range-ruler-20261101/`: all 34 manifest
  entries' original and archive hashes verified, including failures/timings.

Earlier source reports and receipts remain unchanged, notably
`ARX_SCANNER_MULTICHART_FOLLOW_DEVELOPMENT.md` and
`generated-artifacts/arx-follow-interval-validation/`, plus earlier validation
directories.
