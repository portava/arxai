# Scanner initial mount — held toolbar-phase experiment

**HELD — do not import this application change.** Best accepted base remains `6345956d` (render isolation / precise expiry), not this branch. ARX is not complete or release-green.

## Diagnosis on accepted source

Profiling fixture `20df44b6983fa128` executes clean `6345956d4ada4171cbb40d9c97c20127e5e1b361` using React 19.1.0's special profiling renderer on localhost port4299. Two first-route observations at 4× CPU slowdown:

| Initial Scanner commit | Desktop | Mobile viewport |
|---|---:|---:|
| Root render duration |39.2 ms|38.6 ms|
| Root layout effects |34.6 ms|32.0 ms|
| Commit observed after click |112.0 ms|84.4 ms|

Nested fiber durations and later bailout values must not be summed or treated as fresh work. The observer adds overhead. There were19/22 Scanner commits over the captured visits; this is not a count of fresh chart renders.

A separate CPU-sampling visit identifies44.6ms of sampled self time in the toolbar's layout-effect callback at `getComputedStyle` / `clientWidth`. It also samples canvas/resize work. That run intentionally waited for the navigation link before enabling the profiler, adding dwell, and is **not** immediate-click latency acceptance. Browser `(program)` time is not attributed to an application function. The sample locates a candidate synchronous-layout cost; it does not prove eliminating that callback eliminates the same total work.

Previously recorded ordinary-runtime candle network receipts on the accepted source arrive about4–45ms after the click while source-correct visible completion remains263–309ms. Receipt is not JSON parsing, cache readiness or rendering completion. This supports focusing on client work; it does not establish the cause of the real hosted app's delay.

## Experiment and exact source

Candidate `293483c5` changes only the toolbar width measurement from the layout phase to a passive effect, after parent engine setup. It retains the measurement, ResizeObserver, initial state and focus rules. It does not reinstall the earlier held ResizeObserver-only/initially-compact or containment experiments. Ordinary production fixture: `47d80caaad17636d`.

Baseline application: `8941184919f01a02df4a238185116cd6ca0db1cf`, fixture `86bed2ee966637d2`, application-identical to accepted checkpoint `6345956d`.

Candidate correctness checks:2,577 frontend tests pass/11 skipped/0 failed; dashboard typecheck/build pass;87 guards and7 binding checks pass. No root/backend checks were rerun for the one-effect frontend experiment.

Early-frame diagnostic:8 observed frames each at390×844 and1440×1100 show the correct folded/expanded state. Geometry observation can change scheduling and is not physical-paint proof. Browser resize journeys preserve focus from a disappearing control to Tools, then Pan on widening; an opened Tools panel retains focus; Escape closes it correctly. Same exact candles and engine, no horizontal overflow or page exception. Screenshot was visually inspected.

## Ordinary-runtime acceptance: rejected

The strict runner is unchanged: trusted click within150ms of first actionable link, exact canonical and displayed OHLC/context/feed and real engine identity on two frames, plus100×100 unobscured plot. Forty attempts retained. All have valid source/visibility witnesses; timing failures remain failures.

| Source / CPU | Desktop median / max / ≤100ms | Mobile median / max / ≤100ms |
|---|---|---|
| Baseline normal |39.7 /45.6ms /5 of5|39.9 /94.3ms /5 of5|
| Candidate normal |40.6 /111.4ms /4 of5|82.7 /100.4ms /4 of5|
| Baseline4× |317.7 /335.2ms /0 of5|290.4 /296.2ms /0 of5|
| Candidate4× |319.3 /322.3ms /0 of5|266.1 /289.3ms /0 of5|

The slowed mobile observation improves, but desktop median does not, and normal CPU loses two budget passes. At n5, nearest-rank p95/p99 equal the maximum and are weak tail estimates. No reliable overall gain is established; the experiment stays isolated. Moving forced layout work alone is insufficient evidence of eliminating it.

Candidate slowed→normal was followed by baseline normal→slowed, fresh isolated browsers per source. No owned build/test jobs during timing; other host load uncontrolled. Synthetic200-bar historical data, fixed80ms candle response, ordinary Vite fixture, desktop1440×1100 and resized390×844; no real provider, active AI, physical touch or matched competitor timing. Two rendering opportunities are not hardware paint. All owned browsers and servers were closed.

## Replit update outcome, separate source

The earlier control-dock development import completed. Read-only inspection reports clean checkpoint `58a338b43184c0a9f1240570c05b2e97c850cc0e`, application `d74197cf9f7affbbc5390de53bdc38e2c27ac063`, recovery `3b7a044ed4c2432682a0bd5909c8551d96abb7a9`.

Recorded remote checks:2,560 frontend pass/11 skip/0 fail;13 server scheduling;22 recorder/navigation/disclosure;87 guards;7 bindings; types, builds, fixture and preservation pass. Primary/comparison functional journeys pass.

Remote performance is NOT GREEN: slowed zoom0/10 under100ms, median723.8/max876.5ms; normal zoom10/10 pass. Normal navigation0/10 valid due late clicks; slowed navigation0/10 valid due8s locator timeouts, with no trusted clicks/completion timings. Missing values remain null, not zero. A supplemental wrapper assertion failed while the supplied nested-chart assertion passed. Helper/setup/Git-author/locking/null-rounding errors, prior slowed-touch failures and earlier navigation failures remain retained. These are remote reported receipts, not independently rerun here or interchangeable with local timings.

Next: use accepted source6345956d for any selective render-isolation import, preserve that remote checkpoint and compare before/after on exact combined source under matched conditions. **Exclude293483c5 and all other held experiments.** Do not claim the dock, first load or slow touch is performance-complete.

## Research and evidence

React documents that layout effects block repaint: [useLayoutEffect](https://react.dev/reference/react/useLayoutEffect). That explains why the measurement is a candidate, not why this experiment must be faster. MT5 documents local history reuse and downloading missing bars: [chart construction](https://www.metatrader5.com/en/terminal/help/charts_analysis/charts). ARX's in-memory prefetch is not equivalent to MT5's persistent history behavior; that comparison gap remains. TradingView's browser-load caveats and all previously recorded feature/performance gaps remain applicable. No competitor timings were invented.

Manifest, exact per-attempt summaries, portable runners and raw-file hashes: `docs/validation/scanner-initial-mount-20261031/manifest.json`. Raw files: `/Users/areyouok/arx-tier1-release/scanner-initial-mount-20261031`. Diagnostic profiling and ordinary acceptance are separate. No main merge, publishing/deployment, existing database migration, workers, emails, trading enablement or broker/live/demo tests occurred.
