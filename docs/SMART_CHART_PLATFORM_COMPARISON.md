# Smart Chart: TradingView and MetaTrader 5 comparison

Research updated 2026-10-26. Scope: ARX Smart Chart development branch / PR #76,
not a deployment. **Full platform parity and speed superiority remain unproven.**
The checklist below drives implementation; it is not a weighted completion score.
A feature count alone cannot establish professional quality.

## Products and evidence boundaries

TradingView Supercharts is the end-user platform. Advanced Charts is a separate
embeddable library; its public demo is useful for observing interactions but does
not contain the entire Supercharts service. Trading Platform adds broker-facing
integration APIs. The free hosted widget already used by ARX cannot be fed ARX
candles or manipulated as an owned chart. ARX uses Lightweight Charts v5 behind
its own adapter. No approved proprietary Advanced Charts bundle or license grant
was found in this repository. [TradingView products/API](https://www.tradingview.com/charting-library-docs/latest/api/),
[datafeed integration](https://tradingview.com/charting-library-docs/latest/connecting_data/).

The official Advanced Charts demo was inspected read-only in Chromium. Observed
controls include symbol search, compare, intervals, studies/templates, layout
management, snapshot, measure, zoom, drawing persistence mode, object tree, date
presets, go-to, timezone, session, percentage, log and auto scale. This confirms
those controls are present in that demo; it does not benchmark Supercharts or
MT5. Reference: [official demo](https://charting-library.tradingview-widget.com/).

MT5's help documents up to 100 simultaneously open charts. Its marketing material
also uses broader wording, so this comparison uses the explicit help limit.
MT5 documents 21 timeframes, 38 built-in indicators and 44 analytical objects.
ARX's 17 study types include four separately listed moving-average methods;
these counts must not be treated as equivalent catalog coverage.
[MT5 charts](https://www.metatrader5.com/en/terminal/help/charts_analysis/charts),
[technical-analysis catalog](https://www.metatrader5.com/en/trading-platform/technical-analysis).

## Comparison and implementation checklist

Status meanings: **Implemented** means code exists with the listed local evidence;
**Partial** means material capability is missing; **Open** means unavailable in
this Smart Chart implementation. None means production verification is complete.

| Capability | Reference behavior | ARX status and concrete gap |
|---|---|---|
| Candles / OHLC bars / line | All three in MT5 [M1] | Implemented; real-browser style switching retains canonical OHLC and viewport |
| Extended time-based styles | TV area, baseline, hollow, Heikin Ashi and others [T1] | Open |
| Price-based charts | TV Renko, Kagi, point-and-figure, range, line break [T1] | Open; aggregation and nonstandard-price labeling required |
| Footprint / TPO / volume profile | TV specialized chart types [T1] | Open; trustworthy volume/trade data is also required |
| Pan / zoom / return to latest | MT5/TV chart navigation [M1,T2] | Implemented; history anchoring, Latest/Fit/Reset, Home/End |
| Scale modes | TV regular, log, percentage and indexed-to-100 [T2] | Implemented: regular/log/percentage/indexed modes |
| Scale inversion / auto / price-only | TV scale settings [T2] | Partial: automatic price scale and inversion; price-only scaling settings remain open |
| Date jump / range presets | Observed in official demo; TV navigation [T2] | Implemented: UTC go-to and 1D/5D/1M/3M/1Y loaded-history ranges; unavailable history is explicitly reported |
| Timezone / session / countdown | TV chart settings [T2] | Partial: UTC inspection only; no timezone/session selection |
| Custom intervals | MT5 21 presets; TV interval controls [M1,T3] | Partial: ARX contract-supported presets; no claim of all 21 |
| OHLC inspection | MT5 crosshair/data window [M1] | Implemented, canonical values also for line style |
| Study-value data window | MT5 indicator values in data window [M1] | Implemented in this branch; inspect the same timestamp across price/oscillator panes |
| Study catalog | MT5 38; Advanced Charts 100+ [M2,T4] | Partial: 17 OHLC-based types, searchable library |
| Moving-average methods | MT5 SMA, EMA, SMMA, LWMA [M3] | Implemented; explicit SMA seeds and tested weights |
| Multiple copies of a study | Configurable study workspaces [T3,T4] | Implemented; stable IDs, independent settings, up to 12 active instances |
| Applied-price sources | MT5 price/indicator inputs [M4] | Partial: eight OHLC sources; no study-on-study chaining |
| MACD convention | MT5 uses SMA signal [M5] | Implemented signal-method selection; EMA remains legacy default; seed and histogram presentation differences disclosed |
| Oscillator panes | MT5 separate indicator windows [M4] | Implemented; resizable panes and reference levels |
| Indicator custom scripting | Pine/MQL5/platform APIs [T3,T4,M4] | Open; no user script execution sandbox |
| Volume studies / VWAP | MT5 distinguishes tick and actual traded volume [M4] | Open; volume semantics must be preserved end to end |
| User levels / trend / Fibonacci | TV drawing families [T5] | Implemented: seven tools, real candle anchors, reversible edits |
| Pointer/touch placement | Drawing interaction [T5] | Implemented; rapid two-anchor mouse/touch tested |
| Drag handles / whole object | MT5 graphical objects / drawing interaction [M6,T5] | Implemented: selection, whole-object/anchor mouse and touch drag; one undo entry, cancel rollback |
| Snap / lock / styling | MT5 object settings [M6] | Implemented: OHLC magnetic anchors, geometry locks, width/dash/color and exact prices; no object groups |
| Rays / channels / geometry / text | TV/MT5 drawing families [T5,M2] | Partial: rays, extended/vertical lines and rectangles implemented; channels, text and broader tools remain |
| Gann / Elliott / pitchfork / patterns | TV/MT5 analytical families [T5,M2] | Open |
| Object management | TV object tree / MT5 object list [T5,M6] | Partial: list, hide-all, delete, undo/redo; no groups/search/reorder |
| Multi-chart workspace | TV layouts; MT5 chart profiles [T6,M7] | Partial: one/two/four responsive charts, independent instruments/intervals/settings; no cloud profiles |
| Crosshair / time-range synchronization | TV selectable chart synchronization [T6] | Implemented within workspace: optional UTC links, own-instrument candle close, clipped/unavailable loaded-history disclosure |
| Different-symbol comparison | TV compare/overlay [T3] | Partial: independent comparison panes implemented; overlaid/normalized comparison series remain open |
| Drawing synchronization | TV within/across layouts [T6] | Partial: browser-local matching symbol/timeframe sync; no account cloud sync |
| Templates / profiles | TV layouts; MT5 templates/profiles [T7,M7] | Partial: autosave plus one local template; named/importable/account workspaces open |
| Bar replay | TV select start, seek, step, speed, multi-chart replay [T8] | Open; must isolate historical analysis from live signals/order context |
| Strategy testing | Pine strategy tester / MQL5 tester ecosystem [T3,M2] | Open in Smart Chart; other ARX backtesting surfaces are not equivalent evidence |
| Server alerts | TV price, study, strategy and drawing alerts [T9] | Open for native chart drawings/studies; a browser timer would not be equivalent |
| PNG export | MT5 Save As Picture [M6] | Implemented; symbol, interval, time, feed status and study settings included |
| Workspace sharing / cloud recovery | TV saved layouts [T7] | Open; local storage is not cloud durability |
| Data freshness / gaps / backfill | Product behavior depends on datafeed [T10,M1] | Partial: ARX explicit status/watchdog/history handling; production coverage still unverified |
| Quote and execution-price identity | Feed/broker-specific, not a renderer feature [T10] | Open operational validation; no claim that independent vendors' prices must match |
| Mobile and accessibility | Product-specific interaction quality | Partial: responsive/touch/fullscreen/focus checks; no comprehensive screen-reader or every-device certification |
| Sustained rendering performance | Requires equivalent controlled workloads | Partial: ARX-only synthetic CPU and visible-frame tests; no fair TV/MT5 speed comparison |

### Reference key

- [T1 — TradingView chart types](https://www.tradingview.com/support/solutions/43000703407-chart-types-available-on-tradingview/)
- [T2 — Chart configuration](https://www.tradingview.com/support/solutions/43000748166-how-to-configure-your-supercharts/)
- [T3 — Supercharts overview](https://www.tradingview.com/support/solutions/43000746464-getting-started-with-supercharts/)
- [T4 — Advanced Charts custom indicators](https://www.tradingview.com/charting-library-docs/latest/custom_studies/)
- [T5 — Drawing-tool families](https://www.tradingview.com/support/solutions/43000703396-drawing-tools-available-on-tradingview/)
- [T6 — Multi-chart layouts](https://www.tradingview.com/support/solutions/43000629990-leveraging-multi-chart-layouts-in-your-analysis/)
- [T7 — Layouts, charts, drawings and indicators](https://www.tradingview.com/support/solutions/43000692404-layouts-charts-drawings-indicators-and-their-interaction/)
- [T8 — Bar Replay](https://www.tradingview.com/support/solutions/43000712747-bar-replay-how-and-why-to-test-a-strategy-in-the-past/)
- [T9 — Alerts](https://www.tradingview.com/support/solutions/43000520149-introduction-to-tradingview-alerts/)
- [T10 — Datafeed API integration](https://tradingview.com/charting-library-docs/latest/connecting_data/)
- [M1 — MT5 price charts](https://www.metatrader5.com/en/terminal/help/charts_analysis/charts)
- [M2 — Technical analysis](https://www.metatrader5.com/en/trading-platform/technical-analysis)
- [M3 — Moving-average formulas](https://www.metatrader5.com/en/terminal/help/indicators/trend_indicators/ma)
- [M4 — Technical indicators](https://www.metatrader5.com/en/terminal/help/charts_analysis/indicators)
- [M5 — MACD formula](https://www.metatrader5.com/en/terminal/help/indicators/oscillators/macd)
- [M6 — Chart management](https://www.metatrader5.com/en/terminal/help/charts_advanced/charts_manage)
- [M7 — Templates and profiles](https://www.metatrader5.com/en/terminal/help/charts_advanced/templates_profiles)

## Implementation order and proof required

1. **Study foundation:** independently checked math, repeated studies, applied
   prices, named conventions and pane inspection. Implemented in the current
   development changes; browser and regression results recorded separately.
2. **Drawing interaction:** shared layer, selection/drag, OHLC snapping and locks
   implemented with reversible mouse/touch edits. Expand channels, text,
   future-space annotations and keyboard editing.
3. **Professional navigation/workspaces:** scale modes, go-to/ranges, multiple
   symbols, linked crosshair/time range, named templates/import/export.
4. **Replay:** immutable history snapshot, no lookahead, deterministic stepping,
   speed/seek; clearly distinguish all historical prices and disable any
   execution-adjacent inference from replay state.
5. **Measured performance:** visible chart under sustained streaming, 10k/50k
   history, many studies/drawings, pan/zoom and memory lifecycle; repeat on slow
   CPU/mobile. Preserve identical data/workload/environment for comparisons.
6. **Long-tail capability:** volume provenance, custom study sandbox, server-side
   alert delivery, specialized aggregation, cloud workspaces. A licensed advanced
   engine may reduce renderer work but does not supply ARX data truth, alerts,
   execution safety, a Pine ecosystem, or production acceptance automatically.

The native improvements do not automatically upgrade Scanner Chart's separate
renderer. A separate scanner workstream was requested by the owner and must be
assessed and tested independently. Self-trading reliability is also a separate
workstream; chart quality is not evidence of trading profitability or readiness.

## Performance reporting rules

The earlier five-study fixture measured synchronous adapter work over 5,000
bars, not paint latency. The new visible stress harness uses 10,000 bars, 12
studies, 40 Fibonacci drawings and 1,800 paced updates, recording setup, burst
CPU, frame intervals and long tasks. Frame intervals reflect browser scheduling;
they are not direct paint-completion timestamps. Public TradingView demo data
and a broker-fed MT5 terminal are not equal-input control groups. Do not label
ARX faster until an appropriately controlled comparison supports that claim.

See [calculation conventions](SMART_CHART_STUDY_CONVENTIONS.md) and
[acceptance evidence](SMART_CHART_ACCEPTANCE.md). The Tier 1 architecture gate
score is independent of this feature checklist and must not be reused as a
Smart Chart completion percentage.
