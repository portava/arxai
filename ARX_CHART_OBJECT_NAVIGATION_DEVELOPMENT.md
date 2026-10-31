# ARX drawing objects and source binding — development report

## Outcome

The scoped development import is complete. Offline correctness checks pass.
**Immediate first-Scanner navigation acceptance remains failed/incomplete.**
This is not a parity, real-provider, published-app or launch-ready result.

### Exact provenance and recovery

- Branch: `codex/pr103-smart-chart-development-20261031`.
- Preserved recovery checkpoint: `a1c6d9b31df8249bafab0e941170b5226613a368`.
- Recovery ref: `codex/backup-before-object-navigation-20261031`.
- Preserved preceding application: `b87e3629ce7f4744a806f8b86c966711a19bfc65`.
- Reviewed upstream branch: `codex/chart-object-navigation-20261031`.
- Upstream report head: `8072ad7685d0e2f6167d542ae63f500a0df03488`.
- Upstream tested application: `f1fc30925e43d301cb9101477c6c7918533da7f4`.
- **Tested combined development application:
  `49d13ac49fff432db8ff947e93feecf7c4aa5bc2`.**
- Final documentation-only checkpoint and clean-tree receipt:
  `generated-artifacts/arx-object-navigation-validation/final-checkpoint.json`.
  This report does not embed its own commit hash.
- Immutable offline production-runtime build: `c35eef7b3b5466e8`.

Evidence paths below are relative to
`generated-artifacts/arx-object-navigation-validation/`.
Raw generated receipts are retained there, ignored by Git/deployment packaging;
they are not source files contained in the application commit.

## Selective import and preservation

Reviewed the object-navigation, object-controls and source-binding reports before
editing. All ten affected files matched their accepted upstream base locally.
Imported exactly six production files and four regression files: individual
visibility/search, source-context generation binding, loaded drawing navigation,
the reader token type, drawing serialization/rendering and replay focus wiring.
There were no additional dependencies or package/lockfile changes.

All ten files match the pinned tested upstream blobs. All other tracked files
were unchanged from recovery at the tested application commit. No concurrent
tracked source edits were observed. See `scope.json`, `review.json`,
`candidate/` and `preservation-audit.json`.

Preserved local authentication/sign-out, startup and Replit routing fixes,
Truth/safety/permissions, dependency and test commands, funds/cockpit behavior,
chart scaling/channels/dock, reader/prefetch/render-isolation work and the durable
navigation recorder. This was not a whole-app import or a branch reset.

Explicitly excluded resize-dedup (`cfd2defe`, `ed17b8f9`, `745fde49`), toolbar
phase `293483c5`, old toolbar `81b7f0a8`, containment `363c9e43`, and other held
performance experiments. No GitHub merge or push was performed.

## Checks on the combined application

| Check | Actual result |
| --- | --- |
| Full frontend | **2,588 passed, 0 failed, 11 skipped**; 178 files passed, one skipped |
| Root/project-reference and workspace typechecks | Pass, exit 0 |
| API build | Pass, exit 0 |
| Dashboard production build | Pass, exit 0; existing large-chunk warning retained |
| Offline account-stream scheduling | **13 passed, 0 failed, 0 skipped** |
| Navigation recorder/disclosure regressions | **22 passed, 0 failed, 0 skipped** |
| Safety guards | **87/87 passed** |
| Bridge binding assertions | **7/7 passed** |
| Immutable production fixture build | Pass; clean exact application source |
| Scoped blob/preservation audit | Pass; ten exact files, no outside-scope changes |

Logs and command exit codes: `object-frontend-*`, `object-checks-*` and
`object-fixture-*`. Upstream's 2,590 passes are not attributed to this workspace;
its preserved test inventory differs.

### Functional browser checks

Desktop 1440×1100 and mobile-width 390×844 passed the completed drawing journey:
search and stable numbering; loaded locked-anchor navigation; Objects closure
and correct canvas focus; keyboard Tab/Enter; honest unloaded-history refusal
without a range change; individual hide/show, Undo/Redo and saved reload;
geometry/locking/source/candle preservation; no horizontal overflow.
Charts naturally recreate on document reload; identity continuity is not a
claim that the same physical engine object survives reload.

**Retained initial failure:** my first test specification incorrectly required
the temporary global Hide drawings toggle to persist across document reload.
Baseline and candidate both initialize that toggle to false. Individual object
visibility is saved; the global toggle is temporary. No application fix was made.
The original failed `functional/results.json` was not overwritten. A documented
scope correction completed the remaining desktop assertions and mobile journey
in `functional/followup-results.json` and `followup-scope-diff.md`.

Screenshots inspected: `functional/followup-desktop-1440x1100.png` and
`functional/followup-mobile-390x844.png`. The mobile capture is vertically
scrolled, not a first-viewport/chart-first-layout acceptance result.

The follow-up logged zero page exceptions, no external/WebSocket attempts,
14 blocked background POSTs and 128 expected offline 503 resource errors.
Fixture warnings/historical/unavailable-AI states are not live-data acceptance.
Optional comparison/dock browser checks were skipped in this bounded pass;
replay-window limits have regression coverage but no new replay browser run.
No object-jump latency benchmark or upstream 60/60 claim was reproduced here.

## Bounded performance diagnosis — not acceptance

All owned suites/builds and functional browsers had finished before measurement.
Runs were serial. Shared-host activity was not controlled or exclusive.

Runtime: workspace Node **24.22.1**, Playwright **1.64.1**, Linux headless
**Chromium 152.0.7977.64**, executable `/repl/tools/bin/chromium`, slowMo 0,
eight logical CPUs. Explicit CDP slowdown: 1× and 4×. Cgroup `cpu.max` was
`800000 100000`; recorded phases showed **no new cgroup quota throttling**.
CPU-pressure files were unavailable. Host load and per-phase Node event-loop,
CPU and browser metrics are retained; host contention cannot be ruled out.

Each phase had a 60-second deadline; driver 180 seconds; actual outer shell
`timeout` 240 seconds with a further 10-second termination grace. No deadline
was increased to obtain a pass and no source/input/visibility threshold relaxed.

### Preparation failures retained

1. `diagnostics/`: optional CDP command-line inspection was refused because
   `--enable-automation` was not set. No timing slots executed. Full launch flags
   therefore remain unverified; no flags were added to make inspection succeed.
2. `diagnostics-corrected/`: blank controls and four zoom actions completed, but
   both navigation preflights failed: my reduced two-slot journal plan violated
   the recorder's fixed ten-slot contract (`Invalid new run`). No navigation
   click samples executed in that attempt. Its tiny traces contain no clicks
   and cannot diagnose application navigation.
3. `navigation-only/`: corrected only the wrapper, preserving the ten-slot
   recorder contract and original gates. Executed the first two desktop slots
   at each CPU setting, then stopped without emitting completion. The two
   recovered journals each contain two results and eight unstarted slots:
   **four recorded, sixteen explicitly unstarted, both journals incomplete**.
   No blank/zoom reruns or broad performance batches followed.

See each attempt's `results.json`, `events.jsonl` and `executed-driver.cjs`.
Executed navigation/zoom probes and traces are retained alongside them.

### Empty-page controls

Six trusted button-click samples, three per CPU setting:

| CPU | Evaluate round trip | 10-ms browser timer | Locator call wall time | Click to two frames |
| --- | --- | --- | --- | --- |
| 1× | 1.27–2.52 ms | 10.2–10.9 ms | 19.4–62.9 ms | 18.6–30.0 ms |
| 4× | 1.64–3.67 ms | 10.5–10.7 ms | 24.1–30.9 ms | 23.4–28.1 ms |

These exclude a fixed hundreds-of-milliseconds protocol floor **in this current
control run**, not in every older run or application state.

### Actual Scanner navigation diagnostics: all four invalid

Original 150-ms first-actionable-link window, 100-ms completion target, trusted
click, exact executing build/canonical/display data, source/symbol/interval,
series identity and two consecutive unobscured visible frames were retained.
No hover dwell, forced click, spinner or empty-canvas substitute was used.

| CPU / desktop slot | Ready→click | First container | Correct candles / visible completion | Witness cost | Browser candle responseEnd relative to click |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1× / 0 | 165.9 ms | 127.7 ms | 156.8 ms | 1.6 ms | −22.8 ms |
| 1× / 1 | 175.7 ms | 189.6 ms | 290.9 ms | 2.0 ms | +140.9 ms |
| 4× / 0 | 202.6 ms | 453.1 ms | 1,034.2 ms | 10.7 ms | −30.0 ms |
| 4× / 1 | 172.5 ms | 524.1 ms | 984.4 ms | 5.9 ms | +153.4 ms |

All four verified exact source/response and trusted input but failed the readiness
window; all observed visible durations also exceed 100 ms. **Zero valid samples;
valid-only medians/maxima remain null, not zero.** There are no new mobile timing
samples; they remain among the intentionally unstarted slots.

The responseEnd figures are browser Resource Timing, not route.fulfill/mock
preparation. Last JS resource receipt relative to click was −21.3, +110.4,
−29.9 and +113.5 ms respectively. Receipt alone is not parsing, query-cache
readiness, mounting, correct candles or analysis completion. Analysis stayed
unavailable/blocked; no completed-analysis latency is established.

### What the diagnostic evidence supports

- Pointerdown occurred 165.8, 175.5, 202.5 and 172.5 ms after readiness.
  Pointerdown→click was 0–0.2 ms. Most of the readiness gap precedes trusted
  pointer input, not an intentional click dwell. Locator wall times were
  522.0, 503.0, 1,508.3 and 1,022.9 ms; those include action preparation and
  browser work, not just application execution or post-click completion.
- Click capture lag was 18.0, 18.7, 30.9 and 52.6 ms. Native click dispatch
  durations were 105.0, 16.7, 57.3 and 51.2 ms. The much longer 4× completion
  continues after dispatch.
- Approximate 4× post-dispatch windows contain 614.6–640.6 ms inclusive function
  callbacks, 127.1–139.7 ms style work, 50.6–59.1 ms layout and 36.3–41.0 ms
  paint. Large callbacks reference the application fixture's main/index bundles;
  frame gaps reach 350.0/312.2 ms, and long tasks are retained.
  These categories nest/overlap and **must not be summed** or treated as an
  exclusive component/CPU attribution. Windows are approximate; the readiness
  observer and tracing also add work beyond the timed source-witness counter.
- Source-witness costs alone are too small to account for the whole observed
  delay. First-slot candles/modules had arrived before the click, yet rendering
  finished much later. Network receipt alone therefore does not explain those
  slots; later-slot module/candle arrivals can contribute additional waiting.
- Current navigation-phase Node event-loop maxima were about 19.7–20.7 ms;
  no current multi-second Node stall or quota throttling was observed.
  This is not proof of the cause of previous host/runtime stalls.

### Four-action zoom diagnostic

Four 4× mobile-width trusted zoom actions retained exact data/source/engine,
correct changed range and two visible frames:
**73.7, 60.1, 49.5, 57.4 ms**. Four under 100 ms in this short diagnostic;
this is **not** the old 60-action sustained acceptance workload.
Scroll/actionability preparation took 69.7–97.5 ms; locator calls 150.8–179.2 ms.
Their endpoints differ from the in-browser timing and cannot simply be
subtracted to assign overhead. Frame-gap median 16.7 ms, p95 33.4 ms, maximum
83.3 ms; no long tasks recorded in that short zoom window.

### Why the old discrepancy is not resolved

Current source, host conditions and workload differ from the old censored runs.
The prior wrapper explicitly supplied `--no-sandbox`/`--disable-dev-shm-usage`
and appended console/request-failure events; this diagnostic wrapper did not
pass those extra launch arguments and uses different Node-call spans.
Actual default flags could not be inspected. Current CPU phases use fresh
contexts within a browser, whereas the old runner launched fresh browsers per
probe. Tracing adds overhead. No isolated experiment proves the effect of any
one difference, and no matched baseline/candidate speedup is claimed.

The original **40 invalid navigation slots** and **both 180-second sustained
zoom deadlines** remain failures/incomplete. Prior baseline zoom: 18 complete,
one unfinished/null and 41 unstarted; candidate: 29 complete and 31 unstarted.
Neither completed subset had a ≤100-ms result. Do not compare their unequal
censored medians to four short current actions as a speed improvement.

The exact cause of those older deadlines remains unresolved. Investigation
stopped at the bounded diagnostic evidence rather than repeating broad runs.
Earlier Replit first-load, slowed-touch, dock zoom, M2 no-data, general range,
mobile-overlap, hydration, legacy-page 404 and ordinary automatic-alert-POST
limitations remain open; see `ARX_SCANNER_RENDER_ISOLATION_DEVELOPMENT.md`
and its retained predecessor reports.

## Served development preview and boundaries

Only the managed development frontend was restarted, once after checks passed.
Vite started cleanly. Actual served executable modules contain the new Find
drawing/Go to start handlers and source-generation/correct-target bindings:
`served-source-checks.json` and `served-*.js`. The anonymous login page rendered;
its expected identity 401 is not authenticated sign-in acceptance.

Owner/provider, physical-phone/touch, cross-engine, heavy-history, comparison/
replay browser, active-analysis and published-app acceptance remain unverified
or skipped as detailed above. No credentials were requested.

Owned test browsers and fixture server were closed; port 4199 shutdown was
verified. Existing API service and job settings were not changed or restarted.
No database changes/migrations, credential changes, workers/settlement/trading
activation, emails, orders, funds movement, broker/demo/live tests, main merge,
deployment or publication occurred.

Key receipts: `diagnostic-summary.json`, `navigation-diagnostic-summary.json`,
`function-trace-summary.json`, `journal-recovery.json`, `preservation-audit.json`,
`fixture-shutdown.json`, `evidence-sha256.json`, and `final-checkpoint.json`.
