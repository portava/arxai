# Manual-equivalent study requests and observations — 1 November 2026

Application `35fd2aa28a66bd1309559a757468de6af9f213b2`, ordinary actual Scanner build `7e42e9536aee27f0`, extends checkpoint `489ed90b`. This reuses the existing study assistant, settings validator, calculators, renderer and selected-chart ownership. No new chart, remote model service or trading path was introduced.

## Missing controls connected

The assistant accepts explicit MACD fast/slow/signal edits, an atomic periods tuple, and SMA/EMA signal method; Bollinger deviation/multiplier is editable too. For example: “set MACD periods to 8, 21, 5”, “set MACD signal method to SMA” and “set Bollinger Bands deviation to 2.5”. Ordinary “show me” requests now work for existing studies, including the Estimated Volume Profile route. Existing colors, applied prices, channel styles and visibility survive setting edits. Repeated manual instances remain ambiguous and require explicit manual selection; they are never guessed.

Full proposed settings pass the same manual validator before rendering or saving. Invalid periods, slow <= fast, out-of-range deviations, extra assets and compound instructions refuse without changes. A complete tuple is applied atomically, so a valid new fast period may exceed the old slow period without a partial invalid edit. Renderer failure retains the existing uncertainty/restore behavior.

MACD explanations compare the actual named MACD and signal values and locate MACD against zero. They do not call a single observation a crossover, divergence or forecast. Bollinger explanations compare the source candle close with the actual upper/lower lines and disclose finite band width in source price units. Missing or inverted bands remain unavailable; zero-width bands are explicit. RSI and moving-average descriptions now read the named channel rather than assuming the first returned value belongs to the requested tool. Source timestamps, forming-bar caveats and selected-source withdrawal remain intact.

## Exact-source evidence

- Frontend: 3,390 pass, 11 skipped, zero failures; 211 files pass and one skipped.
- Focused settings, comparison, profile, workspace and pane checks: 177/177 across five files.
- Before implementation: 18 new assertions fail, 80 pass. Raw `before.log` is retained. Candidate failures were corrected in the implementation, not by loosening the assertions.
- Dashboard typecheck, ordinary immutable build, 87 guards and seven binding assertions pass.
- Actual Scanner browser: 31/31 desktop and 31/31 at 390px. The tests independently calculate SMA/EMA-seeded MACD and population-deviation Bollinger values and compare every rendered channel over the loaded observations. Actual manual inputs and assistant edits produce identical configurations and full series. Hidden channels remain hidden after settings changes; invalid tuples, source loss and reload persistence pass. All network traffic is intercepted, writes blocked, with no model or broker call.
- Desktop and phone canvas screenshots inspected. Phone MACD last-value labels still crowd the pane; lack of page overflow does not close that visual gap.

Root reviewed the changes. Both helper agents remain unavailable due to usage limits, so no final independent review is claimed. These are synthetic-source, emulated-viewport checks, not real-provider or physical-device qualification. Navigation was not remeasured: prior source `831e958d` retains its normal 10/10 and 4x CPU 0/10 under-100ms results. They are not reassigned to this source.

## Verified comparison and remaining work

TradingView documents separate fast, slow and signal lengths, source, and average types for both the oscillator and signal. ARX still uses EMA for its fast/slow calculation; exposing the existing SMA/EMA signal selector does not supply TradingView's oscillator-type option or establish output parity. [Official MACD reference](https://www.tradingview.com/support/solutions/43000502344-moving-average-convergence-divergence-macd-indicator/)

MT5 documents Bollinger's middle SMA and upper/lower bands based on a configurable multiple of population standard deviation. ARX's existing calculator follows that formula family; this increment connects existing settings and explains their rendered output. Matched-platform source/seed/session comparisons remain open. [Official Bollinger reference](https://www.metatrader5.com/en/terminal/help/indicators/trend_indicators/bb)

General natural-language control, the remaining automatic drawing families, chart simplification/restore, capital/sizing/equity/benchmark, physical-device clarity and the slower-device speed target remain unfinished. The entry-confidence policy and trading gates are unchanged. Replit's previous `0e95a162` source-only import is still busy at the last check; this newer source is not claimed imported, running or published.

Raw evidence: `/Users/areyouok/arx-tier1-release/chart-study-explanations-20261101/`. Counts and limits: `docs/development-sync/CHART_STUDY_EXPLANATIONS_VALIDATION_2026_11_01.json`. Nothing merged to main, deployed, restarted, migrated or broker-tested.
