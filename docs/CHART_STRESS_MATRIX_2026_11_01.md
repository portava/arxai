# Chart stress matrix and renderer diagnosis — 1 November 2026

**Correctness passes; sustained frame target remains unproven and this matrix misses its strict proxy budget.** This is new measurement tooling and evidence, not a production performance fix. Application code is unchanged from accepted ruler source `4357a358e31475650204e5ca24bd42626dcd4779` / saved head `26398f1606a9d9ea3c711607ead06b4f9f408853`.

Tested tooling source: `7488069a852b6b01a3e014428ffafd4537d061fc`. Ordinary minified production/React-production build `556ce8e86f31aca2`; separate unminified production diagnostic build `89d6b50d500b91c3`. Both recorded clean source and unchanged trees during build. Bundle metadata and file hashes are retained. Final targeted TypeScript check of the QA entry and matrix passes on 7488069a. No new production application change required a repeat of the prior full frontend suite.

## Workload and validity

Four fixed cases, each in a fresh document in the same browser, at 1600×1100. The acceptance workbench is unmounted and fixture observer wrappers removed before the renderer workload starts. Each view uses the actual shipped adapter, 12 named study configurations (recorded in full; Bollinger/CCI use period1000), 20 Fibonacci drawings and 20 new rulers. Every case runs180 measured frames, ten forming-tip revisions per frame per view. Every30frames the first chart also pans and changes zoom; the four-view cases synchronize time ranges. These are imperative renderer actions, not trusted mouse/keyboard timing.

Correctness checks after the measured window:

- Count actual accepted price-series updates: **18,000/18,000** across four cases.
- Compare every canonical and installed display OHLC row with an independently regenerated deterministic expected history, including the exact final revised tip.
- Recompute all study points from the full expected history and compare every stored calculator point, not just the last value. This oracle shares the calculator implementation; independent formula tests remain separate evidence.
- Inspect actual study-series data: all installed values must equal the full recomputation, with unique timestamps and complete coverage of the visible candle interval. A correct calculator alone cannot conceal incorrect rendered lines.
- Require40 retained drawings, including20rulers, per view; aligned linked ranges; all panels at least100px in each dimension, inside the viewport and unobscured at their centre.

All four cases passed these validity checks, with no page exceptions. All720 frame samples and long tasks are retained. This does not exercise appended new bars, mixed-symbol/timeframe link boundaries, the Scanner route, automated analysis, provider/network behavior or broker execution. Default study counts, interval choices, drawing mixes, production bundling and the current source differ from earlier runs; no before/after improvement is inferred from old results.

## Results

| History / visible views / CPU | Setup through3frames ms | Frame p50 ms | Frame p95 ms | Frame max ms | Ingestion + deferred study CPU p95 ms | Streaming long tasks |
|---|---:|---:|---:|---:|---:|---:|
|10,000 /1 /normal|145.9|16.7|16.8|16.8|1.3|0|
|50,000 /1 /normal|396.3|16.7|33.3|50.1|4.5|0|
|5,000 each /4 /normal|248.7|16.7|16.8|33.5|3.6|0|
|5,000 each /4 /4× CPU|999.0|66.7|83.4|100.0|12.6|180|

The declared frame-spacing proxy budget stays **16.7ms p95**, with only a 0.000001ms floating-point tolerance. All four cases miss it. The two16.8ms results are close to one60Hz refresh interval and affected by timestamp quantization; they are not silently converted to passes. The larger and throttled cases clearly need work. Setup long tasks include96ms,343ms,176ms/50ms, and565ms/341ms respectively. The4× run additionally has180 streaming long tasks. No outliers were removed or runs repeated to obtain passing timings.

The percentile uses sorted sample index floor((n−1)×.95). Setup excludes generating the deterministic input array and loading the benchmark module. CPU totals avoid double-counting refresh work that already ran within the synchronous ingestion/navigation measurement. Frame spacing includes drawing/scheduling but is a requestAnimationFrame proxy, not measured physical paint or proof of sustained60fps. Host-wide quietness is unknown; owned builds/tests had finished. Browser resources and JIT may remain warm between fresh documents. No TradingView/MT5 runtime comparison is claimed.

## Diagnostic profile and next target

A separate single4×/four-view diagnostic run passed the same correctness checks. Its unminified build and CPU sampling are not acceptance timings. The capture includes setup, streaming and post-window validation; costs cannot all be attributed to a specific frame.

In approximately21,321ms of sampled time, the built-in candlestick row-preparation stack accounted for about4,559ms inclusive. Prominent self-time locations include row-lookup binary-search comparisons (~2,379ms), the search loop (~1,965ms), candlestick point construction (~1,101ms) and garbage collection (~1,023ms). These stack/self totals overlap and must not be added. Unattributed program time was also substantial. Text measurement (~73ms inclusive) and all text drawing (~563ms inclusive) were much smaller than row preparation in this capture; there is no evidence that ruler label measurement is the dominant bottleneck.

The retained diagnostic bundle maps the relevant code to `index-CotDAEDm.js`: candle row construction at lines33297–33299 iterates the series rows; `xb` at33400 assembles OHLC geometry and asks the colourer for the row; row lookup uses the binary search at28082/28172–28173. Sampling stacks reach this preparation path during library drawing. This supports targeting repeated full price-row preparation/colour lookup and allocations. It does not prove a proposed fix will improve accepted timing.

Next: evaluate a renderer change or a narrowly pinned, reviewed upstream optimization in an isolated candidate. Preserve complete canonical history, exact visible price/study geometry, autoscale/percent references, time coordinates, inspection, drawings, replay and all seven styles. Do not mutate shared installed dependencies, silently discard offscreen history, weaken the witness, or install held experiments. The existing matrix is a baseline; compare the same workload and retain every candidate result.

The installed library is5.2.0. Its official custom-series API exposes custom rendering, original data, visible range and price-coordinate conversion; the supplied `bars` still contains all items, so a public custom renderer is an avenue to evaluate, not an assumed performance solution. [Official custom-series documentation](https://tradingview.github.io/lightweight-charts/docs/plugins/custom_series), inspected1November2026 alongside installed type declarations. Broader TradingView/MT5 capability and comparative-performance gaps remain explicit.

## Failed preparation and retained evidence

Initial standalone TypeScript checking lacked the React resolution aliases used by the fixture; it failed before the corrected check passed. The first requested output directory was rejected by the build tool's ownership guard; the final build used its approved ignored directory. A browser-runner `.js` file and the benchmark `.ts` file shared a stem, so Vite selected the runner for a dynamic import. All four first attempts at243773a5 failed before measurements with a missing-function error; none counts as a timing sample. The runner was renamed and the module import made explicit in7488069a, then the full declared matrix ran once. Original errors, final output, all raw samples, profiles and summaries are retained.

Reproduce with `scripts/chart-qa/prod-server.mjs` and `scripts/chart-qa/stress-matrix-runner.js`, injecting `STRESS_EXPECTED_COMMIT`. Use a fresh isolated browser and the loopback fixture; the runner blocks external/API/non-GET traffic. Diagnostic runs use the separately marked unminified build. Raw directory: `/Users/areyouok/arx-tier1-release/chart-stress-evidence-20261101`; portable receipts and SHA-256 manifest: `docs/validation/chart-stress-evidence-20261101/manifest.json`. Owned fixture servers and browsers were stopped after measurements.

## Replit ruler completion

Read-only connector inspection confirms the earlier ruler import completed, clean with no newer tracked changes: application `4348fc6ae7cfbbdbdc527163ab18ee06416f47cd`, checkpoint `124f5ccc9ecca97a07f2b27a15f9a85a1df8d23e`, recovery `65581561a7efe21b674685da0dea2b72ed87d87b`, branch `codex/pr103-smart-chart-development-20261031`.

Reported results: frontend2725pass/0fail/11skip; API contracts76; scheduling13; recorder22; guards87/bindings7; typechecks and both builds pass; Scanner ruler browser journey23pass/0fail/0unfinished in one run. These are connector-reported results; raw remote receipts were not independently inspected. Broader handle-drag gestures and the explanatory text were not newly asserted in the browser. Real-owner/provider/device/published-app acceptance, prior picker/calendar/race/storage/replay gaps, fixture503s, large-chunk warnings and earlier navigation failures/partial visibility remain. No new performance measurements were run in Replit. API activation and refreshed-process volume verification remain deferred.

This stress tooling was not imported into Replit. No main merge, publish/deploy, existing database change, worker/API activation, email, funds movement or broker test occurred. The architecture and competitive-performance goal remain incomplete; no percentage is assigned.
