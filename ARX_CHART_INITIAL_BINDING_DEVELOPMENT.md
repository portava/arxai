# ARX volume, range studies and initial binding — development report

## Terminal outcome

The selective source import and combined offline validation are complete.
The development frontend is refreshed and serves the new chart code.
**API activation is deferred:** the existing API process was not restarted.
Its startup invokes safety/account bootstraps; no permission to risk changing
the existing database/accounts was inferred from this chart update. The volume
correction has source, pure-contract and build evidence, **not refreshed
running-API acceptance**.

No first-navigation improvement, competitor parity or launch readiness is
claimed. No new navigation acceptance or broad timing batch was run.

## Source and recovery

- Branch: `codex/pr103-smart-chart-development-20261031`.
- Preserved preceding application: `49d13ac49fff432db8ff947e93feecf7c4aa5bc2`.
- Recovery checkpoint: `140121e380c3905eca67d6a0d72ffdd508bc45f9`.
- Recovery ref: `codex/backup-before-initial-binding-20261031`.
- Earlier recovery `a1c6d9b31df8249bafab0e941170b5226613a368` remains intact.
- Accepted upstream branch: `codex/chart-initial-binding-20261031`.
- Pinned report head: `1fc600fe9bd6f7fb146c003cb66d26d394e5bba9`.
- Upstream tested application: `f9eb6c5d2ca3f92f9c0661da74c943d32578e2be`.
- **Combined tested application: `ee4091166a4e909a0c0cf8cabb1eaa9f7dba8445`.**
- Exact production-runtime fixture: `38eced1942d5a396`.
- The final documentation-only checkpoint is recorded in
  `generated-artifacts/arx-initial-binding-validation/final-checkpoint.json`.
  This report does not embed its own commit hash.

All receipt paths below are relative to
`generated-artifacts/arx-initial-binding-validation/`.
Generated evidence is retained there and ignored by Git/deployment packaging;
the source checkpoint does not contain the raw generated receipts.

## Scope and preserved differences

Reviewed the source-linked volume, range-study and initial-binding reports and
selected original failed experiments before editing. Nine modified files
matched the upstream object-navigation base exactly; the two new range files
were absent locally. No reconciliation conflict or concurrent tracked edits
were observed.

Imported exactly eleven files: five production and six regression files.
All match the pinned candidate blobs; there were 338 insertions and 11 deletions.
Outside those files the recovery source is unchanged. No dependency, lockfile,
test-command, startup, auth/sign-out, funds/cockpit or configuration replacement
was made. Existing Truth, trading/access gates, chart controls, channels,
reader/prefetch/render isolation, and the durable recorder were preserved.

Held resize-dedup, toolbar-phase/layout, containment and other unapproved
performance experiments were excluded. The archived failed revision-scan
experiment was inspected as evidence, not applied as a patch.

Receipts: `review.json`, `base-blobs.json`, `candidate-blobs.json`,
`scope-audit.json`, `preservation-audit.json`, and `candidate/`.

## Behavior

1. Only explicit raw zero volume supports the existing non-synthetic
   zero-volume advisory. Omitted/non-finite input and the selected duplicate
   retain honest evidence; invalid-price flags and synthetic exemptions remain.
   The internal evidence marker is not a new wire field.
2. Donchian Channels plot midpoint/high/low over the configured observed-bar
   window, including the forming bar. Warm-up stays blank. Long bulk range
   studies use bounded monotone queues; tiny revisions use a bounded scan.
   The original starter collection/order is explicit and preserved.
3. First candle binding preserves the Studies input DOM, query and focus.
   An already-bound provider/context replacement or actual market/interval
   change still resets tools. An active field moved outside the visual
   viewport is scrolled into view without taking focus.

The compatibility wire field still turns missing volume into numeric zero,
and tick volume is not established as real traded volume. No volume analytics,
VWAP, footprint or volume profile was enabled. Donchian remains a partial study
capability, not an order/breakout signal or platform-parity claim.

## Actual combined-source checks

| Check | Result |
| --- | --- |
| Full frontend | **2,617 passed, 0 failed, 11 skipped**; 179 files passed, one skipped |
| Root/project-reference and leaf typechecks | Pass, exit 0 |
| API build | Pass, exit 0 |
| Dashboard production build | Pass, exit 0; large-chunk warning retained |
| Pure candle fixtures, response shape and chart-truth contracts | **76 passed, 0 failed, 0 skipped** |
| Account-stream scheduling regressions | **13 passed, 0 failed, 0 skipped** |
| Recorder/navigation/disclosure regressions | **22 passed, 0 failed, 0 skipped** |
| Guards | **87/87 passed** |
| Binding assertions | **7/7 passed** |
| Immutable actual-Scanner fixture build | Pass; clean source unchanged during build |

The four new API volume-evidence regressions passed. Commands used a stripped
environment, unreachable dummy database, disabled job/trading switches and a
network guard; no existing database or provider was used. Upstream's 2,619
frontend/77 pure-contract counts are not substituted for these measured totals.

Commands, exit codes, durations and full logs are retained as
`binding-frontend-*`, `binding-checks-*`, `binding-fixture-*`, and
`validation-summary.json`.

## Offline browser journey

**Final application assertions: 53 passed, 0 failed.**

- Initial binding: **16/16** at desktop 1440×1100 and mobile-width 390×844.
  Held/released synthetic 200-bar response; identical input, query and focus;
  visible/unobscured active field; exact source candles; genuine provider-change
  reset; no overflow or page exceptions.
- Donchian/range study plus interval extension: **32/32**. Default 20, edited 5,
  three actual plotted series against an independent full-window oracle;
  no misleading applied-price selector; saved reload; mobile width; genuine
  M5 interval change detaches the old search.
- Market change: **5/5**. Actual Symbols-tab UI selection of GBPUSD closes the
  prior workbench; witness matches GBPUSD/M5 and all 200 canonical bars.

Inspected focused-search and Donchian screenshots at both widths:
`functional/binding-final-1440.png`, `binding-final-390.png`,
`donchian-desktop.png`, and `donchian-mobile.png`.
Mobile search visibility requires scrolling to the focused control; this does
not prove the entire chart and controls fit simultaneously. The fixture's
historical/invalid/unavailable-AI warnings and blocked-trading state remain
visible. Its outer LIVE badge is synthetic shell UI, not live-source evidence.

Runtime was native `/repl/tools/bin/chromium` through workspace Playwright,
headless desktop Chromium at resized viewports with isolated contexts.
This is not physical-touch, actual phone-keyboard or cross-engine acceptance.

### Retained failures and unavailable fixture behavior

- Two earlier wrapper attempts failed: source-adaptation mismatch and extension
  scoping/async-log handling. They are retained in
  `functional/harness-debug-attempt.json` and `harness-debug-attempt-2.json`.
  No application repair, relaxed gate or discarded failed attempt was used.
- The top-bar symbol picker showed **No approved symbols found** because
  `/api/me/symbols` was unavailable (fixture 503). That picker was not accepted;
  the separate Symbols-tab UI completed the market-change journey.
- The primary probes logged 17 blocked mutation attempts, the symbol journey
  five and four UI-control exploration contexts thirteen: **35 blocked total**,
  answered 503 rather than fabricated success.
- Primary probes logged 207 unknown unavailable reads; the symbol journey 29
  more. Primary console error counts were 79 and 77, mainly expected unavailable
  resource messages; primary page exceptions were zero.
- Initial development-domain module probing returned 404, and a separate probe
  used the wrong `/api/health` path (404). Failures are retained in
  `served-probe-initial-failures.json`. Correct artifact/shared-router module
  checks and the source-defined `/api/healthz` subsequently returned 200.

Full final checks, intermediate failures, exact executed scripts, runtime,
network logs, witnesses and screenshots are in `functional/`, notably
`results.json`, `symbol-change-results.json`, and `tester-report.json`.
All test browser contexts were closed; the owned fixture server was stopped.

### Upstream experiments reviewed, not claimed as local results

The upstream archive retains: pre-fix volume regressions and an accidental
DB-backed offline-contract command failure; range starter-default failures,
warm-up/revision overhead and mixed benchmark results; initial-binding baseline
and viewport regressions, mobile harness timeout and the genuine offscreen
focus failure before the final visibility fix. Selected original receipts are
saved under `upstream-receipts/`; the three source-linked reports are under
`candidate/docs/`.

Upstream initial-binding timings showed no meaningful first-navigation
improvement. The final focus-visibility commit was not retimed there.
Bulk calculator results do not establish whole-chart/navigation speedup here.

## Navigation/performance outcome

**No new acceptance samples were produced.** Prior results remain:

| CPU / slot | Ready→click | Visible completion |
| --- | ---: | ---: |
| 1× / 0 | 165.9 ms | 156.8 ms |
| 1× / 1 | 175.7 ms | 290.9 ms |
| 4× / 0 | 202.6 ms | 1,034.2 ms |
| 4× / 1 | 172.5 ms | 984.4 ms |

These belong to the preceding application, not the new combined source.
**Zero valid, four invalid, sixteen unstarted; accepted median/max remain null.**
All four failed the unchanged 150-ms ready-to-click window and exceeded the
100-ms visible-completion target. Earlier forty invalid navigation slots and
both 180-second sustained-zoom deadlines remain open, with unfinished/null
and unstarted records unchanged. Short zoom observations are not sustained
acceptance or a speedup comparison.

A bounded **static** examination on the new source is retained in
`mount-inspection.json`: the memoized chart still must mount initially,
TradeHealthPanel mounts alongside it, and default Focus contains eleven direct
surfaces. JSX tab mapping alone does not establish that inactive tabs mount.
This identifies profiling candidates, **not measured component costs or a
cause**. No mounting optimization or held experiment was installed.

The old runtime discrepancy remains unresolved. Older Replit loading,
slowed-touch, M2 no-data, general range, mobile overlap, hydration, legacy 404
and ordinary automatic-alert-POST limitations are not fixed by this import.
See `ARX_CHART_OBJECT_NAVIGATION_DEVELOPMENT.md`,
`ARX_SCANNER_RENDER_ISOLATION_DEVELOPMENT.md` and retained predecessor receipts.

## Actual running preview versus source

- Managed development frontend restarted once after the source checks passed;
  Vite came up cleanly. Three actual served executable module probes confirm
  the workbench generation, focus visibility and Donchian/range bindings.
- Anonymous `/login` rendered normally; its expected identity 401 is not a
  private sign-in test.
- Existing API `/api/healthz` returned 200. **API source/build are updated but
  its process was left untouched; do not attribute the volume fix to it.**
  Existing jobs, credentials, accounts and startup settings were preserved.
- The actual Scanner journeys used an isolated production-runtime build of
  the real source, synthetic intercepted data and blocked mutations—not the
  owner's authenticated live API/provider session.

Owner-authenticated/provider, comparison/replay browser, physical-device/
keyboard, sustained-performance and published-app acceptance remain unverified.
API activation under a demonstrably non-mutating startup is an explicit
remaining blocker, not a hidden success.

No main merge, push, publish/republish/deploy, existing-database change or
migration, credential/account change, worker/settlement/trading activation,
email, order, funds movement or live/demo broker test occurred.

Key final receipts: `validation-summary.json`, `preservation-audit.json`,
`served-source-checks.json`, `existing-api-health.json`, `fixture-shutdown.json`,
`evidence-sha256.json` and `final-checkpoint.json`.
