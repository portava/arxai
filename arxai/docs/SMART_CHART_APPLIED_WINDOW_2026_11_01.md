# Selected chart and complete applied window — 1 November 2026

Application `c9c74fcebfce2dd33039fe6f5804575e99d98232` extends checkpoint1d197960. The support/resistance feature is unfinished and isolated on `codex/chart-support-resistance-20261101` at `af64be441419c713da36f45d48f8eafbd27257f3`; it is not included in this application or proposed Replit import.

## Implemented fixes

Fibonacci explanations now identify the selected chart, rather than always claiming the primary chart. Both preview and archived editable drawing explanations use the same correction. Two existing regression assertions fail before the change;18pane/description checks pass afterward.

The shared automatic-drawing source-window qualifier rejects a displayed window that silently omits an original closed observation. The prior code checked every displayed candle against its source but did not check for omitted interior source candles. The regression fails against the earlier implementation and passes now. Fibonacci reuses this single validator. Causal/replay, overlap, source/OHLC, streaming-tail and supported-timeframe checks remain in place; no detector or chart owner is duplicated.

Exact combined application:41focused tests, dashboard typecheck, ordinary actual Scanner fixture buildbb79854a6d7e1b41,87guards and7binding assertions pass. Actual Scanner browser9/9 assertions pass: preview and kept geometry retain source-clock caveats and identify selected ownership, with no external/model/broker calls. Prior3332frontend and36research browser results remain tied tof85d1c03; they are not reassigned to this later source.

## Interrupted support/resistance work

Both helper agents stopped with usage-limit errors. The root agent preserved their shared-validator extraction, completed its regression, and staged deterministic support/resistance proposals using the existing causal pivot detector. The isolated proposal/Fibonacci tests pass20/20. An initial synthetic fixture omitted completion flags and failed4cases; that failure is retained, and only the fixture metadata was corrected. No independent final review of this unfinished feature is claimed.

The proposal selects the most recent strict two-neighbor pivot low below the last closed price and pivot high above it, recording separate anchor and confirmation times. It counts observed later closes beyond each level without claiming untouched levels or retests. Missing two-sided evidence refuses instead of fabricating levels. This is currently a calculation foundation only: natural-language routing, actual drawing preview, editable saved provenance, visibility/removal controls and browser acceptance are still required before the owner requirement is satisfied. The next implementation must extend the existing Workbench renderer, history and selected-pane ownership.

## Verified comparison scope

TradingView documents swing pivots using neighboring highs/lows. Its separate Standard Pivot Points tool uses higher-timeframe OHLC formulas, with several formula families and session/data-source choices. ARX's staged two-neighbor swing candidates are not that Standard indicator, and neither its plateau handling nor exact output is claimed equivalent. [Pivot High/Low](https://www.tradingview.com/support/solutions/43000589195-pivot-points-high-low/) · [Standard Pivot Points](https://www.tradingview.com/support/solutions/43000521824-pivot-points-standard/)

MT5 documents horizontal lines with an editable price value, useful as support/resistance annotations. That supports the existing ARX horizontal-object reuse direction, not a claim that MT5 supplies the same automated discovery or AI commands. [MT5 horizontal line](https://www.metatrader5.com/en/terminal/help/objects/lines/hor_line)

Full zone discovery, adjustable discovery methods, broader market-structure/trendline commands, historical capital/sizing/equity/benchmark and the slower-device navigation target remain open. No parity, architecture completion or profitable-trade claim follows.

Raw logs: `/Users/areyouok/arx-tier1-release/chart-support-resistance-20261101/`. Replit's completed earlierb302 import is recorded separately: combined4c36cd5a/checkpointef8ec9c8;3317frontendpass/11skip,521targetedbackend,87guards,7bindings,275desktop+35phone browser assertions pass. Runtime preserved; earlier focus/navigation/zoom and real-provider acceptance remain open. Nothing merged to main, deployed, activated, migrated, traded or broker-tested.
