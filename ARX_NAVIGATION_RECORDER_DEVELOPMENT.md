# Scanner navigation recorder: development diagnostic result

**Outcome:** Scoped tooling import complete. Recorder validation and durable
recovery PASS. **First-visit performance acceptance FAILS.** No application
behavior was changed, and this is not a latency-fix, parity or launch-ready claim.

## Exact source and recovery

- Branch: `codex/pr103-smart-chart-development-20261031`.
- Recovery: `caf608b984e2d62d52d5a79b1ea69903efad07dd`,
  saved as `codex/backup-before-navigation-recorder-20261031`.
- Tested combined source: `c4856d8d001c4a851b8dfa8aaffec3ef3b71b07a`.
- Upstream tooling: `643899a0a1ab5075957c851e3f2c9d40e511c160`;
  frozen report/backup: `4944c950f8b1e993d084cb47a8bb003315145879`.
- Actual application source remains unchanged from
  `f3467de7c5f60038a139a60f00abe56d563f0cc4`.
- Immutable isolated production fixture: `167dde6dc4eb7a18`.
  Both batch preflights verified the executing build, clean source status and
  unchanged source. This is the real Scanner/root application with a fixture
  observer and synthetic historical data, **not the deployable frontend build**.
- The final reporting checkpoint is recorded after commit in
  `generated-artifacts/arx-navigation-recorder-validation/checkpoint-receipt.json`
  and in the terminal response. It adds this report/memory only.

Exactly five upstream files were imported under `arxai/scripts/scanner-qa/`:

1. `shared-chart-first-navigation.js`
2. `shared-chart-fixture/README.md`
3. `shared-chart-fixture/build.mjs`
4. `shared-chart-fixture/navigation-journal.mjs`
5. `shared-chart-fixture/navigation-journal.test.mjs`

Their Git blobs match both pinned upstream revisions. Only the navigation probe
previously existed locally; the four fixture files were new, not overwrites.
No unrelated chart ancestry was imported. No concurrent workspace edits were
observed at initial inspection or the preservation audits.

All application/authentication/sign-out/startup/Truth/safety/cockpit source,
dependencies, lockfiles, existing test commands, API/job settings and migration
source are preserved. No credentials or existing databases were accessed or
changed; no workers/trading enabled, broker/provider tests, orders, emails,
main merges, deployments or publishing.

## Fixture adaptation, not application adaptation

The existing ignored fixture's `index.html`, `main.ts`, `routes.mjs` and
`stylesheet.mjs` were reused unchanged. The imported builder/journal were copied
into the new ignored evidence directory. The builder has exactly two local path
adaptations: repository root resolves to `../../../arxai`; output resolves to
`../builds`. No runtime logic, probe, witness, acceptance thresholds or offline
setup were changed. This avoids importing extra tracked fixture dependencies.

All application writes/external requests were intercepted before navigation.
Only direct runner calls to the private, token-protected loopback journal could
write evidence. These writes never use an application API; acknowledgements
follow filesystem flushes and occur outside click-to-chart timing.

## Actual checks

| Check | This combined source |
|---|---|
| Navigation, journal/recovery, disclosure regressions | **22 pass, 0 fail, 0 skip** |
| Probe, fixture builder and journal syntax | **3 pass** |
| Isolated actual-Scanner production fixture build | **PASS** |
| Exact five-file blob/scope/application-preservation audit | **PASS** |
| Journal recovery after browser AND fixture-server shutdown | **2 complete journals, 20 attempts / 20 results; both final measured verdicts FAIL** |
| Immediate navigation batch | **FAIL: 10 retained, 8 valid, 0 meet 100 ms** |
| Separate 1500 ms idle batch | **FAIL: 10 retained, 10 valid, 0 meet 100 ms** |

Full application/frontend/server suites, root typechecks, deployable frontend/API
builds, guards and bindings were **not rerun for this tooling-only change**.
Historical application checks remain tied to their original source: frontend
2539 pass / 11 skip, guards 87, bindings 7 and earlier type/build results are not
new results for this diagnostic run. Existing fixture sourcemap/chunk-size
warnings remain in the retained build log.

## Actual browser, CPU and execution bounds

Workspace-local shell/Node execution, **not the prior remote browser worker**:

- Node `v24.22.1`; installed Playwright `1.64.1`.
- Chromium **152.0.7977.64**, existing `/repl/tools/bin/chromium`; no installation.
- Linux HeadlessChrome UA, headless, `slowMo: 0`, DPR 1.
- Desktop 1440×1100; mobile-sized viewport 390×844. This is a resized Chromium
  context, **not a physical mobile device or touch/CPU emulation**.
- `Emulation.setCPUThrottlingRate({rate:1})` succeeded before navigation in both
  runs. No remote-tool throttle was used. Navigator reported 8 logical processors;
  separately read cgroup quota `800000 100000`, cpuset `0-7`. Physical allocation,
  host contention, GPU and display refresh are not established by those values.
- Recorded load averages: immediate `[0.52,0.37,0.38]`; idle `[1.24,0.58,0.45]`.
  No other builds/test batches were started in the timing window; existing
  managed application services were not stopped or reconfigured.
- Each batch was a **separate** action with actual ShellExec `timeout_ms=240000`,
  GNU `timeout --signal=TERM --kill-after=5s 180s`, and archived Node 180000 ms
  deadline/partial-evidence handler. Observed driver durations were about
  11.1 s and 24.3 s. **Neither deadline expired.**
- Launch configuration is archived. Actual Chromium process argv could not be
  observed; the first process scan accidentally matched the shell command and
  is superseded by the retained `workspace-runtime-preflight-verified.json`.

The initial preflight ran **zero measured attempts**: default Playwright cache
browser was absent, remote deadline control was unavailable, and the remote
preflight reported 503. Workspace verification returned HTTP 200 and found the
existing Chromium. This failure/correction is retained, not silently discarded.

## Every new timing sample remains retained

Median/max below use **all five recorded samples**, including late-click failures,
not only the successful-validity subset. Times are milliseconds after the trusted
navigation click. Full unrounded values and diagnostics remain in raw receipts.

| Scenario | Viewport | Valid / recorded | Meets 100 ms | Visible median / max |
|---|---|---:|---:|---:|
| Immediate | Desktop | 3 / 5 | 0 / 5 | 257.4 / 331.6 |
| Immediate | Mobile-sized | 5 / 5 | 0 / 5 | 181.4 / 248.4 |
| Explicit 1500 ms dwell | Desktop | 5 / 5 | 0 / 5 | 207.9 / 255.3 |
| Explicit 1500 ms dwell | Mobile-sized | 5 / 5 | 0 / 5 | 113.5 / 142.0 |

Immediate desktop indices **0 and 3** failed readiness-to-click at **217.0 and
168.7 ms**, exceeding 150 ms. All 20 completions exceeded 100 ms. No sample was
deleted, retried as a warmup or replaced. Idle readiness-to-click stayed within
its separate 1500–1650 ms window; it is not immediate-click acceptance.

Definitions and limits:

- `readyAt`: first observed visible, positive-sized, center-hit navigation link,
  175.1–278.2 ms after document time origin in immediate runs. This is not the
  full Playwright actionability/stability contract.
- `click`: trusted click-event timestamp; runner navigation/click-call boundaries
  and pointer timing are separately retained. No forced/DOM clicks.
- First observed chart container: **71.3–153.2 ms immediate**,
  **81.2–156.7 ms idle**. An empty/mounted canvas is not data completion.
- Source-complete: first observed matching full canonical **and displayed** OHLC,
  identity/context/source/range over two rendering observations.
  Visible-complete additionally requires an unobscured ≥100px plot region.
  Here the two timestamps coincide: **161.1–331.6 ms immediate** and
  **105.2–255.3 ms idle**. The earliest single-frame correct series was not
  separately timestamped; two observations are not proof of hardware paint.
- Full Scanner controls/heading appearance has no separate timer. Completed
  active analysis is **not measured**: analysis truth is unavailable/inactive.
  The final screenshot shows historical/read-only synthetic data, blocked
  trading and chart Safe Mode, not healthy live-market acceptance.

## What the new diagnostics establish

**Measured:**

- Browser candle `responseEnd` is now retained: 293.0–519.9 ms immediate and
  311.3–419.4 ms idle on the document performance timeline. Mock preparation
  took 79–81 ms and precedes `route.fulfill`; it is a different boundary.
- Relative to immediate clicks, browser candle responseEnd ranges from
  **39.1 ms before to 124.4 ms after click**. Three immediate samples still had
  JS responses finish after click; latest was 92.9 ms after click.
- In **all ten idle samples**, the candle response ended **1372.8–1459.8 ms
  before click**, and all recorded JS transfers ended at least **1399.9 ms
  before click**. Yet source-correct visible completion still took 105.2–255.3 ms.
  Waiting for those particular transfers cannot explain that post-click interval.
  This does not prove earlier JSON parsing, query-cache adoption or evaluation.
- Immediate: 12 long tasks, maximum 191 ms; 52 frame gaps, maximum 162.7 ms.
  Idle: 12 long tasks, maximum 150 ms; 36 frame gaps, maximum 162 ms.
  In idle samples long tasks begin 0–3.4 ms after click and last 77–150 ms.
- Desktop link rectangle changes `(12,371,215,36)` → `(12,400,215,36)` occur
  **after click** in these samples. Those observed changes do not explain a
  preceding ready-to-click delay. Mobile link geometry remained
  `(156,788,78,56)`. All diagnostic dropped-record counts are zero.
- Each sample retains 64 JS / 2 CSS resource timings plus its candle response.
  The witness's cumulative measured cost was 1.2–3.1 ms; this excludes other
  instrumentation and is not total observer overhead.

**Hypotheses / not established:** post-click main-thread work/rendering or
deferred module processing are candidates, but no CPU stack/component attribution
or Playwright internal actionability trace was collected. Overlap alone is not
causation. No real-provider wait was measured in this offline fixture, so there
is no basis to blame a vendor. Unlike runtime/CPU/instrumentation also prevent
attributing differences from old remote or Mac samples to application improvement.

## Denied traffic and inherited failures

Probe-final snapshots: immediate **505 requests / 336 unknown reads / 32 blocked
POSTs / 354 console errors**; idle **591 / 422 / 32 / 454**. Later driver snapshots
are **507 / 338** and **593 / 424** after two additional unmapped GETs:
`/api/me/master-live/access` and `/api/me/live/profile`.
These distinct capture boundaries explain the counts; they are not retries.
Zero external attempts and zero page exceptions were observed.

Known activity-ping, chart-alert-scan and scalp-focus POST attempts were denied
with 503; no actual analysis/order action was clicked. Unknown reads also remain
503 rather than fabricated valid data. These are not healthy-session results.

The previous **20 failed remote immediate samples remain failed**:
ready-to-click 666.6–796.6 ms, visible completion 122–181.5 ms. Their pre-click
mock timestamps never proved browser receipt/cache readiness. The prior idle
action's **45-second outer timeout** remains a failure with **no recoverable
partial samples**, not zero attempts. Its exact outer configuration/runtime/CPU
was not archived and cannot be reconstructed by this new run.

Inherited M2 no-data, inconclusive zoom/pan range, mobile overlap, hydration/DOM
warnings, legacy-page `/live-manual` 404s and automatic-analysis-POST limitations
were not retested or resolved here. Authenticated owner/real-provider/production
acceptance and real first-visit latency remain unverified. No parity/launch claim.

## Evidence and cleanup

Base: `generated-artifacts/arx-navigation-recorder-validation/`

- `import-manifest.json`, `preservation.json`, `validation-summary.json`
- `recorder-checks-{0,1}.log`, `recorder-fixture-0.log`
- `workspace-navigation-driver.cjs`, `workspace-navigation-config.json`
- `workspace-runtime-preflight-verified.json`, `initial-preflight-blocked.json`
- `all-new-samples.csv`, `all-new-samples.json` — all 20 without exclusions
- `runs/workspace-20261031T1944Z/{immediate,idle1500}-results.json`,
  matching `*-browser-events.json`, `*-driver.log`
- `runs/workspace-20261031T1944Z/final-actual-scanner.png`
- `builds/167dde6dc4eb7a18-navigation-receipts/`
  - immediate `7d183b5487a2bae4854e98ca065db2d9.jsonl`
  - idle `3cd9cbefe0d3f9ee14b6bf46a4a75876.jsonl`
  - matching `.recovered.json`, recovered after server shutdown
- `evidence-manifest.json`, `checkpoint-receipt.json` — final hashes/checkpoint

Earlier evidence remains at
`generated-artifacts/arx-scanner-idle-validation/`, with its original report
`ARX_SCANNER_IDLE_LOADING_DEVELOPMENT.md`. Large evidence/builds remain ignored,
outside Git/deployment. Owned browser contexts and the loopback fixture server
were closed. Managed frontend/API/job settings were not changed or restarted.
