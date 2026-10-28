# Smart Chart: TradingView and MetaTrader 5 comparison

Research updated 2026-10-27. Scope: ARX Smart Chart development branch / PR #76,
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

ARX timeframe exposure (Custom intervals row): the chart API contract accepts 21
codes (`lib/api-spec/openapi.yaml:2154`;
`artifacts/api-server/src/lib/data/chart/timeframes.ts:9-12`). The Smart Chart
offers seven. Under `artifacts/trading-dashboard/src/`, the picker renders
`TIMEFRAMES` (`components/charts/ARXNativeChart.tsx:109-117,1113`), layout views
use `CHART_INTERVALS` (`lib/chart-engine/chartLayout.ts:4`), page state accepts
the same seven (`pages/live-chart.tsx:67`), and unrecognised saved values fall
back to M15 (`ARXNativeChart.tsx:120,128`). Replay inherits the chart timeframe
and refuses any other interval with "Replay needs a source-identified candle
window" (`lib/chart-engine/chartReplay.ts:7,32-39`). Scanner Chart's separate
labels, such as 1W, map onto these seven for overlays
(`components/scanner/ScannerChartPanel.tsx:111-123`) and are outside that row.

## Comparison and implementation checklist

Status meanings: **Implemented** means code exists with the listed local evidence;
**Partial** means material capability is missing; **Open** means unavailable in
this Smart Chart implementation. None means production verification is complete.

| Capability | Reference behavior | ARX status and concrete gap |
|---|---|---|
| Candles / OHLC bars / line | All three in MT5 [M1] | Implemented; real-browser style switching retains canonical OHLC and viewport |
| Extended time-based styles | TV area, baseline, hollow, Heikin Ashi and others [T1] | Partial (unit-tested; real-browser evidence pending): close area, close baseline, Heikin Ashi and hollow candles added to the style picker, with canonical studies, drawings, price lines and Last line; legend keeps canonical OHLC and adds a labelled HA suffix in Heikin Ashi. Differences from the cited TV help pages: the baseline base is the first loaded close, not TV's chart-height percentage [T13]; the HA first-bar seed (O+C)/2 is not stated by TV [T12]; hollow equal-price and first-bar handling are ARX conventions [T11]. Real-browser switching (`workbench-acceptance.js`, styles:7) and the four new style-switch latency groups are not yet run. Other [T1] types remain open, for example line with markers, step line, HLC area, high-low, column, and volume candles (which also need trustworthy volume) |
| Price-based charts | TV Renko, Kagi, point-and-figure, range, line break [T1] | Open; aggregation and nonstandard-price labeling required |
| Footprint / TPO / volume profile | TV specialized chart types [T1] | Open; trustworthy volume/trade data is also required |
| Pan / zoom / return to latest | MT5/TV chart navigation [M1,T2] | Implemented; history anchoring, Latest/Fit/Reset, Home/End |
| Scale modes | TV regular, log, percentage and indexed-to-100 [T2] | Implemented: regular/log/percentage/indexed modes |
| Scale inversion / auto / price-only | TV scale settings [T2] | Partial: automatic price scale and inversion; price-only scaling settings remain open |
| Date jump / range presets | Observed in official demo; TV navigation [T2] | Implemented: go-to in the chart's selected display time zone (UTC by default and on daily bars; clock-change gap times are rejected, repeated times use the earlier occurrence) and 1D/5D/1M/3M/1Y loaded-history ranges; unavailable history is explicitly reported |
| Timezone / session / countdown | TV chart settings [T2] | Partial: display timezone selectable; session shading and countdown remain open. Per chart view, not saved in templates; a new comparison view starts from the primary view's choice. UTC (default), browser local and 8 named IANA zones relabel the time axis, crosshair, candle legend, object list, go-to, replay seek and labels, chart reader and PNG capture time, each with its zone abbreviation. Display only: candle times, drawings, links and data requests stay UTC seconds. Kept in UTC: link events, the deep-history request cursor, the market-closed last-quote banner, the embedded TradingView widget, machine-readable time attributes, and every surface on daily (D1) charts, whose bars keep UTC day labels. Axis limitation: lightweight-charts 5.2.0 places day, month and year ticks at UTC boundaries, so in other zones those ticks show a local date or time rather than falling on local midnight. No selectable zone represents broker server time. Evidence: artifacts/trading-dashboard/src/lib/chart-engine/chartTimeZone.ts |
| Custom intervals | MT5 21 presets; TV interval controls [M1,T3] | Partial: Smart Chart exposes 7 of the 21 contract timeframes (M1, M5, M15, M30, H1, H4, D1); the other 14 (M2, M3, M4, M6, M10, M12, M20, H2, H3, H6, H8, H12, W1, MN1) are accepted by the API but not offered by the chart picker, layout views or page state, unrecognised saved values fall back to M15, and replay rejects them; no user-defined intervals. File references in the timeframe note above |
| OHLC inspection | MT5 crosshair/data window [M1] | Implemented, canonical values also for line style; area, baseline, Heikin Ashi (HA values labelled separately after the canonical OHLC) and hollow are unit-tested, real-browser check pending |
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
| Crosshair / time-range synchronization | TV selectable chart synchronization [T6] | Implemented within workspace: optional links on UTC seconds (each view labels times in its own display zone), own-instrument candle close, clipped/unavailable loaded-history disclosure |
| Different-symbol comparison | TV compare/overlay [T3] | Partial: independent comparison panes implemented; overlaid/normalized comparison series remain open |
| Drawing synchronization | TV within/across layouts [T6] | Partial: browser-local matching symbol/timeframe sync; no account cloud sync |
| Templates / profiles | TV layouts; MT5 templates/profiles [T7,M7] | Partial: autosave plus one local template; named/importable/account workspaces open |
| Bar replay | TV select start, seek, step, speed, multi-chart replay [T8]; no equivalent MT5 bar-replay criterion in this row (MT5 visual strategy tester [M8] is documentation, not measurement) | Partial: single-chart replay of up to 5,000 closed bars from the loaded response window ("Replay loaded bars", `components/charts/ARXNativeChart.tsx:1112`) with Start, Previous/Next, Play/Pause at 0.5–8 bars/s, position slider, close-time seek in the selected display zone (UTC by default) and arrow/Space keys; studies receive only the revealed prefix; private `/chart-replay` route outside the live layout unmounts prices, Truth, positions and tickets. View-only; not a backtest or fill simulation. Latency (Apple M4 Pro, 4× CPU throttle, 5,000 constructed bars, 12 studies, 37-name reader): step second-rAF p95 36.9 ms; full forward-seek second-rAF p95 105.7 ms, **FAIL** against 100 ms; no competitor comparison. Remaining: multi-chart replay, saved sessions, deeper attested history (older paginated history excluded), order simulation, costs/slippage. Evidence under `artifacts/trading-dashboard/src/`: `lib/chart-engine/chartReplay.ts`, `components/chart-replay/ChartReplayPlayer.tsx`, `components/chart-replay/ChartReplayBoundary.tsx`; [replay](SMART_CHART_REPLAY.md), [completion performance](SMART_CHART_REPLAY_COMPLETION_PERFORMANCE.md) |
| Strategy testing | Pine strategy tester / MQL5 tester ecosystem [T3,M2] | Open in Smart Chart; other ARX backtesting surfaces are not equivalent evidence |
| Server alerts | TV price, study, strategy and drawing alerts [T9] | Open for native chart drawings/studies; a browser timer would not be equivalent |
| PNG export | MT5 Save As Picture [M6] | Implemented; symbol, interval, capture time (selected display zone with abbreviation, plus UTC ISO when not UTC), feed status and study settings included |
| Workspace sharing / cloud recovery | TV saved layouts [T7] | Open; local storage is not cloud durability |
| Data freshness / gaps / backfill | Product behavior depends on datafeed [T10,M1] | Partial: ARX explicit status/watchdog/history handling; production coverage still unverified |
| Quote and execution-price identity | Feed/broker-specific, not a renderer feature [T10] | Open operational validation; no claim that independent vendors' prices must match |
| Mobile and accessibility | Product-specific interaction quality | Partial: responsive/touch/fullscreen/focus checks; no comprehensive screen-reader or every-device certification |
| Sustained rendering performance | Requires equivalent controlled workloads | Partial: ARX-only measurements; no fair TV/MT5 speed comparison. Owner targets: visible feedback within 100 ms p95 for local interactions and smooth 60 fps on documented reference hardware. Replay (Apple M4 Pro, 4× CPU throttle, 5,000 constructed bars, 12 studies, 37-name reader; [completion performance](SMART_CHART_REPLAY_COMPLETION_PERFORMANCE.md)): step second-rAF p95 36.9 ms, below 100 ms at that checkpoint (an inference, not a recorded PASS; the later 65-name catalogue and descriptive reader have not been validated in this replay workload, per [completion performance](SMART_CHART_REPLAY_COMPLETION_PERFORMANCE.md) line 13; the current 81-name catalogue is likewise unvalidated in this workload ([v5](SMART_CHART_CANDLE_CATALOGUE_V5.md))); full forward-seek second-rAF p95 105.7 ms, **FAIL**. Streaming stress (development Mac, Chromium, no CPU throttle stated; [acceptance](SMART_CHART_ACCEPTANCE.md)): 10k bars p95 frame interval ~16.7 ms; 50k bars p95 frame interval 33.3 ms, ~1,128 ms setup and a ~1,065 ms initial long task. Frame intervals and rAF are scheduling proxies, not paint; sustained 60 fps is unproven. Display-style switching beyond candles/bars (line/area, area/baseline, baseline/Heikin Ashi, Heikin Ashi/hollow) has harness groups in `interaction-latency.js` but no measurement yet; the existing candles/bars switch already measured p95 191–205 ms at 4x, **FAIL** ([acceptance](SMART_CHART_ACCEPTANCE.md#local-control-interaction-latency)) |

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
- [M8 — Visual strategy testing](https://www.metatrader5.com/en/terminal/help/algotrading/visualization) (as cited in [SMART_CHART_REPLAY.md](SMART_CHART_REPLAY.md); documentation, not a measurement)
- [T11 — Hollow candles](https://www.tradingview.com/support/solutions/43000745270/) (linked from [T1]; read 2026-10-28: fill compares close with open, colour compares close with the previous close)
- [T12 — Heikin Ashi](https://www.tradingview.com/support/solutions/43000619436/) (linked from [T1]; read 2026-10-28: open and close formulas; no first-bar seed stated)
- [T13 — Baseline](https://www.tradingview.com/support/solutions/43000690232/) (linked from [T1]; read 2026-10-28: base level set as a percentage of chart height, 50% by default)

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
   execution-adjacent inference from replay state. Status: met for a single
   chart's loaded window (frozen snapshot, prefix-only studies, step/play/speed,
   slider and close-time seek in the selected display zone (UTC by default),
   labelled historical view outside the live layout);
   partially met overall. Multi-chart replay, saved sessions, deeper attested
   history and order simulation remain open, and full forward-seek feedback p95
   of 105.7 ms still **fails** the 100 ms target
   ([completion performance](SMART_CHART_REPLAY_COMPLETION_PERFORMANCE.md)).
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

The replay workload is separate: 5,000 constructed closed bars and 12 actual
studies with all APIs intercepted, at 4× CPU throttling on an Apple M4 Pro host,
recording installation, next display opportunity and second-animation-frame
feedback separately. Its first checkpoint (Headless Chrome 155;
[replay](SMART_CHART_REPLAY.md)) recorded previous/next second-frame p95 of
72.5/73.5 ms and first→5,000th bar p95 of 136.8/142.3 ms (**FAIL**) across the
two retained-candidate trials (of four alternating build trials). The later paired run
([completion performance](SMART_CHART_REPLAY_COMPLETION_PERFORMANCE.md), 37-name
reader) recorded step 36.9 ms and full forward-seek 105.7 ms (**FAIL**)
second-rAF p95. Raw evidence is retained outside the repository in
`arx-tier1-release/smart-chart-replay-20261026` and
`arx-tier1-release/chart-replay-completion-performance-20261026`. The 4×
throttle applies only to the replay figures; the 10k/50k stress runs state no
CPU throttle. Report replay against the owner's 100 ms p95 target, and do not
describe stepping as PASS unless a run records one.

Measurements from the six held branches listed in the
[27 October checkpoint](ARX_CHECKPOINT_2026_10_27.md)
(`codex/chart-replay-earned-checkpoints`, `codex/replay-cache-combined`,
`codex/replay-checkpoint-packing` and the three `codex/chart-reader-lazy-*`
branches) are excluded. Their 217.2 ms cold completion, 130.5 ms first rewind
and 147.1–152.7 ms forward-seek figures describe held experiments, not the
combined source.

See [calculation conventions](SMART_CHART_STUDY_CONVENTIONS.md) and
[acceptance evidence](SMART_CHART_ACCEPTANCE.md). The Tier 1 architecture gate
score is independent of this feature checklist and must not be reused as a
Smart Chart completion percentage.
