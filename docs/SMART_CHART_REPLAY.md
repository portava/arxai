# Smart Chart historical replay

This change adds a single-chart, in-memory historical replay reached from “Replay loaded bars” on a source-identified native chart. It is a diagnostic chart workflow, not a backtest, execution simulator, profitability claim, or verified historical account record.

## Evidence and isolation

The snapshot contains at most 5,000 explicitly closed candles from the current response window, the observed opaque source identity, market/timeframe, capture time, and validated chart preferences. Separately paginated older history is excluded. Missing identity, contradictory closed flags, mixed market/source/timeframe, invalid OHLC, future closed bars, duplicates, overlap and mismatched evidence all refuse capture. One explicitly forming final tip is omitted. Gaps are recorded without inventing bars or assuming a session calendar. MT5 per-candle account-era provenance remains unverified and is labelled accordingly.

The authenticated `/chart-replay` route sits outside the live application layout. Entering it unmounts live prices, Truth, positions, tickets, and current derived overlays. Its immutable snapshot belongs to the current user; switching users immediately masks it and destroys the old session. It is not saved in storage or recoverable by reloading the page. Exiting or navigating back crosses a document boundary to request current data before displaying live panels again. Return locations are parsed and restricted to the current origin.

The player supports previous/next, start, a loaded-window slider, a UTC close-time seek, keyboard stepping, pause/play and 0.5–8 bars per second. Hidden tabs pause and delayed timers do not catch up in a burst. Drawings are isolated to the private replay session. Every study receives only the revealed prefix, including after backwards and arbitrary seeks; future values are not precomputed and cosmetically hidden.

## Rendering and validation

The installed Lightweight Charts 5.2 API supports removing an unchanged tail with `pop`. Small rewinds use it; large additions use one `setData` call instead of thousands of incremental updates. Study calculators retain only an unchanged causal prefix, and an earlier queued stream correction keeps its dirty boundary. Price/range changes are grouped so studies render against the final viewport. Ordinary live/panned view behavior remains covered by regression tests. Replay follows its cursor without the library's animated scroll.

The browser witness is emitted after actual adapter data/study installation, including the observed source, count and last candle value. Canvas existence is not treated as completion. Measurements distinguish installation, the next display opportunity, and a second-animation-frame feedback proxy; none proves physical display scanout or sustained 60 frames per second.

Tests cover all 17 study kinds against full recomputation after backwards/forwards seeks, revised prefixes, prepend, empty/one-bar input and style changes. Ownership, invalid capture, forming tips, playback, source changes, private drawings and fresh exit are also covered. The offline browser fixture uses 5,000 constructed candles and 12 actual studies, with all API calls intercepted and writes/external connections blocked. This is a stress workload above the ordinary 300-bar response, not a provider throughput claim.

## Measured checkpoint

Apple M4 Pro (14 cores, 24 GiB), macOS 26.6.2, Headless Chrome 155, 1440×1100 viewport; 5,000 constructed candles and 12 actual studies. Four alternating build trials used unchanged formulas / optimized formulas / optimized formulas / unchanged formulas, with all other source held identical and peer heavy jobs paused. All 320 measured market/source/count/last-candle witnesses matched and no page errors occurred. The optimized formulas preserve exact outputs in 408 old/new calculator comparisons.

For the two retained-candidate trials at 4× CPU throttling:

| Action and metric | Trial 1 median / p95 / p99 (ms) | Trial 2 median / p95 / p99 (ms) |
| --- | --- | --- |
| Previous/next: data and studies installed | 44.3 / 47.1 / 51.0 | 46.6 / 48.8 / 48.9 |
| Previous/next: second-frame feedback | 69.8 / 72.5 / 80.3 | 71.7 / 73.5 / 74.9 |
| First→5,000th bar: data and studies installed | 90.5 / 93.6 / 93.6 | 91.9 / 94.6 / 94.6 |
| First→5,000th bar: next display opportunity | 124.3 / 130.2 / 130.2 | 127.7 / 135.3 / 135.3 |
| First→5,000th bar: second-frame feedback | 131.8 / 136.8 / 136.8 | 135.5 / 142.3 / 142.3 |

The first→last direction has 10 samples per trial, so nearest-rank p95 and p99 equal the maximum; ordinary stepping has 20 samples. Conventional medians average the two central values. Earlier external summaries used nearest-rank p50 under the name median; the original evidence remains and `all-trials-reanalysis.json` corrects this and separates the two seek directions. No failed trial was discarded.

The final unchanged-formula trial installed a full forward seek at p95 101.7 ms versus 93.6/94.6 ms for the optimized formulas. The first unchanged-formula trial was slower again and is retained. This supports a modest calculation benefit, not a reliable end-to-end 100 ms result or competitor advantage. Heavy-seek feedback remains **FAIL**; observed long tasks and frame intervals also prevent a sustained-60-fps claim.

Validation: 1,401 frontend tests passed with 9 optional live skips; all four workspace typechecks passed; all 87 guards plus 7 structural assertions passed; 177 focused replay/chart tests passed. The final production bundle contains no development React markers. Screenshots show actual candles/studies on desktop and mobile, with no horizontal overflow. The actual offline browser also verifies fresh data requests after exit and unavailable replay after reload.

## Competitor criteria and remaining work

TradingView documents historical stepping, playback and chart-based review in [Bar Replay](https://www.tradingview.com/support/solutions/43000712747-bar-replay-how-and-why-to-test-a-strategy-in-the-past/). MT5 documents broader [visual strategy testing](https://www.metatrader5.com/en/terminal/help/algotrading/visualization) and [testing configuration](https://www.metatrader5.com/en/terminal/help/algotrading/testing), including execution simulation capabilities this change does not provide. The rendering approach follows the installed library's [series API](https://tradingview.github.io/lightweight-charts/docs/api/interfaces/ISeriesApi) and [incremental update example](https://tradingview.github.io/lightweight-charts/tutorials/demos/realtime-updates).

Acceptance requires exact causal-prefix results, source/owner isolation, meaningful completion witnesses and local feedback p95 below 100 ms under the documented workload. Heavy full-window seeks under CPU throttling currently miss that target; failed and intermediate trials remain in the external evidence package. Single-bar stepping improved substantially over the initial implementation, but no equivalent TradingView/MT5 runtime benchmark exists and parity is unproven. Sustained 60 fps is also unproven.

Multi-chart synchronization during replay, saved/cloud sessions, deeper attested history, historical order simulation, costs/slippage, further interaction latency and the wider chart parity checklist remain unfinished. They are not exclusions from the owner's target.

Local reproduction and every raw timing sample, screenshot and validation log are retained under `arx-tier1-release/smart-chart-replay-20261026`; the final receipt records the precise candidate, hardware, build identity and acceptance status.
